import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseDocument } from '../src/domain/index.js';
import { createRun, type RunContext } from '../src/runtime/index.js';
import { createBuildIdentity } from '../tools/build-manifest.js';

test('real frozen environment identity including its version delimiter creates an actual Runtime', () => {
  const identity = createBuildIdentity();
  const document = parseDocument(readFileSync('verification/fixtures/scene-b.json', 'utf8'));
  const context: RunContext = { runId:randomUUID(), generation:1, buildHash:identity.buildHash,
    runtimeArtifactHash:identity.runtimeArtifactHash, environmentId:identity.environmentId,
    evidenceSource:'machine_test',inputSource:'catalog_machine',executionClass:'automation_test' };
  const run = createRun(document, context);
  assert.equal(run.state.context.environmentId, 'nodon-r0-macos-arm64-node24.21.0@1');
  assert.equal(run.events[0]?.kind, 'run_started');
  assert.equal(run.state.context.buildHash, identity.buildHash);
  assert.equal(run.state.tick, 0);
});

test('Runtime context rejects suffix newlines without broadening project or run identifiers', () => {
  const document = parseDocument(readFileSync('verification/fixtures/scene-b.json', 'utf8'));
  const context: RunContext = {runId:'run-1',generation:1,buildHash:'sha256:'+'a'.repeat(64),runtimeArtifactHash:'sha256:'+'b'.repeat(64),
    environmentId:'env@1',evidenceSource:'machine_test',inputSource:'catalog_machine',executionClass:'automation_test'};
  for (const field of ['runId','environmentId','buildHash','runtimeArtifactHash'] as const) {
    assert.throws(() => createRun(document,{...context,[field]:context[field]+'\n'}));
  }
  assert.throws(() => createRun(document,{...context,runId:'run@1'}));
});
