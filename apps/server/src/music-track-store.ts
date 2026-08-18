import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform } from "node:stream";
import type { Readable, TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "pg";
import { analyzeAudioFile } from "./audio-analysis.js";

export const DEFAULT_MAX_MUSIC_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_MUSIC_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export type MusicTrackStoreErrorCode = "file_too_large" | "storage_quota_exceeded" | "upload_busy";

export class MusicTrackStoreError extends Error {
  public constructor(public readonly code: MusicTrackStoreErrorCode) {
    super(code);
    this.name = "MusicTrackStoreError";
  }
}

class UploadLimitTransform extends Transform {
  private uploadedBytes = 0;

  public constructor(
    private readonly existingBytes: number,
    private readonly maxFileBytes: number,
    private readonly maxStorageBytes: number,
  ) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.uploadedBytes += chunk.length;
    if (this.uploadedBytes > this.maxFileBytes) {
      callback(new MusicTrackStoreError("file_too_large"));
    } else if (this.existingBytes + this.uploadedBytes > this.maxStorageBytes) {
      callback(new MusicTrackStoreError("storage_quota_exceeded"));
    } else {
      callback(null, chunk);
    }
  }
}

const storageUsage = async (storageDir: string): Promise<number> => {
  const entries = await readdir(storageDir, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isFile()) bytes += (await stat(join(storageDir, entry.name))).size;
  }
  return bytes;
};

export interface MusicTrack {
  readonly id: string;
  readonly title: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly durationSeconds: number;
  readonly waveform: readonly number[];
  readonly audioUrl: string;
  readonly createdAt: string;
}

interface MusicTrackRow {
  readonly id: string;
  readonly title: string;
  readonly original_filename: string;
  readonly storage_filename: string;
  readonly mime_type: string;
  readonly duration_seconds: number;
  readonly waveform: number[];
  readonly created_at: Date;
}

export type AudioAnalyzer = (
  path: string,
) => Promise<{ readonly durationSeconds: number; readonly waveform: readonly number[] }>;

export interface MusicTrackFileLifecycle {
  readonly unlink: (path: string) => Promise<void>;
}

const toTrack = (row: MusicTrackRow): MusicTrack => ({
  id: row.id,
  title: row.title,
  originalFilename: row.original_filename,
  mimeType: row.mime_type,
  durationSeconds: row.duration_seconds,
  waveform: row.waveform,
  audioUrl: `/api/music/tracks/${row.id}/audio`,
  createdAt: row.created_at.toISOString(),
});

const safeExtension = (filename: string): string => {
  const extension = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".audio";
};

export class MusicTrackStore {
  private activeUpload = false;

  public constructor(
    private readonly pool: Pool,
    private readonly storageDir: string,
    private readonly analyze: AudioAnalyzer = analyzeAudioFile,
    private readonly limits: {
      readonly maxFileBytes: number;
      readonly maxStorageBytes: number;
    } = {
      maxFileBytes: DEFAULT_MAX_MUSIC_FILE_BYTES,
      maxStorageBytes: DEFAULT_MAX_MUSIC_STORAGE_BYTES,
    },
    private readonly fileLifecycle: MusicTrackFileLifecycle = { unlink },
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    const result = await this.pool.query<Pick<MusicTrackRow, "id" | "storage_filename">>(
      "SELECT id, storage_filename FROM music_tracks",
    );
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    const storedFiles = new Set(entries.filter((entry) => entry.isFile()).map(({ name }) => name));
    const referencedFiles = new Set<string>();

    for (const row of result.rows) {
      if (storedFiles.has(row.storage_filename)) {
        referencedFiles.add(row.storage_filename);
      } else {
        await this.pool.query("DELETE FROM music_tracks WHERE id = $1", [row.id]);
      }
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && (entry.name.endsWith(".upload") || !referencedFiles.has(entry.name)),
        )
        .map((entry) => rm(join(this.storageDir, entry.name), { force: true })),
    );
  }

  public async create({
    title,
    originalFilename,
    mimeType,
    stream,
    validateUpload,
  }: {
    readonly title: string;
    readonly originalFilename: string;
    readonly mimeType: string;
    readonly stream: Readable;
    readonly validateUpload?: () => void | Promise<void>;
  }): Promise<MusicTrack> {
    if (this.activeUpload) {
      stream.resume();
      throw new MusicTrackStoreError("upload_busy");
    }
    this.activeUpload = true;
    const id = randomUUID();
    const storageFilename = `${id}${safeExtension(originalFilename)}`;
    const temporaryPath = join(this.storageDir, `${id}.upload`);
    const finalPath = join(this.storageDir, storageFilename);
    try {
      await mkdir(this.storageDir, { recursive: true });
      const existingBytes = await storageUsage(this.storageDir);
      const uploadLimits = new UploadLimitTransform(
        existingBytes,
        this.limits.maxFileBytes,
        this.limits.maxStorageBytes,
      );
      await pipeline(stream, uploadLimits, createWriteStream(temporaryPath, { flags: "wx" }));
      await validateUpload?.();
      const analysis = await this.analyze(temporaryPath);
      await rename(temporaryPath, finalPath);
      const result = await this.pool.query<MusicTrackRow>(
        `INSERT INTO music_tracks
           (id, title, original_filename, storage_filename, mime_type, duration_seconds, waveform)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING *`,
        [
          id,
          title,
          originalFilename,
          storageFilename,
          mimeType,
          analysis.durationSeconds,
          JSON.stringify(analysis.waveform),
        ],
      );
      return toTrack(result.rows[0]!);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await rm(finalPath, { force: true });
      throw error;
    } finally {
      this.activeUpload = false;
    }
  }

  public async list(): Promise<readonly MusicTrack[]> {
    const result = await this.pool.query<MusicTrackRow>(
      "SELECT * FROM music_tracks ORDER BY created_at, title, id",
    );
    return result.rows.map(toTrack);
  }

  public async open(
    id: string,
  ): Promise<{ readonly path: string; readonly mimeType: string } | null> {
    const result = await this.pool.query<Pick<MusicTrackRow, "storage_filename" | "mime_type">>(
      "SELECT storage_filename, mime_type FROM music_tracks WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { path: join(this.storageDir, row.storage_filename), mimeType: row.mime_type };
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.pool.query<Pick<MusicTrackRow, "storage_filename">>(
      "SELECT storage_filename FROM music_tracks WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    await this.fileLifecycle
      .unlink(join(this.storageDir, row.storage_filename))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    const deleted = await this.pool.query<{ readonly id: string }>(
      "DELETE FROM music_tracks WHERE id = $1 RETURNING id",
      [id],
    );
    return deleted.rows.length > 0;
  }
}
