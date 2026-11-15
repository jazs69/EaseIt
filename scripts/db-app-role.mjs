/**
 * Create or update the API's own database role (MT-04).
 *
 * ===========================================================================
 * Row-level security binds only a role that is neither a superuser nor
 * BYPASSRLS. The migrations' owner login is a superuser locally, so the API
 * and worker connect as this role instead, and the tenant policies apply to
 * every query they run.
 *
 * Idempotent, and safe to re-run after every migration: it (re)creates the
 * role if needed, (re)sets its password, and grants it data access -- SELECT,
 * INSERT, UPDATE, DELETE on the tables, usage on sequences, EXECUTE on
 * functions -- plus default privileges so tables created by later migrations
 * are covered. It grants nothing else: no DDL, no role management, no access
 * to `_prisma_migrations`, and never SUPERUSER or BYPASSRLS.
 *
 *   DATABASE_URL     the OWNER connection for the target database (required)
 *   APP_DB_ROLE      the role name (default easeit_app)
 *   APP_DB_PASSWORD  its password (required; never printed)
 *
 *   DATABASE_URL=<owner url> APP_DB_PASSWORD=... node scripts/db-app-role.mjs
 *
 * A role belongs to the PostgreSQL server, not a database, so running it for
 * a second database on the same server updates the same role and adds that
 * database's grants.
 * ===========================================================================
 */

const role = process.env.APP_DB_ROLE ?? 'easeit_app';
const password = process.env.APP_DB_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL (the owner connection) is required.');
  process.exit(1);
}
if (!password || password.length < 16) {
  console.error('APP_DB_PASSWORD is required and must be at least 16 characters.');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
  console.error('APP_DB_ROLE must be a plain lower-case identifier.');
  process.exit(1);
}

const databaseModule = await import('../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

try {
  await prisma.$transaction(async (tx) => {
    // Values travel as bound parameters into transaction-local settings, and
    // the DO block quotes them with format(%I / %L): no string concatenation.
    await tx.$executeRaw`SELECT set_config('easeit.app_role', ${role}, true), set_config('easeit.app_password', ${password}, true)`;
    await tx.$executeRawUnsafe(`
      DO $$
      DECLARE
        r text := current_setting('easeit.app_role');
        p text := current_setting('easeit.app_password');
        owner text := current_user;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r);
        END IF;
        -- Re-asserted every run, so a role altered by hand is put back.
        EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', r, p);
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
        EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner, r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', owner, r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', owner, r);
        IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', r);
        END IF;
      END
      $$;
    `);
  });

  const rows = await prisma.$queryRaw`
    SELECT rolsuper, rolbypassrls, current_database() AS db FROM pg_roles WHERE rolname = ${role}`;
  const row = rows[0];
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.error(`Role ${role} exists but can bypass RLS; refusing to report success.`);
    process.exit(1);
  }
  console.log(`Role ${role} ready on database ${row.db}: no superuser, no BYPASSRLS, data access granted.`);
} finally {
  await prisma.$disconnect();
}
