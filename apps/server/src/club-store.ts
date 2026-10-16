import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AppUser } from "./google-auth.js";

export const DEFAULT_CLUB_ID = "00000000-0000-4000-8000-000000000101";
export type ClubLanguage = "en" | "ru";
export type ClubRole = "manager" | "user";

interface ClubDetails {
  readonly name: string;
  readonly city: string;
  readonly headerLogo: string | null;
  readonly cardLogo: string | null;
  readonly language: ClubLanguage;
  readonly bestMoveEnabled: boolean;
}

export interface ClubInput extends Omit<ClubDetails, "bestMoveEnabled"> {
  readonly bestMoveEnabled?: boolean;
  readonly ownerConsent: true;
}

export interface Club extends ClubDetails {
  readonly id: string;
  readonly role: ClubRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ClubRow {
  id: string;
  name: string;
  city: string;
  header_logo: string | null;
  card_logo: string | null;
  language_code: ClubLanguage;
  best_move_enabled: boolean;
  role: ClubRole;
  created_at: Date;
  updated_at: Date;
}

const mapClub = (row: ClubRow): Club => ({
  id: row.id,
  name: row.name,
  city: row.city,
  headerLogo: row.header_logo,
  cardLogo: row.card_logo,
  language: row.language_code,
  bestMoveEnabled: row.best_move_enabled,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const splitDisplayName = (displayName: string): readonly [string, string] => {
  const normalized = displayName.trim();
  const separator = normalized.search(/\s/);
  if (separator === -1) return [normalized, normalized];
  return [normalized.slice(0, separator), normalized.slice(separator).trim()];
};

export class ClubStore {
  public constructor(private readonly pool: Pool) {}

  public async listForUser(userId: string): Promise<readonly Club[]> {
    const result = await this.pool.query<ClubRow>(
      `SELECT club.id, club.name, club.city, club.header_logo, club.card_logo, club.language_code,
              club.best_move_enabled,
              membership.role, club.created_at, club.updated_at
         FROM clubs AS club
         JOIN club_memberships AS membership ON membership.club_id = club.id
        WHERE membership.user_id = $1
        ORDER BY LOWER(club.name), club.id`,
      [userId],
    );
    return result.rows.map(mapClub);
  }

  public async isMember(userId: string, clubId: string): Promise<boolean> {
    return (await this.getRole(userId, clubId)) !== null;
  }

  public async getRole(userId: string, clubId: string): Promise<ClubRole | null> {
    const result = await this.pool.query<{ role: ClubRole }>(
      "SELECT role FROM club_memberships WHERE user_id = $1 AND club_id = $2",
      [userId, clubId],
    );
    return result.rows[0]?.role ?? null;
  }

  public async create(userOrId: AppUser | string, input: ClubInput): Promise<Club> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user =
        typeof userOrId === "string"
          ? (
              await client.query<{
                id: string;
                email: string;
                name: string;
                picture: string | null;
              }>(
                `SELECT id, email, display_name AS name, picture
                   FROM users
                  WHERE id = $1`,
                [userOrId],
              )
            ).rows[0]
          : userOrId;
      if (user === undefined) throw new Error("Club creator user was not found");
      const userId = user.id;
      const clubId = randomUUID();
      await client.query(
        `INSERT INTO clubs
           (id, name, city, header_logo, card_logo, language_code, best_move_enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          clubId,
          input.name.trim(),
          input.city.trim(),
          input.headerLogo,
          input.cardLogo,
          input.language,
          input.bestMoveEnabled ?? true,
          userId,
        ],
      );
      await client.query(
        `INSERT INTO club_memberships (club_id, user_id, role)
         VALUES ($1, $2, 'manager')`,
        [clubId, userId],
      );
      const [firstName, lastName] = splitDisplayName(user.name);
      await client.query(
        `INSERT INTO players
           (id, club_id, nickname, first_name, last_name, email,
            data_processing_consent, consent_at, club_access, user_id)
         VALUES ($1, $2, 'Owner', $3, $4, $5, TRUE, NOW(), 'manager', $6)`,
        [randomUUID(), clubId, firstName, lastName, user.email, userId],
      );
      const result = await client.query<ClubRow>(
        `SELECT club.id, club.name, club.city, club.header_logo, club.card_logo, club.language_code,
                club.best_move_enabled,
                membership.role, club.created_at, club.updated_at
           FROM clubs AS club
           JOIN club_memberships AS membership ON membership.club_id = club.id
          WHERE club.id = $1 AND membership.user_id = $2`,
        [clubId, userId],
      );
      await client.query("COMMIT");
      return mapClub(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimClubAccess(userId: string, verifiedEmail: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const matching = await client.query<{
        id: string;
        club_id: string;
        club_access: ClubRole;
        user_id: string | null;
      }>(
        `SELECT id, club_id, club_access, user_id
           FROM players
          WHERE club_access <> 'none'
            AND LOWER(BTRIM(email)) = LOWER(BTRIM($1))
          ORDER BY club_id, id
          FOR UPDATE`,
        [verifiedEmail],
      );
      for (const player of matching.rows) {
        if (player.user_id !== null && player.user_id !== userId) continue;
        if (player.user_id === null) {
          await client.query(
            "UPDATE players SET user_id = $1, updated_at = NOW() WHERE id = $2 AND club_id = $3",
            [userId, player.id, player.club_id],
          );
        }
        await client.query(
          `INSERT INTO club_memberships (club_id, user_id, role, access_player_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (club_id, user_id) DO UPDATE
             SET role = EXCLUDED.role
           WHERE club_memberships.access_player_id = EXCLUDED.access_player_id`,
          [player.club_id, userId, player.club_access, player.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async update(
    userId: string,
    clubId: string,
    input: Omit<ClubInput, "ownerConsent">,
  ): Promise<Club | null> {
    const result = await this.pool.query<ClubRow>(
      `WITH editable AS (
         SELECT club_id, role
           FROM club_memberships
          WHERE user_id = $1 AND club_id = $2 AND role = 'manager'
       ), updated AS (
         UPDATE clubs AS club
            SET name = $3, city = $4, header_logo = $5, card_logo = $6,
                language_code = $7,
                best_move_enabled = COALESCE($8, club.best_move_enabled),
                updated_at = NOW()
           FROM editable
          WHERE club.id = editable.club_id
          RETURNING club.*
       )
       SELECT updated.id, updated.name, updated.city, updated.header_logo, updated.card_logo,
              updated.language_code, updated.best_move_enabled,
              editable.role, updated.created_at, updated.updated_at
         FROM updated, editable`,
      [
        userId,
        clubId,
        input.name.trim(),
        input.city.trim(),
        input.headerLogo,
        input.cardLogo,
        input.language,
        input.bestMoveEnabled,
      ],
    );
    return result.rows[0] === undefined ? null : mapClub(result.rows[0]);
  }

  public async delete(userId: string, clubId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT 1
           FROM club_memberships
          WHERE user_id = $1 AND club_id = $2 AND role = 'manager'
          FOR UPDATE`,
        [userId, clubId],
      );
      if (owned.rowCount === 0) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `LOCK TABLE game_results, game_player_results, game_events, game_sessions,
                    game_session_players, players IN SHARE ROW EXCLUSIVE MODE`,
      );
      await client.query("DELETE FROM game_sessions WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM tournaments WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM game_events WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM game_results WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM deleted_games WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM game_daily_counters WHERE club_id = $1", [clubId]);
      await client.query("DELETE FROM players WHERE club_id = $1", [clubId]);
      await client.query(
        `INSERT INTO deleted_clubs (club_id) VALUES ($1)
         ON CONFLICT (club_id) DO NOTHING`,
        [clubId],
      );
      await client.query("DELETE FROM clubs WHERE id = $1", [clubId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
