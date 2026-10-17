import { applyGameEvent, countVotes } from "@mafia/game-domain";
import type { CanonicalGameEventDraft } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { GameTable } from "../table/GameTable.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import type { VotingStageProps } from "./VotingStage.js";

import "./FederationBallot.css";

export const FederationBallot = ({
  game,
  onAcceptedEvent,
  onGameChange,
  onEvent,
  onFoul,
  hostName,
  privacyHidden,
  onSeatPenalty,
  canResolve,
  onResolve,
}: VotingStageProps & { readonly canResolve: boolean; readonly onResolve: () => void }) => {
  const { t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const ballot = game.ballot;
  if (ballot === undefined) return null;
  const liveSeat = ballot.selectedCandidateSeat;
  const candidate = game.players.find(({ seat }) => seat === liveSeat)!;
  const totals = countVotes(game);
  const paused = ballot.dispute !== undefined;
  const open = !paused && !ballot.reviewedCandidateSeats.includes(liveSeat);

  const candidateIndex = game.turnOrder.indexOf(liveSeat);
  const nextSeat = game.turnOrder[candidateIndex + 1];
  const submit = (event: CanonicalGameEventDraft) => {
    if (onAcceptedEvent !== undefined) onAcceptedEvent(event);
    else {
      onGameChange(applyGameEvent(game, event));
      onEvent(event.type, { ...event.payload });
    }
  };
  const advance = () => {
    if (nextSeat !== undefined && !paused)
      submit({ type: "voting.candidate-selected", payload: { candidateSeat: nextSeat } });
  };
  return (
    <div className="federation-ballot-workspace">
      <GameTable
        animateActive
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatPenalty={onSeatPenalty}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          muted: player.mutePending,
          currentVoter: game.voteAssignments[player.seat] === ballot.selectedCandidateSeat,
          voted: game.voteAssignments[player.seat] !== undefined,
          inactive: player.status !== "active",
          voteTargetSeat: game.voteAssignments[player.seat],
        }))}
        onSeatFoul={onFoul}
        seatActionDisabled={(seat) =>
          seat.status !== "active" ||
          !open ||
          ballot.reviewedCandidateSeats.includes(game.voteAssignments[seat.seat] ?? -1)
        }
        seatActionLabel={(seat) =>
          game.voteAssignments[seat.seat] !== undefined
            ? t("votedForSeat", { name: seat.name, seat: game.voteAssignments[seat.seat]! })
            : t("voteAs", { voter: seat.name, candidate: displayName(candidate) })
        }
        onSeatClick={(voterSeat) =>
          submit({
            type: "vote.recorded",
            payload: {
              voterSeat,
              candidateSeat: game.voteAssignments[voterSeat] === liveSeat ? null : liveSeat,
            },
          })
        }
        center={
          <div className="table-vote-center" role="status" aria-label={t("candidateLabel")}>
            <span className="table-prompt">
              {t("candidate", { current: candidateIndex + 1, total: game.turnOrder.length })}
            </span>
            <strong className="voting-candidate-identity">
              #{liveSeat} {displayName(candidate)}
            </strong>
            <span>{t("votes", { count: totals[liveSeat] ?? 0 })}</span>
            {paused ? <span role="alert">{t("pausedDispute")}</span> : null}
          </div>
        }
        advance={
          <div className="table-advance-options">
            {nextSeat !== undefined ? (
              <button type="button" disabled={paused} onClick={advance}>
                {t("nextCandidate")}
              </button>
            ) : null}
            <button type="button" disabled={!canResolve} onClick={onResolve}>
              {t("resolveVoting")}
            </button>
          </div>
        }
      />
    </div>
  );
};
