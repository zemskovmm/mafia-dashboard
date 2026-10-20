const images = new Map<string, Promise<HTMLImageElement>>();

/** Shared decoded image, not a hidden renderer or a second download. */
export const loadVisualImage = (url: string): Promise<HTMLImageElement> => {
  const existing = images.get(url);
  if (existing !== undefined) return existing;
  const image = new Image();
  image.decoding = "async";
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      image.removeAttribute("src");
      reject(new Error("Visual image preparation timed out"));
    }, 10_000);
    const finish = (error?: unknown) => {
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error !== undefined) reject(error);
      else resolve(image);
    };
    if (typeof image.decode === "function") {
      image.src = url;
      void image.decode().then(() => finish(), finish);
    } else {
      image.onload = () => finish();
      image.onerror = () => finish(new Error("Visual image failed to load"));
      image.src = url;
    }
  });
  images.set(url, promise);
  void promise.catch(() => {
    if (images.get(url) === promise) images.delete(url);
  });
  return promise;
};
