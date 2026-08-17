import { describe, expect, it } from "vitest";
import { createRandomId } from "./random-id.js";

describe("createRandomId", () => {
  it("creates a UUID using getRandomValues without requiring crypto.randomUUID", () => {
    const cryptoSource = {
      getRandomValues: (array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
        array.forEach((_, index) => {
          array[index] = index;
        });
        return array;
      },
    };

    expect(createRandomId(cryptoSource)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
