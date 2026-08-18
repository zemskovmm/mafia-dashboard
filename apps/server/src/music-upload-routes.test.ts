import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "./app.js";
import { MusicTrackStore } from "./music-track-store.js";

interface StoredRow {
  readonly id: string;
  readonly title: string;
  readonly original_filename: string;
  readonly storage_filename: string;
  readonly mime_type: string;
  readonly duration_seconds: number;
  readonly waveform: number[];
  readonly created_at: Date;
}

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const storageDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    storageDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const createPool = () => {
  const rows: StoredRow[] = [];
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.startsWith("SELECT id, storage_filename")) {
        return { rows: rows.map(({ id, storage_filename }) => ({ id, storage_filename })) };
      }
      if (sql.includes("INSERT INTO music_tracks")) {
        const row: StoredRow = {
          id: String(values[0]),
          title: String(values[1]),
          original_filename: String(values[2]),
          storage_filename: String(values[3]),
          mime_type: String(values[4]),
          duration_seconds: Number(values[5]),
          waveform: JSON.parse(String(values[6])) as number[],
          created_at: new Date("2026-08-18T00:00:00.000Z"),
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("DELETE FROM music_tracks")) {
        const index = rows.findIndex(({ id }) => id === values[0]);
        return { rows: index < 0 ? [] : [rows.splice(index, 1)[0]] };
      }
      throw new Error(`Unexpected SQL in multipart route test: ${sql}`);
    }),
  } as unknown as Pool;
  return { pool, rows };
};

const multipartBody = (
  parts: readonly (
    | { readonly type: "field"; readonly name: string; readonly value: string }
    | {
        readonly type: "file";
        readonly name?: string;
        readonly filename: string;
        readonly contentType: string;
        readonly value: Buffer;
      }
  )[],
) => {
  const boundary = "mafia-dashboard-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.type === "field") {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`),
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name ?? "file"}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
        ),
        part.value,
        Buffer.from("\r\n"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
};

const createMusicApp = async (maxFileBytes: number) => {
  const storageDir = await mkdtemp(join(tmpdir(), "mafia-multipart-route-"));
  storageDirs.push(storageDir);
  const { pool, rows } = createPool();
  const analyze = vi.fn().mockResolvedValue({ durationSeconds: 1, waveform: [0.2, 0.8] });
  const musicTrackStore = new MusicTrackStore(pool, storageDir, analyze, {
    maxFileBytes,
    maxStorageBytes: 10_000,
  });
  const app = await buildApp({
    pool,
    musicTrackStore,
    musicLimits: { maxFileBytes, maxStorageBytes: 10_000 },
  });
  await app.ready();
  openApps.push(app);
  return { app, analyze, rows, storageDir };
};

describe("local music multipart route", () => {
  it("reconciles local music after schema initialization before the app is returned", async () => {
    const order: string[] = [];
    let releaseReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS music_tracks")) order.push("schema");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        if (sql !== "SELECT id, storage_filename FROM music_tracks") {
          throw new Error(`Unexpected SQL in startup order test: ${sql}`);
        }
        order.push("reconcile");
        await reconciliation;
        return { rows: [] };
      }),
    } as unknown as Pool;
    const storageDir = await mkdtemp(join(tmpdir(), "mafia-startup-order-"));
    storageDirs.push(storageDir);
    const musicTrackStore = new MusicTrackStore(pool, storageDir, vi.fn());
    let returned = false;
    const building = buildApp({ pool, musicTrackStore }).then((app) => {
      returned = true;
      return app;
    });

    await vi.waitFor(() => expect(order).toEqual(["schema", "reconcile"]));
    expect(returned).toBe(false);
    releaseReconciliation();
    const app = await building;
    openApps.push(app);
    expect(returned).toBe(true);
  });

  it("accepts the title plus one audio file contract", async () => {
    const { app, analyze, rows } = await createMusicApp(4);
    const request = multipartBody([
      { type: "field", name: "title", value: "Opening" },
      {
        type: "file",
        filename: "opening.mp3",
        contentType: "audio/mpeg",
        value: Buffer.from("MP3!"),
      },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/music/tracks", ...request });

    expect(response.statusCode).toBe(201);
    expect(analyze).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
  });

  it("rejects a truncated but otherwise decodable file before analysis or persistence", async () => {
    const { app, analyze, rows, storageDir } = await createMusicApp(4);
    const request = multipartBody([
      { type: "field", name: "title", value: "Decodable prefix" },
      {
        type: "file",
        filename: "prefix.mp3",
        contentType: "audio/mpeg",
        value: Buffer.from("MP3!!"),
      },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/music/tracks", ...request });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "audio_file_too_large" });
    expect(analyze).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(await readdir(storageDir)).toEqual([]);
  });

  it("rejects more than the single allowed title field", async () => {
    const { app, analyze, rows } = await createMusicApp(32);
    const request = multipartBody([
      { type: "field", name: "title", value: "Opening" },
      { type: "field", name: "note", value: "not allowed" },
      {
        type: "file",
        filename: "opening.mp3",
        contentType: "audio/mpeg",
        value: Buffer.from("MP3!"),
      },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/music/tracks", ...request });

    expect(response.statusCode).toBe(413);
    expect(analyze).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("rejects an extra part after the allowed title and file", async () => {
    const { app, analyze, rows } = await createMusicApp(32);
    const request = multipartBody([
      { type: "field", name: "title", value: "Opening" },
      {
        type: "file",
        filename: "opening.mp3",
        contentType: "audio/mpeg",
        value: Buffer.from("MP3!"),
      },
      { type: "field", name: "extra", value: "not allowed" },
    ]);

    const response = await app.inject({ method: "POST", url: "/api/music/tracks", ...request });

    expect(response.statusCode).toBe(413);
    expect(analyze).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});
