import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const DEFAULT_CLUB_ID = "00000000-0000-4000-8000-000000000101";

export interface ClubInput {
  readonly name: string;
  readonly city: string;
  readonly headerLogo: string | null;
  readonly cardLogo: string | null;
}

export interface Club extends ClubInput {
  readonly id: string;
  readonly role: "owner" | "editor";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ClubRow {
  id: string;
  name: string;
  city: string;
  header_logo: string | null;
  card_logo: string | null;
  role: "owner" | "editor";
  created_at: Date;
  updated_at: Date;
}

const mapClub = (row: ClubRow): Club => ({
  id: row.id,
  name: row.name,
  city: row.city,
  headerLogo: row.header_logo,
  cardLogo: row.card_logo,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ClubStore {
  public constructor(private readonly pool: Pool) {}

  public async listForUser(userId: string): Promise<readonly Club[]> {
    const result = await this.pool.query<ClubRow>(
      `SELECT club.id, club.name, club.city, club.header_logo, club.card_logo,
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
    const result = await this.pool.query(
      "SELECT 1 FROM club_memberships WHERE user_id = $1 AND club_id = $2",
      [userId, clubId],
    );
    return result.rowCount !== 0;
  }

  public async create(userId: string, input: ClubInput): Promise<Club> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const clubId = randomUUID();
      await client.query(
        `INSERT INTO clubs (id, name, city, header_logo, card_logo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [clubId, input.name.trim(), input.city.trim(), input.headerLogo, input.cardLogo, userId],
      );
      await client.query(
        `INSERT INTO club_memberships (club_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [clubId, userId],
      );
      const result = await client.query<ClubRow>(
        `SELECT club.id, club.name, club.city, club.header_logo, club.card_logo,
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

  public async update(userId: string, clubId: string, input: ClubInput): Promise<Club | null> {
    const result = await this.pool.query<ClubRow>(
      `WITH editable AS (
         SELECT club_id, role
           FROM club_memberships
          WHERE user_id = $1 AND club_id = $2 AND role IN ('owner', 'editor')
       ), updated AS (
         UPDATE clubs AS club
            SET name = $3, city = $4, header_logo = $5, card_logo = $6, updated_at = NOW()
           FROM editable
          WHERE club.id = editable.club_id
          RETURNING club.*
       )
       SELECT updated.id, updated.name, updated.city, updated.header_logo, updated.card_logo,
              editable.role, updated.created_at, updated.updated_at
         FROM updated, editable`,
      [userId, clubId, input.name.trim(), input.city.trim(), input.headerLogo, input.cardLogo],
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
          WHERE user_id = $1 AND club_id = $2 AND role = 'owner'
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
