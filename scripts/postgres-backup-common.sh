#!/bin/sh

fail() {
  printf 'error=%s\n' "$1" >&2
  exit 1
}

require_directory() {
  [ -d "$1" ] || fail "$2 is not an existing directory"
}

require_nonnegative_integer() {
  case "$2" in
    ''|*[!0-9]*) fail "$1 must be a non-negative integer" ;;
  esac
}

resolve_pg_tool() {
  tool_name=$1
  if [ -n "${PG_TOOL_DIR:-}" ]; then
    tool_path=$PG_TOOL_DIR/$tool_name
    [ -x "$tool_path" ] || fail "$tool_name is not executable in PG_TOOL_DIR"
  else
    tool_path=$(command -v "$tool_name") || fail "$tool_name is not available on PATH"
  fi
  printf '%s\n' "$tool_path"
}

postgres_tool_major() {
  tool_path=$1
  version_output=$("$tool_path" --version) || fail "unable to read PostgreSQL tool version"
  case "$version_output" in
    *"(PostgreSQL) "*) version=${version_output#*"(PostgreSQL) "} ;;
    *) fail "unable to parse PostgreSQL tool version" ;;
  esac
  version=${version%% *}
  major=${version%%.*}
  case "$major" in
    ''|*[!0-9]*) fail "unable to parse PostgreSQL tool version" ;;
  esac
  printf '%s\n' "$major"
}

assert_postgres_compatibility() {
  expected_major=${POSTGRES_MAJOR:-17}
  require_nonnegative_integer POSTGRES_MAJOR "$expected_major"
  [ "$expected_major" -gt 0 ] || fail "POSTGRES_MAJOR must be greater than zero"

  for required_tool in "$@"; do
    required_path=$(resolve_pg_tool "$required_tool")
    required_major=$(postgres_tool_major "$required_path")
    [ "$required_major" = "$expected_major" ] ||
      fail "$required_tool major $required_major does not match required PostgreSQL major $expected_major"
  done

  psql_path=$(resolve_pg_tool psql)
  server_version_num=$("$psql_path" --no-password -XAtv ON_ERROR_STOP=1 -c 'SHOW server_version_num') ||
    fail "unable to read PostgreSQL server version"
  case "$server_version_num" in
    ''|*[!0-9]*) fail "PostgreSQL returned an invalid server version" ;;
  esac
  server_major=$((server_version_num / 10000))
  [ "$server_major" = "$expected_major" ] ||
    fail "server major $server_major does not match required PostgreSQL major $expected_major"
}

run_backup_failure_hook() {
  reason=$1
  status=$2
  hook=${BACKUP_FAILURE_HOOK:-}
  [ -n "$hook" ] || return 0
  if [ ! -x "$hook" ]; then
    printf 'warning=backup failure hook is not executable\n' >&2
    return 0
  fi
  "$hook" "$reason" "$status" ||
    printf 'warning=backup failure hook failed\n' >&2
}
