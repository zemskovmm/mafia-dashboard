import { useEffect, useRef } from "react";
import {
  applyGameEvent,
  beginNight,
  completeCarCrashResult,
  resolveVote,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { GameTable } from "../table/GameTable.js";
import { usePlayerDisplayName } from "../players/player-display.js";

import { FederationBallot } from "./FederationBallot.js";
import { FederationCollectiveBallot } from "./FederationCollectiveBallot.js";

export interface VotingStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onResolved: (game: GameState, seats: readonly number[]) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly onSeatPenalty?: (seat: number) => void;
  readonly onFoul?: (seat: number) => void;
}

export const VotingStage = ({
  game,
  onGameChange,
  onResolved,
  onEvent,
  onAcceptedEvent,
  hostName: suppliedHostName,
  privacyHidden = false,
  onSeatPenalty,
  onFoul,
}: VotingStageProps) => {
  const { formatList, t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const hostName = suppliedHostName ?? t("host");
  const resolutionSubmittedRef = useRef(false);
  useEffect(() => {
    if (game.phase !== "voting") resolutionSubmittedRef.current = false;
  }, [game.phase]);
  const allVotesAssigned = (() => {
    if (game.phase !== "voting") return false;
    try {
      resolveVote(game);
      return true;
    } catch {
      return false;
    }
  })();

  const beginNightFromAcceptedState = () => {
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({
        type: "phase.changed",
        payload: { to: "night-mafia" },
      });
      return;
    }
    const next = beginNight(game);
    onGameChange(next);
    onEvent("phase.changed", { from: game.phase, to: next.phase });
  };

  const resolve = () => {
    if (resolutionSubmittedRef.current || !allVotesAssigned) return;
    const result = resolveVote(game);
    resolutionSubmittedRef.current = true;
    if (onAcceptedEvent !== undefined) {
      const voteAssignments = Object.fromEntries(
        Object.entries(game.voteAssignments).flatMap(([seat, candidateSeat]) =>
          candidateSeat === undefined ? [] : [[Number(seat), candidateSeat]],
        ),
      );
      onAcceptedEvent({
        type: "voting.resolved",
        payload: { voteAssignments, result },
      });
      return;
    }
    const event: CanonicalGameEventDraft = {
      type: "voting.resolved",
      payload: {
        voteAssignments: Object.fromEntries(
          Object.entries(game.voteAssignments).filter(
            (entry): entry is [string, number] => entry[1] !== undefined,
          ),
        ),
        result,
      },
    };
    onGameChange(applyGameEvent(game, event));
    onEvent(event.type, event.payload);
  };

  if (game.phase === "voting") {
    return (
      <FederationBallot
        onSeatPenalty={onSeatPenalty}
        game={game}
        onGameChange={onGameChange}
        onResolved={onResolved}
        onEvent={onEvent}
        onAcceptedEvent={onAcceptedEvent}
        hostName={hostName}
        privacyHidden={privacyHidden}
        onFoul={onFoul}
        canResolve={allVotesAssigned}
        onResolve={resolve}
      />
    );
  }

  if (game.phase === "voting-cancelled") {
    const cancellationMessage = t("disciplinaryCancellation");
    return (
      <GameTable
        onSeatPenalty={onSeatPenalty}
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          muted: player.mutePending,
          inactive: player.status !== "active",
        }))}
        onSeatFoul={onFoul}
        center={
          <div className="table-vote-center" role="status" aria-label={t("votingCancelled")}>
            <span className="table-prompt">{t("voting")}</span>
            <strong>{t("votingCancelled")}</strong>
            <span className="voting-cancellation-message">{cancellationMessage}</span>
          </div>
        }
        advance={
          <button type="button" onClick={beginNightFromAcceptedState}>
            {t("beginNight")}
          </button>
        }
      />
    );
  }

  if (game.phase === "car-crash-skipped") {
    return (
      <GameTable
        onSeatPenalty={onSeatPenalty}
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          muted: player.mutePending,
          current: game.carCrashSeats?.includes(player.seat),
          inactive: player.status !== "active",
        }))}
        onSeatFoul={onFoul}
        center={
          <div
            className={"table-vote-center federation-skip-center"}
            role="status"
            aria-label={t("carCrashResult")}
          >
            <span className="table-prompt">{t("carCrash")}</span>
            <strong>{t("eliminateAllSkipped")}</strong>
            <span
              className={"car-crash-skip-message federation-skip-explanation"}
              role={"region"}
              aria-label={t("skipExplanation")}
            >
              {t(
                game.ballotSkipReason === "nine-three-restricted"
                  ? "nineThreeRestricted"
                  : game.ballotSkipReason === "zero-round-five"
                    ? "zeroRoundFive"
                    : "skipMessage",
              )}
            </span>
          </div>
        }
        advance={
          <button type="button" onClick={beginNightFromAcceptedState}>
            {t("beginNight")}
          </button>
        }
      />
    );
  }

  if (game.phase === "car-crash-decision") {
    return (
      <FederationCollectiveBallot
        onSeatPenalty={onSeatPenalty}
        game={game}
        onGameChange={onGameChange}
        onResolved={onResolved}
        onEvent={onEvent}
        onAcceptedEvent={onAcceptedEvent}
        onFoul={onFoul}
        hostName={hostName}
        privacyHidden={privacyHidden}
      />
    );
  }

  if (game.phase === "car-crash-result" && game.carCrashResult !== undefined) {
    const result = game.carCrashResult;
    const names = formatList(
      result.seats.map((seat) => {
        const player = game.players.find((candidate) => candidate.seat === seat);
        return player === undefined ? t("seat", { seat }) : displayName(player);
      }),
    );
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          muted: player.mutePending,
          current: result.seats.includes(player.seat),
          provisionalDeceased: result.eliminate && result.seats.includes(player.seat),
        }))}
        onSeatPenalty={onSeatPenalty}
        onSeatFoul={onFoul}
        center={
          <div className="table-vote-center" role="status" aria-label={t("carCrashResult")}>
            <span className="table-prompt">{t("carCrashResult")}</span>
            <strong>{result.eliminate ? t("eliminated") : t("playersStay")}</strong>
            <span>{names}</span>
            <span>
              {t("eliminateVotes", {
                yesVotes: result.yesVotes,
                eligibleVoters: result.eligibleVoters,
              })}
            </span>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = completeCarCrashResult(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "phase.changed",
                  payload: { to: next.phase },
                });
              } else {
                onGameChange(next);
                onEvent("phase.changed", { from: game.phase, to: next.phase });
              }
            }}
          >
            {t("continue")}
          </button>
        }
      />
    );
  }

  return null;
};
