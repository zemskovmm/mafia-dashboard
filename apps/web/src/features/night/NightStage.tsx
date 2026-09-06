import type { ReactNode } from "react";
import {
  completeMafiaShots,
  completeNight,
  continueDonCheck,
  continueSheriffCheck,
  getMafiaShotResult,
  isNightCheckEligible,
  performDonCheck,
  performSheriffCheck,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
  toggleMafiaShot,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState, NightShotResult } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { nightMessages } from "../../i18n/messages/night.js";
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
  hostName,
  privacyHidden = false,
  onSeatSwipe,
  swipeAction,
}: NightStageProps) => {
  const { t } = useMessages(nightMessages);
  const tableHostName = hostName ?? t("night.host");
  const activePlayers = game.players.filter(({ status }) => status === "active");
  const donEligible = isNightCheckEligible(game, "don");
  const sheriffEligible = isNightCheckEligible(game, "sheriff");
  const skipDon = () => {
    const next = skipDonCheck(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "don.check-skipped", payload: {} });
    } else {
      onGameChange(next);
      onEvent("don.check-skipped", { day: game.day });
    }
  };
  const skipSheriff = () => {
    const next = skipSheriffCheck(game);
    if (onAcceptedEvent !== undefined) {
      onAcceptedEvent({ type: "sheriff.check-skipped", payload: {} });
    } else {
      onGameChange(next);
      onEvent("sheriff.check-skipped", { day: game.day });
    }
  };

  if (game.phase === "night-mafia") {
    const shooters = activePlayers
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    return (
      <GameTable
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: player.status === "active" && player.team === "black",
        }))}
        seatActionLabel={(seat) =>
          shooters.every(({ seat: shooterSeat }) => game.shotAssignments[shooterSeat] === seat.seat)
            ? t("night.removeAllShots", { name: seat.name })
            : t("night.assignAllShots", { name: seat.name })
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
                aria-label={t(selected ? "night.removeShooter" : "night.assignShooter", {
                  shooter: shooter.seat,
                  target: target.name,
                })}
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
            <span className="table-prompt">{t("night.mafiaShots")}</span>
            <strong>
              {t("night.shotsAssigned", {
                assigned: Object.keys(game.shotAssignments).length,
                shooters: shooters.length,
              })}
            </strong>
          </div>
        }
        advance={
          <button
            type="button"
            onClick={() => {
              const resolution = resolveMafiaShots(game);
              if (onAcceptedEvent !== undefined) {
                onAcceptedEvent({
                  type: "mafia.shots-resolved",
                  payload: { shots: resolution.secretShots, result: resolution.result },
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
            {t("night.evaluateShots")}
          </button>
        }
      />
    );
  }

  if (game.phase === "night-mafia-result") {
    const result = getMafiaShotResult(game);
    return (
      <GameTable
        hostName={tableHostName}
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
                });
              } else {
                onGameChange(next);
              }
            }}
          >
            {t("night.continue")}
          </button>
        }
      />
    );
  }

  if (game.phase === "night-don") {
    return (
      <GameTable
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={donEligible ? onSeatSwipe : undefined}
        swipeAction={donEligible ? swipeAction : undefined}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: donEligible && player.role === "don",
          nightCheckHighlight: donEligible && player.role === "don",
        }))}
        seatActionLabel={
          donEligible ? (seat) => t("night.donCheckTarget", { name: seat.name }) : undefined
        }
        seatActionDisabled={donEligible ? undefined : () => true}
        onSeatClick={
          donEligible
            ? (targetSeat) => {
                const check = performDonCheck(game, targetSeat);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "don.checked",
                    payload: { targetSeat, match: check.result.match },
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
            <span className="table-prompt">{t("night.donCheck")}</span>
            <strong>{t("night.selectDonTarget")}</strong>
          </div>
        }
        advance={
          donEligible ? (
            <div className="table-advance-options">
              <button type="button" disabled>
                {t("night.selectPlayer")}
              </button>
              <button type="button" className="table-advance-secondary" onClick={skipDon}>
                {t("night.skipDon")}
              </button>
            </div>
          ) : (
            <button type="button" className="table-advance-secondary" onClick={skipDon}>
              {t("night.skipDon")}
            </button>
          )
        }
      />
    );
  }

  if (game.phase === "night-don-result" && game.checkResult?.kind === "don-check") {
    const target = game.players.find(({ seat }) => seat === game.checkResult?.targetSeat);
    return (
      <GameTable
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          mafiaShooter: donEligible && player.role === "don",
          current: player.seat === game.checkResult?.targetSeat,
        }))}
        center={
          <div className="table-check-center" role="status" aria-label={t("night.donCheckResult")}>
            <span className="table-prompt">
              {t("night.donChecked", { name: target?.name ?? t("night.player") })}
            </span>
            <div className="secret-result">
              {game.checkResult.match ? t("night.sheriffFound") : t("night.notSheriff")}
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
                });
              } else onGameChange(next);
            }}
          >
            {sheriffEligible ? t("night.proceedSheriff") : t("night.continue")}
          </button>
        }
      />
    );
  }

  if (game.phase === "night-sheriff") {
    return (
      <GameTable
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={sheriffEligible ? onSeatSwipe : undefined}
        swipeAction={sheriffEligible ? swipeAction : undefined}
        seats={game.players.map((player) => ({
          ...player,
          sheriffHighlight: sheriffEligible && player.role === "sheriff",
          nightCheckHighlight: sheriffEligible && player.role === "sheriff",
        }))}
        seatActionLabel={
          sheriffEligible ? (seat) => t("night.sheriffCheckTarget", { name: seat.name }) : undefined
        }
        seatActionDisabled={sheriffEligible ? undefined : () => true}
        onSeatClick={
          sheriffEligible
            ? (targetSeat) => {
                const check = performSheriffCheck(game, targetSeat);
                if (onAcceptedEvent !== undefined) {
                  onAcceptedEvent({
                    type: "sheriff.checked",
                    payload: { targetSeat, match: check.result.match },
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
            <span className="table-prompt">{t("night.sheriffCheck")}</span>
            <strong>{t("night.selectSheriffTarget")}</strong>
          </div>
        }
        advance={
          sheriffEligible ? (
            <div className="table-advance-options">
              <button type="button" disabled>
                {t("night.selectPlayer")}
              </button>
              <button type="button" className="table-advance-secondary" onClick={skipSheriff}>
                {t("night.skipSheriff")}
              </button>
            </div>
          ) : (
            <button type="button" className="table-advance-secondary" onClick={skipSheriff}>
              {t("night.skipSheriff")}
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
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players.map((player) => ({
          ...player,
          sheriffHighlight: sheriffEligible && player.role === "sheriff",
          current: player.seat === game.checkResult?.targetSeat,
        }))}
        center={
          <div
            className="table-check-center"
            role="status"
            aria-label={t("night.sheriffCheckResult")}
          >
            <span className="table-prompt">
              {t("night.sheriffChecked", { name: target?.name ?? t("night.player") })}
            </span>
            <div className="secret-result">
              {game.checkResult.match ? t("night.mafiaFound") : t("night.notMafia")}
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
                });
              } else onGameChange(next);
            }}
          >
            {t("night.continue")}
          </button>
        }
      />
    );
  }

  if (game.phase === "night-resolution") {
    return (
      <GameTable
        hostName={tableHostName}
        privacyHidden={privacyHidden}
        onSeatSwipe={onSeatSwipe}
        swipeAction={swipeAction}
        seats={game.players}
        center={
          <div className="table-check-center">
            <span className="table-prompt">{t("night.stageComplete")}</span>
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
            {t("night.beginDay", { day: game.day + 1 })}
          </button>
        }
      />
    );
  }

  return (
    <section className="night-stage">
      <h2>{t("night.stageComplete")}</h2>
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
  const { t } = useMessages(nightMessages);
  const target =
    result.kind === "miss"
      ? undefined
      : game.players.find(({ seat }) => seat === result.targetSeat);

  if (result.kind === "miss") {
    return (
      <div className="night-miss-card" role="group" aria-label={t("night.mafiaMissed")}>
        <span className="table-prompt">{t("night.mafiaMissed")}</span>
        <strong>{t("night.noPlayerDied")}</strong>
      </div>
    );
  }
  if (result.kind === "no-effect") {
    return (
      <div className="night-miss-card" role="status" aria-label={t("night.mafiaNoEffect")}>
        <span className="table-prompt">{t("night.noEffect")}</span>
        <strong>
          {t("night.wasAlreadyOut", {
            name: target?.name ?? t("night.seat", { seat: result.targetSeat }),
          })}
        </strong>
      </div>
    );
  }
  return (
    <div className="deceased-player-card" role="group" aria-label={t("night.deceasedPlayer")}>
      <span className="table-prompt">{t("night.deceasedPlayer")}</span>
      <strong>#{target?.seat ?? result.targetSeat}</strong>
      <span>{target?.name ?? t("night.seat", { seat: result.targetSeat })}</span>
    </div>
  );
};
