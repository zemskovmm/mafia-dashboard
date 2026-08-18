import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { MusicTrackStore } from "./music-track-store.js";

let storageDir = "";

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "mafia-music-test-"));
});

afterAll(async () => {
  if (storageDir !== "") await rm(storageDir, { recursive: true, force: true });
});

describe("MusicTrackStore", () => {
  it("persists analyzed waveform metadata and removes the stored audio", async () => {
    const rows: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO music_tracks")) {
          const row = {
            id: values[0],
            title: values[1],
            original_filename: values[2],
            storage_filename: values[3],
            mime_type: values[4],
            duration_seconds: values[5],
            waveform: JSON.parse(String(values[6])),
            created_at: new Date("2026-08-17T20:00:00.000Z"),
          };
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.startsWith("SELECT *")) return { rows };
        if (sql.startsWith("SELECT storage_filename")) {
          return { rows: rows.filter((row) => row.id === values[0]) };
        }
        if (sql.startsWith("DELETE")) {
          const index = rows.findIndex((row) => row.id === values[0]);
          return { rows: index < 0 ? [] : [rows.splice(index, 1)[0]] };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    } as unknown as Pool;
    const analyze = vi.fn().mockResolvedValue({
      durationSeconds: 123.5,
      waveform: [0.1, 0.8, 0.4],
    });
    const store = new MusicTrackStore(pool, storageDir, analyze);

    const track = await store.create({
      title: "Night table",
      originalFilename: "night.mp3",
      mimeType: "audio/mpeg",
      stream: Readable.from(Buffer.from("test audio bytes")),
    });

    expect(track).toMatchObject({
      title: "Night table",
      originalFilename: "night.mp3",
      mimeType: "audio/mpeg",
      durationSeconds: 123.5,
      waveform: [0.1, 0.8, 0.4],
    });
    const source = await store.open(track.id);
    expect(source?.path.endsWith(".mp3")).toBe(true);
    expect(await readFile(source!.path, "utf8")).toBe("test audio bytes");
    expect((await store.list()).some(({ id }) => id === track.id)).toBe(true);

    expect(await store.delete(track.id)).toBe(true);
    expect(await store.open(track.id)).toBeNull();
  });

  it("rejects a file that exceeds the configured per-file cap while streaming", async () => {
    const analyze = vi.fn();
    const pool = { query: vi.fn() } as unknown as Pool;
    const store = new MusicTrackStore(pool, storageDir, analyze, {
      maxFileBytes: 10,
      maxStorageBytes: 100,
    });

    await expect(
      store.create({
        title: "Too large",
        originalFilename: "large.mp3",
        mimeType: "audio/mpeg",
        stream: Readable.from(Buffer.alloc(11)),
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(analyze).not.toHaveBeenCalled();
    expect((await readdir(storageDir)).filter((name) => name.endsWith(".upload"))).toEqual([]);
  });

  it("rejects an upload that would exceed the total storage quota", async () => {
    const existingPath = join(storageDir, "existing.mp3");
    await writeFile(existingPath, Buffer.alloc(95));
    const analyze = vi.fn();
    const pool = { query: vi.fn() } as unknown as Pool;
    const store = new MusicTrackStore(pool, storageDir, analyze, {
      maxFileBytes: 20,
      maxStorageBytes: 100,
    });

    await expect(
      store.create({
        title: "Over quota",
        originalFilename: "quota.mp3",
        mimeType: "audio/mpeg",
        stream: Readable.from(Buffer.alloc(6)),
      }),
    ).rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(analyze).not.toHaveBeenCalled();
    await rm(existingPath, { force: true });
  });

  it("rejects concurrent writes before they can race the storage quota", async () => {
    let releaseAnalysis!: () => void;
    const firstAnalysis = new Promise<{ durationSeconds: number; waveform: number[] }>(
      (resolve) => {
        releaseAnalysis = () => resolve({ durationSeconds: 10, waveform: [0.5] });
      },
    );
    const analyze = vi
      .fn()
      .mockImplementationOnce(() => firstAnalysis)
      .mockResolvedValue({ durationSeconds: 10, waveform: [0.5] });
    const pool = {
      query: vi.fn(async (_sql: string, values: readonly unknown[]) => ({
        rows: [
          {
            id: values[0],
            title: values[1],
            original_filename: values[2],
            storage_filename: values[3],
            mime_type: values[4],
            duration_seconds: values[5],
            waveform: JSON.parse(String(values[6])),
            created_at: new Date("2026-08-18T00:00:00.000Z"),
          },
        ],
      })),
    } as unknown as Pool;
    const store = new MusicTrackStore(pool, storageDir, analyze);
    const first = store.create({
      title: "First",
      originalFilename: "first.mp3",
      mimeType: "audio/mpeg",
      stream: Readable.from(Buffer.alloc(4)),
    });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());

    await expect(
      store.create({
        title: "Second",
        originalFilename: "second.mp3",
        mimeType: "audio/mpeg",
        stream: Readable.from(Buffer.alloc(4)),
      }),
    ).rejects.toMatchObject({ code: "upload_busy" });

    releaseAnalysis();
    await first;
  });

  it("keeps the database row reachable when unlink fails", async () => {
    const caseDir = await mkdtemp(join(storageDir, "delete-failure-"));
    const storedRows = [{ id: "track-1", storage_filename: "track-1.mp3" }];
    await writeFile(join(caseDir, "track-1.mp3"), "audio");
    const pool = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith("SELECT storage_filename")) {
          return { rows: storedRows.filter(({ id }) => id === values[0]) };
        }
        if (sql.startsWith("DELETE FROM music_tracks")) {
          const index = storedRows.findIndex(({ id }) => id === values[0]);
          return { rows: index < 0 ? [] : [storedRows.splice(index, 1)[0]] };
        }
        throw new Error(`Unexpected SQL in delete failure test: ${sql}`);
      }),
    } as unknown as Pool;
    const unlinkFile = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const store = new MusicTrackStore(
      pool,
      caseDir,
      vi.fn(),
      { maxFileBytes: 100, maxStorageBytes: 1_000 },
      { unlink: unlinkFile },
    );

    await expect(store.delete("track-1")).rejects.toThrow("permission denied");

    expect(storedRows).toEqual([{ id: "track-1", storage_filename: "track-1.mp3" }]);
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/^DELETE/),
      expect.anything(),
    );
  });

  it("removes an interrupted .upload file during startup reconciliation", async () => {
    const caseDir = await mkdtemp(join(storageDir, "temp-artifact-"));
    await writeFile(join(caseDir, "interrupted.upload"), "partial audio");
    const pool = reconciliationPool([]);
    const store = new MusicTrackStore(pool, caseDir, vi.fn());

    await store.initialize();

    expect(await readdir(caseDir)).toEqual([]);
  });

  it("removes a renamed file that has no database row during startup reconciliation", async () => {
    const caseDir = await mkdtemp(join(storageDir, "renamed-artifact-"));
    await writeFile(join(caseDir, "unreferenced.mp3"), "complete audio");
    const pool = reconciliationPool([]);
    const store = new MusicTrackStore(pool, caseDir, vi.fn());

    await store.initialize();

    expect(await readdir(caseDir)).toEqual([]);
  });

  it("removes a database row whose stored file is missing during startup reconciliation", async () => {
    const caseDir = await mkdtemp(join(storageDir, "missing-file-"));
    const rows = [{ id: "missing-track", storage_filename: "missing-track.mp3" }];
    const pool = reconciliationPool(rows);
    const store = new MusicTrackStore(pool, caseDir, vi.fn());

    await store.initialize();

    expect(rows).toEqual([]);
    expect(pool.query).toHaveBeenCalledWith("DELETE FROM music_tracks WHERE id = $1", [
      "missing-track",
    ]);
  });

  it("preserves a valid referenced file and its database row during reconciliation", async () => {
    const caseDir = await mkdtemp(join(storageDir, "valid-file-"));
    await writeFile(join(caseDir, "valid-track.mp3"), "valid audio");
    const rows = [{ id: "valid-track", storage_filename: "valid-track.mp3" }];
    const pool = reconciliationPool(rows);
    const store = new MusicTrackStore(pool, caseDir, vi.fn());

    await store.initialize();

    expect(await readFile(join(caseDir, "valid-track.mp3"), "utf8")).toBe("valid audio");
    expect(rows).toEqual([{ id: "valid-track", storage_filename: "valid-track.mp3" }]);
  });
});

const reconciliationPool = (rows: Array<{ id: string; storage_filename: string }>) =>
  ({
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql === "SELECT id, storage_filename FROM music_tracks") return { rows: [...rows] };
      if (sql === "DELETE FROM music_tracks WHERE id = $1") {
        const index = rows.findIndex(({ id }) => id === values[0]);
        if (index >= 0) rows.splice(index, 1);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in reconciliation test: ${sql}`);
    }),
  }) as unknown as Pool;
