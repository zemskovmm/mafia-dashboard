import type { ReactNode } from "react";
import {
  completeMafiaShots,
  completeNight,
  continueDonCheck,
  continueSheriffCheck,
  getMafiaShotResult,
  performDonCheck,
  performSheriffCheck,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
  toggleMafiaShot,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState, NightShotResult } from "@mafia/game-domain";
import { GameTable } from "../table/GameTable.js";

interface NightStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly swipeAction?: ReactNode;
}

export const NightStage = ({
  game,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  hostName = "Host",
  privacyHidden = false,
  onSeatSwipe,
  swipeAction,
}: NightStageProps) => {
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const hasActiveDon = activePlayers.some(({ role }) => role === "don");
  const hasActiveSheriff = activePlayers.some(({ role }) => role === "sheriff");
  const skipDon = () => {
    const next = skipDonCheck(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "don.check-skipped", payload: {}, secret: true });
    } else {
      onGameChange(next);
      onEvent("don.check-skipped", { day: game.day });
    }
  };
  const skipSheriff = () => {
    const next = skipSheriffCheck(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "sheriff.check-skipped", payload: {}, secret: true });
    } else {
      onGameChange(next);
      onEvent("sheriff.check-skipped", { day: game.day });
    }
  };

  if (game.phase === "night-mafia") {
    const shooters = activePlayers
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const allShotsRecorded = shooters.every(({ seat }) => game.shotAssignments[seat] !== undefined);
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.team === "black",
        }))}
        seatActionLabel={(seat) =>
          shooters.every(({ seat: shooterSeat }) => game.shotAssignments[shooterSeat] === seat.seat)
            ? `Remove all Mafia shots from ${seat.name}`
            : `Assign all Mafia shots to ${seat.name}`
        }
        onSeatClick={(targetSeat) => onGameChange(toggleAllMafiaShotsForTarget(game, targetSeat))}
        renderSeatActions={(target) =>
          shooters.map((shooter) => {
            const assignedTarget = game.shotAssignments[shooter.seat];
            const selected = assignedTarget === target.seat;
            return (
              <button
                type="button"
                key={shooter.seat}
                className={`shooter-button${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                aria-label={`${selected ? "Remove" : "Assign"} shooter ${shooter.seat} ${
                  selected ? "from" : "to"
                } target ${target.name}`}
                onClick={() => {
                  onGameChange(toggleMafiaShot(game, shooter.seat, target.seat));
                }}
              >
                #{shooter.seat}
              </button>
            );
          })
        }
        center={
          <div className="table-night-center">
            <span className="table-prompt">Mafia shots</span>
            <strong>
              {Object.keys(game.shotAssignments).length} of {shooters.length} shooters assigned
            </strong>
          </div>
        }
        advance={
          <button
            type="button"
            disabled={!allShotsRecorded}
            onClick={() => {
              const resolution = resolveMafiaShots(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "mafia.shots-resolved",
                  payload: { shots: resolution.secretShots, result: resolution.result },
                  secret: true,
                });
              } else {
                onEvent("mafia.shots-resolved", {
                  shots: resolution.secretShots,
                  result: resolution.result,
                  day: game.day,
                });
                onGameChange(resolution.game);
              }
            }}
          >
            Evaluate Mafia shots
          </button>
        }
      />
    );
  }

  if (game.phase === "night-mafia-result") {
    const result = getMafiaShotResult(game);
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.team === "black" && game.shotAssignments[player.seat] !== undefined,
          provisionalDeceased: result.kind === "kill" && player.seat === result.targetSeat,
        }))}
        center={
          <div className="table-night-center">
            <MafiaShotResultCard game={game} result={result} />
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = completeMafiaShots(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "phase.changed",
                  payload: { to: next.phase },
                  secret: false,
                });
              } else {
                onGameChange(next);
              }
            }}
          >
            Continue night
          </button>
        }
      />
    );
  }

  if (game.phase === "night-don") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={hasActiveDon ? onSeatSwipe : undefined}
        swipeAction={hasActiveDon ? swipeAction : undefined}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.role === "don",
        }))}
        seatActionLabel={hasActiveDon ? (seat) => `Don check ${seat.name}` : undefined}
        seatActionDisabled={hasActiveDon ? undefined : () => true}
        onSeatClick={
          hasActiveDon
            ? (targetSeat) => {
                const check = performDonCheck(game, targetSeat);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "don.checked",
                    payload: { targetSeat, match: check.result.match },
                    secret: true,
                  });
                } else {
                  onGameChange(check.game);
                  onEvent("don.checked", { ...check.result });
                }
              }
            : undefined
        }
        center={
          <div className="table-check-center">
            <span className="table-prompt">Don check</span>
            <strong>Select a player to check for Sheriff</strong>
          </div>
        }
        advance={
          hasActiveDon ? (
            <div className="table-advance-options">
              <button type="button" disabled>
                Select a player to continue
              </button>
              <button type="button" className="table-advance-secondary" onClick={skipDon}>
                Skip Don check
              </button>
            </div>
          ) : (
            <button type="button" className="table-advance-secondary" onClick={skipDon}>
              Skip Don check
            </button>
          )
        }
      />
    );
  }

  if (game.phase === "night-don-result" && game.checkResult?.kind === "don-check") {
    const target = game.players.find(({ seat }) => seat === game.checkResult?.targetSeat);
    const hasSheriff = game.players.some(({ role }) => role === "sheriff");
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.role === "don",
          current: player.seat === game.checkResult?.targetSeat,
        }))}
        center={
          <div className="table-check-center" role="status" aria-label="Don check result">
            <span className="table-prompt">Don checked {target?.name ?? "player"}</span>
            <div className="secret-result">
              {game.checkResult.match ? "Sheriff found" : "Not the Sheriff"}
            </div>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = continueDonCheck(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "phase.changed",
                  payload: { to: next.phase },
                  secret: false,
                });
              } else onGameChange(next);
            }}
          >
            {hasSheriff ? "Proceed to Sheriff check" : "Continue night"}
          </button>
        }
      />
    );
  }

  if (game.phase === "night-sheriff") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={hasActiveSheriff ? onSeatSwipe : undefined}
        swipeAction={hasActiveSheriff ? swipeAction : undefined}
        seats={game.players.map((player) => ({
          ...player,
          sheriffHighlight: player.status === "active" && player.role === "sheriff",
        }))}
        seatActionLabel={hasActiveSheriff ? (seat) => `Sheriff check ${seat.name}` : undefined}
        seatActionDisabled={hasActiveSheriff ? undefined : () => true}
        onSeatClick={
          hasActiveSheriff
            ? (targetSeat) => {
                const check = performSheriffCheck(game, targetSeat);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "sheriff.checked",
                    payload: { targetSeat, match: check.result.match },
                    secret: true,
                  });
                } else {
                  onGameChange(check.game);
                  onEvent("sheriff.checked", { ...check.result });
                }
              }
            : undefined
        }
        center={
          <div className="table-check-center">
            <span className="table-prompt">Sheriff check</span>
            <strong>Select a player to check for Mafia</strong>
          </div>
        }
        advance={
          hasActiveSheriff ? (
            <div className="table-advance-options">
              <button type="button" disabled>
                Select a player to continue
              </button>
              <button type="button" className="table-advance-secondary" onClick={skipSheriff}>
                Skip Sheriff check
              </button>
            </div>
          ) : (
            <button type="button" className="table-advance-secondary" onClick={skipSheriff}>
              Skip Sheriff check
            </button>
          )
        }
      />
    );
  }

  if (game.phase === "night-sheriff-result" && game.checkResult?.kind === "sheriff-check") {
    const target = game.players.find(({ seat }) => seat === game.checkResult?.targetSeat);
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          sheriffHighlight: player.status === "active" && player.role === "sheriff",
          current: player.seat === game.checkResult?.targetSeat,
        }))}
        center={
          <div className="table-check-center" role="status" aria-label="Sheriff check result">
            <span className="table-prompt">Sheriff checked {target?.name ?? "player"}</span>
            <div className="secret-result">
              {game.checkResult.match ? "Mafia found" : "Not Mafia"}
            </div>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = continueSheriffCheck(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "phase.changed",
                  payload: { to: next.phase },
                  secret: false,
                });
              } else onGameChange(next);
            }}
          >
            Continue night
          </button>
        }
      />
    );
  }

  if (game.phase === "night-resolution") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players}
        center={
          <div className="table-check-center">
            <span className="table-prompt">Night complete</span>
            {game.nightResult === undefined ? null : (
              <MafiaShotResultCard game={game} result={game.nightResult} />
            )}
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const next = completeNight(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "phase.changed",
                  payload: { to: next.phase },
                  secret: false,
                });
              } else {
                onGameChange(next);
                onEvent("phase.changed", {
                  from: "night-resolution",
                  to: next.phase,
                  day: next.day,
                });
              }
            }}
          >
            Begin day {game.day + 1}
          </button>
        }
      />
    );
  }

  return (
    <section className="night-stage">
      <h2>Night complete</h2>
    </section>
  );
};

const MafiaShotResultCard = ({
  game,
  result,
}: {
  readonly game: GameState;
  readonly result: NightShotResult;
}) => {
  const target =
    result.kind === "miss"
      ? undefined
      : game.players.find(({ seat }) => seat === result.targetSeat);

  if (result.kind === "miss") {
    return (
      <div className="night-miss-card" role="group" aria-label="Mafia missed">
        <span className="table-prompt">Mafia missed</span>
        <strong>No player died</strong>
      </div>
    );
  }
  if (result.kind === "no-effect") {
    return (
      <div className="night-miss-card" role="status" aria-label="Mafia shots had no effect">
        <span className="table-prompt">No effect</span>
        <strong>{target?.name ?? `Seat ${result.targetSeat}`} was already out</strong>
      </div>
    );
  }
  return (
    <div className="deceased-player-card" role="group" aria-label="Deceased player">
      <span className="table-prompt">Deceased player</span>
      <strong>#{target?.seat ?? result.targetSeat}</strong>
      <span>{target?.name ?? `Seat ${result.targetSeat}`}</span>
    </div>
  );
};
