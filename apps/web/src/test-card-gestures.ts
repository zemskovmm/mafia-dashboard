import { fireEvent } from "@testing-library/react";

/** Use the real touch gesture path, not retired keyboard shortcuts. */
export const swipeCard = (card: Element, dx = 80, dy = 0) => {
  fireEvent.touchStart(card, {
    touches: [{ identifier: 1, clientX: 100, clientY: 100 }],
  });
  fireEvent.touchEnd(card, {
    changedTouches: [{ identifier: 1, clientX: 100 + dx, clientY: 100 + dy }],
  });
};

/** jsdom has no native Escape-to-cancel bridge; emit the browser event. */
export const cancelDialog = (dialog: Element) =>
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
