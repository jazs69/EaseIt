#!/bin/sh
# EaseIt operations entry point, run inside the `ops` image (CI-14).
#
#   migrate    apply pending migrations, refresh reference data (permissions,
#              system roles, amenities) and (re)assert the API's database
#              role. Idempotent; the compose stack runs it before the API and
#              worker start, on every deploy.
#   provision  create one property and its first administrator, then print a
#              one-time invitation link (see packages/database/prisma/provision.ts
#              for the PROPERTY_* and ADMIN_* variables).
#
# Needs the OWNER connection in DATABASE_URL. The API and worker connect as
# the app role (APP_DB_ROLE, default easeit_app) so row-level security binds
# them; this script is the only thing that uses the owner login.
set -eu

command="${1:-migrate}"
cd /ops/packages/database

case "$command" in
  migrate)
    : "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required (the API database role password)}"
    echo "[ops] 1/3 migrations"
    ./node_modules/.bin/prisma migrate deploy
    echo "[ops] 2/3 reference data"
    # PROPERTY_CODE is cleared so a stray value in the environment can never
    # turn a routine migration into a property creation.
    PROPERTY_CODE= ADMIN_EMAIL= ./node_modules/.bin/tsx prisma/provision.ts
    echo "[ops] 3/3 app database role"
    node /ops/scripts/db-app-role.mjs
    echo "[ops] done"
    ;;
  provision)
    : "${PROPERTY_CODE:?PROPERTY_CODE is required to provision a property}"
    ./node_modules/.bin/tsx prisma/provision.ts
    ;;
  *)
    echo "usage: ops.sh [migrate|provision]" >&2
    exit 64
    ;;
esac
