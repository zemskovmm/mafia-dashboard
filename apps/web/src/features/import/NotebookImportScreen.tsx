import { useEffect, useId, useRef, useState } from "react";
import { MAX_NOTEBOOK_DAYS, type NotebookGameCreation } from "@mafia/game-domain";
import {
  ApiError,
  createGameSession,
  getGameSession,
  type RemoteGameSession,
} from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { notebookMessages } from "../../i18n/messages/notebook.js";
import { NotebookRecordView } from "./NotebookRecordView.js";
import { readNotebookRecord } from "./notebook-import.js";
import {
  buildNotebookCreation,
  cellKey,
  createNotebookDraft,
  type NotebookDraft,
  type NotebookErrors,
  type NotebookPlayer,
  type NotebookRowDraft,
} from "./notebook-model.js";
import "./notebook.css";

export interface NotebookImportScreenProps {
  readonly clubId: string;
  readonly players: readonly { readonly id: string; readonly nickname: string }[];
  readonly onBack: () => void;
  readonly onSaved?: (session: RemoteGameSession) => void;
}

/** Club changes also reset request ownership when the caller omits a key. */
export const NotebookImportScreen = (props: NotebookImportScreenProps) => (
  <ClubNotebookImport key={props.clubId} {...props} />
);

// Compare only the submitted, bounded JSON tree, independent of object key order.
// Added defaults are mismatches too: unknown is not null, zero or an alive status.
const sameJsonValue = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => sameJsonValue(actual[index], value))
    );
  if (
    expected === null ||
    typeof expected !== "object" ||
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  )
    return false;
  const left = actual as Record<string, unknown>;
  const right = expected as Record<string, unknown>;
  const keys = Object.keys(right);
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => Object.hasOwn(left, key) && sameJsonValue(left[key], right[key]))
  );
};
const matchesReadback = (
  session: RemoteGameSession,
  gameId: string,
  payload: NotebookGameCreation,
): boolean =>
  session.gameId === gameId &&
  session.status === "completed" &&
  session.name === payload.name &&
  readNotebookRecord(session.state?.notebook) !== null &&
  sameJsonValue(session.state, payload.state) &&
  sameJsonValue(session.results, payload.results);

const ClubNotebookImport = ({ clubId, players, onBack, onSaved }: NotebookImportScreenProps) => {
  const { t, formatDateTime } = useMessages(notebookMessages);
  const id = useId();
  const [draft, setDraft] = useState(createNotebookDraft);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<NotebookErrors>({});
  const [review, setReview] = useState<NotebookGameCreation | null>(null);
  const [saved, setSaved] = useState<RemoteGameSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<"uncertain" | "rejected" | null>(null);
  const frozen = useRef<NotebookGameCreation | null>(null);
  const inFlight = useRef(false);
  const active = useRef(false);
  const knownGameId = useRef<string | null>(null);
  const previouslyUncertain = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty || saved !== null) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saved]);

  const playerName = (playerId: string) =>
    players.find((player) => player.id === playerId)?.nickname ?? t("unknown");
  const update = (change: Partial<NotebookDraft>) => {
    if (inFlight.current || frozen.current !== null) return;
    setDraft((current) => ({ ...current, ...change }));
    setDirty(true);
    setFailure(null);
  };
  const updateRow = (index: number, change: Partial<NotebookRowDraft>) =>
    update({
      rows: draft.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...change } : row)),
    });
  const leave = () => {
    if (!dirty || saved !== null || window.confirm(t("leave"))) onBack();
  };
  const error = (key: string) =>
    errors[key] === undefined ? null : (
      <p className="notebook-error" id={`${id}-${key}-error`}>
        {t(errors[key])}
      </p>
    );
  const errorProps = (key: string) => ({
    "aria-invalid": errors[key] !== undefined,
    "aria-describedby": errors[key] === undefined ? undefined : `${id}-${key}-error`,
  });
  const choices = (items: readonly NotebookPlayer[] = players) => (
    <>
      <option value="">{t("unknown")}</option>
      {items.map((player) => (
        <option key={player.id} value={player.id}>
          {player.nickname}
        </option>
      ))}
    </>
  );
  const seatOptions = (
    <>
      <option value="">{t("unknown")}</option>
      {Array.from({ length: 10 }, (_, index) => (
        <option key={index} value={String(index + 1)}>
          {index + 1}
        </option>
      ))}
    </>
  );

  const reviewDraft = () => {
    const result = buildNotebookCreation(draft, players, crypto.randomUUID());
    setErrors(result.errors);
    if (result.payload !== null) {
      setReview(result.payload);
      setFailure(null);
    }
  };
  const submit = async () => {
    if (inFlight.current || review === null) return;
    const payload = frozen.current ?? review;
    frozen.current = payload;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    let posted = false;
    let confirmed: RemoteGameSession | null = null;
    try {
      const created = await createGameSession(payload, clubId);
      posted = true;
      if (!active.current) return;
      if (
        typeof created.gameId !== "string" ||
        created.gameId.length === 0 ||
        created.status !== "completed" ||
        (knownGameId.current !== null && knownGameId.current !== created.gameId)
      )
        throw new Error("Unconfirmed notebook identity");
      knownGameId.current = created.gameId;
      const readback = await getGameSession(created.gameId, clubId);
      if (!active.current) return;
      if (!matchesReadback(readback, created.gameId, payload))
        throw new Error("Unconfirmed notebook readback");
      confirmed = readback;
      setSaved(readback);
      setDirty(false);
    } catch (cause: unknown) {
      if (!active.current) return;
      // A read-back failure never unlocks an already-created request. Nor does
      // a timeout/rate-limit response prove that creation did not commit.
      const rejected =
        !posted &&
        !previouslyUncertain.current &&
        knownGameId.current === null &&
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408 &&
        cause.status !== 429;
      if (rejected) {
        frozen.current = null;
        setReview(null);
      } else previouslyUncertain.current = true;
      setFailure(rejected ? "rejected" : "uncertain");
    } finally {
      if (active.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
    if (confirmed !== null && active.current) onSaved?.(confirmed);
  };

  const facts = (payload: NotebookGameCreation) => (
    <dl className="notebook-facts">
      <div>
        <dt>{t("title")}</dt>
        <dd>{payload.name}</dd>
      </div>
      <div>
        <dt>{t("host")}</dt>
        <dd>
          {payload.results.hostPlayerId === undefined
            ? t("unknown")
            : playerName(payload.results.hostPlayerId)}
        </dd>
      </div>
      <div>
        <dt>{t("playedAt")}</dt>
        <dd>
          {payload.results.playedAt === undefined
            ? t("unknown")
            : formatDateTime(payload.results.playedAt)}
        </dd>
      </div>
      <div>
        <dt>{t("outcome")}</dt>
        <dd>{payload.results.outcome === undefined ? t("unknown") : t(payload.results.outcome)}</dd>
      </div>
    </dl>
  );

  if (review !== null) {
    const notebook =
      saved === null ? review.state.notebook : readNotebookRecord(saved.state.notebook);
    return (
      <main className="notebook-import" aria-label={t("importGame")}>
        <div className="notebook-panel glass-surface">
          <header className="notebook-heading">
            <h1>{t(saved === null ? "reviewTitle" : "success")}</h1>
            <button type="button" onClick={leave}>
              {t("back")}
            </button>
          </header>
          {saved === null ? <p>{t("reviewHelp")}</p> : <p role="status">{t("success")}</p>}
          {facts(review)}
          {notebook !== null && (
            <NotebookRecordView
              notebook={notebook}
              participants={saved?.results?.players ?? review.results.players}
              playerName={playerName}
            />
          )}
          {failure !== null && (
            <p role="alert" className="notebook-error">
              {t(failure)}
            </p>
          )}
          <div className="notebook-actions">
            {saved !== null ? (
              <button
                type="button"
                onClick={() => {
                  frozen.current = null;
                  knownGameId.current = null;
                  previouslyUncertain.current = false;
                  setReview(null);
                  setSaved(null);
                  setDraft(createNotebookDraft());
                  setErrors({});
                  setFailure(null);
                }}
              >
                {t("another")}
              </button>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => void submit()}>
                  {t(busy ? "saving" : frozen.current === null ? "save" : "retry")}
                </button>
                <button
                  type="button"
                  disabled={busy || frozen.current !== null}
                  onClick={() => setReview(null)}
                >
                  {t("edit")}
                </button>
              </>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="notebook-import" aria-label={t("importGame")}>
      <form
        className="notebook-panel glass-surface"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          reviewDraft();
        }}
      >
        <header className="notebook-heading">
          <h1>{t("importGame")}</h1>
          <button type="button" onClick={leave}>
            {t("back")}
          </button>
        </header>
        <p>{t("intro")}</p>
        <label className="notebook-field" htmlFor={`${id}-name`}>
          {t("title")}
          <input
            id={`${id}-name`}
            required
            maxLength={100}
            value={draft.name}
            {...errorProps("name")}
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        </label>
        {error("name")}
        <fieldset className="notebook-metadata">
          <legend>{t("optional")}</legend>
          <label className="notebook-field">
            {t("playedAt")}
            <input
              type="datetime-local"
              value={draft.playedAt}
              {...errorProps("playedAt")}
              onChange={(event) => update({ playedAt: event.currentTarget.value })}
            />
            {error("playedAt")}
          </label>
          <label className="notebook-field">
            {t("host")}
            <select
              value={draft.hostPlayerId}
              {...errorProps("host")}
              onChange={(event) => update({ hostPlayerId: event.currentTarget.value })}
            >
              {choices()}
            </select>
            {error("host")}
          </label>
          <label className="notebook-field">
            {t("outcome")}
            <select
              value={draft.outcome}
              onChange={(event) =>
                update({ outcome: event.currentTarget.value as NotebookDraft["outcome"] })
              }
            >
              <option value="">{t("unknown")}</option>
              {(["red", "black", "draw", "cancelled"] as const).map((outcome) => (
                <option key={outcome} value={outcome}>
                  {t(outcome)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className="notebook-help" id={`${id}-notation`}>
          {t("notation")}
        </p>
        <p className="notebook-help">{t("legend")}</p>
        <p className="notebook-help">{t("scroll")}</p>
        {error("roster")}
        <div className="notebook-table-scroll" role="region" aria-label={t("entryTable")}>
          <table className="notebook-table notebook-table--entry" aria-label={t("entryTable")}>
            <thead>
              <tr>
                <th scope="col" className="notebook-player-column">
                  {t("player")}
                </th>
                <th scope="col">{t("role")}</th>
                {Array.from({ length: draft.dayCount * 2 }, (_, column) => (
                  <th scope="col" key={column}>
                    {t(column % 2 === 0 ? "day" : "night", { day: Math.floor(column / 2) + 1 })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((row, index) => {
                const seat = index + 1;
                return (
                  <tr key={seat}>
                    <th scope="row" className="notebook-player-column">
                      <span className="notebook-seat">{t("seat", { seat })}</span>
                      <select
                        aria-label={t("playerSeat", { seat })}
                        value={row.playerId}
                        {...errorProps(`player-${seat}`)}
                        onChange={(event) =>
                          updateRow(index, { playerId: event.currentTarget.value })
                        }
                      >
                        {choices()}
                      </select>
                      {error(`player-${seat}`)}
                    </th>
                    <td>
                      <select
                        aria-label={t("roleSeat", { seat })}
                        value={row.role}
                        onChange={(event) =>
                          updateRow(index, {
                            role: event.currentTarget.value as NotebookRowDraft["role"],
                          })
                        }
                      >
                        <option value="">{t("unknown")}</option>
                        {(["citizen", "mafia", "don", "sheriff"] as const).map((role) => (
                          <option key={role} value={role}>
                            {t(role)}
                          </option>
                        ))}
                      </select>
                    </td>
                    {Array.from({ length: draft.dayCount * 2 }, (_, column) => {
                      const key = cellKey(seat, column);
                      return (
                        <td
                          key={column}
                          className={column % 2 === 1 ? "notebook-night" : undefined}
                        >
                          <input
                            aria-label={t(column % 2 === 0 ? "dayCell" : "nightCell", {
                              seat,
                              day: Math.floor(column / 2) + 1,
                            })}
                            aria-describedby={
                              errors[key] === undefined ? `${id}-notation` : `${id}-${key}-error`
                            }
                            aria-invalid={errors[key] !== undefined}
                            value={row.cells[column] ?? ""}
                            maxLength={16}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) =>
                              updateRow(index, {
                                cells: row.cells.map((text, cellIndex) =>
                                  cellIndex === column ? event.currentTarget.value : text,
                                ),
                              })
                            }
                          />
                          {error(key)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="notebook-actions">
          <button
            type="button"
            disabled={draft.dayCount >= MAX_NOTEBOOK_DAYS}
            onClick={() =>
              update({
                dayCount: draft.dayCount + 1,
                rows: draft.rows.map((row) => ({ ...row, cells: [...row.cells, "", ""] })),
              })
            }
          >
            {t("addDay")}
          </button>
          <small>{t("daysLimit")}</small>
        </div>
        {error("days")}
        <fieldset className="notebook-best">
          <legend>{t("bestMove")}</legend>
          <p className="notebook-help">{t("bestHelp")}</p>
          <div className="notebook-best-fields">
            <label className="notebook-field">
              {t("bestOwner")}
              <select
                value={draft.bestMoveOwner}
                onChange={(event) => update({ bestMoveOwner: event.currentTarget.value })}
              >
                {seatOptions}
              </select>
            </label>
            {draft.bestMoveTargets.map((target, index) => (
              <label className="notebook-field" key={index}>
                {t("bestTarget", { number: index + 1 })}
                <select
                  value={target}
                  {...errorProps("bestMove")}
                  onChange={(event) =>
                    update({
                      bestMoveTargets: draft.bestMoveTargets.map((value, targetIndex) =>
                        targetIndex === index ? event.currentTarget.value : value,
                      ),
                    })
                  }
                >
                  {seatOptions}
                </select>
              </label>
            ))}
          </div>
          {error("bestMove")}
        </fieldset>
        {Object.keys(errors).length > 0 && (
          <p role="alert" className="notebook-error">
            {t("validation")}
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="notebook-error">
            {t(failure)}
          </p>
        )}
        <div className="notebook-actions">
          <button type="submit">{t("review")}</button>
        </div>
      </form>
    </main>
  );
};
