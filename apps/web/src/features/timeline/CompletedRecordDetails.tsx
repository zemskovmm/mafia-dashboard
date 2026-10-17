import type { CompletedRecordFacts } from "./completed-record.js";
import type { TimelineText } from "./timeline-model.js";

const cellStyle = { padding: "8px 10px", whiteSpace: "nowrap" } as const;

export const CompletedRecordDetails = ({
  facts,
  text,
  playerName,
  formatDateTime,
}: {
  readonly facts: CompletedRecordFacts;
  readonly text: TimelineText;
  readonly playerName: (id: string) => string;
  readonly formatDateTime: (value: string) => string;
}) => {
  const unknown = text.t("Unknown");
  const outcome =
    facts.outcome === "red"
      ? text.t("Citizens won")
      : facts.outcome === "black"
        ? text.t("Mafia won")
        : facts.outcome === "draw"
          ? text.t("Game drawn")
          : facts.outcome === "cancelled"
            ? text.t("Game cancelled")
            : text.t("Unknown outcome");
  const teams = { red: text.t("Citizens"), black: text.t("Mafia") };
  const roles = {
    citizen: text.t("Citizen"),
    sheriff: text.t("Sheriff"),
    mafia: text.t("Mafia"),
    don: text.t("Don"),
  };
  const statuses = {
    active: text.t("Active at completion"),
    eliminated: text.t("Eliminated"),
    "red-carded": text.t("Removed"),
  };
  return (
    <section style={{ padding: "14px 18px", minWidth: 0 }} aria-label={text.t("Recorded facts")}>
      <h2>{text.t("Recorded facts")}</h2>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        <div>
          <dt>{text.t("Result")}</dt>
          <dd>{outcome}</dd>
        </div>
        <div>
          <dt>{text.t("Winner")}</dt>
          <dd>{facts.winner === null ? unknown : teams[facts.winner]}</dd>
        </div>
        <div>
          <dt>{text.t("Played at")}</dt>
          <dd>
            {facts.playedAt === null ? text.t("Unknown date") : formatDateTime(facts.playedAt)}
          </dd>
        </div>
        <div>
          <dt>{text.t("Host")}</dt>
          <dd>
            {facts.hostPlayerId === null ? text.t("Unknown host") : playerName(facts.hostPlayerId)}
          </dd>
        </div>
        <div>
          <dt>{text.t("Recorded day")}</dt>
          <dd>{facts.day ?? unknown}</dd>
        </div>
        <div>
          <dt>{text.t("Reason")}</dt>
          <dd>{facts.reason ?? unknown}</dd>
        </div>
      </dl>
      {facts.adjudication === null ? null : (
        <div>
          <h3>{text.t("Adjudication")}</h3>
          <dl>
            <div>
              <dt>{text.t("Losing team")}</dt>
              <dd>
                {facts.adjudication.losingTeam === null
                  ? unknown
                  : teams[facts.adjudication.losingTeam]}
              </dd>
            </div>
            <div>
              <dt>{text.t("Offender seat")}</dt>
              <dd>{facts.adjudication.offenderSeat ?? unknown}</dd>
            </div>
            <div>
              <dt>{text.t("Rule")}</dt>
              <dd>{facts.adjudication.rule ?? unknown}</dd>
            </div>
            <div>
              <dt>{text.t("Reason")}</dt>
              <dd>{facts.adjudication.reason ?? unknown}</dd>
            </div>
            <div>
              <dt>{text.t("Committee approval")}</dt>
              <dd>
                {facts.adjudication.committeeApproved === null
                  ? unknown
                  : text.t(
                      facts.adjudication.committeeApproved
                        ? "Committee approved"
                        : "Committee approval not recorded",
                    )}
              </dd>
            </div>
          </dl>
        </div>
      )}
      {facts.participants === null || facts.participants.length === 0 ? (
        <p>{text.t("Participant observations are unavailable.")}</p>
      ) : (
        <div className="timeline-track-scroll">
          <table
            aria-label={text.t("Recorded participants")}
            style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}
          >
            <thead>
              <tr>
                {(
                  [
                    "Player",
                    "Seat",
                    "Role",
                    "Team",
                    "Final status",
                    "Fouls",
                    "Best Move hits",
                  ] as const
                ).map((key) => (
                  <th key={key} scope="col" style={cellStyle}>
                    {text.t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {facts.participants.map((player, index) => (
                <tr key={`${player.playerId}:${index}`}>
                  <th scope="row" style={cellStyle}>
                    {playerName(player.playerId)}
                  </th>
                  <td style={cellStyle}>{player.seat ?? unknown}</td>
                  <td style={cellStyle}>{player.role === null ? unknown : roles[player.role]}</td>
                  <td style={cellStyle}>{player.team === null ? unknown : teams[player.team]}</td>
                  <td style={cellStyle}>
                    {player.status === null ? unknown : statuses[player.status]}
                  </td>
                  <td style={cellStyle}>{player.fouls ?? unknown}</td>
                  <td style={cellStyle}>{player.bestMoveHits ?? unknown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
