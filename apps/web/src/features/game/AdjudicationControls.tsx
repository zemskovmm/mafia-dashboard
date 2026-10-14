import { useState } from "react";
import {
  adjudicateOpponentVictory,
  type CanonicalGameEventDraft,
  type GameState,
  type Team,
} from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { adjudicationMessages } from "../../i18n/messages/adjudication.js";

const rules = ["6.3.1", "6.3.2", "6.3.3", "6.3.4", "6.3.5", "6.6.4"] as const;

export const AdjudicationControls = ({
  game,
  onAcceptedEvent,
}: {
  readonly game: GameState;
  readonly onAcceptedEvent: (event: CanonicalGameEventDraft) => void;
}) => {
  const { t } = useMessages(adjudicationMessages);
  const [losingTeam, setLosingTeam] = useState<Team>("red");
  const [offender, setOffender] = useState("");
  const [rule, setRule] = useState<string>(rules[0]);
  const [reason, setReason] = useState("");
  const [committeeApproved, setCommitteeApproved] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const valid =
    reason.trim().length > 0 &&
    reason.trim().length <= 500 &&
    (rule !== "6.3.5" || committeeApproved);
  return (
    <details className="manage-menu-actions">
      <summary>{t("title")}</summary>
      <form
        className="manage-menu-actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          const payload = {
            losingTeam,
            ...(offender === "" ? {} : { offenderSeat: Number(offender) }),
            rule,
            reason: reason.trim(),
            committeeApproved,
          };
          try {
            adjudicateOpponentVictory(game, payload);
          } catch {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onAcceptedEvent({ type: "game.adjudicated", payload });
        }}
      >
        <label>
          {t("losingTeam")}
          <select
            value={losingTeam}
            onChange={(event) => {
              setLosingTeam(event.currentTarget.value as Team);
              setOffender("");
            }}
          >
            <option value="red">{t("red")}</option>
            <option value="black">{t("black")}</option>
          </select>
        </label>
        <label>
          {t("offender")}
          <select value={offender} onChange={(event) => setOffender(event.currentTarget.value)}>
            <option value="">{t("none")}</option>
            {game.players
              .filter(({ team }) => team === losingTeam)
              .map(({ seat }) => (
                <option key={seat} value={seat}>
                  #{seat}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t("rule")}
          <select
            value={rule}
            onChange={(event) => {
              setRule(event.currentTarget.value);
              setCommitteeApproved(false);
            }}
          >
            {rules.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("reason")}
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
        {rule === "6.3.5" ? (
          <label>
            <input
              type="checkbox"
              checked={committeeApproved}
              onChange={(event) => setCommitteeApproved(event.currentTarget.checked)}
            />
            {t("committee")}
          </label>
        ) : null}
        <p>{t("winner", { team: t(losingTeam === "red" ? "black" : "red") })}</p>
        {invalid ? <p role="alert">{t("invalid")}</p> : null}
        <button type="submit" className="danger-action" disabled={!valid}>
          {t("accept")}
        </button>
      </form>
    </details>
  );
};
