import { useState } from "react";

import { tryApplyGameEvent } from "@mafia/game-domain";
import type {
  CanonicalGameEventDraft,
  GameState,
  RemovalObservation,
  RemovalOccurrenceStage,
} from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import {
  federationDisciplineMessages,
  removalRules,
} from "../../i18n/messages/federation-discipline.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { FederationBallotTools } from "../voting/FederationBallotTools.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import {
  defaultRemovalStage,
  hasImmediateRemovalAnnouncement,
  removalStagesForPhase,
} from "./federation-ui-state.js";
import { AdjudicationControls } from "./AdjudicationControls.js";
import { FederationJudgeDialog } from "./FederationJudgeDialog.js";
import { RuleBookButton } from "../rules/RuleBookButton.js";
import type { RuleReferenceId } from "../rules/rule-references.js";
import "./federation-controls.css";

export interface DisciplineRequest {
  readonly seat: number;
  readonly action: "foul" | "removal";
  readonly id: number;
  readonly game: GameState;
  readonly shortcut?: boolean;
}
interface DisciplineControlsProps {
  readonly game: GameState;
  readonly request: DisciplineRequest | null;
  readonly rulesOpen?: boolean;
  readonly privacyHidden?: boolean;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly onComplete?: () => void;
  readonly onOpenRule?: (rule: RuleReferenceId) => void;
  readonly readerOpen?: boolean;
}

export const FederationDisciplineControls = (props: DisciplineControlsProps) => {
  const { game, request, rulesOpen = false, readerOpen = false, onComplete } = props;
  const { t } = useMessages(federationDisciplineMessages);
  const { t: votingT } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const open = (!!request && request.game === game) || rulesOpen;
  const player = game.players.find((p) => p.seat === request?.seat);
  const pending = game.disciplinaryRemovals?.filter((r) => r.announcement === "pending") ?? [];
  const submit = (draft: CanonicalGameEventDraft) => {
    const result = tryApplyGameEvent(game, draft);
    if (!result.ok || readerOpen) return;
    if (props.onAcceptedEvent) props.onAcceptedEvent(draft);
    else {
      props.onGameChange(result.game);
      props.onEvent(draft.type, { ...draft.payload });
    }
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
                onClick={() => {
                  submit(draft);
                  onComplete?.();
                }}
              >
                {t("discipline.announce", { name: displayName(subject) })}
              </button>
            );
          })}
        </section>
      ) : null}
      {removalStagesForPhase(game.phase).length &&
      !["finished", "draw", "cancelled"].includes(game.phase) ? (
        <FederationJudgeDialog
          active={open}
          suspended={readerOpen}
          className="is-discipline"
          title={
            request?.shortcut && player
              ? t("discipline.playerTitle", { seat: player.seat, name: displayName(player) })
              : votingT("ballotRulesLabel")
          }
          closeLabel={t("discipline.close")}
          onDismiss={() => onComplete?.()}
        >
          <PenaltyForm key={request?.id ?? 0} {...props} />
          {game.phase === "voting" ? (
            <section aria-label={t("discipline.ballotTitle")}>
              <h2>{t("discipline.ballotTitle")}</h2>
              <FederationBallotTools
                key={game.ballot?.selectedCandidateSeat}
                game={game}
                submit={(draft) => {
                  if (open) submit(draft);
                }}
              />
            </section>
          ) : null}
        </FederationJudgeDialog>
      ) : null}
    </div>
  );
};

/** Only player-specific drafts reset for a new request; ballot review stays mounted. */
const PenaltyForm = ({
  game,
  request,
  privacyHidden = false,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  onComplete,
  onOpenRule,
  readerOpen = false,
}: DisciplineControlsProps) => {
  const { t } = useMessages(federationDisciplineMessages);
  const displayName = usePlayerDisplayName();
  const shortcut = request?.shortcut === true;
  const [seat, setSeat] = useState(
    request?.seat ?? game.players.find((p) => p.status === "active")?.seat ?? 1,
  );
  const [action, setAction] = useState<"foul" | "removal" | "opponent-victory">(
    request?.action ?? "removal",
  );
  const [stage, setStage] = useState<RemovalOccurrenceStage | "">(
    shortcut ? defaultRemovalStage(game.phase) : "",
  );
  const [rule, setRule] = useState("");
  const [reason, setReason] = useState("");
  const [checkInProgress, setCheckInProgress] = useState(false);
  const player = game.players.find((p) => p.seat === seat);
  const fourth = action === "foul" && player?.fouls === 3;
  const removal = action === "removal" || fourth;
  const stages = removalStagesForPhase(game.phase);
  const checkOwner =
    (stage === "don-check" && player?.role === "don" && game.phase === "night-don") ||
    (stage === "sheriff-check" && player?.role === "sheriff" && game.phase === "night-sheriff");
  const observation: RemovalObservation | null =
    stage && (fourth || rule)
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
  const submit = (draft: CanonicalGameEventDraft) => {
    const result = tryApplyGameEvent(game, draft);
    if (!result.ok) return;
    if (onAcceptedEvent) onAcceptedEvent(draft);
    else {
      onGameChange(result.game);
      onEvent(draft.type, { ...draft.payload });
    }
  };
  const accept = (draft: CanonicalGameEventDraft) => {
    if (readerOpen || (request && request.game !== game)) return;
    if (!tryApplyGameEvent(game, draft).ok) return;
    submit(draft);
    setReason("");
    setStage("");
    setCheckInProgress(false);
    onComplete?.();
  };
  return (
    <>
      {shortcut ? null : <h2>{t("discipline.title")}</h2>}
      <div className="federation-discipline-form">
        {!shortcut && (action !== "opponent-victory" || privacyHidden) ? (
          <label>
            {t("discipline.player")}
            <select
              value={seat}
              onChange={(e) => {
                setSeat(Number(e.target.value));
                setCheckInProgress(false);
              }}
            >
              {game.players.map((p) => (
                <option key={p.seat} value={p.seat}>
                  #{p.seat} · {displayName(p)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          {t("discipline.action")}
          <select value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            {shortcut ? null : <option value="foul">{t("discipline.foul")}</option>}
            <option value="removal">{t("discipline.removal")}</option>
            <option value="opponent-victory">{t("discipline.opponentVictory")}</option>
          </select>
        </label>
        {action === "opponent-victory" ? (
          <AdjudicationControls
            key={seat}
            game={game}
            embedded
            offenderSeat={shortcut || privacyHidden ? seat : undefined}
            privacyHidden={privacyHidden}
            onAcceptedEvent={accept}
            onOpenRule={onOpenRule}
          />
        ) : (
          <form
            className="federation-discipline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (event && legal) accept(event);
            }}
          >
            {removal ? (
              <>
                {shortcut && stage ? (
                  <p>
                    {t("discipline.stage")}: <strong>{t(`stage.${stage}`)}</strong>
                  </p>
                ) : (
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
                )}
                <div className="discipline-rule-picker">
                  <label>
                    {t("discipline.rule")}
                    <select
                      value={fourth ? "6.2.1" : rule}
                      disabled={fourth}
                      onChange={(e) => setRule(e.target.value)}
                    >
                      <option value="">{t("discipline.chooseRule")}</option>
                      {removalRules.map((value) => (
                        <option key={value} value={value}>
                          {value} · {t(`rule.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <RuleBookButton rule={fourth ? "6.2.1" : rule} onOpen={onOpenRule} />
                </div>
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
        )}
      </div>
    </>
  );
};
