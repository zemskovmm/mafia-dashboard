import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizePlayerRoleIcon, MAX_ROLE_ICON_INPUT_BYTES } from "./player-role-icons.js";
import { readFile } from "node:fs/promises";

const url = (bytes: Buffer, format = "png") =>
  `data:image/${format};base64,${bytes.toString("base64")}`;
const chunk = (type: string, bytes: Buffer) => {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4, "ascii");
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
};
const png = () =>
  sharp({ create: { width: 16, height: 8, channels: 4, background: "#ff000080" } })
    .png()
    .toBuffer();

describe("bounded raster decoder", () => {
  it("keeps the presentation contract identical to the web counterpart", async () => {
    const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
    const canonical = (source: string) => source.replace(/\s+/g, "").replaceAll("=|", "=");
    expect(canonical(await read("./player-role-icon-contracts.ts"))).toBe(
      canonical(await read("../../web/src/api/player-role-icon-contracts.ts")),
    );
  });
  it("admits the exact transport-byte ceiling, strips ancillary payload and rejects one more byte", async () => {
    const original = await png();
    const sized = (size: number) =>
      Buffer.concat([
        original.subarray(0, 33),
        chunk("npAD", Buffer.alloc(size - original.length - 12)),
        original.subarray(33),
      ]);
    const ceiling = sized(MAX_ROLE_ICON_INPUT_BYTES);
    expect(ceiling.length).toBe(MAX_ROLE_ICON_INPUT_BYTES);
    const output = await normalizePlayerRoleIcon(url(ceiling));
    expect(Buffer.from(output.split(",")[1]!, "base64").length).toBeLessThan(512);
    await expect(
      normalizePlayerRoleIcon(url(sized(MAX_ROLE_ICON_INPUT_BYTES + 1))),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("accepts exactly four million pixels but rejects one row more", async () => {
    const source = (height: number) =>
      sharp({ create: { width: 2000, height, channels: 3, background: "red" } })
        .png()
        .toBuffer();
    const output = await normalizePlayerRoleIcon(url(await source(2000)));
    expect(await sharp(Buffer.from(output.split(",")[1]!, "base64")).metadata()).toMatchObject({
      width: 256,
      height: 256,
    });
    await expect(normalizePlayerRoleIcon(url(await source(2001)))).rejects.toThrow();
  });
  it("honors EXIF orientation, retains alpha and removes metadata", async () => {
    const bytes = await sharp({
      create: { width: 512, height: 256, channels: 4, background: "#ff000080" },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const output = Buffer.from(
      (await normalizePlayerRoleIcon(url(bytes))).split(",")[1]!,
      "base64",
    );
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ width: 128, height: 256, hasAlpha: true });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    const pixel = await sharp(output).raw().toBuffer();
    expect(pixel[3]).toBe(128);
  });
  it("rejects APNG animation controls even when a decoder would show a static frame", async () => {
    const original = await png();
    const animated = Buffer.concat([
      original.subarray(0, 33),
      chunk("acTL", Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      original.subarray(33),
    ]);
    await expect(normalizePlayerRoleIcon(url(animated))).rejects.toThrow();
  });
  it("rejects unsupported GIF, forged format, truncated JPEG/WebP and corrupt PNG chunks", async () => {
    const original = await png();
    const jpeg = await sharp(original).jpeg().toBuffer();
    const webp = await sharp(original).webp().toBuffer();
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    for (const input of [
      url(await sharp(original).gif().toBuffer(), "gif"),
      url(webp),
      url(original, "webp"),
      url(jpeg.subarray(0, -20), "jpeg"),
      url(webp.subarray(0, -5), "webp"),
      url(corrupt),
    ]) {
      await expect(normalizePlayerRoleIcon(input), input.slice(0, 45)).rejects.toThrow();
    }
  });
});
