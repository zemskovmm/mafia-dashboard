import { useEffect, useId, useRef, useState } from "react";
import type { ClubTournament } from "@mafia/game-domain";
import { createTournament, listTournaments } from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { tournamentMessages } from "../../i18n/messages/tournaments.js";
import { reportError } from "../console/error-console.js";
import "./tournaments.css";

export interface TournamentPickerProps {
  readonly clubId: string;
  readonly value: string | null;
  readonly onChange: (tournamentId: string | null) => void;
  readonly disabled?: boolean;
  readonly onValidityChange?: (valid: boolean) => void;
}

/** Parents additionally key by game when replacing a setup/history record. */
export const TournamentPicker = (props: TournamentPickerProps) => (
  <ClubTournamentPicker key={props.clubId} {...props} />
);

const ClubTournamentPicker = ({
  clubId,
  value,
  onChange,
  disabled = false,
  onValidityChange,
}: TournamentPickerProps) => {
  const { t } = useMessages(tournamentMessages);
  const id = useId();
  const [enabled, setEnabled] = useState(value !== null);
  const [tournaments, setTournaments] = useState<readonly ClubTournament[] | null>(null);
  const [listError, setListError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState(false);
  const createRequest = useRef(0);
  const restoreCreateFocus = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const included = enabled || value !== null;
  const valid = !included || value !== null;

  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);
  useEffect(() => {
    if (!included) return;
    let active = true;
    setListError(false);
    setTournaments(null);
    void listTournaments(clubId)
      .then((next) => {
        // A slower list may predate a creation acknowledged while it was loading.
        if (active)
          setTournaments((current) => [
            ...next,
            ...(current ?? []).filter((item) => !next.some(({ id }) => id === item.id)),
          ]);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "tournaments.list" });
        if (active) {
          setListError(true);
          setTournaments((current) => current ?? []);
        }
      });
    return () => {
      active = false;
    };
  }, [clubId, included, retry]);
  useEffect(() => {
    createRequest.current += 1;
    setBusy(false);
    return () => {
      createRequest.current += 1;
    };
  }, [disabled, value]);
  useEffect(() => {
    if (creating) nameRef.current?.focus();
    else if (restoreCreateFocus.current && !busy) {
      newButtonRef.current?.focus();
      restoreCreateFocus.current = false;
    }
  }, [creating, busy]);

  const cancelCreation = () => {
    createRequest.current += 1;
    restoreCreateFocus.current = true;
    setBusy(false);
    setCreating(false);
    setCreateError(false);
    setName("");
  };
  const create = async () => {
    const trimmed = name.trim();
    if (disabled || busy || trimmed.length === 0 || trimmed.length > 100) return;
    const request = ++createRequest.current;
    setBusy(true);
    setCreateError(false);
    try {
      const tournament = await createTournament(trimmed, clubId);
      if (createRequest.current !== request) return;
      restoreCreateFocus.current = true;
      setTournaments((current) => [
        ...(current ?? []).filter(({ id }) => id !== tournament.id),
        tournament,
      ]);
      setCreating(false);
      setName("");
      setEnabled(true);
      onChange(tournament.id);
    } catch (error: unknown) {
      reportError(error, { source: "api", context: "tournaments.create" });
      if (createRequest.current === request) setCreateError(true);
    } finally {
      if (createRequest.current === request) setBusy(false);
    }
  };

  return (
    <div className="tournament-picker">
      <label className="tournament-picker-toggle" htmlFor={`${id}-include`}>
        <input
          id={`${id}-include`}
          type="checkbox"
          checked={included}
          disabled={disabled}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setEnabled(checked);
            if (!checked) {
              cancelCreation();
              if (value !== null) onChange(null);
            }
          }}
        />
        <span>{t("include")}</span>
      </label>
      {included && (
        <div className="tournament-picker-fields">
          <label htmlFor={`${id}-selection`}>
            {t("tournament")}
            <select
              id={`${id}-selection`}
              value={value ?? ""}
              disabled={disabled || busy || tournaments === null}
              aria-invalid={!valid}
              aria-describedby={!valid ? `${id}-help` : undefined}
              onChange={(event) => {
                if (event.currentTarget.value !== "") onChange(event.currentTarget.value);
              }}
            >
              <option value="" disabled>
                {t("choose")}
              </option>
              {value !== null && !tournaments?.some(({ id }) => id === value) && (
                <option value={value}>{t("selected")}</option>
              )}
              {tournaments?.map((tournament) => (
                <option key={tournament.id} value={tournament.id}>
                  {tournament.name}
                </option>
              ))}
            </select>
          </label>
          {tournaments === null && <p role="status">{t("loading")}</p>}
          {listError && (
            <div>
              <p role="alert">{t("loadError")}</p>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => setRetry((count) => count + 1)}
              >
                {t("retry")}
              </button>
            </div>
          )}
          {!valid && <p id={`${id}-help`}>{t("chooseHelp")}</p>}
          <button
            ref={newButtonRef}
            type="button"
            disabled={disabled || busy || creating}
            onClick={() => {
              setCreating(true);
              setCreateError(false);
            }}
          >
            {t("new")}
          </button>
          {creating && (
            <div
              className="tournament-picker-create"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelCreation();
                }
              }}
            >
              <label htmlFor={`${id}-name`}>
                {t("name")}
                <input
                  ref={nameRef}
                  id={`${id}-name`}
                  value={name}
                  maxLength={100}
                  disabled={disabled || busy}
                  aria-describedby={`${id}-name-help`}
                  onChange={(event) => setName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      void create();
                    }
                  }}
                />
              </label>
              <p id={`${id}-name-help`}>{t("nameHelp")}</p>
              <div className="tournament-picker-actions">
                <button
                  type="button"
                  disabled={disabled || busy || name.trim().length === 0}
                  onClick={() => void create()}
                >
                  {t(busy ? "creating" : "create")}
                </button>
                <button type="button" disabled={disabled} onClick={cancelCreation}>
                  {t("cancel")}
                </button>
              </div>
              {createError && <p role="alert">{t("createError")}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
