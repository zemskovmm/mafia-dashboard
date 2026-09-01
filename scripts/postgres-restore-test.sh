#!/bin/sh
set -eu
umask 077
LC_ALL=C
export LC_ALL

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$script_directory/postgres-backup-common.sh"

[ "$#" -eq 1 ] || fail "usage: postgres-restore-test.sh ARCHIVE"
archive_path=$1
[ -f "$archive_path" ] && [ -s "$archive_path" ] || fail "archive must be a non-empty regular file"

assert_postgres_compatibility psql pg_restore createdb dropdb
psql_path=$(resolve_pg_tool psql)
dropdb_path=$(resolve_pg_tool dropdb)

random_suffix=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n') ||
  fail "unable to generate an isolated restore-test database name"
case "$random_suffix" in
  ????????????????) ;;
  *) fail "unable to generate an isolated restore-test database name" ;;
esac
case "$random_suffix" in
  *[!0-9a-f]*) fail "unable to generate an isolated restore-test database name" ;;
esac
target_database=mafia_restore_test_$(date -u '+%Y%m%d_%H%M%S')_$random_suffix
cleanup_target=
cleanup() {
  status=$?
  trap - 0
  if [ -n "$cleanup_target" ]; then
    if ! "$dropdb_path" --no-password --if-exists --force "$cleanup_target" >/dev/null; then
      printf 'error=unable to remove isolated restore-test database\n' >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15

RESTORE_CLEANUP_ON_FAILURE=1 \
  "$script_directory/postgres-restore.sh" "$archive_path" "$target_database" >/dev/null
cleanup_target=$target_database

representative_game_id=${RESTORE_TEST_GAME_ID:-}
representative_club_id=${RESTORE_TEST_CLUB_ID:-}

validate_optional_uuid() {
  [ -z "$1" ] && return
  case "$1" in
    ????????-????-????-????-????????????) ;;
    *) fail "$2 must be a UUID" ;;
  esac
  case "$1" in
    *[!0-9a-fA-F-]*) fail "$2 must be a UUID" ;;
  esac
}

validate_optional_uuid "$representative_game_id" RESTORE_TEST_GAME_ID
validate_optional_uuid "$representative_club_id" RESTORE_TEST_CLUB_ID

game_predicate=TRUE
club_predicate=TRUE
[ -z "$representative_game_id" ] || game_predicate="session.id = '$representative_game_id'::uuid"
[ -z "$representative_club_id" ] || club_predicate="session.club_id = '$representative_club_id'::uuid"

validation=$(
  "$psql_path" --no-password -XAtv ON_ERROR_STOP=1 --dbname="$target_database" \
    -c "WITH RECURSIVE representative AS (
          SELECT session.*
            FROM game_sessions AS session
           WHERE $game_predicate
             AND $club_predicate
           ORDER BY session.updated_at DESC, session.club_id, session.id
           LIMIT 1
        ),
        canonical_events AS (
          SELECT event.*
            FROM game_events AS event
            JOIN representative AS session
              ON session.club_id = event.club_id AND session.id = event.game_id
           WHERE event.replay_sequence IS NOT NULL
        ),
        event_chain AS (
          SELECT event.id, event.parent_event_id
            FROM canonical_events AS event
            JOIN representative AS session ON session.head_event_id = event.id
          UNION
          SELECT parent.id, parent.parent_event_id
            FROM canonical_events AS parent
            JOIN event_chain AS child ON child.parent_event_id = parent.id
        ),
        metrics AS (
          SELECT session.id,
                 session.club_id,
                 session.status,
                 session.revision,
                 COUNT(DISTINCT event.id)::integer AS event_count,
                 MIN(event.replay_sequence) AS first_sequence,
                 MAX(event.replay_sequence) AS last_sequence,
                 (SELECT COUNT(*)::integer FROM event_chain) AS chain_count,
                 COUNT(DISTINCT player.player_id)::integer AS participant_count,
                 COUNT(DISTINCT player.player_id) FILTER (WHERE NOT player.is_host)::integer AS non_host_count,
                 JSONB_ARRAY_LENGTH(
                   CASE
                     WHEN JSONB_TYPEOF(session.state -> 'game' -> 'players') = 'array'
                       THEN session.state -> 'game' -> 'players'
                     ELSE '[]'::jsonb
                   END
                 ) AS state_player_count,
                 (SELECT COUNT(*)::integer
                    FROM game_session_players AS projection
                   WHERE projection.club_id = session.club_id
                     AND projection.game_id = session.id
                     AND NOT projection.is_host
                     AND NOT EXISTS (
                       SELECT 1
                         FROM JSONB_ARRAY_ELEMENTS(
                           CASE
                             WHEN JSONB_TYPEOF(session.state -> 'game' -> 'players') = 'array'
                               THEN session.state -> 'game' -> 'players'
                             ELSE '[]'::jsonb
                           END
                         ) AS state_player
                        WHERE state_player ->> 'id' = projection.player_id::text
                          AND state_player ->> 'seat' = projection.seat::text
                          AND state_player ->> 'role' = projection.role
                     )) AS projection_mismatch_count,
                 (SELECT COUNT(*)::integer
                    FROM canonical_events AS child
                   WHERE (child.replay_sequence = 1 AND child.parent_event_id IS NOT NULL)
                      OR (
                        child.replay_sequence > 1
                        AND (
                          child.parent_event_id IS NULL
                          OR NOT EXISTS (
                            SELECT 1
                              FROM canonical_events AS parent
                             WHERE parent.id = child.parent_event_id
                               AND parent.replay_sequence = child.replay_sequence - 1
                          )
                        )
                      )) AS broken_parent_count,
                 (SELECT COUNT(*)::integer
                    FROM game_results AS result
                   WHERE result.club_id = session.club_id AND result.game_id = session.id) AS result_count,
                 (SELECT COUNT(*)::integer
                    FROM game_player_results AS result
                   WHERE result.club_id = session.club_id AND result.game_id = session.id) AS player_result_count,
                 COUNT(club.id)::integer AS club_count,
                 COUNT(ruleset.id)::integer AS ruleset_count
            FROM representative AS session
            LEFT JOIN canonical_events AS event ON TRUE
            LEFT JOIN game_session_players AS player
              ON player.club_id = session.club_id AND player.game_id = session.id
            LEFT JOIN clubs AS club ON club.id = session.club_id
            LEFT JOIN game_rulesets AS ruleset
              ON ruleset.id = session.ruleset_id AND ruleset.version = session.ruleset_version
           GROUP BY session.id, session.club_id, session.status, session.revision, session.state
        )
        SELECT CONCAT_WS('|', id, status, revision, event_count, participant_count, result_count)
          FROM metrics
         WHERE revision > 0
           AND club_count > 0
           AND ruleset_count > 0
           AND event_count > 0
           AND first_sequence = 1
           AND last_sequence = event_count
           AND chain_count = event_count
           AND broken_parent_count = 0
           AND participant_count > 0
           AND state_player_count = non_host_count
           AND projection_mismatch_count = 0
           AND (
             (status = 'active' AND result_count = 0 AND player_result_count = 0)
             OR
             (status = 'completed' AND result_count = 1 AND player_result_count = non_host_count)
           )"
) || fail "representative restore validation query failed"
[ -n "$validation" ] || fail "restored database has no valid representative game"

IFS='|' read -r restored_game_id restored_status restored_revision restored_events \
  restored_participants restored_results <<EOF
$validation
EOF
[ -n "$restored_results" ] || fail "representative restore validation returned an unexpected result"

printf 'restore_test_status=ok\n'
printf 'target_database=%s\n' "$target_database"
printf 'game_id=%s\n' "$restored_game_id"
printf 'game_status=%s\n' "$restored_status"
printf 'game_revision=%s\n' "$restored_revision"
printf 'canonical_event_count=%s\n' "$restored_events"
printf 'participant_count=%s\n' "$restored_participants"
printf 'result_count=%s\n' "$restored_results"
