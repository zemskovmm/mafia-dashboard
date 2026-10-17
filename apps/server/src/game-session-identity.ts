import { CASPER_PLAYER_ID, CASPER_SEAT } from "@mafia/game-domain";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileFields = ["name", "nickname", "firstName", "lastName", "email", "hostName"];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class UnsupportedGameFormatError extends Error {
  readonly code = "unsupported_game_format";
  constructor() {
    super("Unsupported game record structure");
  }
}

export class InvalidGameIdentityError extends Error {
  readonly code = "invalid_game_identity";
  constructor() {
    super("Game identity is not an eligible identity in this club");
  }
}

interface References {
  readonly all: Set<string>;
  readonly selected: Set<string>;
  readonly invalid: boolean;
  readonly named: boolean;
}

/** Only inspect structured identity positions, not game titles or moderator prose. */
export const inspectGameIdentities = (state: unknown, results: unknown): References => {
  const all = new Set<string>();
  const selected = new Set<string>();
  let invalid = false;
  let named = false;
  const add = (value: unknown, active: boolean) => {
    if (value === null || value === undefined || value === "") return;
    if (typeof value !== "string" || (value !== CASPER_PLAYER_ID && !uuid.test(value))) {
      invalid = true;
      return;
    }
    if (value === CASPER_PLAYER_ID) return;
    all.add(value);
    if (active) selected.add(value);
  };
  const visit = (value: unknown, active: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, active));
      return;
    }
    if (!record(value)) return;
    if (Object.hasOwn(value, "hostName") && value.hostName !== null) named = true;
    if (
      record(value.payload) &&
      profileFields.some((key) => Object.hasOwn(value.payload as object, key))
    )
      named = true;
    if (Object.hasOwn(value, "hostPlayerId")) {
      if (value.hostPlayerId === CASPER_PLAYER_ID) invalid = true;
      add(value.hostPlayerId, active);
    }
    if (Object.hasOwn(value, "players") && value.players != null) {
      if (!Array.isArray(value.players)) invalid = true;
      else {
        const ids = new Set<string>();
        for (const player of value.players) {
          if (
            !record(player) ||
            typeof (player.playerId ?? player.id) !== "string" ||
            (player.playerId ?? player.id) === ""
          ) {
            invalid = true;
            continue;
          }
          const id = (player.playerId ?? player.id) as string;
          add(id, active);
          if (ids.has(id.toLowerCase())) invalid = true;
          ids.add(id.toLowerCase());
          if (profileFields.some((key) => Object.hasOwn(player, key))) named = true;
        }
      }
    }
    if (Object.hasOwn(value, "selectedPlayerIds")) {
      if (!Array.isArray(value.selectedPlayerIds)) invalid = true;
      else value.selectedPlayerIds.forEach((id) => add(id, active));
    }
    // Player structs in setup/game/baselines/event payloads/results. Event IDs
    // without a seat are event identities, not player identities.
    if (
      Object.hasOwn(value, "seat") &&
      (Object.hasOwn(value, "id") || Object.hasOwn(value, "playerId"))
    ) {
      if (profileFields.some((key) => Object.hasOwn(value, key))) named = true;
      if (
        (value.playerId ?? value.id) === CASPER_PLAYER_ID &&
        value.seat != null &&
        value.seat !== CASPER_SEAT
      )
        invalid = true;
      add(value.playerId ?? value.id, active);
    } else if (Object.hasOwn(value, "playerId")) {
      add(value.playerId, active);
      if (profileFields.some((key) => Object.hasOwn(value, key))) named = true;
    }
    Object.values(value).forEach((child) => visit(child, active));
  };
  visit(state, results === null); // Active selection is a property of the current snapshot.
  visit(results, false); // Completed results are historical identity references.
  if (record(state)) {
    const setup = record(state.setup) ? state.setup : null;
    const selected = new Set<unknown>(
      [
        ...(Array.isArray(setup?.selectedPlayerIds) ? setup.selectedPlayerIds : []),
        ...(record(setup?.setup) && Array.isArray(setup.setup.players)
          ? setup.setup.players.map((player: unknown) => (record(player) ? player.id : null))
          : []),
        ...(record(state.game) && Array.isArray(state.game.players)
          ? state.game.players.map((player: unknown) => (record(player) ? player.id : null))
          : []),
      ].map((id) => (typeof id === "string" ? id.toLowerCase() : id)),
    );
    const host = state.hostPlayerId ?? setup?.hostPlayerId;
    if (
      host === CASPER_PLAYER_ID ||
      (typeof host === "string" && host !== "" && selected.has(host.toLowerCase()))
    )
      invalid = true;
  }
  return { all, selected, invalid, named };
};

/** A shape guard only: no edition values, engine routing, decoding or resealing. */
export const hasEngineSelector = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasEngineSelector);
  if (!record(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "rulesEdition" ||
      key === "rulesetId" ||
      key === "rulesetVersion" ||
      hasEngineSelector(child),
  );
};
export const assertSupportedGame = (state: unknown, results: unknown): void => {
  if (
    inspectGameIdentities(state, results).named ||
    hasEngineSelector(state) ||
    hasEngineSelector(results)
  )
    throw new UnsupportedGameFormatError();
};
