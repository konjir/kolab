/**
 * With KONJIR_TEST_POSTGRES=1, the suite runs on Postgres 18 in a container (Testcontainers),
 * and each test gets a database of its own on it (@konjir/engine/testing). Without it, the
 * tests use PGlite. KONJIR_TEST_DATABASE_URL points them at a server you run instead.
 *
 * The container's own user is a superuser, which skips every ownership and grant check. The
 * tests connect as `kolab` instead, a login with CREATEDB and CREATEROLE but not SUPERUSER:
 * the shape of the RDS master user that the test server runs as.
 */
export default async function globalSetup() {
  // Names this run's databases, so jest.global-teardown.js drops exactly them. Always fresh,
  // never inherited: Nx runs the projects in parallel, and each must drop only its own. It
  // starts with the time in seconds, base 36, so the teardown can sweep old runs' leftovers.
  const { randomBytes } = await import('node:crypto');
  process.env.KONJIR_TEST_RUN = Math.floor(Date.now() / 1000).toString(36).padStart(7, '0') + randomBytes(2).toString('hex');
  if (process.env.KONJIR_TEST_POSTGRES !== '1' || process.env.KONJIR_TEST_DATABASE_URL) return;
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { default: pg } = await import('pg');
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  globalThis.__konjirPostgres = container;

  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try {
    await admin.query(`create role kolab login password 'kolab' createdb createrole nosuperuser`);
  } finally {
    await admin.end();
  }
  const url = new URL(container.getConnectionUri());
  url.username = 'kolab';
  url.password = 'kolab';
  process.env.KONJIR_TEST_DATABASE_URL = url.toString();
}
