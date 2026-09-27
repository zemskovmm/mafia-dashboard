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

export const createSetup = (players: readonly PlayerInput[]): SetupState => {
  if (players.length !== 10) {
    throw new Error("Setup requires exactly ten players");
  }

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

  if (players.some(({ name }) => name.trim().length === 0)) {
    throw new Error("Every player requires a display name");
  }

  players.forEach(assertCasperPlayer);

  return {
    step: "music",
    players: players.map((player) => ({ ...player })),
    roleDeck: [...CANONICAL_ROLE_DECK],
    remainingRoles: [...CANONICAL_ROLE_DECK],
    assignments: {},
  };
};

export const beginRoleDraw = (state: SetupState, random: RandomSource): SetupState => {
  state.players.forEach(assertCasperPlayer);
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

export const drawRoleForSeat = (state: SetupState, seat: number): SetupState => {
  if (state.step !== "role-draw") {
    throw new Error("Role drawing has not started");
  }
  if (!state.players.some((player) => player.seat === seat)) {
    throw new Error(`Seat ${seat} is not part of this game`);
  }
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper already has a role and cannot draw another");
  }
  if (state.assignments[seat] !== undefined) {
    throw new Error(`Seat ${seat} already has a role`);
  }

  const role = state.remainingRoles[0];
  if (role === undefined) {
    throw new Error("No roles remain to draw");
  }

  return {
    ...state,
    remainingRoles: state.remainingRoles.slice(1),
    assignments: { ...state.assignments, [seat]: role },
  };
};

export const rerollRoleForSeat = (
  state: SetupState,
  seat: number,
  random: RandomSource,
): SetupState => {
  if (state.step !== "role-draw") throw new Error("Role drawing has not started");
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper cannot reroll his role");
  }
  const currentRole = state.assignments[seat];
  if (currentRole === undefined) throw new Error(`Seat ${seat} does not have a role to reroll`);
  if (state.remainingRoles.length === 0) return state;

  const nextIndex = Math.min(
    state.remainingRoles.length - 1,
    Math.floor(random() * state.remainingRoles.length),
  );
  const nextRole = state.remainingRoles[nextIndex]!;
  return {
    ...state,
    remainingRoles: state.remainingRoles.map((role, index) =>
      index === nextIndex ? currentRole : role,
    ),
    assignments: { ...state.assignments, [seat]: nextRole },
  };
};

export const assignRoleForSeat = (state: SetupState, seat: number, role: Role): SetupState => {
  if (state.step !== "role-draw") throw new Error("Roles can only be assigned during role draw");
  if (!state.players.some((player) => player.seat === seat)) {
    throw new Error(`Seat ${seat} does not exist`);
  }
  if (state.players.some((player) => player.seat === seat && isCasperPlayer(player))) {
    throw new Error("Casper's role cannot be reassigned");
  }
  const availableIndex = state.remainingRoles.indexOf(role);
  if (availableIndex < 0) throw new Error(`Role ${role} is not available`);
  const currentRole = state.assignments[seat];
  return {
    ...state,
    remainingRoles:
      currentRole === undefined
        ? state.remainingRoles.filter((_, index) => index !== availableIndex)
        : state.remainingRoles.map((availableRole, index) =>
            index === availableIndex ? currentRole : availableRole,
          ),
    assignments: { ...state.assignments, [seat]: role },
  };
};

export const assertCompleteRoleAssignments = (state: SetupState): void => {
  if (Object.keys(state.assignments).length !== 10 || state.remainingRoles.length !== 0) {
    throw new Error("All ten seats must have a role before setup can continue");
  }

  // A restored or forged setup must satisfy the same identity and deck rules as a fresh draw.
  createSetup(state.players);
  for (const player of state.players) assertCasperRole(player, state.assignments[player.seat]);
  const roles = Object.values(state.assignments);
  if (
    Object.keys(state.assignments).some((seat) => !/^(10|[1-9])$/.test(seat)) ||
    roles.some((role) => !CANONICAL_ROLE_DECK.includes(role as Role)) ||
    Object.entries(roleCounts(roles as Role[])).some(
      ([role, count]) => count !== CANONICAL_ROLE_DECK.filter((card) => card === role).length,
    )
  ) {
    throw new Error("Role assignments must match the canonical ten-card deck");
  }
};

export const completeRoleDraw = (state: SetupState): SetupState => {
  assertCompleteRoleAssignments(state);

  return { ...state, step: "mafia-planning" };
};
