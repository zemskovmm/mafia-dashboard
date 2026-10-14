import { useState } from "react";
import { tryApplyGameEvent } from "@mafia/game-domain";
import type {
  CanonicalGameEventDraft,
  GameState,
  RemovalObservation,
  RemovalOccurrenceStage,
} from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { federationDisciplineMessages } from "../../i18n/messages/federation-discipline.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import { hasImmediateRemovalAnnouncement, removalStagesForPhase } from "./federation-ui-state.js";
import { FederationJudgeDialog } from "./FederationJudgeDialog.js";
import "./federation-controls.css";

export interface DisciplineRequest {
  readonly seat: number;
  readonly action: "foul" | "removal";
  readonly id: number;
}
export const FederationDisciplineControls = ({
  game,
  request,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  onComplete,
}: {
  readonly game: GameState;
  readonly request: DisciplineRequest | null;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly onComplete?: () => void;
}) => {
  const { t } = useMessages(federationDisciplineMessages);
  const displayName = usePlayerDisplayName();
  const [open, setOpen] = useState(!!request);
  const [seat, setSeat] = useState(
    request?.seat ?? game.players.find((p) => p.status === "active")?.seat ?? 1,
  );
  const [action, setAction] = useState<"foul" | "removal">(request?.action ?? "removal");
  const [stage, setStage] = useState<RemovalOccurrenceStage | "">("");
  const [rule, setRule] = useState("");
  const [reason, setReason] = useState("");
  const [checkInProgress, setCheckInProgress] = useState(false);
  const player = game.players.find((p) => p.seat === seat);
  const fourth = action === "foul" && player?.fouls === 3;
  const removal = action === "removal" || fourth;
  const stages = removalStagesForPhase(game.phase);
  const pending = game.disciplinaryRemovals?.filter((r) => r.announcement === "pending") ?? [];
  const checkOwner =
    (stage === "don-check" && player?.role === "don" && game.phase === "night-don") ||
    (stage === "sheriff-check" && player?.role === "sheriff" && game.phase === "night-sheriff");
  const observation: RemovalObservation | null =
    stage && reason.trim() && (fourth || rule)
      ? {
          seat,
          stage,
          rule: fourth ? "6.2.1" : rule,
          reason: reason.trim(),
          checkInProgress: !!checkOwner && checkInProgress,
        }
      : null;
  const event: CanonicalGameEventDraft | null = !removal
    ? {
        type: "foul.issued",
        payload: {
          seat,
          foulNumber: (player?.fouls ?? 0) + 1,
          redCarded: false,
          phase: game.phase,
          currentTurnIndex: game.currentTurnIndex,
        },
      }
    : observation
      ? fourth
        ? {
            type: "discipline.foul-issued",
            payload: { seat, foulNumber: 4, redCarded: true, removal: observation },
          }
        : { type: "discipline.removal-observed", payload: observation }
      : null;
  const legal = event ? tryApplyGameEvent(game, event).ok : false;
  const accept = (draft: CanonicalGameEventDraft) => {
    const result = tryApplyGameEvent(game, draft);
    if (!result.ok) return;
    if (onAcceptedEvent) onAcceptedEvent(draft);
    else {
      onGameChange(result.game);
      onEvent(draft.type, { ...draft.payload });
    }
    setOpen(false);
    setReason("");
    setStage("");
    setCheckInProgress(false);
    onComplete?.();
  };
  return (
    <div className="federation-discipline">
      {pending.length ? (
        <section className="federation-announcements" aria-label={t("discipline.pending")}>
          {hasImmediateRemovalAnnouncement(game) ? (
            <small role="status">{t("discipline.blocked")}</small>
          ) : null}
          {pending.map((r) => {
            const subject = game.players.find((p) => p.seat === r.seat)!;
            const draft: CanonicalGameEventDraft = {
              type: "discipline.removals-announced",
              payload: { seats: [r.seat] },
            };
            const available = tryApplyGameEvent(game, draft).ok;
            return (
              <button
                key={r.seat}
                type="button"
                disabled={!available}
                title={available ? undefined : t("discipline.wait")}
                onClick={() => accept(draft)}
              >
                {t("discipline.announce", { name: displayName(subject) })}
              </button>
            );
          })}
        </section>
      ) : null}
      {stages.length ? (
        <button type="button" onClick={() => setOpen(true)}>
          {t("discipline.title")}
        </button>
      ) : null}
      {stages.length && open ? (
        <FederationJudgeDialog
          title={t("discipline.title")}
          closeLabel={t("discipline.close")}
          onDismiss={() => {
            setOpen(false);
            onComplete?.();
          }}
        >
          <form
            className="federation-discipline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (event && legal) accept(event);
            }}
          >
            <p>{t("discipline.reference")}</p>
            <label>
              {t("discipline.player")}
              <select
                value={seat}
                onChange={(e) => {
                  setSeat(Number(e.target.value));
                  setCheckInProgress(false);
                }}
              >
                {game.players
                  .filter(
                    (p) =>
                      p.status === "active" ||
                      (p.status === "eliminated" &&
                        (game.goodbyeSeats?.includes(p.seat) ||
                          (game.nightResult?.kind === "kill" &&
                            game.nightResult.targetSeat === p.seat) ||
                          (game.carCrashResult?.eliminate &&
                            game.carCrashResult.seats.includes(p.seat)))),
                  )
                  .map((p) => (
                    <option key={p.seat} value={p.seat}>
                      #{p.seat} · {displayName(p)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("discipline.action")}
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as "foul" | "removal")}
              >
                <option value="foul">{t("discipline.foul")}</option>
                <option value="removal">{t("discipline.removal")}</option>
              </select>
            </label>
            {removal ? (
              <>
                <label>
                  {t("discipline.stage")}
                  <select
                    value={stage}
                    onChange={(e) => {
                      setStage(e.target.value as RemovalOccurrenceStage | "");
                      setCheckInProgress(false);
                    }}
                  >
                    <option value="">{t("discipline.chooseStage")}</option>
                    {stages.map((value) => (
                      <option key={value} value={value}>
                        {t(`stage.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("discipline.rule")}
                  <select
                    value={fourth ? "6.2.1" : rule}
                    disabled={fourth}
                    onChange={(e) => setRule(e.target.value)}
                  >
                    <option value="">{t("discipline.chooseRule")}</option>
                    {Array.from({ length: 13 }, (_, i) => `6.2.${i + 1}`).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("discipline.reason")}
                  <input
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                {checkOwner ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={checkInProgress}
                      onChange={(e) => setCheckInProgress(e.target.checked)}
                    />
                    {t("discipline.underway")}
                  </label>
                ) : null}
              </>
            ) : null}
            <button type="submit" disabled={!legal}>
              {t("discipline.confirm")}
            </button>
          </form>
        </FederationJudgeDialog>
      ) : null}
    </div>
  );
};
