import { useId, useState } from "react";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { applyGameEvent } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { usePlayerDisplayName } from "../players/player-display.js";

export const FederationBallotTools = ({
  game,
  submit,
}: {
  readonly game: GameState;
  readonly submit: (event: CanonicalGameEventDraft) => void;
}) => {
  const { t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const id = useId();
  const voters = game.players.filter((p) => p.status === "active");
  const [voter, setVoter] = useState(voters[0]?.seat ?? 1);
  const [target, setTarget] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [disputeSeat, setDisputeSeat] = useState(
    game.ballot?.selectedCandidateSeat ?? game.turnOrder[0]!,
  );
  const [disputeReason, setDisputeReason] = useState("");
  const canDispute =
    game.ballot !== undefined &&
    game.ballot.dispute === undefined &&
    (game.ballot.hostRecording ||
      (game.turnOrder.slice(0, game.currentTurnIndex + 1).includes(disputeSeat) &&
        (game.turnOrder[game.currentTurnIndex] !== disputeSeat || game.ballot.mention === 2))) &&
    !game.ballot.reviewedCandidateSeats.includes(disputeSeat);
  const correctionPermitted =
    game.ballot !== undefined &&
    game.ballot.dispute === undefined &&
    (game.ballot.mention === 2 || game.ballot.acceptedCandidateSeats.length > 0);
  return (
    <>
      {game.ballot?.finalRuling !== undefined ? (
        <p className="federation-ballot-notice">{t("finalRuling")}</p>
      ) : null}
      {game.ballot?.dispute !== undefined ? (
        <FederationReview
          key={`${game.ballot.dispute.candidateSeat}:${game.ballot.dispute.reason}`}
          game={game}
          submit={submit}
        />
      ) : null}
      {!game.ballot?.hostRecording ? (
        <details className="federation-ballot-tools">
          <summary>{t("correction")}</summary>
          <p>{t("correctionGuidance")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!correctionPermitted || !reason.trim()) return;
              submit({
                type: "vote.corrected",
                payload: { voterSeat: voter, candidateSeat: target, reason: reason.trim() },
              });
              setReason("");
            }}
          >
            <label htmlFor={`${id}-voter`}>{t("correctionVoter")}</label>
            <select
              id={`${id}-voter`}
              value={voter}
              onChange={(event) => setVoter(Number(event.target.value))}
            >
              {voters.map((p) => (
                <option key={p.seat} value={p.seat}>
                  #{p.seat} {displayName(p)}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-target`}>{t("correctedVote")}</label>
            <select
              id={`${id}-target`}
              value={target ?? "unassigned"}
              onChange={(event) =>
                setTarget(event.target.value === "unassigned" ? null : Number(event.target.value))
              }
            >
              <option value="unassigned">{t("unassigned")}</option>
              {game.turnOrder.map((seat) => (
                <option key={seat} value={seat}>
                  #{seat}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-reason`}>{t("correctionReason")}</label>
            <input
              id={`${id}-reason`}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <button type="submit" disabled={!correctionPermitted || !reason.trim()}>
              {t("applyCorrection")}
            </button>
          </form>
        </details>
      ) : null}
      <details className="federation-ballot-tools">
        <summary>{t("dispute")}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canDispute || !disputeReason.trim()) return;
            submit({
              type: "voting.count-disputed",
              payload: { candidateSeat: disputeSeat, reason: disputeReason.trim() },
            });
            setDisputeReason("");
          }}
        >
          <label htmlFor={`${id}-dispute-seat`}>{t("disputeCandidate")}</label>
          <select
            id={`${id}-dispute-seat`}
            value={disputeSeat}
            onChange={(event) => setDisputeSeat(Number(event.target.value))}
          >
            {game.turnOrder.map((seat) => (
              <option key={seat} value={seat}>
                #{seat}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-dispute-reason`}>{t("disputeReason")}</label>
          <input
            id={`${id}-dispute-reason`}
            maxLength={500}
            value={disputeReason}
            onChange={(event) => setDisputeReason(event.target.value)}
          />
          <button type="submit" disabled={!canDispute || !disputeReason.trim()}>
            {t("pauseReview")}
          </button>
        </form>
      </details>
    </>
  );
};

const FederationReview = ({
  game,
  submit,
}: {
  readonly game: GameState;
  readonly submit: (event: CanonicalGameEventDraft) => void;
}) => {
  const { t } = useMessages(votingMessages);
  const displayName = usePlayerDisplayName();
  const id = useId();
  const [assignments, setAssignments] = useState<Record<number, number>>(() =>
    Object.fromEntries(
      Object.entries(game.voteAssignments).filter(
        (entry): entry is [string, number] => entry[1] !== undefined,
      ),
    ),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const ruling: CanonicalGameEventDraft = {
    type: "voting.count-ruled",
    payload: {
      voteAssignments: assignments,
      externalReviewAcknowledged: true,
      reason: reason.trim(),
    },
  };
  let canRule = acknowledged && Boolean(reason.trim());
  if (canRule) {
    try {
      applyGameEvent(game, ruling);
    } catch {
      canRule = false;
    }
  }
  return (
    <section className="federation-ballot-tools federation-review" aria-label={t("pausedDispute")}>
      <div role="alert">
        <strong>{t("pausedDispute")}</strong>
        <p>{game.ballot?.dispute?.reason}</p>
        <p>{t("pausedGuidance")}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canRule) submit(ruling);
        }}
      >
        {game.players
          .filter((p) => p.status === "active")
          .map((p) => (
            <div key={p.seat} className="federation-review-row">
              <label htmlFor={`${id}-vote-${p.seat}`}>
                {t("reviewedVote", { seat: p.seat })} · {displayName(p)}
              </label>
              <select
                id={`${id}-vote-${p.seat}`}
                value={assignments[p.seat] ?? "unassigned"}
                onChange={(event) =>
                  setAssignments((current) => {
                    const next = { ...current };
                    if (event.target.value === "unassigned") delete next[p.seat];
                    else next[p.seat] = Number(event.target.value);
                    return next;
                  })
                }
              >
                <option value="unassigned">{t("unassigned")}</option>
                {game.turnOrder.map((seat) => (
                  <option key={seat} value={seat}>
                    #{seat}
                  </option>
                ))}
              </select>
            </div>
          ))}
        <label htmlFor={`${id}-ack`}>
          <input
            id={`${id}-ack`}
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {t("externalReview")}
        </label>
        <label htmlFor={`${id}-reason`}>{t("rulingReason")}</label>
        <input
          id={`${id}-reason`}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button type="submit" disabled={!canRule}>
          {t("acceptRuling")}
        </button>
      </form>
    </section>
  );
};
