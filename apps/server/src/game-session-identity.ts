import { CASPER_PLAYER_ID, CASPER_SEAT } from "@mafia/game-domain";
import type { PoolClient } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileFields = ["name", "nickname", "firstName", "lastName", "email", "hostName"];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class UnsupportedGameFormatError extends Error {
  readonly code = "unsupported_game_format";
  constructor() {
    super("Unsupported name-bearing game record");
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
    if (Object.hasOwn(value, "hostPlayerId")) add(value.hostPlayerId, active);
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
      if ((value.playerId ?? value.id) === CASPER_PLAYER_ID && value.seat !== CASPER_SEAT)
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
    const selected = new Set<unknown>([
      ...(Array.isArray(setup?.selectedPlayerIds) ? setup.selectedPlayerIds : []),
      ...(record(setup?.setup) && Array.isArray(setup.setup.players)
        ? setup.setup.players.map((player: unknown) => (record(player) ? player.id : null))
        : []),
      ...(record(state.game) && Array.isArray(state.game.players)
        ? state.game.players.map((player: unknown) => (record(player) ? player.id : null))
        : []),
    ]);
    const host = state.hostPlayerId ?? setup?.hostPlayerId;
    if (
      host === CASPER_PLAYER_ID ||
      (host !== null && host !== undefined && host !== "" && selected.has(host))
    )
      invalid = true;
  }
  return { all, selected, invalid, named };
};

export const assertSupportedGame = (state: unknown, results: unknown): void => {
  if (inspectGameIdentities(state, results).named) throw new UnsupportedGameFormatError();
};

export const validateGameIdentities = async (
  client: PoolClient,
  clubId: string,
  state: unknown,
  results: unknown,
  newSelection: boolean,
): Promise<void> => {
  const refs = inspectGameIdentities(state, results);
  if (refs.named) throw new UnsupportedGameFormatError();
  if (refs.invalid || (record(state) && state.hostPlayerId === CASPER_PLAYER_ID)) {
    throw new InvalidGameIdentityError();
  }
  const ids = [...refs.all].sort();
  if (ids.length === 0) return;
  // Deletion and save take the same projection-table locks before these row
  // locks. Locking rows also serializes with profile retirement, regardless of
  // whether the relational projection is present or consistent.
  const players = await client.query<{ id: string; retired_at: Date | null }>(
    "SELECT id, retired_at FROM players WHERE club_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE",
    [clubId, ids],
  );
  if (
    players.rows.length !== ids.length ||
    players.rows.some(
      (row) => row.retired_at !== null && (newSelection || refs.selected.has(row.id)),
    )
  ) {
    throw new InvalidGameIdentityError();
  }
};
