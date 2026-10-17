/**
 * Drops the databases this run's tests made (@konjir/engine/testing), then stops the Postgres
 * container jest.global-setup.js started, if it started one.
 *
 * They're dropped here, once every test file has finished, rather than after each file: each
 * file's servers and Kolabs close first (closeOpened, from jest.setup.js), but anything a file
 * still held in a hook of its own would have its database dropped from under it, and its LISTEN
 * connection would try to reconnect after the file's environment was gone.
 *
 * On a server that outlives runs, it also sweeps databases left by runs that started more than
 * a day ago and never got here (killed, crashed, or --watch).
 */
const RUN_NAME = /^kj_test_([0-9a-z]{7})[0-9a-f]{4}_[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60;

export default async function globalTeardown() {
  const url = process.env.KONJIR_TEST_DATABASE_URL;
  const run = process.env.KONJIR_TEST_RUN;
  if (url && run) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`select datname from pg_database where datname like 'kj\\_test\\_%'`);
      const now = Date.now() / 1000;
      const ours = (name) => name.startsWith(`kj_test_${run}_`);
      const stale = (name) => {
        const m = RUN_NAME.exec(name);
        return !!m && now - parseInt(m[1], 36) > DAY;
      };
      for (const { datname } of rows) {
        if (ours(datname) || stale(datname)) await client.query(`drop database if exists "${datname}" with (force)`);
      }
    } finally {
      await client.end();
    }
  }
  await globalThis.__konjirPostgres?.stop();
}
