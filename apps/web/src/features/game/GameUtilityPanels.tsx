import { countVotes, getCurrentVotingCandidateSeat, isFederationGame } from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { TimerControls } from "../timer/TimerControls.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import { VgpuPlayerLightingCanvas } from "../effects/vgpu/VgpuLightingCanvas.js";

export interface GameUtilityPanelsProps {
  readonly game: GameState | null;
  readonly onSelectVotingCandidate?: (seat: number) => void;
}

export const GameUtilityPanels = ({ game, onSelectVotingCandidate }: GameUtilityPanelsProps) => {
  const { t } = useMessages(gameMessages);
  const { t: votingT } = useMessages(votingMessages);
  const federation = game !== null && isFederationGame(game);
  const displayName = usePlayerDisplayName();
  const nominationTotals = game === null ? {} : countVotes(game);
  const currentCandidate = game?.phase === "voting" ? getCurrentVotingCandidateSeat(game) : null;
  const inspectedCandidate = federation ? game?.ballot?.selectedCandidateSeat : currentCandidate;
  const activeSeats = (game?.players ?? [])
    .filter(({ status }) => status === "active")
    .map(({ seat }) => seat);
  const tiedSeats = new Set(game?.carCrashSeats ?? []);
  const skippedCarCrash =
    game?.phase === "car-crash-skipped" ||
    (game?.phase === "car-crash-decision" &&
      tiedSeats.size === activeSeats.length &&
      activeSeats.every((seat) => tiedSeats.has(seat)));
  const showVoteTotals =
    game?.phase === "voting" ||
    game?.phase === "voting-cancelled" ||
    game?.phase === "car-crash" ||
    (game?.phase === "car-crash-decision" && !skippedCarCrash) ||
    game?.phase === "car-crash-result" ||
    game?.phase === "goodbye-speech";
  const activeVoteCount =
    game?.phase === "car-crash-decision" || game?.phase === "car-crash-result"
      ? Object.keys(game.carCrashVotes ?? {}).length
      : Object.keys(game?.voteAssignments ?? {}).length;

  return (
    <>
      <div className="utility-panel-section" data-panel="timer">
        <TimerControls />
      </div>
      <div className="utility-panel-section" data-panel="voting">
        <section className="nomination-panel" aria-label={t("utility.votingOrder")}>
          <p className="eyebrow">{t("utility.votingOrder")}</p>
          {federation ? (
            <>
              <p className="muted">{votingT("nominationPrivate")}</p>
              {game?.phase === "voting" ? (
                <>
                  <p>{votingT("panelLiveCall", { seat: currentCandidate ?? "" })}</p>
                  <p>
                    {votingT("uncastVotes", {
                      count: game.players.filter(
                        (p) => p.status === "active" && game.voteAssignments[p.seat] === undefined,
                      ).length,
                    })}
                  </p>
                </>
              ) : null}
            </>
          ) : null}
          {showVoteTotals ? (
            <p className="vote-count-summary">
              {t("utility.activeVotes", { count: activeVoteCount })}
            </p>
          ) : null}
          {game === null || game.nominations.length === 0 ? (
            <p className="muted">{t("utility.noNominations")}</p>
          ) : (
            <ol>
              {game.nominations.map(({ candidateSeat, nominatorSeat }) => {
                const candidate = game.players.find(({ seat }) => seat === candidateSeat);
                const nominator = game.players.find(({ seat }) => seat === nominatorSeat);
                const current = candidateSeat === currentCandidate;
                return (
                  <li
                    key={candidateSeat}
                    className={current ? "is-voting-highlight" : undefined}
                    aria-current={current ? "step" : undefined}
                  >
                    <VgpuPlayerLightingCanvas kind={current ? "attention" : null} />
                    <span className="nomination-copy">
                      {game.phase === "voting" && onSelectVotingCandidate !== undefined ? (
                        <button
                          type="button"
                          aria-pressed={candidateSeat === inspectedCandidate}
                          onClick={() => onSelectVotingCandidate(candidateSeat)}
                        >
                          #{candidateSeat}{" "}
                          {candidate === undefined
                            ? t("utility.seat", { seat: candidateSeat })
                            : displayName(candidate)}
                        </button>
                      ) : (
                        <strong>
                          #{candidateSeat}{" "}
                          {candidate === undefined
                            ? t("utility.seat", { seat: candidateSeat })
                            : displayName(candidate)}
                        </strong>
                      )}
                      <span>
                        {t("utility.initiatedBy", {
                          seat: nominatorSeat,
                          name:
                            nominator === undefined
                              ? t("utility.seat", { seat: nominatorSeat })
                              : displayName(nominator),
                        })}
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
      </div>
    </>
  );
};
