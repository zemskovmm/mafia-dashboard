export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export type ParsedByteRange = ByteRange | null | "invalid";

const safeInteger = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const parseByteRange = (header: string | undefined, size: number): ParsedByteRange => {
  if (header === undefined) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return "invalid";

  const value = header.trim();
  const suffixMatch = /^bytes=-(\d+)$/.exec(value);
  if (suffixMatch !== null) {
    const suffixLength = safeInteger(suffixMatch[1]!);
    if (suffixLength === null || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const openEndedMatch = /^bytes=(\d+)-$/.exec(value);
  if (openEndedMatch !== null) {
    const start = safeInteger(openEndedMatch[1]!);
    return start === null || start >= size ? "invalid" : { start, end: size - 1 };
  }

  const boundedMatch = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (boundedMatch !== null) {
    const start = safeInteger(boundedMatch[1]!);
    const requestedEnd = safeInteger(boundedMatch[2]!);
    if (start === null || requestedEnd === null || start >= size || start > requestedEnd) {
      return "invalid";
    }
    return { start, end: Math.min(size - 1, requestedEnd) };
  }

  return "invalid";
};
