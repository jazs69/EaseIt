#!/usr/bin/env bash
# Start the whole stack from freshly built images and prove it boots (CI-14).
#
#   EASEIT_REGISTRY=easeit EASEIT_VERSION=smoke deploy/smoke.sh
#
# Expects the five images already present locally under
# ${EASEIT_REGISTRY}/easeit-<target>:${EASEIT_VERSION}. Runs everything except
# Caddy (no public DNS here), then checks, in order:
#
#   1. the migrate step exits 0 (migrations, reference data, app role);
#   2. the API answers /health/ready, connected as the app role, not the owner;
#   3. the worker is running and stays up;
#   4. the three web apps answer;
#   5. provisioning a property and an administrator works and prints a link,
#      and the invitation endpoint behind the API accepts it;
#   6. the backup service takes its first backup at start and that backup's
#      restore rehearsal passes (the service turns healthy);
#   7. disaster recovery as the README describes it: restore into a new
#      database, activate refused while the API is connected, stop, activate,
#      `up` again, and the API serves the restored data as the app role.
#
# Uses a throwaway compose project and volumes, removed at the end.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
project="easeit-smoke-$$"
env_file="$(mktemp)"
# A host directory, as on a server. `pwd -W` gives Docker Desktop a Windows path.
backup_dir="$(cd "$here" && (pwd -W 2>/dev/null || pwd))/.smoke-backups-$$"
cleanup() {
  # The backup files belong to root inside the container; remove them from there.
  docker compose -p "$project" --env-file "$env_file" -f "$here/docker-compose.yml" run --rm -T --no-deps     --entrypoint sh backup -c 'rm -rf /backups/* /backups/.partial-*' >/dev/null 2>&1 || true
  docker compose -p "$project" --env-file "$env_file" -f "$here/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$here/.smoke-backups-$$" "$env_file"
}
trap cleanup EXIT

cat > "$env_file" <<EOF
EASEIT_REGISTRY=${EASEIT_REGISTRY:?}
EASEIT_VERSION=${EASEIT_VERSION:?}
API_DOMAIN=api.smoke.invalid
ADMIN_DOMAIN=admin.smoke.invalid
BOOKING_DOMAIN=book.smoke.invalid
MARKETING_DOMAIN=www.smoke.invalid
ACME_EMAIL=ops@smoke.invalid
AUTH_COOKIE_DOMAIN=.smoke.invalid
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
SMTP_HOST=smtp.smoke.invalid
SMTP_USER=smoke
SMTP_PASS=smoke
SMTP_FROM=EaseIt <no-reply@smoke.invalid>
# Never called here: lookups happen only when staff search a GSTIN.
GST_PROVIDER=sandbox
GST_API_KEY=smoke
BACKUP_DIR=${backup_dir}
EOF

compose() { docker compose -p "$project" --env-file "$env_file" -f "$here/docker-compose.yml" "$@"; }

echo "== up (without caddy)"
compose up -d postgres redis migrate api worker web-admin web-booking web-marketing

wait_healthy() {
  local service="$1" id status
  id="$(compose ps -q "$service")"
  for _ in $(seq 1 90); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
    [ "$status" = "healthy" ] && { echo "   $service healthy"; return 0; }
    [ "$status" = "exited" ] || [ "$status" = "dead" ] && break
    sleep 2
  done
  echo "   $service did not become healthy (last: $status)" >&2
  compose logs --tail 80 "$service" >&2
  return 1
}

echo "== 1. migrate"
migrate_id="$(compose ps -aq migrate)"
for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Status}}' "$migrate_id")" = "exited" ] && break
  sleep 2
done
code="$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id")"
compose logs migrate | grep -E '\[ops\]|Role ' || true
[ "$code" = "0" ] || { echo "   migrate exited $code" >&2; compose logs migrate >&2; exit 1; }

echo "== 2. api"
wait_healthy api
compose exec -T api node -e "
fetch('http://127.0.0.1:4000/api/v1/health/ready').then(async (r) => {
  console.log('   ready:', r.status, await r.text());
  process.exit(r.ok ? 0 : 1);
}, (e) => { console.error(e); process.exit(1); });"
role="$(compose exec -T postgres psql -U easeit -d easeit -At -c "select usename from pg_stat_activity where datname='easeit' and application_name <> 'psql' and usename is not null group by usename order by 1" | tr '\n' ' ')"
echo "   database logins in use: $role"
case " $role " in *" easeit_app "*) ;; *) echo "   the API is not connected as easeit_app" >&2; exit 1 ;; esac

echo "== 3. worker"
sleep 5
[ "$(docker inspect -f '{{.State.Status}}' "$(compose ps -q worker)")" = "running" ] || { compose logs worker >&2; exit 1; }
echo "   worker running"

echo "== 4. web apps"
for service in web-admin web-booking web-marketing; do wait_healthy "$service"; done

echo "== 5. provision"
out="$(compose run --rm -T \
  -e PROPERTY_CODE=SMOKE1 -e PROPERTY_NAME='Smoke Test Hotel' -e PROPERTY_SLUG=smoke-test \
  -e ADMIN_EMAIL=owner@smoke.invalid -e WEB_ADMIN_URL=https://admin.smoke.invalid \
  migrate provision)"
echo "$out" | sed -E 's/token=[A-Za-z0-9_-]+/token=<redacted>/'
token="$(echo "$out" | grep -oE 'token=[A-Za-z0-9_-]{43}' | cut -d= -f2)"
[ -n "$token" ] || { echo "   no invitation link printed" >&2; exit 1; }
compose exec -T api node -e "
fetch('http://127.0.0.1:4000/api/v1/auth/invitations/accept', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: process.argv[1], newPassword: 'Smoke-Test-Password-2026!' }),
}).then(async (r) => { console.log('   accept invitation:', r.status, await r.text()); process.exit(r.ok ? 0 : 1); },
        (e) => { console.error(e); process.exit(1); });" "$token"

echo "== 6. backup"
compose up -d backup
wait_healthy backup
compose run --rm -T --no-deps backup list

echo "== 7. disaster recovery"
out="$(compose run --rm -T --no-deps backup restore)"
restored="$(echo "$out" | sed -n 's/^RESTORED_DATABASE=//p')"
[ -n "$restored" ] || { echo "   restore printed no database" >&2; exit 1; }
echo "   restored into $restored"
if compose run --rm -T --no-deps backup activate "$restored" 2>/dev/null; then
  echo "   activate was allowed while the API is connected" >&2; exit 1
fi
echo "   activate refused while the API is connected"
compose stop api worker
compose run --rm -T --no-deps backup activate "$restored"
compose up -d postgres redis migrate api worker web-admin web-booking web-marketing backup
wait_healthy api
compose exec -T api node -e "
fetch('http://127.0.0.1:4000/api/v1/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));"
facts="$(compose exec -T postgres psql -U easeit -d easeit -At -c "
  select (select string_agg(code, ',') from property) || ' / ' ||
         (select count(*) from auth_token where purpose = 'INVITATION' and \"consumedAt\" is not null) || ' accepted invitation / ' ||
         (select count(*) from pg_database where datname like 'easeit_before_%') || ' kept previous database'")"
echo "   after recovery: $facts"
case "$facts" in "SMOKE1 / 1 accepted invitation / 1 kept previous database") ;; *) echo "   unexpected state after recovery" >&2; exit 1 ;; esac
role="$(compose exec -T postgres psql -U easeit -d easeit -At -c "select string_agg(distinct usename, ' ') from pg_stat_activity where datname='easeit' and application_name <> 'psql'")"
case " $role " in *" easeit_app "*) echo "   API reconnected as easeit_app" ;; *) echo "   the API is not connected as easeit_app after recovery ($role)" >&2; exit 1 ;; esac

echo "== smoke test passed"
