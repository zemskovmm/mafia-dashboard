import { useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { AppUser, Club, ClubInput, ClubUpdateInput } from "../../api/client.js";
import { reportError } from "../console/error-console.js";

interface ClubPortalProps {
  readonly user: AppUser | null;
  readonly authConfigured: boolean | null;
  readonly authUnavailable: boolean;
  readonly themeColor: string;
  readonly clubs: readonly Club[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly editing: Club | "new" | null;
  readonly onSignOut: () => Promise<void>;
  readonly onThemeColorChange: (color: string) => void;
  readonly onEditingChange: (editing: Club | "new" | null) => void;
  readonly onSaveClub: (clubId: string | null, input: ClubInput | ClubUpdateInput) => Promise<void>;
  readonly onOpenClub: (club: Club) => void;
}

const readImage = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Unable to read image")),
    );
    reader.readAsDataURL(file);
  });

const ClubEditor = ({
  club,
  saving,
  onCancel,
  onSave,
}: {
  readonly club: Club | null;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (input: ClubInput | ClubUpdateInput) => Promise<void>;
}) => {
  const [name, setName] = useState(club?.name ?? "");
  const [city, setCity] = useState(club?.city ?? "");
  const [headerLogo, setHeaderLogo] = useState<string | null>(club?.headerLogo ?? null);
  const [cardLogo, setCardLogo] = useState<string | null>(club?.cardLogo ?? null);
  const [ownerConsent, setOwnerConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseImage = async (file: File | undefined, setter: (image: string | null) => void) => {
    if (file === undefined) return;
    try {
      setter(await readImage(file));
      setError(null);
    } catch (error) {
      reportError(error, { source: "application", context: "club-image.read" });
      setError("That image could not be read.");
    }
  };

  return (
    <section className="club-editor-card" aria-label="Club details">
      <label>
        Club name
        <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        City
        <input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} />
      </label>
      <div className="club-logo-fields">
        <label className="club-logo-field">
          <span>Header logo</span>
          <span className="club-logo-preview">
            {headerLogo === null ? (
              <span className="club-logo-placeholder">
                <ImagePlus aria-hidden="true" />
                Choose image
              </span>
            ) : (
              <>
                <img src={headerLogo} alt="Header logo preview" />
                <span className="club-logo-change">Change</span>
              </>
            )}
          </span>
          <input
            className="club-logo-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(event) => void chooseImage(event.target.files?.[0], setHeaderLogo)}
          />
        </label>
        <label className="club-logo-field">
          <span>Playing-card logo</span>
          <span className="club-logo-preview card-logo-preview">
            {cardLogo === null ? (
              <span className="club-logo-placeholder">
                <ImagePlus aria-hidden="true" />
                Choose image
              </span>
            ) : (
              <>
                <img src={cardLogo} alt="Playing-card logo preview" />
                <span className="club-logo-change">Change</span>
              </>
            )}
          </span>
          <input
            className="club-logo-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(event) => void chooseImage(event.target.files?.[0], setCardLogo)}
          />
        </label>
      </div>
      {club === null ? (
        <label>
          <input
            type="checkbox"
            checked={ownerConsent}
            onChange={(event) => setOwnerConsent(event.target.checked)}
          />
          I consent to store my Google name and email in the Owner player profile.
        </label>
      ) : null}
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="club-editor-actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="club-save-button"
          disabled={
            saving || name.trim() === "" || city.trim() === "" || (club === null && !ownerConsent)
          }
          onClick={() =>
            void onSave(
              club === null
                ? { name, city, headerLogo, cardLogo, ownerConsent: true }
                : { name, city, headerLogo, cardLogo },
            )
          }
        >
          {saving ? "Saving club…" : "Save club"}
        </button>
      </div>
    </section>
  );
};

export const ClubPortal = ({
  user,
  authConfigured,
  authUnavailable,
  themeColor,
  clubs,
  loading,
  error,
  editing,
  onSignOut,
  onThemeColorChange,
  onEditingChange,
  onSaveClub,
  onOpenClub,
}: ClubPortalProps) => {
  const [saving, setSaving] = useState(false);
  const portalTitle =
    editing === "new"
      ? "Create a new club"
      : editing === null
        ? "Choose your club"
        : `Edit ${editing.name}`;

  useEffect(() => {
    if (editing !== null && editing !== "new" && !clubs.some(({ id }) => id === editing.id)) {
      onEditingChange(null);
    }
  }, [clubs, editing, onEditingChange]);

  const save = async (input: ClubInput | ClubUpdateInput) => {
    setSaving(true);
    try {
      await onSaveClub(editing === "new" || editing === null ? null : editing.id, input);
      onEditingChange(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="club-portal">
      <div className="curtain curtain-left" aria-hidden="true" />
      <div className="curtain curtain-right" aria-hidden="true" />
      <section className="club-portal-content">
        <label className="portal-theme-color-field">
          <span>Glass color</span>
          <input
            type="color"
            aria-label="Glass color"
            value={themeColor}
            onChange={(event) => onThemeColorChange(event.currentTarget.value)}
          />
        </label>
        <p className="club-portal-suit" aria-hidden="true">
          ♠
        </p>
        <h1>{portalTitle}</h1>
        {user === null ? (
          loading ? (
            <p className="club-auth-status" role="status">
              Checking secure session…
            </p>
          ) : authUnavailable ? (
            <p className="club-auth-status" role="alert" aria-label="Sign-in status unavailable">
              Sign-in status is unavailable. Reload this page to try again.
            </p>
          ) : authConfigured ? (
            <a className="google-auth-button" href="/api/auth/google/start">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="#4285f4"
                  d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.32 2.98-7.42Z"
                />
                <path
                  fill="#34a853"
                  d="M12 22c2.7 0 4.98-.9 6.63-2.35l-3.24-2.55c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.63A10 10 0 0 0 12 22Z"
                />
                <path
                  fill="#fbbc05"
                  d="M6.39 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.44H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.56l3.35-2.63Z"
                />
                <path
                  fill="#ea4335"
                  d="M12 5.94c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.44l3.35 2.63C7.18 7.7 9.39 5.94 12 5.94Z"
                />
              </svg>
              Continue with Google
            </a>
          ) : (
            <p className="club-auth-status" role="alert">
              Google sign-in is not configured for this server.
            </p>
          )
        ) : editing !== null ? (
          <ClubEditor
            key={editing === "new" ? "new" : editing.id}
            club={editing === "new" ? null : editing}
            saving={saving}
            onCancel={() => onEditingChange(null)}
            onSave={save}
          />
        ) : (
          <>
            <div className="club-user-chip">
              <span className="club-user-avatar">
                {user.picture === null ? (
                  user.name.slice(0, 1).toUpperCase()
                ) : (
                  <img src={user.picture} alt="" referrerPolicy="no-referrer" />
                )}
              </span>
              <span>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </span>
              <button type="button" disabled={loading} onClick={() => void onSignOut()}>
                Sign out
              </button>
            </div>
            <div className="club-card-grid" aria-label="Available clubs">
              {clubs.map((club, index) => (
                <article
                  key={club.id}
                  className="club-playing-card"
                  style={{ "--card-index": index } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="club-card-open"
                    aria-label={`Open ${club.name} in ${club.city}`}
                    onClick={() => onOpenClub(club)}
                  >
                    <span className="club-card-corner" aria-hidden="true">
                      {index % 2 === 0 ? "K" : "Q"}
                      <small>♥</small>
                    </span>
                    <span className="club-card-logo" aria-hidden="true">
                      {club.cardLogo === null ? (
                        <span>{club.name.slice(0, 2).toUpperCase()}</span>
                      ) : (
                        <img src={club.cardLogo} alt="" />
                      )}
                    </span>
                    <strong>{club.name}</strong>
                    <span>{club.city}</span>
                  </button>
                </article>
              ))}
              <button
                type="button"
                className="club-playing-card new-club-card"
                onClick={() => onEditingChange("new")}
              >
                <span aria-hidden="true">＋</span>
                <strong>New club</strong>
                <small>Create freely</small>
              </button>
            </div>
          </>
        )}
        {error === null ? null : (
          <p className="club-portal-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
};
