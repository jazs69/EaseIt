#!/usr/bin/env bash
# EaseIt database backups (BR-01..BR-03). Runs in the `backup` service, which
# uses the postgres:17 image so pg_dump always matches the server's major.
#
#   schedule          (default) one backup at start if the last good one is
#                     older than a day, then one every day at BACKUP_TIME (UTC)
#   now               dump, verify by restoring, prune; exit non-zero on failure
#   verify [FILE]     restore FILE (default: newest) into a scratch database,
#                     check it against its manifest, drop the scratch database
#   restore [FILE]    restore FILE (default: newest verified) into a NEW
#                     database <db>_restored_<stamp>, verify it, keep it
#   activate DB       swap a restored database in for the live one; refuses
#                     while anything is connected. The old one is kept as
#                     <db>_before_<stamp>, never dropped.
#   list              backups with size and verification result
#
# Every backup is three files plus a rehearsal record:
#   easeit-<stamp>.dump           pg_dump custom format
#   easeit-<stamp>.dump.sha256    its checksum
#   easeit-<stamp>.manifest       object inventory and per-table row counts,
#                                 read in the SAME snapshot as the dump
#   easeit-<stamp>.verified       written only after a restore of it passed
#
# Verification has four layers, all against the restored copy:
#   1. object inventory (tables, indexes, constraints by type, triggers, RLS
#      policies, functions, enums) equals the manifest;
#   2. the double-booking guards exist and every constraint is validated;
#   3. every table's row count equals the manifest;
#   4. business invariants: no oversold or negative inventory day, no
#      reservation_room without its reservation, no unfinished migration.
#
# Connection: the libpq variables PGHOST, PGUSER, PGPASSWORD, PGDATABASE (the
# owner login; the app role cannot read past row-level security).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_TIME="${BACKUP_TIME:-20:30}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-3}"
SOURCE_DB="${PGDATABASE:?PGDATABASE is required}"
GUARDS="'inventory_day_not_oversold','reservation_room_no_overlap','inventory_day_counters_non_negative','reservation_cancelled_at_matches_status'"

# Progress goes to stderr so stdout carries only results (a file name, a database).
log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
q() { psql -X -v ON_ERROR_STOP=1 -At "$@"; }

# The object inventory and per-table counts, one "key<TAB>value" per line,
# sorted. Run against the source inside the dump's snapshot and against the
# restored copy; the two outputs must be identical.
INVENTORY_SQL="
SELECT 'object' || E'\t' || k || E'\t' || v FROM (
  SELECT 'tables' AS k, count(*) AS v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  UNION ALL SELECT 'indexes', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('i', 'I')
  UNION ALL SELECT 'sequences', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  UNION ALL SELECT 'constraint_' || co.contype::text, count(*) FROM pg_constraint co
    JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = 'public' GROUP BY co.contype::text
  UNION ALL SELECT 'constraints_not_valid', count(*) FROM pg_constraint co
    JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = 'public' AND NOT co.convalidated
  UNION ALL SELECT 'triggers', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL SELECT 'rls_tables', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity
  UNION ALL SELECT 'policies', count(*) FROM pg_policies WHERE schemaname = 'public'
  UNION ALL SELECT 'functions', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  UNION ALL SELECT 'enums', count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
) s;
SELECT format('SELECT %L || E''\t'' || %L || E''\t'' || count(*) FROM public.%I', 'rows', c.relname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname
\gexec
"

newest() { # newest dump, optionally only verified ones
  local f
  for f in $(ls -1 "$BACKUP_DIR"/easeit-*.dump 2>/dev/null | sort -r); do
    if [ "${1:-}" != "verified" ] || [ -f "${f%.dump}.verified" ]; then echo "$f"; return 0; fi
  done
  return 1
}

dump() {
  mkdir -p "$BACKUP_DIR"
  local s base tmp snap line
  s="$(stamp)"
  base="$BACKUP_DIR/easeit-$s"
  tmp="$BACKUP_DIR/.partial-$s"
  log "dump of $SOURCE_DB -> $(basename "$base").dump"

  # One REPEATABLE READ transaction exports its snapshot, writes the manifest
  # from it, and stays open while pg_dump reads the same snapshot, so the
  # counts describe exactly what is in the file.
  coproc SNAP { psql -X -q -At -v ON_ERROR_STOP=1 -F $'\t' 2>&1; }
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&"${SNAP[1]}"
  read -r -t 30 snap <&"${SNAP[0]}" || die "could not export a snapshot"
  [[ "$snap" =~ ^[0-9A-F-]+$ ]] || die "unexpected snapshot id: $snap"
  { printf '%s\n' "$INVENTORY_SQL"; echo "SELECT '__END__';"; } >&"${SNAP[1]}"
  : > "$tmp.manifest"
  while read -r -t 300 line <&"${SNAP[0]}"; do
    [ "$line" = "__END__" ] && break
    case "$line" in object$'\t'* | rows$'\t'*) echo "$line" >> "$tmp.manifest" ;; *) die "manifest query: $line" ;; esac
  done
  [ "$line" = "__END__" ] || die "manifest query did not finish"

  pg_dump -Fc --snapshot="$snap" -f "$tmp.dump" "$SOURCE_DB"
  echo "COMMIT;" >&"${SNAP[1]}"
  exec {SNAP[1]}>&-
  wait "$SNAP_PID" || true

  sort -o "$tmp.manifest" "$tmp.manifest"
  sha256sum "$tmp.dump" | cut -d' ' -f1 > "$tmp.dump.sha256"
  mv "$tmp.manifest" "$base.manifest"
  mv "$tmp.dump.sha256" "$base.dump.sha256"
  mv "$tmp.dump" "$base.dump"
  log "dump written: $(du -h "$base.dump" | cut -f1), $(grep -c '^rows' "$base.manifest") tables"
  echo "$base.dump"
}

# Restore FILE into a NEW database TARGET and run the four layers against it.
restore_and_check() {
  local file="$1" target="$2" manifest="${1%.dump}.manifest" actual
  [ -f "$file" ] || die "no such backup: $file"
  [ -f "$manifest" ] && [ -f "$file.sha256" ] || die "$(basename "$file") has no manifest or checksum; refusing to trust it"
  [ "$target" != "$SOURCE_DB" ] || die "refusing to restore over the live database"

  log "checksum"
  [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$(cat "$file.sha256")" ] || die "checksum mismatch: $(basename "$file") is damaged"

  log "restore into new database $target"
  # createdb fails if the name exists: a restore never writes into a database
  # that already has anything in it. No owners/ACLs from the dump: the app
  # role's grants are re-asserted by `migrate` on the next start.
  createdb "$target"
  pg_restore --exit-on-error --no-owner --no-acl -d "$target" "$file"

  log "layers 1+3: object inventory and per-table row counts"
  actual="$(printf '%s\n' "$INVENTORY_SQL" | q -F $'\t' -d "$target" | sort)"
  if ! diff <(cat "$manifest") <(echo "$actual") > /tmp/manifest.diff; then
    sed 's/^/    /' /tmp/manifest.diff >&2
    die "restored copy differs from the manifest (< manifest, > restored)"
  fi

  log "layers 2+4: guards and business invariants"
  q -d "$target" -c "
    DO \$\$
    DECLARE guards int; not_valid int; oversold int; orphans int; unfinished int;
    BEGIN
      SELECT count(*) INTO guards FROM pg_constraint WHERE conname IN ($GUARDS);
      IF guards <> 4 THEN RAISE EXCEPTION 'restored copy has % of 4 double-booking guards', guards; END IF;
      SELECT count(*) INTO not_valid FROM pg_constraint WHERE NOT convalidated;
      IF not_valid <> 0 THEN RAISE EXCEPTION '% constraint(s) not validated', not_valid; END IF;
      SELECT count(*) INTO oversold FROM inventory_day
        WHERE sold < 0 OR blocked < 0 OR sold + blocked > physical + \"overbookingAllowance\";
      IF oversold <> 0 THEN RAISE EXCEPTION '% oversold or negative inventory day(s)', oversold; END IF;
      SELECT count(*) INTO orphans FROM reservation_room rr
        LEFT JOIN reservation r ON r.id = rr.\"reservationId\" WHERE r.id IS NULL;
      IF orphans <> 0 THEN RAISE EXCEPTION '% reservation_room row(s) without a reservation', orphans; END IF;
      SELECT count(*) INTO unfinished FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
      IF unfinished <> 0 THEN RAISE EXCEPTION '% unfinished migration(s)', unfinished; END IF;
    END \$\$;" > /dev/null
  log "verified: $(grep -c '^rows' "$manifest") tables, $(awk -F'\t' '$1=="rows"{s+=$3} END{print s+0}' "$manifest") rows, 4 guards, invariants hold"
}

verify() {
  local file="${1:-}" target
  [ -n "$file" ] || file="$(newest)" || die "no backups in $BACKUP_DIR"
  target="${SOURCE_DB}_verify_$(stamp | tr 'A-Z' 'a-z')"
  local ok=0
  (restore_and_check "$file" "$target") || ok=$?
  # The scratch copy is dropped however the check ended.
  dropdb --if-exists "$target" >/dev/null 2>&1 || true
  [ "$ok" = 0 ] || return 1
  { echo "verified_at $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "scratch_database $target"; grep -c '^rows' "${file%.dump}.manifest" | sed 's/^/tables /'; } > "${file%.dump}.verified"
}

prune() {
  local i=0 f
  for f in $(ls -1 "$BACKUP_DIR"/easeit-*.dump 2>/dev/null | sort -r); do
    i=$((i + 1))
    # The newest BACKUP_MIN_KEEP verified backups are kept whatever their age.
    if [ "$i" -le "$BACKUP_MIN_KEEP" ] && [ -f "${f%.dump}.verified" ]; then continue; fi
    if [ -n "$(find "$f" -mtime +"$BACKUP_RETENTION_DAYS")" ]; then
      log "prune $(basename "$f")"
      rm -f "$f" "$f.sha256" "${f%.dump}.manifest" "${f%.dump}.verified"
    fi
  done
  rm -f "$BACKUP_DIR"/.partial-* 2>/dev/null || true
}

run_once() {
  local file
  file="$(dump)"
  verify "$file"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/last-success"
  prune
  log "backup complete: $(basename "$file")"
}

seconds_until_next() {
  local now next
  now="$(date -u +%s)"
  next="$(date -u -d "today $BACKUP_TIME" +%s)"
  [ "$next" -gt "$now" ] || next="$(date -u -d "tomorrow $BACKUP_TIME" +%s)"
  echo $((next - now))
}

schedule() {
  [[ "$BACKUP_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "BACKUP_TIME must be HH:MM (UTC)"
  trap 'log "stopping"; exit 0' TERM INT
  if [ -z "$(find "$BACKUP_DIR/last-success" -mmin -1440 2>/dev/null)" ]; then
    log "no successful backup in the last 24 hours: running one now"
    (run_once) || log "BACKUP FAILED (container stays up; healthcheck turns unhealthy after 26 hours)"
  fi
  while true; do
    local wait_s
    wait_s="$(seconds_until_next)"
    log "next backup at $BACKUP_TIME UTC (in ${wait_s}s)"
    sleep "$wait_s" & wait $!
    (run_once) || log "BACKUP FAILED (container stays up; healthcheck turns unhealthy after 26 hours)"
  done
}

restore() {
  local file="${1:-}" target
  [ -n "$file" ] || file="$(newest verified)" || die "no verified backups in $BACKUP_DIR"
  target="${SOURCE_DB}_restored_$(stamp | tr 'A-Z' 'a-z')"
  if ! (restore_and_check "$file" "$target"); then
    dropdb --if-exists "$target" || true
    die "restore of $(basename "$file") failed verification; nothing kept"
  fi
  log "restored $(basename "$file") into $target. The live database is untouched."
  echo "RESTORED_DATABASE=$target"
  log "to switch to it: docker compose stop api worker web-admin web-booking"
  log "                 docker compose run --rm backup activate $target"
  log "                 docker compose up -d"
}

activate() {
  local target="${1:?usage: activate <database printed by restore>}" old others
  [[ "$target" =~ ^${SOURCE_DB}_restored_[0-9a-z]+$ ]] || die "activate only takes a database made by 'restore' (${SOURCE_DB}_restored_...)"
  [ "$(q -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")" = "1" ] || die "no database $target"
  others="$(q -d postgres -c "SELECT string_agg(DISTINCT coalesce(nullif(usename, ''), '?') || '@' || coalesce(host(client_addr), 'local'), ', ')
    FROM pg_stat_activity WHERE datname IN ('$SOURCE_DB', '$target') AND pid <> pg_backend_pid()")"
  [ -z "$others" ] || die "still connected to $SOURCE_DB: $others. Stop them first: docker compose stop api worker"
  old="${SOURCE_DB}_before_$(stamp | tr 'A-Z' 'a-z')"
  q -d postgres -c "ALTER DATABASE \"$SOURCE_DB\" RENAME TO \"$old\"" > /dev/null
  q -d postgres -c "ALTER DATABASE \"$target\" RENAME TO \"$SOURCE_DB\"" > /dev/null
  log "activated: $target is now $SOURCE_DB; the previous database is kept as $old"
  log "next: docker compose up -d   (migrate re-asserts the app role, then the API starts)"
}

list() {
  local f
  for f in $(ls -1 "$BACKUP_DIR"/easeit-*.dump 2>/dev/null | sort -r); do
    printf '%s  %6s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" \
      "$([ -f "${f%.dump}.verified" ] && sed -n 's/^verified_at /verified /p' "${f%.dump}.verified" || echo 'NOT verified')"
  done
  [ -f "$BACKUP_DIR/last-success" ] && echo "last success: $(cat "$BACKUP_DIR/last-success")" || echo "no successful backup yet"
}

command="${1:-schedule}"
shift || true
case "$command" in
  schedule) schedule ;;
  now) run_once ;;
  verify) verify "${1:-}" ;;
  restore) restore "${1:-}" ;;
  activate) activate "${1:-}" ;;
  list) list ;;
  *) echo "usage: backup.sh [schedule|now|verify [FILE]|restore [FILE]|activate DB|list]" >&2; exit 64 ;;
esac
