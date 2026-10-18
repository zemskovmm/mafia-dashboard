import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { RoleIconPicker } from "./RoleIconPicker.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = () => ({
  role: "citizen" as const,
  consent: true,
  onApply: vi.fn(),
  onCancel: vi.fn(),
});

describe("RoleIconPicker", () => {
  it("uses a native modal and native labelled controls, searching either language", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<RoleIconPicker {...props()} onApply={onApply} />);
    const dialog = screen.getByRole("dialog", { name: "Citizen icon" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Search icons" }), "кошка");
    expect(within(dialog).getByRole("button", { name: "Cat" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Dog" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cat" }));
    expect(within(dialog).getByRole("button", { name: "Cat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onApply).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Use icon" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: "builtin", id: "cat" });
  });

  it("allows built-ins without consent but explains why upload is unavailable", async () => {
    const user = userEvent.setup();
    render(<RoleIconPicker {...props()} consent={false} />);
    expect(screen.getByLabelText("Upload image")).toBeDisabled();
    expect(screen.getByText(/Uploads require data-processing consent/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Icon category" }), "animals");
    expect(screen.getByRole("button", { name: "Cat" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Star" })).not.toBeInTheDocument();
  });

  it("localizes labels, errors and names in Russian", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="ru">
        <RoleIconPicker {...props()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("dialog", { name: "Мирный: иконка" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Поиск иконок" }), "cat");
    expect(screen.getByRole("button", { name: "Кошка" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Загрузить изображение"), {
      target: { files: [new File(["svg"], "a.svg", { type: "image/svg+xml" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Выберите PNG, JPEG или WebP");
  });

  it("previews a valid local upload without applying it until Use icon", async () => {
    class DecodedImage {
      naturalWidth = 640;
      naturalHeight = 320;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", DecodedImage);
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<RoleIconPicker {...props()} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Upload image"), {
      target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Selected icon: Custom image")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog").querySelector(".role-icon-picker__preview img"),
    ).toHaveAttribute("src", "data:image/png;base64,cG5n");
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use icon" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      dataUrl: "data:image/png;base64,cG5n",
    });
  });

  it("rejects excess decoded pixel dimensions", async () => {
    class OversizedImage {
      naturalWidth = 3000;
      naturalHeight = 2000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", OversizedImage);
    render(<RoleIconPicker {...props()} />);
    fireEvent.change(screen.getByLabelText("Upload image"), {
      target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("4 million pixels");
    expect(screen.getByText("Selected icon: Default icon")).toBeInTheDocument();
  });

  it("rejects oversized and unsupported files before reading", async () => {
    render(<RoleIconPicker {...props()} />);
    const input = screen.getByLabelText("Upload image");
    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array(512 * 1024 + 1)], "large.png", { type: "image/png" })],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("512 KiB");
    fireEvent.change(input, {
      target: { files: [new File(["gif"], "animated.gif", { type: "image/gif" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PNG, JPEG or WebP");
  });

  it("cancels a pending read when another icon is selected and never applies stale bytes", async () => {
    const user = userEvent.setup();
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
    const abort = vi.spyOn(FileReader.prototype, "abort");
    const onApply = vi.fn();
    render(<RoleIconPicker {...props()} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Upload image"), {
      target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Use icon" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cat" }));
    await user.click(screen.getByRole("button", { name: "Use icon" }));
    expect(abort).toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: "builtin", id: "cat" });
  });

  it("invalidates pending reads on unmount, consent withdrawal and saving", async () => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
    const abort = vi.spyOn(FileReader.prototype, "abort");
    const settings = props();
    const { rerender, unmount } = render(<RoleIconPicker {...settings} />);
    const select = () =>
      fireEvent.change(screen.getByLabelText("Upload image"), {
        target: { files: [new File(["png"], "a.png", { type: "image/png" })] },
      });
    select();
    rerender(<RoleIconPicker {...settings} consent={false} />);
    expect(abort).toHaveBeenCalledTimes(1);
    rerender(<RoleIconPicker {...settings} />);
    select();
    rerender(<RoleIconPicker {...settings} busy />);
    expect(abort).toHaveBeenCalledTimes(2);
    rerender(<RoleIconPicker {...settings} />);
    select();
    unmount();
    await act(async () => {});
    expect(abort).toHaveBeenCalledTimes(3);
    expect(settings.onApply).not.toHaveBeenCalled();
  });
});
