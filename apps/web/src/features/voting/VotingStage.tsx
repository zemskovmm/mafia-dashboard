import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  acceptCarCrashBallot,
  advanceVotingCandidate,
  beginCarCrash,
  beginCarCrashDecision,
  beginNight,
  beginSkippedCarCrashDecision,
  completeCarCrashResult,
  countVotes,
  getCurrentVotingCandidateSeat,
  resolveCarCrashVote,
  resolveVote,
  skipVoting,
  toggleVote,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { GameTable, type TableSeatView } from "../table/GameTable.js";
import { usePlayerDisplayName } from "../players/player-display.js";

interface VotingStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onResolved: (game: GameState, seats: readonly number[]) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly swipeAction?: ReactNode;
  readonly onDismissSwipeAction?: () => void;
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
  onSeatSwipe,
  swipeAction,
  onDismissSwipeAction,
  onFoul,
}: VotingStageProps) => {
  const { formatList, t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const hostName = suppliedHostName ?? t("host");
  const [, setSelectedVoterSeat] = useState<number | null>(null);
  const resolutionSubmittedRef = useRef(false);
  useEffect(() => {
    if (game.phase !== "voting") resolutionSubmittedRef.current = false;
  }, [game.phase]);
  const totals = countVotes(game);
  const allVotesAssigned = (() => {
    if (game.phase !== "voting") return false;
    try {
      resolveVote(game);
      return true;
    } catch {
      return false;
    }
  })();

  const selectedCandidate = game.phase === "voting" ? getCurrentVotingCandidateSeat(game) : null;
  const selectedCandidateIndex = game.phase === "voting" ? game.currentTurnIndex : -1;
  const renderFoulAction = (seat: TableSeatView) =>
    seat.status === "active" && onFoul !== undefined ? (
      <button
        type="button"
        aria-label={t("foulLabel", { name: seat.name })}
        onClick={() => onFoul(seat.seat)}
      >
        {t("foul")}
      </button>
    ) : null;

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

  const skipVotingAsAcceptedState = () => {
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({
        type: "voting.skipped",
        payload: { reason: "host-skipped" },
      });
      return;
    }
    const next = skipVoting(game);
    onGameChange(next);
    onEvent("voting.skipped", { day: game.day, reason: "host-skipped" });
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
    if (result.kind === "car-crash") {
      onGameChange(beginCarCrash(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    if (result.kind === "eliminate-both-vote") {
      onGameChange(beginCarCrashDecision(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    if (result.kind === "eliminate-all-skipped") {
      onGameChange(beginSkippedCarCrashDecision(game, result.seats));
      onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
      return;
    }
    onResolved(game, result.seats);
    onEvent("voting.resolved", { kind: result.kind, seats: result.seats, totals: result.totals });
  };

  if (game.phase === "voting-cancelled") {
    const cancellationMessage =
      game.votingCancellation?.reason === "red-card" ? t("redCardCancelled") : t("hostSkipped");
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        onDismissSwipeAction={onDismissSwipeAction}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
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
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        onDismissSwipeAction={onDismissSwipeAction}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          current: game.carCrashSeats?.includes(player.seat),
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
        center={
          <div className="table-vote-center" role="status" aria-label={t("carCrashResult")}>
            <span className="table-prompt">{t("carCrash")}</span>
            <strong>{t("eliminateAllSkipped")}</strong>
            <span className="car-crash-skip-message">{t("skipMessage")}</span>
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
    const carCrashSeats = game.carCrashSeats ?? [];
    const nominees = formatList(
      carCrashSeats.map((seat) => {
        const player = game.players.find((candidate) => candidate.seat === seat);
        return player === undefined ? t("seat", { seat }) : displayName(player);
      }),
    );
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        onDismissSwipeAction={onDismissSwipeAction}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          current: game.carCrashSeats?.includes(player.seat),
          votingHighlight: game.carCrashVotes?.[player.seat] === true,
          inactive: player.status !== "active",
        }))}
        renderSeatActions={renderFoulAction}
        seatActionDisabled={(seat) => seat.status !== "active"}
        seatActionLabel={(seat) => {
          const selected = game.carCrashVotes?.[seat.seat] === true;
          return selected
            ? t("removeAllVote", { name: seat.name })
            : t("voteAsEliminateAll", { name: seat.name });
        }}
        onSeatClick={(voterSeat) => {
          const player = game.players.find(({ seat }) => seat === voterSeat);
          if (player?.status !== "active") return;
          const votes = { ...game.carCrashVotes };
          if (votes[voterSeat] === true) delete votes[voterSeat];
          else votes[voterSeat] = true;
          setSelectedVoterSeat(votes[voterSeat] === true ? voterSeat : null);
          onGameChange({ ...game, carCrashVotes: votes });
        }}
        center={
          <div className="table-vote-center" role="group" aria-label={t("carCrashDecision")}>
            <span className="table-prompt">{t("carCrash")}</span>
            <strong>{nominees}</strong>
            <span>{t("eliminateAllPlayers")}</span>
            <span>
              {t("votes", {
                count: Object.values(game.carCrashVotes ?? {}).filter(Boolean).length,
              })}
            </span>
          </div>
        }
        advance={
          <div className="table-advance-options">
            <button
              type="button"
              onClick={() => {
                const votes = Object.fromEntries(
                  game.players
                    .filter(({ status }) => status === "active")
                    .map(({ seat }) => [seat, game.carCrashVotes?.[seat] === true]),
                );
                const acceptedGame = { ...game, carCrashVotes: votes };
                const result = resolveCarCrashVote(acceptedGame);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "car-crash.ballot-resolved",
                    payload: { votes, result },
                  });
                } else {
                  onGameChange(acceptCarCrashBallot(acceptedGame));
                  onEvent("car-crash.ballot-resolved", {
                    votes,
                    eliminate: result.eliminate,
                    seats: result.seats,
                    yesVotes: result.yesVotes,
                    eligibleVoters: result.eligibleVoters,
                  });
                }
              }}
            >
              {t("resolveCarCrash")}
            </button>
            <button
              type="button"
              className="table-advance-secondary"
              onClick={skipVotingAsAcceptedState}
            >
              {t("skipVoting")}
            </button>
          </div>
        }
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
          current: result.seats.includes(player.seat),
          provisionalDeceased: result.eliminate && result.seats.includes(player.seat),
        }))}
        renderSeatActions={renderFoulAction}
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

  const candidate = game.players.find(({ seat }) => seat === selectedCandidate);
  return (
    <GameTable
      hostName={hostName}
      privacyHidden={privacyHidden}
      onSeatSwipe={onSeatSwipe}
      swipeAction={swipeAction}
      onDismissSwipeAction={onDismissSwipeAction}
      seats={game.players.map((player) => ({
        ...player,
        name: displayName(player),
        votingHighlight: game.voteAssignments[player.seat] === selectedCandidate,
        inactive: game.voteAssignments[player.seat] !== undefined || player.status !== "active",
        voteTargetSeat: game.voteAssignments[player.seat],
      }))}
      renderSeatActions={renderFoulAction}
      seatActionDisabled={(seat) => seat.status !== "active"}
      seatActionLabel={(seat) => {
        const assigned = game.voteAssignments[seat.seat];
        if (assigned !== undefined) return t("votedForSeat", { name: seat.name, seat: assigned });
        if (candidate === undefined) return t("seatWithName", { seat: seat.seat, name: seat.name });
        return t("voteAs", { voter: seat.name, candidate: displayName(candidate) });
      }}
      onSeatClick={(voterSeat) => {
        if (candidate === undefined) return;
        const removingVote = game.voteAssignments[voterSeat] === candidate.seat;
        const next = toggleVote(game, voterSeat, candidate.seat);
        setSelectedVoterSeat(removingVote ? null : voterSeat);
        onGameChange(next);
      }}
      center={
        <div className="table-vote-center" role="group" aria-label={t("candidateLabel")}>
          <span className="table-prompt">
            {t("candidate", {
              current: selectedCandidateIndex + 1,
              total: game.nominations.length,
            })}
          </span>
          <strong
            className={candidate === undefined ? undefined : "voting-candidate-identity"}
            tabIndex={candidate === undefined ? undefined : 0}
          >
            {candidate === undefined
              ? t("noCandidate")
              : `#${candidate.seat} ${displayName(candidate)}`}
          </strong>
          <span>
            {t("votes", {
              count: selectedCandidate === null ? 0 : (totals[selectedCandidate] ?? 0),
            })}
          </span>
        </div>
      }
      advance={
        <div className="table-advance-options">
          {selectedCandidateIndex >= 0 && selectedCandidateIndex < game.nominations.length - 1 ? (
            <button
              type="button"
              aria-label={t("nextCandidate")}
              onClick={() => {
                const next = advanceVotingCandidate(game);
                setSelectedVoterSeat(null);
                onGameChange(next);
              }}
            >
              {t("nextCandidate")}
            </button>
          ) : null}
          <button type="button" disabled={!allVotesAssigned} onClick={resolve}>
            {t("resolveVoting")}
          </button>
          <button
            type="button"
            className="table-advance-secondary"
            onClick={skipVotingAsAcceptedState}
          >
            {t("skipVoting")}
          </button>
        </div>
      }
    />
  );
};
