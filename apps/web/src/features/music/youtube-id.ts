const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const normalizeYouTubeVideoId = (input: string): string | null => {
  const value = input.trim();
  if (VIDEO_ID.test(value)) return value;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    let candidate: string | null = null;
    if (host === "youtu.be") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (host === "youtube.com" || host === "m.youtube.com") {
      candidate = url.searchParams.get("v");
      if (candidate === null) {
        const [kind, id] = url.pathname.split("/").filter(Boolean);
        if (kind === "shorts" || kind === "embed") candidate = id ?? null;
      }
    }
    return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
};
