import type { GameState, ReplayFrame } from "@mafia/game-domain";
import {
  advanceDepartureCauses,
  publicDepartureCauses,
  type PlayerDepartureCauses,
} from "../game/player-action-presentation.js";
import { getNominationSupporterSeats } from "../timeline/nomination-history.js";
import type { LedgerFact, LedgerFactKind, LedgerInput, LedgerModel } from "./ledger-types.js";

interface Ballot {
  id: string;
  day: number;
  attempt: number;
  collective: boolean;
  sample: GameState;
  closed?: LedgerFactKind;
  closeId?: string;
  noIndividual?: boolean;
  /** Collective yes tally is observed separately from missing individual responses. */
  count?: number;
  total?: number;
}

const choiceKind = (collective: boolean, choice: number | boolean | undefined): LedgerFactKind => {
  if (!collective) return typeof choice === "number" ? "vote" : "voteUnassigned";
  if (choice === true) return "collectiveYes";
  return choice === false ? "collectiveNo" : "collectiveUnobserved";
};

/** Only the caller admits/replays history; this projection never changes game state. */
export const projectLedger = ({ game, frames, privacyHidden }: LedgerInput): LedgerModel => {
  const columns = Array.from({ length: game.day + 1 }, (_, day) => ({
    day,
    current: day === game.day,
  }));
  const cells = new Map<number, Map<number, LedgerFact[]>>();
  for (const player of game.players)
    cells.set(player.seat, new Map(columns.map(({ day }) => [day, []])));
  const add = (seat: number, day: number, fact: LedgerFact, source: GameState = game) => {
    if (
      source.players.find((player) => player.seat === seat)?.id !==
      game.players.find((player) => player.seat === seat)?.id
    )
      return;
    cells.get(seat)?.get(day)?.push(fact);
  };
  const ballots: Ballot[] = [];
  let activeBallot: Ballot | undefined;
  const startBallot = (id: string, sample: GameState, collective = false): Ballot => {
    const ballot = {
      id,
      day: sample.day,
      attempt: ballots.filter(({ day }) => day === sample.day).length + 1,
      collective,
      sample,
    };
    ballots.push(ballot);
    activeBallot = ballot;
    return ballot;
  };
  const ballotPhase = (state: GameState) =>
    state.phase === "voting" || state.phase === "car-crash-decision";
  for (const frame of frames ?? []) {
    const { before, after, entry } = frame;
    if (entry.type === "game.checkpointed" || entry.type === "game.started") continue;
    if (
      ballotPhase(before) &&
      (!activeBallot ||
        activeBallot.closed ||
        activeBallot.collective !== (before.phase === "car-crash-decision"))
    )
      startBallot(entry.id, before, before.phase === "car-crash-decision");
    const ballot = activeBallot;
    if (ballot && !ballot.closed && ballot.day === before.day) {
      if (entry.type === "voting.resolved") {
        ballot.sample = { ...before, voteAssignments: entry.payload.voteAssignments };
        ballot.closed = "ballotClosed";
        ballot.closeId = entry.id;
      } else if (
        entry.type === "car-crash.resolved" ||
        entry.type === "car-crash.ballot-resolved" ||
        entry.type === "car-crash.count-completed"
      ) {
        ballot.sample = { ...before, carCrashVotes: entry.payload.votes };
        ballot.count = entry.payload.result.yesVotes;
        ballot.total = entry.payload.result.eligibleVoters;
        ballot.closed = "ballotClosed";
        ballot.closeId = entry.id;
      } else if (after.phase === "voting-cancelled") {
        ballot.sample = before;
        ballot.closed = "ballotCancelled";
        ballot.closeId = entry.id;
      } else if (before.phase === "car-crash-decision" && after.phase === "car-crash-skipped") {
        ballot.sample = before;
        ballot.closed = "ballotSkipped";
        ballot.closeId = entry.id;
        ballot.noIndividual = true;
      } else if (
        ballotPhase(after) &&
        ballot.collective === (after.phase === "car-crash-decision")
      ) {
        ballot.sample = after;
      }
      if (entry.type === "voting.count-disputed") {
        for (const player of before.players.filter(({ status }) => status === "active"))
          add(
            player.seat,
            ballot.day,
            {
              id: `${entry.id}:disputed:${player.seat}`,
              kind: "ballotDisputed",
              period: "day",
              values: { attempt: ballot.attempt },
            },
            before,
          );
      }
    }
    if (
      entry.type === "voting.legally-skipped" ||
      (after.ballotSkipReason && after.ballotSkipReason !== before.ballotSkipReason)
    ) {
      const skipped = startBallot(entry.id, before);
      skipped.closed = "ballotSkipped";
      skipped.closeId = entry.id;
      skipped.noIndividual = true;
    }
    // A sole nominee can be conclusively removed by the final speech, without a voting event.
    if (
      before.phase === "day" &&
      ["turn.completed", "phase.changed"].includes(entry.type) &&
      after.players.some(
        (player) =>
          player.status === "eliminated" &&
          before.players.find(({ id }) => id === player.id)?.status === "active",
      )
    ) {
      const sole = startBallot(entry.id, before);
      sole.closed = "ballotClosed";
      sole.closeId = entry.id;
      sole.noIndividual = true;
    }
    if (
      ballotPhase(after) &&
      (!ballotPhase(before) || before.phase !== after.phase) &&
      (!activeBallot ||
        activeBallot.closed ||
        activeBallot.collective !== (after.phase === "car-crash-decision"))
    )
      startBallot(entry.id, after, after.phase === "car-crash-decision");
  }
  for (const ballot of ballots) {
    const { day, sample, attempt, collective, closed } = ballot;
    const id = `${ballot.closeId ?? ballot.id}:ballot:${attempt}`;
    const participants = sample.players.filter(({ status }) => status === "active");
    for (const player of participants) {
      if (!ballot.noIndividual) {
        const choice = collective
          ? sample.carCrashVotes?.[player.seat]
          : sample.voteAssignments[player.seat];
        if (choice !== undefined || closed)
          add(
            player.seat,
            day,
            {
              id: `${id}:choice:${player.seat}`,
              kind: choiceKind(collective, choice),
              period: "day",
              values: typeof choice === "number" ? { seat: choice, attempt } : { attempt },
            },
            sample,
          );
      }
      if (closed)
        add(
          player.seat,
          day,
          {
            id: `${id}:closed:${player.seat}`,
            kind: closed,
            period: "day",
            values:
              closed === "ballotClosed"
                ? {
                    attempt,
                    count: ballot.noIndividual
                      ? "—"
                      : (ballot.count ??
                        Object.values(sample.voteAssignments).filter((seat) => seat !== undefined)
                          .length),
                    total: ballot.noIndividual ? "—" : (ballot.total ?? participants.length),
                  }
                : { attempt },
          },
          sample,
        );
    }
  }
  // Current unaccepted choices supplement, never overwrite, the admitted ballot.
  if (ballotPhase(game)) {
    const accepted = ballots.at(-1);
    const matching =
      accepted &&
      !accepted.closed &&
      accepted.day === game.day &&
      accepted.collective === (game.phase === "car-crash-decision")
        ? accepted
        : undefined;
    const collective = game.phase === "car-crash-decision";
    for (const player of game.players.filter(({ status }) => status === "active")) {
      const choice = collective
        ? game.carCrashVotes?.[player.seat]
        : game.voteAssignments[player.seat];
      const old = matching
        ? collective
          ? matching.sample.carCrashVotes?.[player.seat]
          : matching.sample.voteAssignments[player.seat]
        : undefined;
      if (choice === old) continue;
      add(player.seat, game.day, {
        id: `draft:${matching?.id ?? "current"}:choice:${player.seat}`,
        provisional: true,
        kind: choiceKind(collective, choice),
        period: "day",
        values:
          typeof choice === "number"
            ? { seat: choice, attempt: matching?.attempt ?? 1 }
            : { attempt: matching?.attempt ?? 1 },
      });
    }
  }
  const nominations = new Map<number, ReplayFrame>();
  const observedNominations = new Map<number, Map<string, string>>();
  const observedSupport = new Map<number, Set<number>>();
  for (const frame of frames ?? []) {
    if (
      frame.entry.type === "player.nominated" ||
      frame.entry.type === "nomination.selection-set"
    ) {
      const day = frame.before.day;
      const candidate = frame.entry.payload.candidateSeat;
      nominations.set(day, frame);
      const created = !frame.before.nominations.some(
        ({ candidateSeat }) => candidateSeat === candidate,
      );
      if (created) {
        observedSupport.get(day)?.delete(candidate);
        const observed = observedNominations.get(day) ?? new Map<string, string>();
        observed.set(`${frame.entry.payload.nominatorSeat}:${candidate}`, frame.entry.id);
        observedNominations.set(day, observed);
      }
      if (frame.entry.type === "nomination.selection-set") {
        const observed = observedSupport.get(day) ?? new Set<number>();
        observed.add(candidate);
        observedSupport.set(day, observed);
      }
    }
  }
  for (const [day, frame] of nominations) {
    for (const nomination of frame.after.nominations) {
      const sourceId = observedNominations
        .get(day)
        ?.get(`${nomination.nominatorSeat}:${nomination.candidateSeat}`);
      if (sourceId)
        add(
          nomination.nominatorSeat,
          day,
          {
            id: `${sourceId}:nomination:${nomination.candidateSeat}`,
            kind: "nomination",
            period: "day",
            values: { seat: nomination.candidateSeat },
          },
          frame.after,
        );
      if (observedSupport.get(day)?.has(nomination.candidateSeat)) {
        const supporters = getNominationSupporterSeats(nomination);
        add(
          nomination.candidateSeat,
          day,
          {
            id: `${frame.entry.id}:support:${nomination.candidateSeat}`,
            kind: "support",
            period: "day",
            values: { count: supporters.length, seats: supporters.join(", ") || "—" },
          },
          frame.after,
        );
      }
    }
  }
  // Derive departures only from observed transitions and existing public-release masking.
  let causes: PlayerDepartureCauses = {};
  const origins = new Map<number, { day: number; period: "day" | "night"; id: string }>();
  const periodOf = (state: GameState): "day" | "night" =>
    state.phase.startsWith("night-") || state.phase === "best-move" ? "night" : "day";
  const shotFrames = new Map<
    number,
    { frame: ReplayFrame; assignments: GameState["shotAssignments"] }
  >();
  const bestMoves = new Map<number, ReplayFrame>();
  const unavailable = new Set<string>();
  const openedChecks = new Set(
    (frames ?? []).flatMap(({ before, entry }) =>
      entry.type === "night.check-windows-opened"
        ? entry.payload.roles.map((role) => `${before.day}:${role}`)
        : [],
    ),
  );
  for (const frame of frames ?? []) {
    const { before, after, entry } = frame;
    if (entry.type === "game.checkpointed" || entry.type === "game.started") continue;
    const previousPublic = publicDepartureCauses(before, causes);
    causes = advanceDepartureCauses(causes, before, after);
    for (const player of after.players) {
      const old = before.players.find(({ id, seat }) => id === player.id && seat === player.seat);
      if (!old || player.status === "active") origins.delete(player.seat);
      if (old && old.status !== player.status && player.status !== "active")
        origins.set(player.seat, { day: before.day, period: periodOf(before), id: entry.id });
    }
    const nextPublic = publicDepartureCauses(after, causes);
    for (const [key, cause] of Object.entries(nextPublic)) {
      const seat = Number(key);
      const origin = origins.get(seat);
      if (origin && previousPublic[seat] !== cause)
        add(
          seat,
          origin.day,
          {
            id: `${origin.id}:departure:${seat}`,
            kind: cause === "discipline" ? "removed" : "eliminated",
            period: origin.period,
          },
          after,
        );
    }
    if (entry.type === "foul.issued" || entry.type === "discipline.foul-issued") {
      add(
        entry.payload.seat,
        before.day,
        {
          id: `${entry.id}:foul`,
          kind: "foul",
          period: periodOf(before),
          values: { count: entry.payload.foulNumber },
        },
        after,
      );
    }
    // No per-secret placeholders or secret occurrence counts survive this boundary.
    if (privacyHidden) continue;
    if (entry.type === "mafia.shots-observed") {
      shotFrames.set(before.day, { frame, assignments: after.shotAssignments });
      entry.payload.observations.forEach((shot, index) =>
        add(
          shot.shooterSeat,
          before.day,
          {
            id: `${entry.id}:physical:${index}`,
            kind: "shotObserved",
            period: "night",
            values: { seat: shot.targetSeat },
          },
          before,
        ),
      );
    }
    if (entry.type === "mafia.multiple-shot-observed")
      add(
        entry.payload.shooterSeat,
        before.day,
        {
          id: `${entry.id}:physical`,
          kind: "shotObserved",
          period: "night",
          values: { seat: "?" },
        },
        before,
      );
    if (entry.type === "mafia.shots-resolved") {
      shotFrames.set(before.day, {
        frame,
        assignments: Object.fromEntries(
          entry.payload.shots.map(({ shooterSeat, targetSeat }) => [shooterSeat, targetSeat]),
        ),
      });
      for (const player of before.players.filter(
        ({ status, team }) => status === "active" && team === "black",
      ))
        add(
          player.seat,
          before.day,
          {
            id: `${entry.id}:outcome:${player.seat}`,
            kind:
              entry.payload.result.kind === "kill"
                ? "killed"
                : entry.payload.result.kind === "no-effect"
                  ? "noEffect"
                  : "miss",
            period: "night",
            ...(entry.payload.result.kind === "miss"
              ? {}
              : { values: { seat: entry.payload.result.targetSeat } }),
          },
          before,
        );
    }
    if (
      entry.type === "don.checked" ||
      entry.type === "sheriff.checked" ||
      entry.type === "don.check-skipped" ||
      entry.type === "sheriff.check-skipped"
    ) {
      const role = entry.type.startsWith("don.") ? "don" : "sheriff";
      const actor = before.players.find((player) => player.role === role);
      if (actor) {
        if (entry.type === "don.checked" || entry.type === "sheriff.checked")
          add(
            actor.seat,
            before.day,
            {
              id: `${entry.id}:check`,
              kind:
                entry.type === "don.checked"
                  ? entry.payload.match
                    ? "donMatch"
                    : "donNoMatch"
                  : entry.payload.match
                    ? "sheriffMatch"
                    : "sheriffNoMatch",
              period: "night",
              values: { seat: entry.payload.targetSeat },
            },
            before,
          );
        else
          add(
            actor.seat,
            before.day,
            { id: `${entry.id}:check`, kind: "checkSkipped", period: "night" },
            before,
          );
      }
    }
    // Settled entitlements, not role/alive inference; an observed reopening supersedes absence.
    if (before.phase === "night-mafia-result" && after.phase !== before.phase) {
      for (const role of ["don", "sheriff"] as const) {
        const key = `${before.day}:${role}`;
        const actor = before.players.find((player) => player.role === role);
        if (
          after.nightCheckEligibility?.[role] === false &&
          !openedChecks.has(key) &&
          actor &&
          !unavailable.has(key)
        ) {
          unavailable.add(key);
          add(
            actor.seat,
            before.day,
            { id: `${entry.id}:unavailable:${role}`, kind: "checkUnavailable", period: "night" },
            before,
          );
        }
      }
    }
    if (entry.type.startsWith("best-move.") && after.bestMove) bestMoves.set(before.day, frame);
  }
  if (!privacyHidden) {
    for (const [day, { frame, assignments }] of shotFrames) {
      for (const [key, target] of Object.entries(assignments))
        if (target !== undefined)
          add(
            Number(key),
            day,
            {
              id: `${frame.entry.id}:shot:${key}`,
              kind: "shot",
              period: "night",
              values: { seat: target },
            },
            frame.before,
          );
    }
    if (game.phase === "night-mafia") {
      const accepted = shotFrames.get(game.day)?.assignments;
      const keys = new Set([...Object.keys(accepted ?? {}), ...Object.keys(game.shotAssignments)]);
      for (const key of keys) {
        const seat = game.shotAssignments[Number(key)];
        if (seat !== accepted?.[Number(key)])
          add(Number(key), game.day, {
            id: `draft:shot:${key}`,
            kind: "shot",
            period: "night",
            values: { seat: seat ?? "?" },
            provisional: true,
          });
      }
    }
    for (const [day, frame] of bestMoves) {
      const move = frame.after.bestMove!;
      // Tentative UI selections are not finalized spoken transcripts.
      if (!move.completionReason) continue;
      if (move.selectedSeats.length === 0)
        add(
          move.playerSeat,
          day,
          { id: `${frame.entry.id}:best-move`, kind: "bestMoveSkipped", period: "night" },
          frame.after,
        );
      move.selectedSeats.forEach((seat, index) =>
        add(
          move.playerSeat,
          day,
          {
            id: `${frame.entry.id}:best-move:${index}`,
            kind: "bestMove",
            period: "night",
            values: { seat },
          },
          frame.after,
        ),
      );
    }
    if (game.phase === "best-move" && game.bestMove && !game.bestMove.completionReason) {
      game.bestMove.selectedSeats.forEach((seat, index) =>
        add(game.bestMove!.playerSeat, game.day, {
          id: `draft:best-move:${index}`,
          kind: "bestMove",
          period: "night",
          values: { seat },
          provisional: true,
        }),
      );
    }
  }
  return {
    historyAvailable: frames !== undefined,
    columns,
    rows: [...game.players]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => ({
        playerId: player.id,
        seat: player.seat,
        cells: columns.map(({ day, current }) => {
          const facts = cells.get(player.seat)!.get(day)!;
          return {
            day,
            state: facts.some((fact) => !fact.provisional)
              ? "recorded"
              : frames !== undefined && current
                ? "pending"
                : "unknown",
            facts,
          };
        }),
      })),
  };
};
