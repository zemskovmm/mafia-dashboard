#!/bin/sh
set -eu
umask 077
LC_ALL=C
export LC_ALL

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$script_directory/postgres-backup-common.sh"

cleanup_on_failure=${RESTORE_CLEANUP_ON_FAILURE:-0}
case "$cleanup_on_failure" in
  0|1) ;;
  *) fail "RESTORE_CLEANUP_ON_FAILURE must be 0 or 1" ;;
esac
created_target=
dropdb_path=
cleanup() {
  status=$?
  trap - 0
  if [ "$status" -ne 0 ] && [ "$cleanup_on_failure" = 1 ] && [ -n "$created_target" ]; then
    if ! "$dropdb_path" --no-password --if-exists --force "$created_target" >/dev/null; then
      printf 'warning=unable to remove failed restore target\n' >&2
    fi
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15

[ "$#" -eq 2 ] || fail "usage: postgres-restore.sh ARCHIVE TARGET_DATABASE"
archive_path=$1
target_database=$2

[ -f "$archive_path" ] && [ -s "$archive_path" ] || fail "archive must be a non-empty regular file"
case "$target_database" in
  ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) fail "target database name is invalid" ;;
esac
[ "${#target_database}" -le 63 ] || fail "target database name exceeds PostgreSQL's limit"

assert_postgres_compatibility psql pg_restore createdb dropdb
psql_path=$(resolve_pg_tool psql)
pg_restore_path=$(resolve_pg_tool pg_restore)
createdb_path=$(resolve_pg_tool createdb)
dropdb_path=$(resolve_pg_tool dropdb)

"$pg_restore_path" --list "$archive_path" >/dev/null || fail "archive inspection failed"

source_database=$("$psql_path" --no-password -XAtv ON_ERROR_STOP=1 -c 'SELECT current_database()') ||
  fail "unable to identify the source database"
[ -n "$source_database" ] || fail "PostgreSQL returned an empty source database name"
[ "$target_database" != "$source_database" ] || fail "restore target must not be the source database"

target_exists=$(
  "$psql_path" --no-password -XAtv ON_ERROR_STOP=1 \
    -c "SELECT 1 FROM pg_database WHERE datname = '$target_database'"
) || fail "unable to inspect restore target"
[ -z "$target_exists" ] || fail "restore target already exists"

"$createdb_path" --no-password --template=template0 "$target_database"
created_target=$target_database
"$pg_restore_path" --no-password --exit-on-error --single-transaction --no-owner --no-privileges \
  --dbname="$target_database" "$archive_path"
"$psql_path" --no-password -Xv ON_ERROR_STOP=1 --dbname="$target_database" \
  -c 'ANALYZE' >/dev/null

printf 'restore_status=ok\n'
printf 'target_database=%s\n' "$target_database"
