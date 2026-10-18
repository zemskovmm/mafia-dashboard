import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RoleIconArtwork } from "./RoleIconArtwork.js";

afterEach(cleanup);

it("renders new and retained private images and falls back on unknown or missing choices", () => {
  const image = "data:image/png;base64,cG5n";
  const fallback = <span>Default</span>;
  const { container, rerender } = render(
    <RoleIconArtwork choice={{ kind: "image", dataUrl: image }} fallback={fallback} />,
  );
  expect(container.querySelector("img")).toHaveAttribute("src", image);
  expect(container.querySelector("img")).toHaveAttribute("alt", "");
  rerender(
    <RoleIconArtwork
      choice={{ kind: "upload", id: "owned" }}
      images={{ owned: image }}
      fallback={fallback}
    />,
  );
  expect(container.querySelector("img")).toHaveAttribute("src", image);
  rerender(
    <RoleIconArtwork
      choice={{ kind: "upload", id: "missing" }}
      images={{ owned: image }}
      fallback={fallback}
    />,
  );
  expect(screen.getByText("Default")).toBeInTheDocument();
  rerender(
    <RoleIconArtwork
      choice={JSON.parse('{"kind":"builtin","id":"unknown"}')}
      fallback={fallback}
    />,
  );
  expect(screen.getByText("Default")).toBeInTheDocument();
  rerender(
    <RoleIconArtwork
      choice={{ kind: "image", dataUrl: "https://invalid.test/tracker.png" }}
      fallback={fallback}
    />,
  );
  expect(container.querySelector("img")).toBeNull();
});

it("handles failed images and recovers when a different source arrives", () => {
  const { container, rerender } = render(
    <RoleIconArtwork
      choice={{ kind: "image", dataUrl: "data:image/png;base64,YQ==" }}
      fallback={<span>Default</span>}
    />,
  );
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByText("Default")).toBeInTheDocument();
  rerender(
    <RoleIconArtwork
      choice={{ kind: "image", dataUrl: "data:image/png;base64,Yg==" }}
      fallback={<span>Default</span>}
    />,
  );
  expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,Yg==");
  expect(screen.queryByText("Default")).not.toBeInTheDocument();
});

it("renders local built-in artwork in a decorative square", () => {
  const { container } = render(
    <RoleIconArtwork
      choice={{ kind: "builtin", id: "cat" }}
      className="preview"
      fallback={<span>Default</span>}
    />,
  );
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector(".preview")).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByText("Default")).not.toBeInTheDocument();
});
