#!/bin/sh
set -eu
umask 077
LC_ALL=C
export LC_ALL

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$script_directory/postgres-backup-common.sh"

partial_archive=
partial_offsite=
archive_lock=
offsite_lock=
failure_reason=initialization
cleanup() {
  status=$?
  trap - 0
  [ -z "$partial_archive" ] || rm -f "$partial_archive"
  [ -z "$partial_offsite" ] || rm -f "$partial_offsite"
  [ -z "$archive_lock" ] || rmdir "$archive_lock" 2>/dev/null || true
  [ -z "$offsite_lock" ] || rmdir "$offsite_lock" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    run_backup_failure_hook "$failure_reason" "$status"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 130' 2
trap 'exit 143' 15

backup_directory=${BACKUP_DIR:?Set BACKUP_DIR to an existing protected directory}
backup_prefix=${BACKUP_PREFIX:-mafia-dashboard}
retention_days=${BACKUP_RETENTION_DAYS:-14}
offsite_directory=${BACKUP_OFFSITE_DIR:-}
offsite_retention_days=${BACKUP_OFFSITE_RETENTION_DAYS:-30}

case "$backup_prefix" in
  ''|*[!A-Za-z0-9._-]*|.*|-*) fail "BACKUP_PREFIX contains unsupported characters" ;;
esac
require_nonnegative_integer BACKUP_RETENTION_DAYS "$retention_days"
require_directory "$backup_directory" BACKUP_DIR
if [ -n "$offsite_directory" ]; then
  require_nonnegative_integer BACKUP_OFFSITE_RETENTION_DAYS "$offsite_retention_days"
  require_directory "$offsite_directory" BACKUP_OFFSITE_DIR
  backup_directory_canonical=$(CDPATH='' cd -- "$backup_directory" && pwd -P)
  offsite_directory_canonical=$(CDPATH='' cd -- "$offsite_directory" && pwd -P)
  [ "$backup_directory_canonical" != "$offsite_directory_canonical" ] ||
    fail "BACKUP_OFFSITE_DIR must differ from BACKUP_DIR"
fi

failure_reason=version-check
assert_postgres_compatibility psql pg_dump pg_restore
pg_dump_path=$(resolve_pg_tool pg_dump)
pg_restore_path=$(resolve_pg_tool pg_restore)

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
archive_name=$backup_prefix-$timestamp.dump
archive_path=$backup_directory/$archive_name
partial_archive=$archive_path.partial.$$
archive_lock_path=$archive_path.lock
[ ! -e "$archive_path" ] && [ ! -L "$archive_path" ] || fail "backup archive already exists"
[ ! -e "$partial_archive" ] && [ ! -L "$partial_archive" ] || fail "backup partial file already exists"
mkdir "$archive_lock_path" || fail "backup archive publication is already in progress"
archive_lock=$archive_lock_path

failure_reason=dump
"$pg_dump_path" --no-password --format=custom --file="$partial_archive"
[ -s "$partial_archive" ] || fail "pg_dump produced an empty archive"

failure_reason=archive-validation
"$pg_restore_path" --list "$partial_archive" >/dev/null
chmod 600 "$partial_archive"
mv "$partial_archive" "$archive_path"
partial_archive=
rmdir "$archive_lock"
archive_lock=

if [ -n "$offsite_directory" ]; then
  failure_reason=offsite-copy
  offsite_path=$offsite_directory/$archive_name
  partial_offsite=$offsite_path.partial.$$
  offsite_lock_path=$offsite_path.lock
  [ ! -e "$offsite_path" ] && [ ! -L "$offsite_path" ] ||
    fail "off-server backup archive already exists"
  [ ! -e "$partial_offsite" ] && [ ! -L "$partial_offsite" ] ||
    fail "off-server backup partial file already exists"
  mkdir "$offsite_lock_path" || fail "off-server backup publication is already in progress"
  offsite_lock=$offsite_lock_path
  cp "$archive_path" "$partial_offsite"
  cmp -s "$archive_path" "$partial_offsite" || fail "off-server backup verification failed"
  chmod 600 "$partial_offsite"
  mv "$partial_offsite" "$offsite_path"
  partial_offsite=
  rmdir "$offsite_lock"
  offsite_lock=
fi

failure_reason=retention
find "$backup_directory" -type f -name "$backup_prefix-????????T??????Z.dump" \
  -mtime "+$retention_days" -exec rm -f -- {} +
if [ -n "$offsite_directory" ]; then
  find "$offsite_directory" -type f -name "$backup_prefix-????????T??????Z.dump" \
    -mtime "+$offsite_retention_days" -exec rm -f -- {} +
fi

failure_reason=complete
printf 'backup_status=ok\n'
printf 'archive=%s\n' "$archive_path"
[ -z "$offsite_directory" ] || printf 'offsite_archive=%s\n' "$offsite_path"
