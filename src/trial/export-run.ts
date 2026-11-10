import { resolve } from 'node:path';
import { canonicalJson } from '../domain/index.js';
import { assertAuthorizedRoot, exportRun, readRun, type ExportRunOptions } from '../evidence/run-evidence.js';
import type { RunSession } from '../host/run-session.js';
import type { BuildIdentity } from '../../tools/build-manifest.js';
/** Retry is safe only when the immutable package is exactly the same genuine snapshot and assertions. */
export function exportGenuineRun(session: RunSession, identity: BuildIdentity, options: ExportRunOptions): string {
  try { return exportRun(session, identity, options); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'E_RUN_PACKAGE_EXISTS') throw error;
    const root = assertAuthorizedRoot(options.root);
    const path = resolve(root, 'evidence/r0', identity.buildId, '04_runs', session.snapshot().context.runId);
    const existing = readRun(path, root);
    if (canonicalJson(existing.snapshot) !== canonicalJson(session.snapshot()) || canonicalJson(existing.assertions) !== canonicalJson(options.assertions ?? []) ||
      existing.envelope.fixtureRef !== (options.fixtureRef ?? null) || existing.envelope.inputRef !== (options.inputRef ?? null)) throw new Error('E_EVIDENCE_EXPORT_CONFLICT');
    return path;
  }
}
