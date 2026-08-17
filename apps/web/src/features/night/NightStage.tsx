import { useState } from "react";
import {
  completeNight,
  performDonCheck,
  performSheriffCheck,
  recordMafiaShot,
  resolveMafiaShots,
} from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";

interface NightStageProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
}

export const NightStage = ({ game, onGameChange, onEvent }: NightStageProps) => {
  const [privateResult, setPrivateResult] = useState<string | null>(null);
  const activePlayers = game.players.filter(({ status }) => status === "active");

  if (game.phase === "night-mafia") {
    const shooters = activePlayers.filter(({ team }) => team === "black");
    const currentShooter = shooters.find(({ seat }) => game.shotAssignments[seat] === undefined);
    const allShotsRecorded = currentShooter === undefined;
    return (
      <section className="night-stage">
        <h2>Mafia shots</h2>
        {currentShooter === undefined ? (
          <p className="night-instruction">All active Mafia-aligned shots are recorded.</p>
        ) : (
          <p className="night-instruction">Shooter: {currentShooter.name}</p>
        )}
        <div className="night-target-grid">
          {activePlayers.map((target) => (
            <button
              type="button"
              key={target.seat}
              disabled={currentShooter === undefined}
              aria-label={
                currentShooter === undefined
                  ? `Target ${target.name}`
                  : `Target ${target.name} for ${currentShooter.name}`
              }
              onClick={() => {
                if (currentShooter === undefined) return;
                const next = recordMafiaShot(game, currentShooter.seat, target.seat);
                onGameChange(next);
                onEvent("mafia.shot-recorded", {
                  shooterSeat: currentShooter.seat,
                  targetSeat: target.seat,
                  secret: true,
                });
              }}
            >
              <strong>{target.seat}</strong>
              <span>{target.name}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="primary-action"
          disabled={!allShotsRecorded}
          onClick={() => {
            const resolution = resolveMafiaShots(game);
            setPrivateResult(
              resolution.result.kind === "kill"
                ? `Successful shot · seat ${resolution.result.targetSeat}`
                : "Mafia missed",
            );
            onGameChange(resolution.game);
            onEvent("mafia.shots-resolved", resolution.result);
          }}
        >
          Resolve Mafia shots
        </button>
      </section>
    );
  }

  if (game.phase === "night-don") {
    return (
      <section className="night-stage">
        <h2>Don check</h2>
        <p className="night-instruction">Wake Don. Select one player to check for Sheriff.</p>
        <div className="night-target-grid">
          {activePlayers.map((target) => (
            <button
              type="button"
              key={target.seat}
              aria-label={`Don check ${target.name}`}
              onClick={() => {
                const check = performDonCheck(game, target.seat);
                setPrivateResult(check.result.match ? "Sheriff found" : "Not the Sheriff");
                onGameChange(check.game);
                onEvent("don.checked", { ...check.result });
              }}
            >
              <strong>{target.seat}</strong>
              <span>{target.name}</span>
            </button>
          ))}
        </div>
        {privateResult === null ? null : <div className="secret-result">{privateResult}</div>}
      </section>
    );
  }

  if (game.phase === "night-sheriff") {
    return (
      <section className="night-stage">
        <h2>Sheriff check</h2>
        <p className="night-instruction">Wake Sheriff. Select one player to check for Mafia.</p>
        <div className="night-target-grid">
          {activePlayers.map((target) => (
            <button
              type="button"
              key={target.seat}
              aria-label={`Sheriff check ${target.name}`}
              onClick={() => {
                const check = performSheriffCheck(game, target.seat);
                setPrivateResult(check.result.match ? "Mafia found" : "Not Mafia");
                onGameChange(check.game);
                onEvent("sheriff.checked", { ...check.result });
              }}
            >
              <strong>{target.seat}</strong>
              <span>{target.name}</span>
            </button>
          ))}
        </div>
        {privateResult === null ? null : <div className="secret-result">{privateResult}</div>}
      </section>
    );
  }

  if (game.phase === "night-resolution") {
    return (
      <section className="night-stage">
        <h2>Night result</h2>
        {privateResult === null ? null : <div className="secret-result">{privateResult}</div>}
        <button
          type="button"
          className="primary-action"
          onClick={() => {
            const next = completeNight(game);
            setPrivateResult("Night complete");
            onGameChange(next);
            onEvent("phase.changed", { from: "night-resolution", to: "day", day: next.day });
          }}
        >
          Begin day {game.day + 1}
        </button>
      </section>
    );
  }

  return (
    <section className="night-stage">
      <h2>Night complete</h2>
    </section>
  );
};
