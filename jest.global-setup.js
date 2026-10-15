/**
 * With KONJIR_TEST_POSTGRES=1, the suite runs on Postgres 18 in a container (Testcontainers),
 * and each test gets a database of its own on it (@konjir/engine/testing). Without it, the
 * tests use PGlite. KONJIR_TEST_DATABASE_URL points them at a server you run instead.
 */
export default async function globalSetup() {
  if (process.env.KONJIR_TEST_POSTGRES !== '1' || process.env.KONJIR_TEST_DATABASE_URL) return;
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  globalThis.__konjirPostgres = container;
  process.env.KONJIR_TEST_DATABASE_URL = container.getConnectionUri();
}
