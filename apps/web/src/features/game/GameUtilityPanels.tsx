import { useRef, type ReactNode } from "react";
import { countVotes } from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { TimerControls } from "../timer/TimerControls.js";
import { classifyPanelSwipe } from "./panel-swipe.js";

const PANEL_SWIPE_THRESHOLD = 44;

export interface GameUtilityPanelsProps {
  readonly game: GameState;
  readonly timerHidden: boolean;
  readonly votingHidden: boolean;
  readonly onTimerHiddenChange: (hidden: boolean) => void;
  readonly onVotingHiddenChange: (hidden: boolean) => void;
}

const DismissiblePanel = ({
  name,
  hidden,
  onHiddenChange,
  children,
}: {
  readonly name: "Timer" | "Voting";
  readonly hidden: boolean;
  readonly onHiddenChange: (hidden: boolean) => void;
  readonly children: ReactNode;
}) => {
  const touchStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const lowerName = name.toLowerCase();
  const handleClick = (nextHidden: boolean) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onHiddenChange(nextHidden);
  };

  return (
    <>
      <button
        type="button"
        className="utility-panel-restore"
        aria-label={`Show ${lowerName}`}
        hidden={!hidden}
        onClick={() => handleClick(false)}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          suppressNextClickRef.current = false;
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0];
          if (!touch || !touchStartRef.current) return;
          const start = touchStartRef.current;
          const end = {
            x: touch.clientX,
            y: touch.clientY,
          };
          suppressNextClickRef.current =
            Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) >= PANEL_SWIPE_THRESHOLD;
          const swipe = classifyPanelSwipe(start, end, PANEL_SWIPE_THRESHOLD);
          touchStartRef.current = null;
          if (swipe === "left") onHiddenChange(false);
        }}
      >
        Show {lowerName}
      </button>
      <div className="utility-panel-section" data-panel={lowerName} hidden={hidden}>
        <button
          type="button"
          className="panel-swipe-handle utility-panel-handle"
          aria-label={`${name} panel handle`}
          aria-expanded="true"
          onClick={() => handleClick(true)}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
            suppressNextClickRef.current = false;
          }}
          onTouchEnd={(event) => {
            const touch = event.changedTouches[0];
            if (!touch || !touchStartRef.current) return;
            const start = touchStartRef.current;
            const end = {
              x: touch.clientX,
              y: touch.clientY,
            };
            suppressNextClickRef.current =
              Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) >=
              PANEL_SWIPE_THRESHOLD;
            const swipe = classifyPanelSwipe(start, end, PANEL_SWIPE_THRESHOLD);
            touchStartRef.current = null;
            if (swipe === "right") onHiddenChange(true);
          }}
        >
          <span aria-hidden="true" />
        </button>
        {children}
      </div>
    </>
  );
};

export const GameUtilityPanels = ({
  game,
  timerHidden,
  votingHidden,
  onTimerHiddenChange,
  onVotingHiddenChange,
}: GameUtilityPanelsProps) => {
  const nominationTotals = countVotes(game);
  const activeSeats = game.players
    .filter(({ status }) => status === "active")
    .map(({ seat }) => seat);
  const tiedSeats = new Set(game.carCrashSeats ?? []);
  const skippedCarCrash =
    game.phase === "car-crash-skipped" ||
    (game.phase === "car-crash-decision" &&
      tiedSeats.size === activeSeats.length &&
      activeSeats.every((seat) => tiedSeats.has(seat)));
  const showVoteTotals =
    game.phase === "voting" ||
    game.phase === "voting-cancelled" ||
    game.phase === "car-crash" ||
    (game.phase === "car-crash-decision" && !skippedCarCrash) ||
    game.phase === "car-crash-result" ||
    game.phase === "goodbye-speech";
  const activeVoteCount =
    game.phase === "car-crash-decision" || game.phase === "car-crash-result"
      ? Object.keys(game.carCrashVotes ?? {}).length
      : Object.keys(game.voteAssignments).length;

  return (
    <>
      <DismissiblePanel name="Timer" hidden={timerHidden} onHiddenChange={onTimerHiddenChange}>
        <TimerControls />
      </DismissiblePanel>
      <DismissiblePanel name="Voting" hidden={votingHidden} onHiddenChange={onVotingHiddenChange}>
        <section className="nomination-panel" aria-label="Voting order">
          <p className="eyebrow">Voting order</p>
          {showVoteTotals ? (
            <p className="vote-count-summary">
              {activeVoteCount} active {activeVoteCount === 1 ? "vote" : "votes"}
            </p>
          ) : null}
          {game.nominations.length === 0 ? (
            <p className="muted">No nominations yet</p>
          ) : (
            <ol>
              {game.nominations.map(({ candidateSeat, nominatorSeat }) => {
                const candidate = game.players.find(({ seat }) => seat === candidateSeat);
                const nominator = game.players.find(({ seat }) => seat === nominatorSeat);
                return (
                  <li key={candidateSeat}>
                    <span className="nomination-copy">
                      <strong>
                        #{candidateSeat} {candidate?.name ?? `Seat ${candidateSeat}`}
                      </strong>
                      <span>
                        Initiated by #{nominatorSeat} {nominator?.name ?? `Seat ${nominatorSeat}`}
                      </span>
                    </span>
                    {showVoteTotals ? (
                      <span className="nomination-total">
                        {nominationTotals[candidateSeat] ?? 0}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </DismissiblePanel>
    </>
  );
};
