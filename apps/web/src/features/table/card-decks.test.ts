import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCardArtwork } from "./card-decks.js";

const styles = ["classic", "heritage", "noir"] as const;
const seats = Array.from({ length: 10 }, (_, index) => index + 1);
const faceName = (seat: number) => `face-${String(seat).padStart(2, "0")}.svg`;
const filenames = ["back.svg", ...seats.map(faceName)];
const assetRoot = resolve(process.cwd(), "src/assets/player-cards");
const svgNamespace = "http://www.w3.org/2000/svg";
const decorativeElements = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);
const geometryAttributes = new Set([
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "transform",
  "viewBox",
]);
const decorativeAttributes = new Set([
  ...geometryAttributes,
  "xmlns",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "preserveAspectRatio",
]);

function parseSvg(style: (typeof styles)[number], filename: string) {
  const source = readFileSync(resolve(assetRoot, style, filename), "utf8");
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  return { source, document };
}

function geometrySignature(document: Document) {
  // Ignore all paint, text/metadata and attribute ordering: recolouring a face is not new art.
  return JSON.stringify(
    [...document.querySelectorAll("*")].map((element) => [
      element.localName,
      [...element.attributes]
        .filter((attribute) => geometryAttributes.has(attribute.name))
        .map((attribute) => [attribute.name, attribute.value] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
}

describe("replaceable printed-card artwork", () => {
  it("contains exactly three decks with ten numbered faces and one shared back each", () => {
    expect(readdirSync(assetRoot).sort()).toEqual([...styles].sort());
    for (const style of styles) {
      expect(readdirSync(resolve(assetRoot, style)).sort()).toEqual([...filenames].sort());
    }
  });

  for (const style of styles) {
    it(`${style}: ships standalone, decorative-only SVGs without role text or active/remote content`, () => {
      for (const filename of filenames) {
        const { source, document } = parseSvg(style, filename);
        expect(document.querySelector("parsererror"), filename).toBeNull();
        expect(document.doctype, filename).toBeNull();
        expect(document.documentElement.localName, filename).toBe("svg");
        expect(document.documentElement.namespaceURI, filename).toBe(svgNamespace);
        expect(document.documentElement.getAttribute("viewBox"), filename).toBe(
          filename === "back.svg" ? "0 0 250 350" : "0 0 160 256",
        );
        expect(document.documentElement.textContent?.trim(), filename).toBe("");
        expect(source, filename).not.toMatch(
          /<\?|<!|\b(?:citizen|mafia|sheriff|don|гражданин|мафия|шериф|дон)\b/iu,
        );
        for (const element of document.querySelectorAll("*")) {
          expect(
            decorativeElements.has(element.localName),
            `${filename}: ${element.localName}`,
          ).toBe(true);
          expect(element.namespaceURI, filename).toBe(svgNamespace);
          for (const attribute of element.attributes) {
            expect(decorativeAttributes.has(attribute.name), `${filename}: ${attribute.name}`).toBe(
              true,
            );
            if (attribute.name !== "xmlns") {
              expect(attribute.value, `${filename}: ${attribute.name}`).not.toMatch(
                /url\s*\(|(?:https?:|data:|javascript:|\/\/)/i,
              );
            }
          }
        }
      }
    });

    it(`${style}: has ten different geometric compositions, not ten palette variants`, () => {
      const signatures = seats.map((seat) => {
        const { document } = parseSvg(style, faceName(seat));
        expect(document.querySelectorAll("path[d]").length).toBeGreaterThan(0);
        return geometrySignature(document);
      });
      expect(new Set(signatures).size).toBe(10);
    });
  }
});

describe("seat-only artwork manifest", () => {
  for (const style of styles) {
    it(`${style}: resolves every allowed face and the same neutral back to Vite asset URLs`, () => {
      const artwork = seats.map((seat) => getCardArtwork(style, seat));
      expect(new Set(artwork.map(({ front }) => front)).size).toBe(10);
      expect(new Set(artwork.map(({ back }) => back)).size).toBe(1);
      for (const [index, { front, back }] of artwork.entries()) {
        expect(front).not.toMatch(/^(?:data:|https?:)/i);
        expect(back).not.toMatch(/^(?:data:|https?:)/i);
        expect(new URL(front, "https://artwork.test").pathname).toBe(
          `/src/assets/player-cards/${style}/${faceName(index + 1)}`,
        );
        expect(new URL(back, "https://artwork.test").pathname).toBe(
          `/src/assets/player-cards/${style}/back.svg`,
        );
      }
      expect(seats.map((seat) => getCardArtwork(style, seat))).toEqual(artwork);
    });

    it(`${style}: invalid seat numbers use the neutral back, never a synthesized path`, () => {
      const back = getCardArtwork(style, 1).back;
      for (const seat of [
        -Infinity,
        -100,
        -1,
        -0,
        0,
        0.5,
        1.5,
        9.5,
        10.00001,
        11,
        100,
        Infinity,
        NaN,
      ]) {
        expect(getCardArtwork(style, seat), String(seat)).toEqual({ front: back, back });
      }
    });
  }
});
