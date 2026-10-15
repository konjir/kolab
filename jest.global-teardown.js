/** Stops the Postgres container jest.global-setup.js started, if it started one. */
export default async function globalTeardown() {
  await globalThis.__konjirPostgres?.stop();
}
