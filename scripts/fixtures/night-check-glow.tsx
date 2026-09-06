import { useCallback, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  advanceSetupPhase,
  beginNight,
  beginRoleDraw,
  completeMafiaShots,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  resolveMafiaShots,
  skipDonCheck,
  toggleAllMafiaShotsForTarget,
} from "@mafia/game-domain";
import { NightStage } from "../../apps/web/src/features/night/NightStage.js";
import {
  createLightingRendererState,
  LightingRendererContext,
  lightingRendererReducer,
} from "../../apps/web/src/features/effects/LightingRendererContext.js";
import { VgpuLightingProvider } from "../../apps/web/src/features/effects/vgpu/VgpuLightingProvider.js";

const params = new URLSearchParams(window.location.search);
const role = params.get("role") === "don" ? "don" : "sheriff";
let setup = beginRoleDraw(
  createSetup(
    Array.from({ length: 10 }, (_, index) => ({
      id: `p-${index + 1}`,
      name: `Player ${index + 1}`,
      seat: index + 1,
    })),
  ),
  createSeededRandom(17),
);
for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
const owner = day.players.find((player) => player.role === role)!;
const other = day.players.find((player) => player.role === "citizen")!;
const prior = params.has("prior");
const night = beginNight({
  ...day,
  players: day.players.map((player) =>
    player.seat === other.seat || (prior && player.seat === owner.seat)
      ? { ...player, status: "eliminated" }
      : player,
  ),
});
let initial = prior
  ? { ...night, phase: role === "don" ? ("night-don" as const) : ("night-sheriff" as const) }
  : completeMafiaShots(resolveMafiaShots(toggleAllMafiaShotsForTarget(night, owner.seat)).game);
if (!prior && role === "sheriff") initial = skipDonCheck(initial);

const Harness = () => {
  const [game, setGame] = useState(initial);
  const [lighting, dispatch] = useReducer(
    lightingRendererReducer,
    window.localStorage,
    createLightingRendererState,
  );
  const onReady = useCallback(
    (generation: number) => dispatch({ type: "vgpu-ready", generation }),
    [],
  );
  const onFailure = useCallback(
    (generation: number) => dispatch({ type: "vgpu-failed", generation }),
    [],
  );
  return (
    <LightingRendererContext.Provider value={lighting}>
      <VgpuLightingProvider
        enabled={lighting.requestedRenderer === "vgpu"}
        generation={lighting.vgpuGeneration}
        onReady={onReady}
        onFailure={onFailure}
      >
        <div
          className="app-shell game-shell is-table-cycle-night"
          data-lighting-renderer={lighting.effectiveRenderer}
          data-player-lighting={lighting.playerLightingEnabled ? "enabled" : "disabled"}
          data-vgpu-status={lighting.vgpuStatus}
          data-owner={owner.seat}
          data-other={other.seat}
          data-phase={game.phase}
        >
          <NightStage
            game={game}
            onGameChange={setGame}
            onEvent={() => undefined}
            privacyHidden={params.has("privacy")}
          />
        </div>
      </VgpuLightingProvider>
    </LightingRendererContext.Provider>
  );
};

createRoot(document.getElementById("root")!).render(<Harness />);
