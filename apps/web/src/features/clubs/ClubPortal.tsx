import { useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { AppUser, Club, ClubInput, ClubUpdateInput } from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { LanguageSelector } from "../../i18n/LanguageSelector.js";
import { shellMessages } from "../../i18n/messages/shell.js";
import { reportError } from "../console/error-console.js";
import type { ClubEntryOrigin } from "./ClubEntryTransition.js";
import { computeCardFront } from "./club-fire-renderer.js";

interface ClubPortalProps {
  readonly user: AppUser | null;
  readonly authConfigured: boolean | null;
  readonly authUnavailable: boolean;
  readonly clubs: readonly Club[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly showDeletionNotice?: boolean;
  readonly editing: Club | "new" | null;
  readonly onSignOut: () => Promise<void>;
  readonly onEditingChange: (editing: Club | "new" | null) => void;
  readonly onSaveClub: (clubId: string | null, input: ClubInput | ClubUpdateInput) => Promise<void>;
  readonly onOpenClub: (club: Club, origin: ClubEntryOrigin) => void;
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
  const { locale, t } = useMessages(shellMessages);
  const [name, setName] = useState(club?.name ?? "");
  const [city, setCity] = useState(club?.city ?? "");
  const [headerLogo, setHeaderLogo] = useState<string | null>(club?.headerLogo ?? null);
  const [cardLogo, setCardLogo] = useState<string | null>(club?.cardLogo ?? null);
  const [language, setLanguage] = useState(club?.language ?? locale);
  const [bestMoveEnabled, setBestMoveEnabled] = useState(club?.bestMoveEnabled ?? true);
  const [ownerConsent, setOwnerConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseImage = async (file: File | undefined, setter: (image: string | null) => void) => {
    if (file === undefined) return;
    try {
      setter(await readImage(file));
      setError(null);
    } catch (error) {
      reportError(error, { source: "application", context: "club-image.read" });
      setError(t("imageReadFailed"));
    }
  };

  return (
    <section className="club-editor-card" aria-label={t("clubDetails")}>
      <label>
        {t("clubName")}
        <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t("city")}
        <input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} />
      </label>
      <LanguageSelector value={language} onChange={setLanguage} />
      <div className="club-logo-fields">
        <label className="club-logo-field">
          <span>{t("headerLogo")}</span>
          <span className="club-logo-preview">
            {headerLogo === null ? (
              <span className="club-logo-placeholder">
                <ImagePlus aria-hidden="true" />
                {t("chooseImage")}
              </span>
            ) : (
              <>
                <img src={headerLogo} alt={t("headerLogoPreview")} />
                <span className="club-logo-change">{t("change")}</span>
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
          <span>{t("playingCardLogo")}</span>
          <span className="club-logo-preview">
            {cardLogo === null ? (
              <span className="club-logo-placeholder">
                <ImagePlus aria-hidden="true" />
                {t("chooseImage")}
              </span>
            ) : (
              <>
                <img src={cardLogo} alt={t("playingCardLogoPreview")} />
                <span className="club-logo-change">{t("change")}</span>
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
            checked={bestMoveEnabled}
            onChange={(event) => setBestMoveEnabled(event.target.checked)}
          />
          {t("bestMoveEnabled")}
        </label>
      ) : null}
      {club === null ? (
        <label>
          <input
            type="checkbox"
            checked={ownerConsent}
            onChange={(event) => setOwnerConsent(event.target.checked)}
          />
          {t("ownerConsent")}
        </label>
      ) : null}
      {error === null ? null : <p role="alert">{error}</p>}
      <div className="club-editor-actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          {t("cancel")}
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
                ? {
                    name,
                    city,
                    headerLogo,
                    cardLogo,
                    language,
                    bestMoveEnabled,
                    ownerConsent: true,
                  }
                : { name, city, headerLogo, cardLogo, language, bestMoveEnabled },
            )
          }
        >
          {saving ? t("savingClub") : t("saveClub")}
        </button>
      </div>
    </section>
  );
};

export const ClubPortal = ({
  user,
  authConfigured,
  authUnavailable,
  clubs,
  loading,
  error,
  showDeletionNotice = false,
  editing,
  onSignOut,
  onEditingChange,
  onSaveClub,
  onOpenClub,
}: ClubPortalProps) => {
  const { t } = useMessages(shellMessages);
  const [saving, setSaving] = useState(false);
  const portalTitle =
    editing === "new"
      ? t("createNewClub")
      : editing === null
        ? t("clubPortalSlogan")
        : t("editClubTitle", { name: editing.name });

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
      {user !== null && editing === null ? (
        <div className="club-user-chip">
          <span className="club-user-avatar">
            {user.picture === null ? (
              user.name.slice(0, 1).toUpperCase()
            ) : (
              <img src={user.picture} alt="" referrerPolicy="no-referrer" />
            )}
          </span>
          <span>
            <strong title={user.name}>{user.name}</strong>
            <small title={user.email}>{user.email}</small>
          </span>
          <button type="button" disabled={loading} onClick={() => void onSignOut()}>
            {t("signOut")}
          </button>
        </div>
      ) : null}
      <section className="club-portal-content">
        <div className="club-portal-brand">
          <img src="/la-verdad.svg" width="72" height="72" alt={t("applicationName")} />
          <strong>{t("applicationName")}</strong>
        </div>
        <h1 className={editing === null ? "club-portal-slogan" : undefined}>{portalTitle}</h1>
        {user !== null && showDeletionNotice ? (
          <p className="club-auth-status" role="status">
            {t("clubDeletedWithoutErasure")}
          </p>
        ) : null}
        {user === null ? (
          loading ? (
            <p className="club-auth-status" role="status">
              {t("checkingSecureSession")}
            </p>
          ) : authUnavailable ? (
            <p className="club-auth-status" role="alert" aria-label={t("signInStatusUnavailable")}>
              {t("signInUnavailableReload")}
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
              {t("continueWithGoogle")}
            </a>
          ) : (
            <p className="club-auth-status" role="alert">
              {t("googleSignInNotConfigured")}
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
          <div className="club-card-grid" aria-label={t("availableClubs")}>
            {clubs.map((club, index) => (
              <article
                key={club.id}
                className="club-playing-card"
                style={{ "--card-index": index } as React.CSSProperties}
              >
                <button
                  type="button"
                  className="club-card-open"
                  aria-label={t("openClub", { name: club.name, city: club.city })}
                  onClick={(event) => {
                    const card = event.currentTarget.closest<HTMLElement>(".club-playing-card")!;
                    const bounds = card.getBoundingClientRect();
                    const style = getComputedStyle(card);
                    onOpenClub(club, {
                      x: bounds.left + bounds.width / 2,
                      y: bounds.top + bounds.height / 2,
                      front: computeCardFront(card, bounds, style),
                      card,
                      cardTransform: style.transform,
                    });
                  }}
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
              <strong>{t("newClub")}</strong>
              <small>{t("createFreely")}</small>
            </button>
          </div>
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
