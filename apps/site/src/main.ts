const tutorialDialog = document.querySelector<HTMLDialogElement>("#tutorial-video");
const tutorialPlayer = tutorialDialog?.querySelector<HTMLDivElement>(".dialog-player");
const inlinePlayer = document.querySelector<HTMLDivElement>("[data-inline-player]");

function videoFrame(source: "main" | "tutorial") {
  const frame = document.createElement("iframe");
  frame.src =
    source === "main"
      ? "https://player.vimeo.com/video/1102965770?title=0&byline=0&portrait=0&badge=0&color=ffffff&autoplay=1"
      : "https://www.youtube.com/embed/hLQM89v0XZg?rel=0&fmt=18&html5=1&showinfo=0";
  frame.title = source === "main" ? "Как играют в мафию" : "Короткое видео с правилами мафии";
  frame.allow = "autoplay; fullscreen; picture-in-picture";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  return frame;
}

for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-video]")) {
  link.addEventListener("click", (event) => {
    // Modified clicks keep ordinary external-link behavior, including no-JS fallback.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (
      link.dataset.video === "tutorial" &&
      tutorialDialog &&
      tutorialPlayer &&
      typeof tutorialDialog.showModal === "function"
    ) {
      event.preventDefault();
      tutorialPlayer.replaceChildren(videoFrame("tutorial"));
      // Safari does not focus pointer-clicked links; establish native dialog return focus.
      link.focus({ preventScroll: true });
      tutorialDialog.showModal();
    } else if (link.dataset.video === "main" && inlinePlayer) {
      event.preventDefault();
      inlinePlayer.append(videoFrame("main"));
      inlinePlayer.classList.add("is-playing");
    }
  });
}

tutorialDialog?.addEventListener("close", () => tutorialPlayer?.replaceChildren());
tutorialDialog?.addEventListener("click", (event) => {
  if (event.target === tutorialDialog) tutorialDialog.close();
});
