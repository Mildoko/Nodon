import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDocument, parseStrictJson, type Document } from '../domain/index.js';
import type { Direction } from '../runtime/index.js';
import { createBuildIdentity, type BuildIdentity } from '../../tools/build-manifest.js';
import { assertAuthorizedRoot, exportRun, readRun, replayRun } from '../evidence/run-evidence.js';
import { RunSession } from './run-session.js';

interface CatalogInput { segments: Array<{ ticks: number; x: Direction['x']; y: Direction['y'] }>; maxTicks: number; inputSource: 'catalog_machine'; inputId: string; scriptId?: string; stopOnLegalTerminal?: boolean }
interface Assertion { name: string; expected: unknown; actual: unknown; passed: boolean }
function catalog(root: string, kind: 'fixtures' | 'inputs', name: string): unknown {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('E_CATALOG_ID');
  const directory = resolve(root, 'verification', kind);
  if (!readdirSync(directory).includes(name + '.json')) throw new Error('E_CATALOG_NOT_FOUND');
  const path = resolve(directory, name + '.json');
  if (lstatSync(path).isSymbolicLink()) throw new Error('E_CATALOG_SYMLINK');
  return parseStrictJson(readFileSync(path, 'utf8'));
}
function inputCatalog(root: string, name: string): CatalogInput {
  const value = catalog(root, 'inputs', name) as CatalogInput;
  if (value === null || typeof value !== 'object' || Object.keys(value).some(key => !['segments', 'maxTicks', 'inputSource', 'inputId', 'scriptId', 'stopOnLegalTerminal'].includes(key)) ||
    value.inputId !== name || value.inputSource !== 'catalog_machine' || !Array.isArray(value.segments) ||
    !Number.isSafeInteger(value.maxTicks) || value.maxTicks < 1 || value.maxTicks > 7200 ||
    (value.scriptId !== undefined && typeof value.scriptId !== 'string') || (value.stopOnLegalTerminal !== undefined && typeof value.stopOnLegalTerminal !== 'boolean')) throw new Error('E_CATALOG_INPUT');
  let total = 0;
  for (const segment of value.segments) {
    if (segment === null || typeof segment !== 'object' || Object.keys(segment).length !== 3 ||
      !Number.isSafeInteger(segment.ticks) || segment.ticks < 1 || ![-1, 0, 1].includes(segment.x) || ![-1, 0, 1].includes(segment.y)) throw new Error('E_CATALOG_INPUT');
    total += segment.ticks;
  }
  if (total !== value.maxTicks) throw new Error('E_CATALOG_INPUT_LENGTH');
  return value;
}
function execute(document: Document, input: CatalogInput, identity: BuildIdentity): RunSession {
  const runId = randomUUID();
  const run = new RunSession(document, { runId, generation: 1, buildHash: identity.buildHash,
    runtimeArtifactHash: identity.runtimeArtifactHash, environmentId: identity.environmentId,
    evidenceSource: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test' });
  for (const segment of input.segments) {
    for (let index = 0; index < segment.ticks; index++) {
      const state = run.snapshot();
      if (state.status !== 'running' || state.budgetExhausted) return run;
      run.step({ runId, generation: 1, direction: { x: segment.x, y: segment.y } });
    }
  }
  return run;
}
function flags(args: string[], names: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !names.includes(key) || value === undefined || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error('E_CLI_ARGUMENT');
    result[key] = value;
  }
  if (Object.keys(result).length !== names.length) throw new Error('E_CLI_ARGUMENT');
  return result;
}
function assertValue(name: string, actual: unknown, expected: unknown): Assertion {
  return { name, actual: actual === undefined ? null : actual, expected: expected === undefined ? null : expected,
    passed: JSON.stringify(actual) === JSON.stringify(expected) };
}
const USAGE = 'node dist/src/host/cli.js run --fixture terminal-conflict --input terminal-conflict\nnode dist/src/host/cli.js verify --case R0-RT-07\nnode dist/src/host/cli.js replay --run <actual-run-directory>\nnode dist/src/host/cli.js audit --run <actual-run-directory>';

/** No URL, arbitrary file, shell, provider or editable case-manifest endpoint. */
export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help') { console.log(USAGE); return; }
  const root = assertAuthorizedRoot();
  if (command === 'run') {
    const selected = flags(rest, ['--fixture', '--input']);
    const identity = createBuildIdentity(root);
    const fixture = selected['--fixture']!, inputId = selected['--input']!;
    const document = assertDocument(catalog(root, 'fixtures', fixture));
    const input = inputCatalog(root, inputId);
    const run = execute(document, input, identity);
    const state = run.snapshot();
    const runPath = exportRun(run, identity, { root, fixtureRef: fixture, inputRef: inputId, assertions: [
      assertValue('genuine run_started', state.events.filter(event => event.kind === 'run_started').length, 1),
      assertValue('no runtime fault', state.status === 'fault', false),
    ] });
    console.log(JSON.stringify({ command, buildId: identity.buildId, buildHash: identity.buildHash, runId: state.context.runId, runPath,
      tick: state.tick, status: state.status, terminal: state.terminal, blocked: state.budgetExhausted, truncation: state.truncation,
      evidenceSource: state.context.evidenceSource, inputSource: state.context.inputSource, executionClass: state.context.executionClass }));
    if (state.status === 'fault' || state.budgetExhausted) process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    const selected = flags(rest, ['--case']);
    if (selected['--case'] !== 'R0-RT-07') throw new Error('E_CASE_NOT_SUPPORTED');
    const identity = createBuildIdentity(root);
    const input = inputCatalog(root, 'terminal-conflict');
    const results: Array<{ variant: string; runId: string; runPath: string; assertions: Assertion[]; passed: boolean }> = [];
    for (const variant of ['caught', 'timeout', 'win'] as const) {
      let document = assertDocument(catalog(root, 'fixtures', 'terminal-conflict'));
      if (variant !== 'caught') document.project.scene.entities = document.project.scene.entities.filter(entity => entity.id !== 'g1');
      if (variant === 'win') document.project.rules.timer.enabled = false;
      document = assertDocument(document);
      const run = execute(document, input, identity), state = run.snapshot();
      const assertions = [assertValue('full fixed ticks consumed', state.tick, 900), assertValue('consumed input count', state.inputs.length, 900),
        assertValue('terminal reason', state.terminal?.reason, variant), assertValue('score', state.score, 1),
        assertValue('goal reached', state.terminal?.goalReached, true), assertValue('caught flag', state.terminal?.caught, variant === 'caught'),
        assertValue('timeout flag', state.terminal?.timeout, variant !== 'win'),
        assertValue('same-tick genuine event order', state.events.filter(event => event.tick === 900).map(event => event.kind), ['reward_collected', 'score_changed', 'goal_checked', 'round_ended']),
        assertValue('one terminal', state.events.filter(event => event.kind === 'round_ended').length, 1),
        assertValue('no diagnostics', state.diagnostics.length, 0)];
      const runPath = exportRun(run, identity, { root, fixtureRef: 'terminal-conflict/' + variant, inputRef: 'terminal-conflict', assertions });
      results.push({ variant, runId: state.context.runId, runPath, assertions, passed: assertions.every(assertion => assertion.passed) });
    }
    const passed = results.every(result => result.passed);
    console.log(JSON.stringify({ command, caseId: 'R0-RT-07', buildId: identity.buildId, evidenceSource: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test', passed, results }));
    if (!passed) process.exitCode = 1;
    return;
  }
  if (command === 'replay') {
    const selected = flags(rest, ['--run']);
    const result = replayRun(selected['--run']!, root);
    console.log(JSON.stringify({ command, ...result }));
    if (!result.historicalBuild && !result.comparison.equal) process.exitCode = 1;
    return;
  }
  if (command === 'audit') {
    const selected = flags(rest, ['--run']);
    const bundle = readRun(selected['--run']!, root);
    console.log(JSON.stringify({ command, runPath: bundle.path, valid: true, auditLevel: bundle.auditLevel, buildHash: bundle.envelope.buildHash,
      runId: bundle.envelope.runId, packageManifestHash: bundle.packageManifestHash }));
    return;
  }
  throw new Error('E_CLI_COMMAND');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'E_CLI_FAILURE';
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
