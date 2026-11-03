/**
 * `konjir import <file.json> [--dry-run] [--update]` (W6.3): sends an import file to Kolab's
 * konjir_import, as the person signed in, and says what it did. Kolab checks the file and does the
 * writes; this reads the file, checks it is one JSON object under the size Kolab takes, and reports.
 * It never runs inside a Konjir job (main refuses it with KONJIR_JOB set), and Kolab refuses an
 * agent's session, so only a person's own sign-in imports. Each run writes what its role may: a whole
 * file takes a product pass and an engineer pass, each its own sign-in.
 */
import { readFileSync, statSync } from 'node:fs';

/** The most a request body to /mcp holds (the server's limit, 2 MiB), less room for the call around the file. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024 - 16 * 1024;

type Call = (verb: string, args: Record<string, unknown>) => Promise<unknown>;

interface Step { what: string; outcome: string; version?: number; reviewers?: string[]; detail?: string }
interface Report { kolab: string; by: string; role: string; dry_run: boolean; steps: Step[]; complete: boolean; differs: string[]; failed: string[]; waiting: string[]; sent_back: string[]; other_pass: string[]; next?: string }

const USAGE = 'konjir import <file.json> [--dry-run] [--update]';

/**
 * Runs an import: `args` is what follows `konjir import`. Returns Kolab's report and the exit code:
 * 0 when nothing failed, differs or was sent back (what waits, or is left for the other pass, is for
 * a later run), 1 otherwise. `log` gets one line a step, for a person reading the terminal.
 */
export async function importKolab(call: Call, args: string[], opts: { log?: (line: string) => void } = {}): Promise<{ report: Report; exitCode: number }> {
  const rest = [...args];
  const on = (name: string) => { const i = rest.indexOf(`--${name}`); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  const dryRun = on('dry-run');
  const update = on('update');
  const unknown = rest.filter((a) => a.startsWith('-'));
  if (unknown.length) throw new Error(`${USAGE}: unknown ${unknown.join(' ')}`);
  if (rest.length !== 1) throw new Error(`${USAGE}: name one file`);
  const path = rest[0];
  let size: number;
  try { size = statSync(path).size; } catch { throw new Error(`no file ${path} to import`); }
  if (size > IMPORT_MAX_BYTES) {
    throw new Error(`${path} is ${Math.ceil(size / 1024).toLocaleString('en')} KiB; Kolab takes an import of at most ${Math.floor(IMPORT_MAX_BYTES / 1024).toLocaleString('en')} KiB in one call. Split it: the spec and binding in one file, the rulings in another (each file names the kolab and the nodes its rulings are on)`);
  }
  let file: unknown;
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${path} isn't JSON: ${(e as Error).message}`); }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Error(`${path} is one JSON object: {"format": "konjir-import/1", …}`);
  const report = await call('import', { file, ...(dryRun ? { dry_run: true } : {}), ...(update ? { update: true } : {}) }) as Report;
  const log = opts.log ?? (() => undefined);
  log(`${report.dry_run ? 'Dry run: nothing written. ' : ''}Import into kolab ${report.kolab}, as ${report.by}, the ${report.role} pass:`);
  for (const s of report.steps) {
    log(`  ${s.outcome.padEnd(12)} ${s.what}${s.version !== undefined ? `@${s.version}` : ''}${s.detail ? `: ${s.detail}` : ''}${s.reviewers?.length ? ` (reviewers: ${s.reviewers.join(', ')})` : ''}`);
  }
  log(report.dry_run ? 'Run it without --dry-run to write it.'
    : report.complete ? 'Complete: the kolab holds everything the file gives.'
      : `Not complete: ${[report.other_pass.length && `${report.other_pass.length} left for the other pass (${report.next})`, report.waiting.length && `${report.waiting.length} waiting (run it again once they commit)`, report.differs.length && `${report.differs.length} differing`, report.sent_back.length && `${report.sent_back.length} sent back by a reviewer`, report.failed.length && `${report.failed.length} failed`].filter(Boolean).join(', ')}.`);
  return { report, exitCode: report.failed.length || report.differs.length || report.sent_back.length ? 1 : 0 };
}
