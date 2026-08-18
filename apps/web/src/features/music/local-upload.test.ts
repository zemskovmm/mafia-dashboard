import { describe, expect, it, vi } from "vitest";
import { mergeByStableId, uploadSequentially } from "./local-upload.js";

describe("uploadSequentially", () => {
  it("preserves selection order while allowing only one upload at a time", async () => {
    let active = 0;
    let maximumActive = 0;
    const files = ["opening", "night", "closing"];

    const uploaded = await uploadSequentially(files, async (file) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return `${file}-uploaded`;
    });

    expect(maximumActive).toBe(1);
    expect(uploaded).toEqual(["opening-uploaded", "night-uploaded", "closing-uploaded"]);
  });

  it("publishes each success before attempting a later file that fails", async () => {
    const published: string[] = [];
    const failure = new Error("second upload failed");
    const upload = vi
      .fn<(input: string) => Promise<string>>()
      .mockResolvedValueOnce("opening-uploaded")
      .mockRejectedValueOnce(failure);

    await expect(
      uploadSequentially(["opening", "night"], upload, (track) => published.push(track)),
    ).rejects.toBe(failure);

    expect(published).toEqual(["opening-uploaded"]);
  });
});

describe("mergeByStableId", () => {
  it("keeps one latest value per stable ID without reordering existing values", () => {
    expect(
      mergeByStableId(
        [
          { id: "one", title: "Opening" },
          { id: "two", title: "Old title" },
        ],
        [
          { id: "two", title: "Night" },
          { id: "three", title: "Closing" },
        ],
      ),
    ).toEqual([
      { id: "one", title: "Opening" },
      { id: "two", title: "Night" },
      { id: "three", title: "Closing" },
    ]);
  });
});
