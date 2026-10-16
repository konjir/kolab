/**
 * Drops the databases this run's tests made (@konjir/engine/testing), then stops the Postgres
 * container jest.global-setup.js started, if it started one.
 *
 * They're dropped here, once every test file has closed its servers, rather than after each
 * file: a file's own afterAll runs after jest.setup.js's, so a server it still holds would
 * have its database dropped from under it, and its LISTEN connection would try to reconnect
 * after the file's environment was gone.
 */
export default async function globalTeardown() {
  const url = process.env.KONJIR_TEST_DATABASE_URL;
  const run = process.env.KONJIR_TEST_RUN;
  if (url && run) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`select datname from pg_database where datname like $1`, [`kj_test_${run}_%`]);
      for (const { datname } of rows) await client.query(`drop database if exists "${datname}" with (force)`);
    } finally {
      await client.end();
    }
  }
  await globalThis.__konjirPostgres?.stop();
}
