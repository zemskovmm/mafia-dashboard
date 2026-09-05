# PostgreSQL backup and recovery

This runbook defines the production recovery checkpoint for Mafia Dashboard. A successful backup is a private PostgreSQL custom archive that has been structurally inspected, copied to an off-server destination, and later restored into an isolated database with application-level checks.

## Recovery contract

- **Backup class:** one-database logical dump in PostgreSQL custom format (`pg_dump --format=custom`).
- **Default schedule:** daily at 02:15 UTC.
- **Default retention:** 14 days on the application host and 30 days on the off-server mount. Both values are configurable.
- **Restore test:** after setup, after every PostgreSQL major upgrade, and at least weekly against a known game.
- **Recovery-point objective:** no more than 24 hours only while the daily job and off-server copy are succeeding. Use base backups plus WAL archiving if that loss window is unacceptable.
- **Recovery-time objective:** target two hours for the single-server baseline; measure and revise it from periodic drills.
- **Included:** one application database, schema, indexes, constraints, and rows.
- **Excluded:** PostgreSQL cluster roles and tablespaces, object-storage credentials, volume snapshots, and point-in-time recovery. Recreate the application role from protected deployment configuration before restoring to a new cluster.

A Docker volume is not a backup. The off-server path must be a separately managed encrypted mount or synchronized filesystem whose failure is independent of the application host.

## Workflows

| Entry point                                           | Purpose                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/postgres-backup.sh`                          | Create, inspect, publish, mirror, and retain a timestamped archive.                                                              |
| `scripts/postgres-restore.sh ARCHIVE TARGET_DATABASE` | Inspect a trusted archive and restore it into a new database.                                                                    |
| `scripts/postgres-restore-test.sh ARCHIVE`            | Restore into a unique temporary database, validate representative game semantics, and remove the database on success or failure. |
| `npm run verify:backup`                               | Execute the repository's disposable PostgreSQL 17 backup/restore drill.                                                          |

All shell workflows require `psql`, `pg_dump`, `pg_restore`, `createdb`, and `dropdb` from the same PostgreSQL major as the server. The current baseline enforces major 17. Set `PG_TOOL_DIR` only when those binaries are outside `PATH`; set `POSTGRES_MAJOR` only for an intentional, separately tested major upgrade.

The scripts use standard libpq variables such as `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSERVICE`, `PGPASSFILE`, and TLS variables. Do not put a password in a command argument, repository file, log, or archive name. Prefer a mode-`0600` `.pgpass`/`PGPASSFILE`, a protected service environment, or the platform's secret manager.

## Configure storage

Create two existing directories before scheduling the job:

```bash
sudo install -d -m 0700 -o root -g root /var/backups/mafia-dashboard
sudo install -d -m 0700 -o root -g root /mnt/offsite/mafia-dashboard
```

`/mnt/offsite/mafia-dashboard` is only an example. It must be backed by storage outside the application host, and the scheduler must fail when that mount is unavailable rather than silently writing to the underlying local mount point. Configure equivalent paths in the protected deployment `.env`:

```dotenv
BACKUP_LOCAL_DIR=/var/backups/mafia-dashboard
BACKUP_OFFSITE_DIR=/mnt/offsite/mafia-dashboard
BACKUP_RETENTION_DAYS=14
BACKUP_OFFSITE_RETENTION_DAYS=30
```

The backup workflow:

1. checks every PostgreSQL client and the source server major;
2. writes a private partial archive in the final local directory;
3. requires non-zero size and a successful `pg_restore --list`;
4. atomically publishes `mafia-dashboard-YYYYMMDDTHHMMSSZ.dump`;
5. byte-verifies and atomically publishes the off-server copy;
6. applies each directory's retention only after both publications succeed.

It never prunes partial files, unrelated names, or any archive after a failed dump/copy. If the off-server copy fails, the verified local archive remains and the command exits non-zero.

## Back up bundled Compose PostgreSQL

`compose.postgres-tools.yaml` adds an on-demand PostgreSQL 17 client container on the private Compose network. It is profile-gated and does not run during ordinary application startup.

```bash
docker compose \
  -f compose.yaml \
  -f compose.postgres-tools.yaml \
  --profile postgres-tools \
  run --rm postgres-tools \
  /opt/mafia/scripts/postgres-backup.sh
```

The one-off container receives the same database identity as the bundled `db` service, mounts the scripts read-only, and writes only to the two configured backup directories. A successful command prints the local `archive=...` and `offsite_archive=...` paths without printing credentials or row data.

## Back up external PostgreSQL

Install PostgreSQL 17 client tools on the operations host and provide protected libpq configuration. The following names are examples, not credentials:

```bash
export PGHOST=db.internal.example
export PGPORT=5432
export PGUSER=mafia_backup
export PGDATABASE=mafia
export PGPASSFILE=/run/secrets/mafia-pgpass
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/etc/ssl/certs/database-ca.pem
export BACKUP_DIR=/var/backups/mafia-dashboard
export BACKUP_OFFSITE_DIR=/mnt/offsite/mafia-dashboard
export BACKUP_RETENTION_DAYS=14
export BACKUP_OFFSITE_RETENTION_DAYS=30
./scripts/postgres-backup.sh
```

Use a database role with enough read access for `pg_dump` and no application write privileges. Managed PostgreSQL providers may offer additional physical/PITR backups; keep their policy separate and test both recovery paths.

## Schedule and alert

The following systemd units are a production scheduling example for the bundled Compose deployment. Install them under `/etc/systemd/system/`, adjust `WorkingDirectory`, and run the service as an account allowed to access Docker and both protected backup directories.

`mafia-backup.service`:

```ini
[Unit]
Description=Mafia Dashboard PostgreSQL backup
RequiresMountsFor=/mnt/offsite/mafia-dashboard
OnFailure=mafia-backup-alert@%n.service

[Service]
Type=oneshot
WorkingDirectory=/srv/mafia-dashboard
ExecStart=/usr/bin/docker compose -f compose.yaml -f compose.postgres-tools.yaml --profile postgres-tools run --rm postgres-tools /opt/mafia/scripts/postgres-backup.sh
```

`mafia-backup.timer`:

```ini
[Unit]
Description=Daily Mafia Dashboard PostgreSQL backup

[Timer]
OnCalendar=*-*-* 02:15:00 UTC
Persistent=true
RandomizedDelaySec=10m
Unit=mafia-backup.service

[Install]
WantedBy=timers.target
```

`mafia-backup-alert@.service` is the failure-alert integration point:

```ini
[Unit]
Description=Alert for failed Mafia Dashboard backup unit %i

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/notify-mafia-backup-failure %i
```

The notifier must send only the unit name/status and retrieve details from protected journal access; it must not include environment files, connection strings, credentials, or row payloads. For direct execution, `BACKUP_FAILURE_HOOK=/absolute/executable` provides the same integration: the executable receives a stable reason and numeric exit status.

Enable and test the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mafia-backup.timer
sudo systemctl start mafia-backup.service
systemctl status mafia-backup.service mafia-backup.timer
```

Monitor all of the following:

- non-zero service exits and alert delivery;
- newest local and off-server archive age/size;
- off-server mount health and free space;
- weekly restore-test success and duration;
- unexpected retention gaps or permission changes.

An archive's existence alone is not success.

## Restore safely

Treat an archive as trusted executable input: restoring it can execute SQL chosen by the archive producer. Accept only archives from the protected backup destination and verify custody before use.

The restore workflow refuses the connected source database and any existing target. It creates the target from `template0`, restores with `--exit-on-error --single-transaction --no-owner --no-privileges`, and runs `ANALYZE`. It never drops or overwrites the damaged/source database.

For bundled Compose PostgreSQL:

```bash
docker compose \
  -f compose.yaml \
  -f compose.postgres-tools.yaml \
  --profile postgres-tools \
  run --rm postgres-tools \
  /opt/mafia/scripts/postgres-restore.sh \
  /backups/local/mafia-dashboard-YYYYMMDDTHHMMSSZ.dump \
  mafia_recovered_YYYYMMDD
```

For external PostgreSQL, configure the target cluster through protected libpq variables and run the same script directly. The connected role must be able to create databases. If the restore fails after target creation, preserve the fresh target for diagnosis or remove it explicitly before retrying; the script never guesses that destructive cleanup is safe.

### Verify a representative game

A restore test requires at least one representative game. Set its identifiers when known; otherwise the script selects the latest game and fails rather than accepting an empty database.

```bash
export RESTORE_TEST_GAME_ID=00000000-0000-4000-8000-000000000000
export RESTORE_TEST_CLUB_ID=00000000-0000-4000-8000-000000000000
./scripts/postgres-restore-test.sh /secure/path/mafia-dashboard-YYYYMMDDTHHMMSSZ.dump
```

For the bundled Compose service, export the identifiers only in the operator shell and forward their names without values on the command line:

```bash
docker compose \
  -f compose.yaml \
  -f compose.postgres-tools.yaml \
  --profile postgres-tools \
  run --rm \
  --env RESTORE_TEST_GAME_ID \
  --env RESTORE_TEST_CLUB_ID \
  postgres-tools \
  /opt/mafia/scripts/postgres-restore-test.sh \
  /backups/local/mafia-dashboard-YYYYMMDDTHHMMSSZ.dump
```

Do not put real identifiers in the repository.

The test proves:

- the club and ruleset references exist;
- revision/status are valid;
- canonical replay sequences and the parent chain reach the session head;
- player/seat/role projections match the authoritative game snapshot;
- completed games have corresponding aggregate and player result rows;
- the isolated database is removed on success and failure.

It reports identifiers, statuses, and counts only—not private state or secret event payloads.

## Disaster recovery cutover

1. Declare the incident, stop application writes, and record the current application image/database target.
2. Preserve the damaged database/volume. Do not overwrite or delete it.
3. Select the newest verified off-server archive that predates the corruption.
4. Provision the destination PostgreSQL major and application role from protected deployment configuration.
5. Restore to a new database name with `postgres-restore.sh`.
6. Run `postgres-restore-test.sh` against the same archive and independently inspect the recovered known game.
7. Verify that the recovered schema and stored formats match the intended application image. Historical archives are not upgraded automatically. Only after that check, update the protected `DATABASE_URL`, run the one-shot current-schema initialization/validation job, and start the application. Preserve an incompatible recovery target; do not reset it to bypass validation.
8. Verify `/health/live`, `/health/ready`, authentication, club isolation, and the known game before reopening writes.
9. Observe the service and retain the damaged source plus previous connection configuration until recovery is accepted.
10. Record elapsed time, recovered archive timestamp, actual data-loss window, and follow-up actions without recording secrets or private game payloads.

## PostgreSQL upgrades

Create the pre-upgrade archive with clients matching the source major. Before cutover, restore that archive into a disposable instance of the intended target major using target-major `pg_restore`, set `POSTGRES_MAJOR` to that target major for the test, and repeat semantic verification. Do not assume an application rollback reverses a database migration or PostgreSQL major upgrade.

The custom archive is portable across supported upgrades, but compatibility is proven by restore—not by archive creation. Keep the old server and archive until the new application/database pair passes acceptance.

## Encryption and access controls

- Scripts set `umask 077`; finalized archives are mode `0600`.
- Backup directories and mount points must be mode `0700` and available only to the backup/restore operator.
- Encrypt local storage and off-server storage at rest; manage keys outside this repository and separately from the copied archive.
- Encrypt transport to external PostgreSQL and remote storage; use certificate verification where supported.
- Do not back up `.env`, `.pgpass`, OAuth secrets, token-encryption keys, service credentials, or logs alongside database archives.
- Audit read/delete access and test key recovery. Losing the encryption key is equivalent to losing the backup.

## Verified drill evidence

On 2026-09-01, `npm run verify:backup` executed the actual shell entry points against a disposable `postgres:17-alpine` server, the real schema, and a non-secret completed game with relational event, participant, game-result, and player-result projections. It also rejected a deliberately corrupted event-parent chain, exercised a missing-database failure, and proved that both failure paths cleaned their isolated state without publishing a corrupt artifact. Redacted output:

```text
postgres_client=pg_dump (PostgreSQL) 17.11
postgres_server=17.11
archive=mafia-dashboard-20260901T121625Z.dump
archive_bytes=43486
offsite_copy=byte_verified
isolated_restore_test=semantic_checks_passed
representative_game=00000000-0000-4000-8000-000000000901 revision=7 canonical_events=2 participants=1 winner=red result_rows=1
isolated_database_cleanup=verified
semantic_failure_path=invalid_parent_chain_rejected
failure_path=no_finalized_artifact
cleanup=container_and_temporary_files_removed
backup_restore_drill=ok
```

The verifier removes its container, databases, temporary files, generated password, and archives even on failure. Run it again after changes to the schema or backup workflows:

```bash
npm run test:backup-contracts
npm run verify:backup
```

## References

- [PostgreSQL 17: Backup and Restore](https://www.postgresql.org/docs/17/backup.html)
- [PostgreSQL 17: `pg_dump`](https://www.postgresql.org/docs/17/app-pgdump.html)
- [PostgreSQL 17: `pg_restore`](https://www.postgresql.org/docs/17/app-pgrestore.html)
