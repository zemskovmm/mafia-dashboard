import { useId, useRef, useState } from "react";
import { applyGameEvent, countVotes, getCurrentVotingCandidateSeat } from "@mafia/game-domain";
import type { CanonicalGameEventDraft } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { GameTable } from "../table/GameTable.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import type { VotingStageProps } from "./VotingStage.js";
import { FederationBallotTools } from "./FederationBallotTools.js";
import "./FederationBallot.css";

export const FederationBallot = ({
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
  canResolve,
  onResolve,
}: VotingStageProps & { readonly canResolve: boolean; readonly onResolve: () => void }) => {
  const { t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const ballot = game.ballot;
  const toolsId = useId();
  const toolsButton = useRef<HTMLButtonElement>(null);
  const [toolsOpen, setToolsOpen] = useState(ballot?.dispute !== undefined);
  const dismissTools = () => {
    setToolsOpen(false);
    toolsButton.current?.focus();
  };
  if (ballot === undefined) return null;
  const liveSeat = getCurrentVotingCandidateSeat(game);
  const candidate = game.players.find(({ seat }) => seat === liveSeat)!;
  const totals = countVotes(game);
  const paused = ballot.dispute !== undefined;
  const open = ballot.mention === 2 && !ballot.stopped && !paused;
  const uncastCount = game.players.filter(
    (p) => p.status === "active" && game.voteAssignments[p.seat] === undefined,
  ).length;
  const earlyClose = canResolve && uncastCount > 0;
  const nextSeat = game.turnOrder[game.currentTurnIndex + 1];
  const submit = (event: CanonicalGameEventDraft) => {
    if (onAcceptedEvent !== undefined) onAcceptedEvent(event);
    else {
      onGameChange(applyGameEvent(game, event));
      onEvent(event.type, { ...event.payload });
    }
  };
  const advance = () => {
    if (nextSeat !== undefined && ballot.stopped && !paused)
      submit({ type: "voting.live-advanced", payload: { candidateSeat: nextSeat } });
  };
  return (
    <div className="federation-ballot-workspace">
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        onDismissSwipeAction={onDismissSwipeAction}
        seats={game.players.map((player) => ({
          ...player,
          name: displayName(player),
          votingHighlight: game.voteAssignments[player.seat] === ballot.selectedCandidateSeat,
          inactive: player.status !== "active",
          voteTargetSeat: game.voteAssignments[player.seat],
        }))}
        renderSeatActions={(seat) =>
          seat.status === "active" && onFoul !== undefined ? (
            <button
              type="button"
              aria-label={t("foulLabel", { name: seat.name })}
              onClick={() => onFoul(seat.seat)}
            >
              {t("foul")}
            </button>
          ) : null
        }
        seatActionDisabled={(seat) =>
          seat.status !== "active" || !open || game.voteAssignments[seat.seat] !== undefined
        }
        seatActionLabel={(seat) =>
          game.voteAssignments[seat.seat] !== undefined
            ? t("votedForSeat", { name: seat.name, seat: game.voteAssignments[seat.seat]! })
            : t("voteAs", { voter: seat.name, candidate: displayName(candidate) })
        }
        onSeatClick={(voterSeat) =>
          submit({ type: "vote.accepted", payload: { voterSeat, candidateSeat: liveSeat } })
        }
        center={
          <div className="table-vote-center" role="status" aria-label={t("liveCall")}>
            <span className="table-prompt">
              {t("liveCall")} {game.currentTurnIndex + 1}/{game.turnOrder.length}
            </span>
            <strong>
              #{liveSeat} {displayName(candidate)}
            </strong>
            <span>
              {t(
                paused
                  ? "pausedDispute"
                  : open
                    ? "acceptanceOpen"
                    : ballot.stopped
                      ? "countStopped"
                      : "waitingCall",
              )}
            </span>
            <span>
              {t("inspectedCandidate", { seat: ballot.selectedCandidateSeat })} ·{" "}
              {t("votes", { count: totals[ballot.selectedCandidateSeat] ?? 0 })}
            </span>
            <span>{t("uncastVotes", { count: uncastCount })}</span>
          </div>
        }
        advance={
          <div className="table-advance-options">
            {ballot.orderAnnouncements < 2 ? (
              <button
                type="button"
                disabled={paused}
                onClick={() => submit({ type: "voting.order-announced", payload: {} })}
              >
                {t("announceOrder", { current: ballot.orderAnnouncements + 1 })}
              </button>
            ) : ballot.mention < 2 ? (
              <button
                type="button"
                disabled={paused}
                onClick={() =>
                  submit({
                    type: "voting.candidate-mentioned",
                    payload: { candidateSeat: liveSeat },
                  })
                }
              >
                {t("mentionCandidate", { seat: liveSeat, current: ballot.mention + 1 })}
              </button>
            ) : !ballot.stopped ? (
              <button
                type="button"
                disabled={paused}
                onClick={() =>
                  submit({ type: "voting.candidate-stopped", payload: { candidateSeat: liveSeat } })
                }
              >
                {t("stopCandidate")}
              </button>
            ) : canResolve ? (
              <button type="button" onClick={onResolve}>
                {t(earlyClose ? "closeDetermined" : "resolveVoting")}
              </button>
            ) : nextSeat !== undefined ? (
              <button type="button" disabled={paused} onClick={advance}>
                {t("nextCandidate")}
              </button>
            ) : null}
          </div>
        }
      />
      <button
        ref={toolsButton}
        type="button"
        className="federation-ballot-tools-toggle"
        aria-label={t("ballotTools")}
        title={t("ballotTools")}
        aria-expanded={toolsOpen}
        aria-controls={toolsId}
        onClick={() => setToolsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && toolsOpen) {
            event.preventDefault();
            dismissTools();
          }
        }}
      >
        {t("ballotRulesLabel")}
      </button>
      <aside
        id={toolsId}
        className="federation-ballot-sheet"
        aria-label={t("ballotTools")}
        hidden={!toolsOpen}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            dismissTools();
          }
        }}
      >
        <button type="button" onClick={dismissTools}>
          {t("closeBallotTools")}
        </button>
        <div className="federation-stage-actions">
          {nextSeat !== undefined && (!ballot.stopped || canResolve) ? (
            <button type="button" disabled={!ballot.stopped || paused} onClick={advance}>
              {t("nextCandidate")}
            </button>
          ) : null}
          {!ballot.stopped || !canResolve ? (
            <button type="button" disabled={!canResolve} onClick={onResolve}>
              {t(earlyClose ? "closeDetermined" : "resolveVoting")}
            </button>
          ) : null}
        </div>
        <p>{t("orderedGuidance")}</p>
        <p>{t("noGenericSkip")}</p>
        {earlyClose ? <p className="federation-ballot-notice">{t("determinedGuidance")}</p> : null}
        <FederationBallotTools game={game} submit={submit} />
      </aside>
    </div>
  );
};
