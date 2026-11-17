# Deploying EaseIt

One Linux server runs everything with Docker Compose: PostgreSQL 17, Redis,
the API, the worker, the three web apps and Caddy in front for HTTPS. At ten
properties and ~50 staff that is the right size (CLAUDE.md section 1): one
database, scaled vertically.

```
            internet ─► Caddy :443 ─┬─► api           :4000 ─┬─► postgres (app role, RLS)
                                    ├─► web-admin     :3000  │
                                    ├─► web-booking   :3000  └─► redis ◄── worker
                                    └─► web-marketing :3000
            migrate (one-shot, owner login): migrations → reference data → app role
```

Images come from GitHub Container Registry, published by
`.github/workflows/publish.yml` when a `vX.Y.Z` tag is pushed. That workflow runs
the full release checks and a smoke test of this exact stack first, and pushes
nothing if either fails. Deploying is always a person running the commands
below; GitHub holds no server credentials.

## 1. Once per repository

Set the public URLs the web images are built for, under _Settings → Secrets
and variables → Actions → Variables_:

| Variable               | Example                     |
| ---------------------- | --------------------------- |
| `PUBLIC_API_URL`       | `https://api.example.com`   |
| `PUBLIC_ADMIN_URL`     | `https://admin.example.com` |
| `PUBLIC_MARKETING_URL` | `https://www.example.com`   |

They are compiled into the browser bundles, so changing a domain means
publishing a new version. The workflow refuses to build without
`PUBLIC_API_URL`.

Publish a version:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 2. Once per server

- Ubuntu 24.04 (or any Linux with Docker Engine and the Compose plugin), 4 vCPU,
  8 GB RAM, 80 GB disk is comfortable for ten properties.
- DNS A/AAAA records for the four hostnames pointing at the server, _before_
  the first start (Caddy requests certificates immediately).
- Ports 80 and 443 open. Nothing else needs to be: PostgreSQL and Redis
  publish no ports.
- An SMTP relay. Sign-in codes are emailed, so nobody can sign in without it.

```bash
sudo mkdir -p /opt/easeit && cd /opt/easeit
# copy deploy/docker-compose.yml, Caddyfile, backup.sh and .env.example here
cp .env.example .env && chmod 600 .env
# fill in .env: domains, EASEIT_REGISTRY/EASEIT_VERSION, and generate secrets:
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # APP_DB_PASSWORD
openssl rand -hex 32   # JWT_SECRET
```

If the GHCR packages are private, log in once with a token that has
`read:packages`: `echo <token> | docker login ghcr.io -u <user> --password-stdin`.

## 3. First start

```bash
docker compose pull
docker compose up -d
docker compose logs migrate     # [ops] 1/3 migrations ... [ops] done
docker compose ps               # api, web-* healthy; worker running
```

`migrate` runs before the API and worker on every `up`: it applies pending
migrations with the owner login, refreshes the permission catalog, system
roles and amenities, and (re)asserts the app role the API connects as. It is
idempotent.

## 4. Add a hotel and its first administrator

Nothing in the application creates a property, so each hotel is provisioned
once:

```bash
docker compose run --rm \
  -e PROPERTY_CODE=31001 \
  -e PROPERTY_NAME="Grand Marine Goa" \
  -e PROPERTY_SLUG=grand-marine-goa \
  -e PROPERTY_TIMEZONE=Asia/Kolkata \
  -e ADMIN_EMAIL=owner@example.com \
  -e ADMIN_FIRST_NAME=Asha -e ADMIN_LAST_NAME=Rao \
  -e WEB_ADMIN_URL=https://admin.example.com \
  migrate provision
```

It creates the property (with the default GST slabs for INR), grants the
administrator (`ADMIN_ROLE`, default `SUPER_ADMIN`; use `PROPERTY_ADMIN` for a
single-hotel manager) and prints a **single-use invitation link valid for 72
hours**. Send it to that person only; they choose their own password. Re-running
never edits an existing property; for an administrator who has not signed in
yet it issues a fresh link and revokes the old one.

Then, in the admin app: room types and rooms, rates, Settings → General
(the hotel's GSTIN and invoice prefix), taxes and policies. Further staff are
invited from the Staff screen.

## 5. Upgrade

```bash
# in .env: EASEIT_VERSION=1.1.0
docker compose pull
docker compose up -d            # migrate runs first; api/worker restart after it
docker compose ps
```

Take a backup first: `docker compose run --rm backup now` (it dumps, restores
the dump into a scratch database, checks it and only then reports success).

Migrations only ever roll forward. **Rolling back** to an earlier image is safe
only when the release being undone added no migration; otherwise restore that
pre-upgrade backup (section 6) with the earlier `EASEIT_VERSION`, or ship a
fix forward.

## 6. Backups and recovery

The `backup` service dumps the database once a day at `BACKUP_TIME` (UTC;
default 20:30, which is 02:00 in India), into `BACKUP_DIR` (default
`/opt/easeit/backups`). **A backup only counts once it has been restored**: each
dump is restored into a scratch database and checked in four layers (object
inventory, the double-booking guards and every constraint, each table's row
count against a manifest read in the same snapshot as the dump, and the
inventory and booking invariants), then the scratch database is dropped. Files
older than `BACKUP_RETENTION_DAYS` (14) are deleted, except the newest
`BACKUP_MIN_KEEP` (3) verified ones. The service turns **unhealthy** when no
backup has succeeded for 26 hours.

```bash
docker compose run --rm backup list      # what exists and whether it verified
docker compose run --rm backup now       # an extra backup, e.g. before an upgrade
docker compose run --rm backup verify    # rehearse a restore of the newest one again
docker compose ps backup                 # healthy = a good backup in the last 26 h
```

**Copy the backups off this server.** A backup on the same disk does not
survive losing the disk. Until there is an automated off-site copy, sync the
directory from another machine every day, for example:

```bash
rsync -a --delete server:/opt/easeit/backups/ /srv/easeit-backups/
```

Each backup is four files: the `.dump`, its `.sha256`, the `.manifest` it is
checked against and a `.verified` record. Keep them together.

### Recovering the database

Nothing here ever writes into the live database. A restore goes into a new
one, and switching is a separate, explicit step that keeps the old database.

```bash
# 1. Restore the newest verified backup (or name a file) into a NEW database.
#    It is checked exactly like the nightly rehearsal; the live data is untouched.
docker compose run --rm backup restore
#    ... RESTORED_DATABASE=easeit_restored_20261117t013110z

# 2. Stop everything that talks to the database. Activate refuses otherwise.
docker compose stop api worker

# 3. Swap: the restored database becomes `easeit`, the old one is kept as
#    easeit_before_<time> (drop it by hand once you are sure).
docker compose run --rm backup activate easeit_restored_20261117t013110z

# 4. Start again. `migrate` re-grants the app role and applies any migration
#    newer than the backup before the API starts.
docker compose up -d
```

On a **new server**: set it up as in sections 2 and 3, copy the backup files
into `BACKUP_DIR`, then run the four steps above.

Everything written after the backup is lost: with one dump a day, up to 24
hours. Point-in-time recovery (WAL archiving) is not set up yet.

## 7. Day to day

| Task                   | Command                                              |
| ---------------------- | ---------------------------------------------------- |
| Logs                   | `docker compose logs -f api worker`                  |
| Outbox backlog         | `curl https://api.example.com/api/v1/health/outbox`  |
| Database shell (owner) | `docker compose exec postgres psql -U easeit easeit` |
| Restart one service    | `docker compose restart worker`                      |
| Backups                | `docker compose run --rm backup list`                |

The worker drains the outbox (booking confirmations, night audit runs) and runs
each property's night-audit schedule; if it is down, bookings still work and
the emails go out when it returns.

### Alerts

The worker reports two conditions to `ALERT_EMAIL_TO`, and to
`ALERT_WEBHOOK_URL` if one is set:

- **A background job failed for good** (it used up its retries, or its input can
  never succeed). The alert names the job type, its id, the hotel code and the
  recorded error. The job stays in `outbox_event` with status `DEAD`. Each one
  is reported once. If no alert channel accepts it (mail server down, webhook
  failing), it is retried every 30 seconds until one does. A burst is sent in
  batches of 20.
- **Work is stuck**: a job's worker lease ran out more than 2 minutes ago and
  nothing reclaimed it. That means no worker is running, or all of them are
  stuck. Repeated every 30 minutes while it lasts. If the worker itself is
  down, it cannot send this, so also watch the API's `/api/v1/health/outbox`
  (`staleLeases`, `oldestPendingAgeSeconds`) from an external uptime monitor.

To find dead jobs:

```sh
docker compose exec postgres psql -U easeit easeit -c \
  "SELECT id, \"eventType\", \"lastError\", \"completedAt\" FROM outbox_event WHERE status = 'DEAD' ORDER BY \"completedAt\" DESC LIMIT 20"
```

Tuning (optional): `ALERT_CHECK_MS` (30000), `ALERT_STALE_LEASE_GRACE_MS`
(120000), `ALERT_REPEAT_MS` (1800000), `ALERT_TIMEOUT_MS` (10000).

Staff see who changed what in the admin app under **Audit Log** (permission
`audit_log:read`, held by property administrators).

## Images

| Image                  | Runs                                               |
| ---------------------- | -------------------------------------------------- |
| `easeit-api`           | `node dist/main.js` (API) or `node dist/worker.js` |
| `easeit-ops`           | `ops.sh migrate` (default) or `ops.sh provision`   |
| `easeit-web-admin`     | staff dashboard (Next.js standalone)               |
| `easeit-web-booking`   | public booking engine                              |
| `easeit-web-marketing` | marketing site                                     |

All five build from the repository's root `Dockerfile` (`--target <name>`);
`deploy/smoke.sh` starts this stack from locally built images and checks it,
including a backup, its restore rehearsal and the full recovery above; it is
what the publish workflow runs before pushing. The `backup` service uses the
stock `postgres:17` image with `backup.sh` mounted in.
