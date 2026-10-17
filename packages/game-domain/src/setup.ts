import { CASPER_SEAT, assertCasperPlayer, assertCasperRole, isCasperPlayer } from "./casper.js";

import type { PlayerInput, Role, SetupState } from "./types.js";

const CANONICAL_ROLE_DECK: readonly Role[] = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
];

export type RandomSource = () => number;

export const createSeededRandom = (seed: number): RandomSource => {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const shuffle = (roles: readonly Role[], random: RandomSource): Role[] => {
  const shuffled = [...roles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
};

export const roleCounts = (roles: readonly Role[]): Record<Role, number> => {
  const counts: Record<Role, number> = { sheriff: 0, citizen: 0, mafia: 0, don: 0 };
  for (const role of roles) {
    counts[role] += 1;
  }
  return counts;
};

const assertSetupPlayers = (players: readonly PlayerInput[]): void => {
  if (!Array.isArray(players) || players.length !== 10) {
    throw new Error("Setup requires exactly ten players");
  }

  if (
    [...players].some(
      (player) =>
        player === null ||
        typeof player !== "object" ||
        typeof player.id !== "string" ||
        player.id.trim().length === 0 ||
        Object.keys(player).some((key) => key !== "id" && key !== "seat"),
    )
  )
    throw new Error("Setup requires identity-only player IDs and seats");

  if (new Set(players.map(({ id }) => id)).size !== 10) {
    throw new Error("Setup requires ten distinct players");
  }

  if (new Set(players.map(({ seat }) => seat)).size !== 10) {
    throw new Error("Setup requires ten distinct seats");
  }

  const seats = players.map(({ seat }) => seat).sort((left, right) => left - right);
  if (seats.some((seat, index) => seat !== index + 1)) {
    throw new Error("Seats must be numbered 1 through 10");
  }

  players.forEach(assertCasperPlayer);
};

export const createSetup = (players: readonly PlayerInput[]): SetupState => {
  assertSetupPlayers(players);
  return {
    step: "music",
    players: players.map(({ id, seat }) => ({ id, seat })),
    roleDeck: [...CANONICAL_ROLE_DECK],
    remainingRoles: [...CANONICAL_ROLE_DECK],
    assignments: {},
  };
};

export const beginRoleDraw = (state: SetupState, random: RandomSource): SetupState => {
  assertValidRoleAllocation(state);
  const roleDeck = shuffle(CANONICAL_ROLE_DECK, random);
  const hasCasper = state.players.some(isCasperPlayer);
  const citizenIndex = hasCasper ? roleDeck.indexOf("citizen") : -1;
  return {
    ...state,
    step: "role-draw",
    roleDeck,
    remainingRoles: roleDeck.filter((_, index) => index !== citizenIndex),
    assignments: hasCasper ? { [CASPER_SEAT]: "citizen" } : {},
  };
};

const undealtHumanSeats = (state: SetupState): number[] =>
  state.players
    .filter((player) => !isCasperPlayer(player) && state.assignments[player.seat] === undefined)
    .map(({ seat }) => seat)
    .sort((left, right) => left - right);

const hasCanonicalRoleCounts = (roles: readonly Role[]): boolean =>
  roles.length === CANONICAL_ROLE_DECK.length &&
  [...roles].every((role) => CANONICAL_ROLE_DECK.includes(role)) &&
  Object.entries(roleCounts(roles)).every(
    ([role, count]) => count === CANONICAL_ROLE_DECK.filter((card) => card === role).length,
  );

const assertValidRoleAllocation = (state: SetupState): void => {
  assertSetupPlayers(state.players);
  if (!["music", "role-draw", "mafia-planning"].includes(state.step)) {
    throw new Error("Invalid setup step");
  }
  if (!Array.isArray(state.roleDeck) || !hasCanonicalRoleCounts(state.roleDeck)) {
    throw new Error("Setup role deck must match the canonical ten-card deck");
  }
  if (
    state.assignments === null ||
    typeof state.assignments !== "object" ||
    Array.isArray(state.assignments) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(state.assignments)) ||
    Object.entries(state.assignments).some(
      ([seat, role]) => !/^(10|[1-9])$/.test(seat) || !CANONICAL_ROLE_DECK.includes(role as Role),
    )
  ) {
    throw new Error("Role assignments must use valid seats and canonical roles");
  }
  if (state.step === "music" && Object.keys(state.assignments).length !== 0) {
    throw new Error("Roles cannot be assigned before role drawing starts");
  }
  if (state.step !== "music") {
    for (const player of state.players) assertCasperRole(player, state.assignments[player.seat]);
  }
  const undealtCount = state.players.filter(
    ({ seat }) => state.assignments[seat] === undefined,
  ).length;
  if (!Array.isArray(state.remainingRoles) || state.remainingRoles.length !== undealtCount) {
    throw new Error("Setup remaining roles must match the unassigned seats");
  }
  if (
    !hasCanonicalRoleCounts([
      ...state.remainingRoles,
      ...(Object.values(state.assignments) as Role[]),
    ])
  ) {
    throw new Error("Setup role pool must match the canonical ten-card deck");
  }
  if (state.step === "mafia-planning" && undealtCount !== 0) {
    throw new Error("All ten seats must have a role before setup can continue");
  }
};

/** Live seat-bound roles, including dealt seats and fixed Casper; never deals or reshuffles. */
export const getRoleDrawPreview = (state: SetupState): Readonly<Record<number, Role>> => {
  assertValidRoleAllocation(state);
  if (state.step === "music") throw new Error("Role drawing has not started");
  const preview: Record<number, Role> = { ...(state.assignments as Record<number, Role>) };
  undealtHumanSeats(state).forEach((seat, index) => {
    preview[seat] = state.remainingRoles[index]!;
  });
  return preview;
};

export const drawRoleForSeat = (state: SetupState, seat: number): SetupState => {
  if (state.step !== "role-draw") {
    throw new Error("Role drawing has not started");
  }
  assertValidRoleAllocation(state);
  if (!state.players.some((player) => player.seat === seat)) {
    throw new Error(`Seat ${seat} is not part of this game`);
  }
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper already has a role and cannot draw another");
  }
  if (state.assignments[seat] !== undefined) {
    throw new Error(`Seat ${seat} already has a role`);
  }

  const index = undealtHumanSeats(state).indexOf(seat);
  const role = state.remainingRoles[index];
  if (role === undefined) {
    throw new Error("No roles remain to draw");
  }

  return {
    ...state,
    remainingRoles: state.remainingRoles.filter((_, cardIndex) => cardIndex !== index),
    assignments: { ...state.assignments, [seat]: role },
  };
};

export const rerollRoleForSeat = (
  state: SetupState,
  seat: number,
  random: RandomSource,
): SetupState => {
  if (state.step !== "role-draw") throw new Error("Role drawing has not started");
  assertValidRoleAllocation(state);
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper cannot reroll his role");
  }
  const currentRole = state.assignments[seat];
  if (currentRole === undefined) throw new Error(`Seat ${seat} does not have a role to reroll`);
  if (state.remainingRoles.length === 0) return state;

  const eligibleSeats = [...undealtHumanSeats(state), seat].sort((left, right) => left - right);
  const seatIndex = eligibleSeats.indexOf(seat);
  const eligibleRoles = [...state.remainingRoles];
  eligibleRoles.splice(seatIndex, 0, currentRole);
  const shuffled = shuffle(eligibleRoles, random);
  return {
    ...state,
    remainingRoles: shuffled.filter((_, index) => index !== seatIndex),
    assignments: { ...state.assignments, [seat]: shuffled[seatIndex]! },
  };
};

export const clearRoleForSeat = (state: SetupState, seat: number): SetupState => {
  if (state.step !== "role-draw") throw new Error("Roles can only be cleared during role draw");
  assertValidRoleAllocation(state);
  const player = state.players.find((candidate) => candidate.seat === seat);
  if (player === undefined) throw new Error(`Seat ${seat} does not exist`);
  if (isCasperPlayer(player)) throw new Error("Casper's role cannot be cleared");
  const role = state.assignments[seat];
  if (role === undefined) return state;
  const assignments = { ...state.assignments };
  delete assignments[seat];
  const remainingRoles = [...state.remainingRoles];
  const index = undealtHumanSeats(state).filter((undealtSeat) => undealtSeat < seat).length;
  remainingRoles.splice(index, 0, role);
  return { ...state, assignments, remainingRoles };
};

export const assignRoleForSeat = (state: SetupState, seat: number, role: Role): SetupState => {
  if (state.step !== "role-draw") throw new Error("Roles can only be assigned during role draw");
  assertValidRoleAllocation(state);
  if (!state.players.some((player) => player.seat === seat)) {
    throw new Error(`Seat ${seat} does not exist`);
  }
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper's role cannot be reassigned");
  }
  if (state.assignments[seat] === role) return state;
  const cleared = clearRoleForSeat(state, seat);
  const seatIndex = undealtHumanSeats(cleared).indexOf(seat);
  const availableIndex =
    cleared.remainingRoles[seatIndex] === role ? seatIndex : cleared.remainingRoles.indexOf(role);
  if (availableIndex < 0) throw new Error(`Role ${role} is not available`);
  const remainingRoles = [...cleared.remainingRoles];
  remainingRoles[availableIndex] = remainingRoles[seatIndex]!;
  remainingRoles.splice(seatIndex, 1);
  return {
    ...cleared,
    remainingRoles,
    assignments: { ...state.assignments, [seat]: role },
  };
};

export const assertCompleteRoleAssignments = (state: SetupState): void => {
  assertValidRoleAllocation(state);
  if (Object.keys(state.assignments).length !== 10 || state.remainingRoles.length !== 0) {
    throw new Error("All ten seats must have a role before setup can continue");
  }
};

export const completeRoleDraw = (state: SetupState): SetupState => {
  assertCompleteRoleAssignments(state);

  return { ...state, step: "mafia-planning" };
};
