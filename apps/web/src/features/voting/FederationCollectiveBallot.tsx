import { useId } from "react";
import {
  getCollectiveLiftEligibility,
  resolveCompletedCarCrashCount,
  acceptCompletedCarCrashCount,
} from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { GameTable } from "../table/GameTable.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import type { VotingStageProps } from "./VotingStage.js";
import "./FederationBallot.css";

export const FederationCollectiveBallot = ({
  game,
  onAcceptedEvent,
  onGameChange,
  onEvent,
  onFoul,
  hostName,
  privacyHidden,
  onSeatSwipe,
  swipeAction,
  onDismissSwipeAction,
}: VotingStageProps) => {
  const { t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const id = useId();
  const eligibility = getCollectiveLiftEligibility(game, game.carCrashSeats ?? []);
  const voters = game.players.filter((p) => p.status === "active");
  const votes = game.carCrashVotes ?? {};
  const yesVotes = Object.values(votes).filter((vote) => vote === true).length;
  const uncastCount = voters.filter((p) => votes[p.seat] === undefined).length;
  let canResolve = false;
  try {
    resolveCompletedCarCrashCount(game);
    canResolve = true;
  } catch {
    /* Completion still validates phase, eligibility and recorded voter inputs. */
  }
  const transcribe = (seat: number, value: string) => {
    if (!eligibility.permitted) return;
    const next = { ...votes };
    if (value === "unassigned") delete next[seat];
    else next[seat] = value === "yes";
    onGameChange({ ...game, carCrashVotes: next });
  };
  const resolve = () => {
    if (!canResolve) return;
    const result = resolveCompletedCarCrashCount(game);
    const acceptedVotes = Object.fromEntries(
      Object.entries(votes).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
    if (onAcceptedEvent !== undefined)
      onAcceptedEvent({
        type: "car-crash.count-completed",
        payload: { votes: acceptedVotes, result },
      });
    else {
      onGameChange(acceptCompletedCarCrashCount(game));
      onEvent("car-crash.count-completed", { votes, result });
    }
  };
  return (
    <div className="federation-ballot-workspace">
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        onDismissSwipeAction={onDismissSwipeAction}
        seats={game.players.map((p) => ({
          ...p,
          name: displayName(p),
          muted: p.mutePending,
          inactive: p.status !== "active",
          voted: votes[p.seat] !== undefined,
          votingHighlight: votes[p.seat] === true,
        }))}
        seatActionDisabled={(seat) => seat.status !== "active" || !eligibility.permitted}
        seatActionLabel={(seat) => t("voteAsEliminateAll", { name: seat.name })}
        onSeatClick={(seat) => transcribe(seat, votes[seat] === true ? "no" : "yes")}
        onSeatFoul={onFoul}
        center={
          <div className="table-vote-center" role="status" aria-label={t("carCrashDecision")}>
            <span className="table-prompt">{t("carCrash")}</span>
            <strong>{t("eliminateAllPlayers")}</strong>
            <span>{t("eliminateVotes", { yesVotes, eligibleVoters: voters.length })}</span>
            <span>{t("uncastVotes", { count: uncastCount })}</span>
          </div>
        }
        advance={
          <button type="button" disabled={!canResolve} onClick={resolve}>
            {t("resolveCarCrash")}
          </button>
        }
      />
      {!eligibility.permitted ? (
        <p role="alert">
          {t(
            eligibility.reason === "nine-three-restricted"
              ? "nineThreeRestricted"
              : eligibility.reason === "zero-round-five"
                ? "zeroRoundFive"
                : "skipMessage",
          )}
        </p>
      ) : null}
      <details className="federation-ballot-tools">
        <summary>{t("correction")}</summary>
        {voters.map((p) => (
          <div key={p.seat} className="federation-review-row">
            <label htmlFor={`${id}-vote-${p.seat}`}>
              {t("liftVote", { seat: p.seat })} · {displayName(p)}
            </label>
            <select
              id={`${id}-vote-${p.seat}`}
              disabled={!eligibility.permitted}
              value={votes[p.seat] === undefined ? "unassigned" : votes[p.seat] ? "yes" : "no"}
              onChange={(event) => transcribe(p.seat, event.target.value)}
            >
              <option value="unassigned">{t("unassigned")}</option>
              <option value="yes">{t("liftYes")}</option>
              <option value="no">{t("liftNo")}</option>
            </select>
          </div>
        ))}
      </details>
    </div>
  );
};
