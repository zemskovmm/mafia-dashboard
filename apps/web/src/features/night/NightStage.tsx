import {
  completeMafiaShots,
  completeNight,
  continueDonCheck,
  continueSheriffCheck,
  getMafiaShotResult,
  performDonCheck,
  performSheriffCheck,
  recordMafiaShot,
  reopenMafiaShots,
  resolveMafiaShots,
} from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { GameTable } from "../table/GameTable.js";

interface NightStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
}

export const NightStage = ({
  game,
  onGameChange,
  onEvent,
  hostName = "Host",
  privacyHidden = false,
}: NightStageProps) => {
  const activePlayers = game.players.filter(({ status }) => status === "active");

  if (game.phase === "night-mafia") {
    const shooters = activePlayers
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const allShotsRecorded = shooters.every(({ seat }) => game.shotAssignments[seat] !== undefined);
    const assignRemainingShots = (targetSeat: number) => {
      let next = game;
      for (const shooter of shooters) {
        if (next.shotAssignments[shooter.seat] === undefined) {
          next = recordMafiaShot(next, shooter.seat, targetSeat);
        }
      }
      onGameChange(next);
    };
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.team === "black",
        }))}
        seatActionLabel={(seat) => `Assign all remaining Mafia shots to ${seat.name}`}
        onSeatClick={assignRemainingShots}
        renderSeatActions={(target) =>
          shooters.map((shooter) => {
            const assignedTarget = game.shotAssignments[shooter.seat];
            const selected = assignedTarget === target.seat;
            return (
              <button
                type="button"
                key={shooter.seat}
                className={`shooter-button${selected ? " is-selected" : ""}`}
                disabled={assignedTarget !== undefined}
                aria-label={`Assign shooter ${shooter.seat} to target ${target.name}`}
                onClick={() => {
                  onGameChange(recordMafiaShot(game, shooter.seat, target.seat));
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
            <button
              type="button"
              className="table-center-primary"
              disabled={!allShotsRecorded}
              onClick={() => onGameChange(resolveMafiaShots(game).game)}
            >
              Evaluate Mafia shots
            </button>
          </div>
        }
      />
    );
  }

  if (game.phase === "night-mafia-result") {
    const result = getMafiaShotResult(game);
    const target =
      result.kind === "miss"
        ? undefined
        : game.players.find(({ seat }) => seat === result.targetSeat);
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.team === "black" && game.shotAssignments[player.seat] !== undefined,
          provisionalDeceased: result.kind === "kill" && player.seat === result.targetSeat,
        }))}
        center={
          <div className="table-night-center">
            {result.kind === "miss" ? (
              <div className="night-miss-card" role="group" aria-label="Mafia missed">
                <span className="table-prompt">Mafia missed</span>
                <strong>No player died</strong>
              </div>
            ) : result.kind === "no-effect" ? (
              <div className="night-miss-card" role="status" aria-label="Mafia shots had no effect">
                <span className="table-prompt">No effect</span>
                <strong>{target?.name ?? `Seat ${result.targetSeat}`} was already out</strong>
              </div>
            ) : (
              <div className="deceased-player-card" role="group" aria-label="Deceased player">
                <span className="table-prompt">Deceased player</span>
                <strong>#{target?.seat}</strong>
                <span>{target?.name}</span>
              </div>
            )}
            <div className="night-result-actions">
              <button type="button" onClick={() => onGameChange(reopenMafiaShots(game))}>
                Re-evaluate Mafia shots
              </button>
              <button
                type="button"
                className="table-center-primary"
                onClick={() => {
                  const next = completeMafiaShots(game);
                  onGameChange(next);
                  for (const [shooterSeat, targetSeat] of Object.entries(game.shotAssignments)) {
                    onEvent("mafia.shot-recorded", {
                      shooterSeat: Number(shooterSeat),
                      targetSeat,
                      day: game.day,
                      secret: true,
                    });
                  }
                  onEvent("mafia.shots-resolved", { ...result, day: game.day });
                }}
              >
                Continue night
              </button>
            </div>
          </div>
        }
      />
    );
  }

  if (game.phase === "night-don") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.role === "don",
        }))}
        seatActionLabel={(seat) => `Don check ${seat.name}`}
        onSeatClick={(targetSeat) => {
          const check = performDonCheck(game, targetSeat);
          onGameChange(check.game);
          onEvent("don.checked", { ...check.result });
        }}
        center={
          <div className="table-check-center">
            <span className="table-prompt">Don check</span>
            <strong>Select a player to check for Sheriff</strong>
          </div>
        }
      />
    );
  }

  if (game.phase === "night-don-result" && game.checkResult?.kind === "don-check") {
    const target = game.players.find(({ seat }) => seat === game.checkResult?.targetSeat);
    const hasSheriff = game.players.some(
      ({ role, status }) => role === "sheriff" && status === "active",
    );
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
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
            <button
              type="button"
              className="table-center-primary"
              onClick={() => onGameChange(continueDonCheck(game))}
            >
              {hasSheriff ? "Proceed to Sheriff check" : "Continue night"}
            </button>
          </div>
        }
      />
    );
  }

  if (game.phase === "night-sheriff") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players.map((player) => ({
          ...player,
          sheriffHighlight: player.status === "active" && player.role === "sheriff",
        }))}
        seatActionLabel={(seat) => `Sheriff check ${seat.name}`}
        onSeatClick={(targetSeat) => {
          const check = performSheriffCheck(game, targetSeat);
          onGameChange(check.game);
          onEvent("sheriff.checked", { ...check.result });
        }}
        center={
          <div className="table-check-center">
            <span className="table-prompt">Sheriff check</span>
            <strong>Select a player to check for Mafia</strong>
          </div>
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
            <button
              type="button"
              className="table-center-primary"
              onClick={() => onGameChange(continueSheriffCheck(game))}
            >
              Continue night
            </button>
          </div>
        }
      />
    );
  }

  if (game.phase === "night-resolution") {
    return (
      <GameTable
        hostName={hostName}
        privacyHidden={privacyHidden}
        seats={game.players}
        center={
          <div className="table-check-center">
            <span className="table-prompt">Night complete</span>
            <button
              type="button"
              className="table-center-primary"
              onClick={() => {
                const next = completeNight(game);
                onGameChange(next);
                onEvent("phase.changed", {
                  from: "night-resolution",
                  to: next.phase,
                  day: next.day,
                });
              }}
            >
              Begin day {game.day + 1}
            </button>
          </div>
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
