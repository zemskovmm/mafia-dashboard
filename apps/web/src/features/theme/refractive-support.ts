export interface RefractiveSupportInputs {
  readonly enabled?: boolean;
  readonly cssSupportsFilterUrl: boolean;
  readonly browserBrands: readonly string[];
}

const chromiumFamilyBrands = new Set([
  "brave",
  "chromium",
  "google chrome",
  "microsoft edge",
  "opera",
]);

const unsupportedBrowserBrands = new Set(["firefox", "mozilla firefox", "safari", "webkit"]);

export const supportsTrueRefraction = ({
  enabled = true,
  cssSupportsFilterUrl,
  browserBrands,
}: RefractiveSupportInputs): boolean => {
  if (!enabled || !cssSupportsFilterUrl) return false;

  const normalizedBrands = browserBrands.map((brand) => brand.trim().toLowerCase());
  return (
    !normalizedBrands.some((brand) => unsupportedBrowserBrands.has(brand)) &&
    normalizedBrands.some((brand) => chromiumFamilyBrands.has(brand))
  );
};
