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
# copy deploy/docker-compose.yml, deploy/Caddyfile and deploy/.env.example here
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

Migrations only ever roll forward. **Rolling back** to an earlier image is safe
only when the release being undone added no migration; otherwise restore the
backup taken before the upgrade (#15, backups) or ship a fix forward. Take a
backup before every upgrade until the scheduled backups are in place.

## 6. Day to day

| Task                   | Command                                              |
| ---------------------- | ---------------------------------------------------- |
| Logs                   | `docker compose logs -f api worker`                  |
| Outbox backlog         | `curl https://api.example.com/api/v1/health/outbox`  |
| Database shell (owner) | `docker compose exec postgres psql -U easeit easeit` |
| Restart one service    | `docker compose restart worker`                      |

The worker drains the outbox (booking confirmations, night audit runs) and runs
each property's night-audit schedule; if it is down, bookings still work and
the emails go out when it returns.

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
which is what the publish workflow runs before pushing.
