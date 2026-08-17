import { describe, expect, it } from "vitest";
import { normalizeYouTubeVideoId } from "./youtube-id.js";

describe("normalizeYouTubeVideoId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=12", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("extracts %s", (input, expected) => {
    expect(normalizeYouTubeVideoId(input)).toBe(expected);
  });

  it.each(["", "not a video", "https://example.com/video", "short"])("rejects %s", (input) => {
    expect(normalizeYouTubeVideoId(input)).toBeNull();
  });
});
