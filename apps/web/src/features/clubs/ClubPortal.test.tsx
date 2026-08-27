import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Club } from "../../api/client.js";
import { ClubPortal } from "./ClubPortal.js";

afterEach(cleanup);

const creator = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  name: "Club Owner",
  picture: null,
};

describe("ClubPortal", () => {
  it("requires explicit Owner profile consent for each club creation", async () => {
    const user = userEvent.setup();
    const onSaveClub = vi.fn().mockResolvedValue(undefined);

    const Harness = () => {
      const [editing, setEditing] = useState<Club | "new" | null>("new");
      return (
        <ClubPortal
          user={creator}
          authConfigured
          authUnavailable={false}
          themeColor="#c39a58"
          clubs={[]}
          loading={false}
          error={null}
          editing={editing}
          onSignOut={vi.fn().mockResolvedValue(undefined)}
          onThemeColorChange={vi.fn()}
          onEditingChange={setEditing}
          onSaveClub={onSaveClub}
          onOpenClub={vi.fn()}
        />
      );
    };

    render(<Harness />);
    await user.type(screen.getByLabelText("Club name"), "Mafia Sevilla");
    await user.type(screen.getByLabelText("City"), "Sevilla");

    const consent = screen.getByRole("checkbox", {
      name: "I consent to store my Google name and email in the Owner player profile.",
    });
    const save = screen.getByRole("button", { name: "Save club" });
    expect(consent).not.toBeChecked();
    expect(save).toBeDisabled();

    await user.click(consent);
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(onSaveClub).toHaveBeenCalledWith(null, {
        name: "Mafia Sevilla",
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        ownerConsent: true,
      }),
    );
    await user.click(screen.getByRole("button", { name: /^New club/ }));
    expect(
      screen.getByRole("checkbox", {
        name: "I consent to store my Google name and email in the Owner player profile.",
      }),
    ).not.toBeChecked();
  });

  it("changes the one glass skin through a native color picker", () => {
    const onThemeColorChange = vi.fn();

    render(
      <ClubPortal
        user={creator}
        authConfigured
        authUnavailable={false}
        themeColor="#c39a58"
        clubs={[]}
        loading={false}
        error={null}
        editing={null}
        onSignOut={vi.fn().mockResolvedValue(undefined)}
        onThemeColorChange={onThemeColorChange}
        onEditingChange={vi.fn()}
        onSaveClub={vi.fn().mockResolvedValue(undefined)}
        onOpenClub={vi.fn()}
      />,
    );

    const picker = screen.getByLabelText("Glass color");
    expect(picker).toHaveAttribute("type", "color");
    expect(picker).toHaveValue("#c39a58");

    fireEvent.change(picker, { target: { value: "#7170ff" } });
    expect(onThemeColorChange).toHaveBeenCalledWith("#7170ff");
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
  });
});
