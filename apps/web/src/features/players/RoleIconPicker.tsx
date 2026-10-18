import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PLAYER_ICON_ROLES,
  type PlayerIconRole,
  type PlayerRoleIconInput,
  type PlayerRoleIconsInput,
} from "../../api/player-role-icon-contracts.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { roleIconMessages } from "../../i18n/messages/role-icons.js";
import { RoleDrawIcon } from "../table/RoleDrawPresentation.js";
import { RoleIconArtwork } from "./RoleIconArtwork.js";
import {
  findRoleIcon,
  ROLE_ICON_CATEGORIES,
  roleIconCategoryName,
  searchRoleIcons,
  type RoleIconCategory,
} from "./role-icon-library.js";

const roleLabel = { citizen: "Citizen", mafia: "Mafia", don: "Don", sheriff: "Sheriff" } as const;

export interface RoleIconPickerProps {
  readonly role: PlayerIconRole;
  readonly choice?: PlayerRoleIconInput;
  readonly images?: Readonly<Record<string, string>>;
  readonly consent: boolean;
  readonly busy?: boolean;
  readonly onApply: (choice: PlayerRoleIconInput) => void;
  readonly onCancel: () => void;
}

type UploadFailure = "format" | "size" | "pixels" | "decode";
class RoleIconUploadError extends Error {
  constructor(readonly reason: UploadFailure) {
    super(reason);
  }
}

/** Early feedback only: the server checks raster bytes, animation and normalization. */
export const readRoleIconFile = async (file: File, signal: AbortSignal): Promise<string> => {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new RoleIconUploadError("format");
  if (file.size > 512 * 1024) throw new RoleIconUploadError("size");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const aborted = () => {
      reader.abort();
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const finish = () => {
      signal.removeEventListener("abort", aborted);
      reader.onload = null;
      reader.onerror = null;
    };
    reader.onload = () => {
      const result = reader.result;
      finish();
      if (typeof result === "string") resolve(result);
      else reject(new RoleIconUploadError("decode"));
    };
    reader.onerror = () => {
      finish();
      reject(new RoleIconUploadError("decode"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else reader.readAsDataURL(file);
  });
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    const finish = () => {
      signal.removeEventListener("abort", aborted);
      image.onload = null;
      image.onerror = null;
    };
    const aborted = () => {
      finish();
      image.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    image.onload = () => {
      const pixels = image.naturalWidth * image.naturalHeight;
      finish();
      if (pixels <= 0) reject(new RoleIconUploadError("decode"));
      else if (pixels > 4_000_000) reject(new RoleIconUploadError("pixels"));
      else resolve();
    };
    image.onerror = () => {
      finish();
      reject(new RoleIconUploadError("decode"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else image.src = dataUrl;
  });
  return dataUrl;
};

export const RoleIconPicker = ({
  role,
  choice,
  images,
  consent,
  busy = false,
  onApply,
  onCancel,
}: RoleIconPickerProps) => {
  const { t, locale } = useMessages(roleIconMessages);
  const [selected, setSelected] = useState<PlayerRoleIconInput>(choice ?? null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RoleIconCategory | "all">("all");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<UploadFailure | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<AbortController | null>(null);
  const titleId = useId();
  const uploadId = useId();
  const hintId = useId();
  const cancelRead = () => {
    pending.current?.abort();
    pending.current = null;
    setReading(false);
  };
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => {
      pending.current?.abort();
      pending.current = null;
      if (element.open) element.close();
    };
  }, []);
  useEffect(() => {
    if (!consent || busy) {
      cancelRead();
      if (!consent)
        setSelected((current) =>
          current?.kind === "image" || current?.kind === "upload" ? null : current,
        );
    }
  }, [consent, busy]);
  const choose = (next: PlayerRoleIconInput) => {
    cancelRead();
    setError(null);
    setSelected(next);
  };
  const dismiss = () => {
    cancelRead();
    onCancel();
  };
  const matchingIcons = searchRoleIcons(query, category);
  const selectedName =
    selected?.kind === "builtin"
      ? findRoleIcon(selected.id)?.names[locale]
      : selected
        ? t("Custom image")
        : t("Default icon");
  return createPortal(
    <dialog ref={dialog} className="role-icon-picker" aria-labelledby={titleId} onCancel={dismiss}>
      <header className="role-icon-picker__heading">
        <h2 id={titleId}>{t("Role icon title", { role: t(roleLabel[role]) })}</h2>
      </header>
      <div className="role-icon-picker__selection">
        <RoleIconArtwork
          className="role-icon-picker__preview"
          choice={selected}
          images={images}
          fallback={<RoleDrawIcon role={role} />}
        />
        <span>
          {t("Selected icon")}: {selectedName}
        </span>
        <button
          type="button"
          disabled={busy}
          aria-pressed={selected === null}
          onClick={() => choose(null)}
        >
          {t("Use default")}
        </button>
      </div>
      <div className="role-icon-picker__filters">
        <label>
          {t("Search icons")}
          <input
            type="search"
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("Icon category")}
          <select
            value={category}
            disabled={busy}
            onChange={(event) => setCategory(event.currentTarget.value as RoleIconCategory | "all")}
          >
            <option value="all">{t("All icons")}</option>
            {ROLE_ICON_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {roleIconCategoryName(item, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="role-icon-picker__library">
        {matchingIcons.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className="role-icon-picker__option"
            disabled={busy}
            aria-label={entry.names[locale]}
            title={entry.names[locale]}
            aria-pressed={selected?.kind === "builtin" && selected.id === entry.id}
            onClick={() => choose({ kind: "builtin", id: entry.id })}
          >
            <RoleIconArtwork choice={{ kind: "builtin", id: entry.id }} />
            <span>{entry.names[locale]}</span>
          </button>
        ))}
        {matchingIcons.length === 0 ? <p>{t("No icons found")}</p> : null}
      </div>
      <div className="role-icon-picker__upload">
        <label htmlFor={uploadId}>{t("Upload image")}</label>
        <input
          id={uploadId}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={!consent || busy}
          aria-describedby={hintId}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            cancelRead();
            if (!file || !consent || busy) return;
            const controller = new AbortController();
            pending.current = controller;
            setReading(true);
            setError(null);
            void readRoleIconFile(file, controller.signal)
              .then((dataUrl) => {
                if (pending.current === controller && !controller.signal.aborted)
                  setSelected({ kind: "image", dataUrl });
              })
              .catch((reason: unknown) => {
                if (pending.current === controller && !controller.signal.aborted)
                  setError(reason instanceof RoleIconUploadError ? reason.reason : "decode");
              })
              .finally(() => {
                if (pending.current === controller) {
                  pending.current = null;
                  setReading(false);
                }
              });
          }}
        />
        <p id={hintId}>
          {t("Upload limits")}
          {!consent ? <> {t("Upload consent")}</> : null}
        </p>
        {reading ? <p role="status">{t("Reading image")}</p> : null}
        {error ? (
          <p role="alert">
            {t(
              error === "format"
                ? "Upload format error"
                : error === "size"
                  ? "Upload size error"
                  : error === "pixels"
                    ? "Upload pixels error"
                    : "Upload decode error",
            )}
          </p>
        ) : null}
      </div>
      <footer className="role-icon-picker__actions">
        <button type="button" onClick={dismiss}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="primary-action"
          disabled={busy || reading}
          onClick={() => {
            cancelRead();
            onApply(selected);
          }}
        >
          {t("Use icon")}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
};

export const RoleIconFields = ({
  choices,
  images,
  consent,
  busy,
  labelPrefix,
  draftIdentity,
  onChange,
}: {
  readonly choices: PlayerRoleIconsInput;
  readonly images?: Readonly<Record<string, string>>;
  readonly consent: boolean;
  readonly busy: boolean;
  readonly labelPrefix: string;
  readonly draftIdentity?: object;
  readonly onChange: (role: PlayerIconRole, choice: PlayerRoleIconInput) => void;
}) => {
  const { t, locale } = useMessages(roleIconMessages);
  const [editing, setEditing] = useState<{
    role: PlayerIconRole;
    draftIdentity?: object;
  } | null>(null);
  // A refreshed profile invalidates the chooser before effects run, including
  // pending reads/decodes and selections made against the previous snapshot.
  const editingRole = editing?.draftIdentity === draftIdentity ? editing?.role : undefined;
  useEffect(() => {
    setEditing(null);
  }, [busy, draftIdentity]);
  return (
    <fieldset className="role-icon-fields" disabled={busy}>
      <legend>{t("Role icons")}</legend>
      <p>{t("Role icons guidance")}</p>
      <div className="role-icon-fields__roles">
        {PLAYER_ICON_ROLES.map((role) => {
          const choice = choices[role];
          const name =
            choice?.kind === "builtin"
              ? findRoleIcon(choice.id)?.names[locale]
              : choice
                ? t("Custom image")
                : t("Default icon");
          return (
            <button
              type="button"
              key={role}
              aria-label={t("Edit role icon", { player: labelPrefix, role: t(roleLabel[role]) })}
              onClick={() => setEditing({ role, draftIdentity })}
            >
              <span className="role-icon-fields__art">
                <RoleIconArtwork
                  choice={choice}
                  images={images}
                  fallback={<RoleDrawIcon role={role} />}
                />
              </span>
              <span>{t(roleLabel[role])}</span>
              <small>{name}</small>
            </button>
          );
        })}
      </div>
      {editingRole && !busy ? (
        <RoleIconPicker
          key={editingRole}
          role={editingRole}
          choice={choices[editingRole]}
          images={images}
          consent={consent}
          busy={busy}
          onCancel={() => setEditing(null)}
          onApply={(choice) => {
            onChange(editingRole, choice);
            setEditing(null);
          }}
        />
      ) : null}
    </fieldset>
  );
};
