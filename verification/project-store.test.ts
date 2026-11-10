import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { assertDocument, type Document } from '../src/domain/index.js';
import { ProjectStore } from '../src/host/project-store.js';

// These are local, controlled identifiers; no host, browser, or model is started.
const SESSION = 'c1000000-0000-4000-8000-000000000001';
const WRITER = 'c1000000-0000-4000-8000-000000000002';
type Result = ReturnType<ProjectStore['execute']>;
let commandSequence = 0;

function fixture(name = 'scene-a'): Document {
  const input: unknown = JSON.parse(readFileSync(join(process.cwd(), 'verification', 'fixtures', `${name}.json`), 'utf8'));
  return assertDocument(input);
}

function store(initial = fixture()): ProjectStore {
  return new ProjectStore(initial, { sessionId: SESSION, writerToken: WRITER });
}

function envelope(subject: ProjectStore, command: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  commandSequence += 1;
  return {
    commandId: `c2000000-0000-4000-8000-${commandSequence.toString(16).padStart(12, '0')}`,
    sessionId: SESSION,
    writerToken: WRITER,
    projectId: subject.snapshot().project.projectId,
    expectedRevision: subject.snapshot().project.revision,
    command,
    ...overrides,
  };
}

function accepted(result: Result) {
  if (!result.ok) assert.fail(`Expected success, received ${result.code}: ${JSON.stringify(result.errors)}`);
  assert.equal(result.changed, true);
  assert.match(result.semanticHash, /^sha256:[0-9a-f]{64}$/u);
  return result;
}

function rejected(subject: ProjectStore, input: unknown, expectedCode?: string) {
  const before = subject.snapshot();
  const result = subject.execute(input);
  if (result.ok) assert.fail(`Expected rejection, received revision ${result.revision}`);
  if (expectedCode !== undefined) assert.equal(result.code, expectedCode);
  assert.ok(result.code.length > 0);
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.currentRevision, before.project.revision);
  assert.deepEqual(subject.snapshot(), before, 'Rejected command must leave the complete document unchanged');
  return result;
}

function commit(subject: ProjectStore, command: unknown) {
  const beforeRevision = subject.snapshot().project.revision;
  const result = accepted(subject.execute(envelope(subject, command)));
  assert.equal(result.revision, beforeRevision + 1);
  assert.equal(subject.snapshot().project.revision, beforeRevision + 1);
  assert.equal(subject.snapshot().project.semanticHash, result.semanticHash);
  return result;
}

function atRevision(document: Document, revision: number): Document {
  const expected = structuredClone(document);
  expected.project.revision = revision;
  return expected;
}

test('D04 / R0-CMD-02: session, writer, project and revision gates reject before mutation or ID allocation', () => {
  const subject = store();
  const add = { type: 'add_entity', kind: 'normal', x: 20, y: 20 };
  for (const overrides of [
    { sessionId: 'stale-session' },
    { writerToken: 'stale-writer' },
    { projectId: 'different-project' },
    { expectedRevision: 1 },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
  ]) rejected(subject, envelope(subject, add, overrides));
  const result = commit(subject, add);
  assert.equal(result.allocatedEntityId, 'e1');
  assert.equal(result.revision, 1);
});

test('D04 / R0-CMD-02: the first completed command wins; a stale second writer cannot overwrite it', () => {
  const subject = store();
  const first = envelope(subject, { type: 'set_goal', value: 6 });
  const second = envelope(subject, { type: 'set_goal', value: 8 });
  assert.equal(accepted(subject.execute(first)).revision, 1);
  rejected(subject, second);
  assert.equal(subject.snapshot().project.rules.goal.targetScore, 6);
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(fixture(), 2));
});

test('D04 / R0-CMD-02: UUID idempotency returns the original receipt even after later revisions', () => {
  const subject = store();
  const input = envelope(subject, { type: 'set_goal', value: 6 });
  const original = accepted(subject.execute(input));
  const reordered = { ...input, command: { value: 6, type: 'set_goal' } };
  assert.deepEqual(subject.execute(reordered), original);
  assert.equal(subject.snapshot().project.revision, 1);
  commit(subject, { type: 'set_text', field: 'authorNote', value: '第二次编辑' });
  const beforeReplay = subject.snapshot();
  assert.deepEqual(subject.execute(structuredClone(input)), original);
  assert.deepEqual(subject.snapshot(), beforeReplay);
  rejected(subject, { ...input, command: { type: 'set_goal', value: 8 } }, 'E_IDEMPOTENCY_CONFLICT');
  commit(subject, { type: 'undo' });
  assert.equal(subject.snapshot().project.rules.goal.targetScore, 6);
  assert.equal(subject.snapshot().project.authorNote, '');
});

test('D04 / R0-CMD-02: allocation receipt replay creates exactly one entity and one undo unit', () => {
  const subject = store();
  const input = envelope(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 });
  const receipt = accepted(subject.execute(input));
  assert.equal(receipt.allocatedEntityId, 'e1');
  assert.deepEqual(subject.execute(structuredClone(input)), receipt);
  assert.equal(subject.snapshot().project.scene.entities.filter(entity => entity.id === 'e1').length, 1);
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(fixture(), 2));
  rejected(subject, envelope(subject, { type: 'undo' }));
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 60, y: 20 }).allocatedEntityId, 'e2');
});

test('D05 / R0-RT-17 branch A: copy/delete/undo preserves IDs and never reissues e1 or e2', () => {
  const initial = fixture();
  const subject = store(initial);
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }).allocatedEntityId, 'e1');
  assert.equal(commit(subject, { type: 'copy_entity', entityId: 'e1', x: 60, y: 20 }).allocatedEntityId, 'e2');
  const beforeDelete = subject.snapshot();
  commit(subject, { type: 'remove_entity', entityId: 'e1' });
  assert.equal(subject.snapshot().project.scene.entities.some(entity => entity.id === 'e1'), false);
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(beforeDelete, 4));
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 100, y: 20 }).allocatedEntityId, 'e3');
  for (const entity of initial.project.scene.entities) {
    assert.deepEqual(subject.snapshot().project.scene.entities.find(candidate => candidate.id === entity.id), entity);
  }
});

test('D05 / R0-RT-17 branch B: undo adds a new revision, clears its single unit and does not rewind allocation', () => {
  const subject = store();
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }).allocatedEntityId, 'e1');
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(fixture(), 2));
  rejected(subject, envelope(subject, { type: 'undo' }));
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 60, y: 20 }).allocatedEntityId, 'e2');
});

test('D06: failed add/copy and snapshot reads consume no IDs', () => {
  const subject = store();
  const invalidCommands: unknown[] = [
    { type: 'add_entity', kind: 'normal', x: 21, y: 20 },
    { type: 'add_entity', kind: 'normal', x: 10, y: 20 },
    { type: 'add_entity', kind: 'normal', x: 150, y: 100 },
    { type: 'add_entity', kind: 'normal', x: Number.NaN, y: 20 },
    { type: 'copy_entity', entityId: 'missing', x: 20, y: 20 },
    { type: 'copy_entity', entityId: 'n1', x: 20.5, y: 20 },
    { type: 'copy_entity', entityId: 'n1', x: 150, y: 100 },
  ];
  for (const command of invalidCommands) {
    rejected(subject, envelope(subject, command));
    assert.deepEqual(subject.snapshot(), fixture());
  }
  assert.equal(commit(subject, { type: 'copy_entity', entityId: 'h1', x: 20, y: 20 }).allocatedEntityId, 'e1');
  assert.deepEqual(subject.snapshot().project.scene.entities.find(entity => entity.id === 'e1'), { id: 'e1', kind: 'high', x: 20, y: 20 });
});

test('D06: a fixture e1 is preserved and skipped during successful allocation', () => {
  const initial = fixture();
  const normal = initial.project.scene.entities.find(entity => entity.id === 'n1');
  assert.ok(normal);
  normal.id = 'e1';
  const subject = store(initial);
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }).allocatedEntityId, 'e2');
  assert.deepEqual(subject.snapshot().project.scene.entities.find(entity => entity.id === 'e1'), { id: 'e1', kind: 'normal', x: 150, y: 100 });
});

test('D05: same-value and invalid commands preserve the previous complete undo unit', () => {
  const subject = store();
  const initial = subject.snapshot();
  commit(subject, { type: 'set_goal', value: 6 });
  rejected(subject, envelope(subject, { type: 'set_goal', value: 6 }), 'E_NO_CHANGE');
  rejected(subject, envelope(subject, { type: 'move_entity', entityId: 'h1', x: 660, y: 190 }), 'E_NO_CHANGE');
  rejected(subject, envelope(subject, { type: 'set_text', field: 'title', value: initial.project.title }), 'E_NO_CHANGE');
  rejected(subject, envelope(subject, { type: 'set_timer', value: { enabled: false, limit: 45 } }), 'E_NO_CHANGE');
  rejected(subject, envelope(subject, { type: 'set_reward_values', value: { normalValue: 3, highValue: 3 } }));
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(initial, 2));
  rejected(subject, envelope(subject, { type: 'undo' }));
});

test('D05: only the latest successful edit is undone, with complete content and current project identity', () => {
  const subject = store();
  commit(subject, { type: 'set_goal', value: 6 });
  const first = subject.snapshot();
  commit(subject, { type: 'move_entity', entityId: 'h1', x: 540, y: 220 });
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(first, 3));
  rejected(subject, envelope(subject, { type: 'undo' }));
  assert.equal(subject.snapshot().project.projectId, fixture().project.projectId);
  assert.equal(subject.snapshot().project.sourceProject, null);
});

test('R0-RT-11: manual goal15 draft is accepted unchanged and a later goal6 edit repairs it explicitly', () => {
  const subject = store();
  const initial = subject.snapshot();
  commit(subject, { type: 'set_goal', value: 15 });
  assert.equal(subject.snapshot().project.rules.goal.targetScore, 15);
  assert.deepEqual(subject.snapshot().project.scene, initial.project.scene);
  assert.deepEqual(subject.snapshot().project.rules.timer, { enabled: false, limit: 45 });
  commit(subject, { type: 'set_goal', value: 6 });
  commit(subject, { type: 'undo' });
  assert.equal(subject.snapshot().project.rules.goal.targetScore, 15);
  assert.equal(subject.snapshot().project.revision, 3);
});

test('R0-RT-11: removing every reward is a legal manual draft without auto-fixing goal or timer', () => {
  const subject = store();
  const rewards = subject.snapshot().project.scene.entities.filter(entity => entity.kind === 'normal' || entity.kind === 'high');
  let beforeLast = subject.snapshot();
  for (const reward of rewards) {
    beforeLast = subject.snapshot();
    commit(subject, { type: 'remove_entity', entityId: reward.id });
  }
  const draft = subject.snapshot();
  assert.deepEqual(draft.project.scene.entities.map(entity => entity.id), ['p', 'g1']);
  assert.equal(draft.project.rules.goal.targetScore, 10);
  assert.deepEqual(draft.project.rules.timer, { enabled: false, limit: 45 });
  assert.equal(draft.project.revision, rewards.length);
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(beforeLast, rewards.length + 1));
});

test('R0-CMD-02: player add/copy/delete and unknown or untrusted command entrances reject atomically', () => {
  const subject = store();
  const commands: unknown[] = [
    { type: 'add_entity', kind: 'player', x: 20, y: 20 },
    { type: 'copy_entity', entityId: 'p', x: 20, y: 20 },
    { type: 'remove_entity', entityId: 'p' },
    { type: 'remove_entity', entityId: 'missing' },
    { type: 'move_entity', entityId: 'missing', x: 20, y: 20 },
    { type: 'unknown' },
    { type: 'set_goal', value: 6, shell: 'do-not-execute' },
    { type: 'set_goal', value: 6, url: 'https://invalid.example/' },
    { type: 'set_theme', value: { themeId: 'theme_snack', playerSkinId: 'snack_player_01', script: 'do-not-execute' } },
    { type: 'apply_operations', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] },
    { type: 'confirm_candidate', candidateState: fixture().project, passed: true },
  ];
  for (const command of commands) rejected(subject, envelope(subject, command));
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }).allocatedEntityId, 'e1');
});

test('D04: malformed envelopes and non-JSON command values reject with no partial commit', () => {
  const subject = store();
  const input = envelope(subject, { type: 'set_goal', value: 6 });
  for (const invalid of [null, [], 'command', 6, undefined]) rejected(subject, invalid);
  for (const field of ['commandId', 'sessionId', 'writerToken', 'projectId', 'expectedRevision', 'command']) {
    const missing = envelope(subject, { type: 'set_goal', value: 6 });
    delete missing[field];
    rejected(subject, missing);
  }
  for (const overrides of [
    { commandId: 'not-a-uuid' },
    { expectedRevision: Number.POSITIVE_INFINITY },
    { arbitrary: true },
    { command: { type: 'set_goal', value: undefined } },
    { command: { type: 'set_goal', value: () => 6 } },
    { command: new Date('2026-10-28T00:00:00Z') },
    { command: { type: 'set_goal', value: '6' } },
  ]) rejected(subject, envelope(subject, input.command, overrides));
  assert.equal(subject.snapshot().project.revision, 0);
});

test('R0-RT-11: illegal positions and rules are never rounded, clamped, relocated or partly repaired', () => {
  const subject = store();
  commit(subject, { type: 'set_text', field: 'authorNote', value: '保持撤销' });
  const invalidCommands: unknown[] = [
    { type: 'move_entity', entityId: 'n1', x: 10, y: 100 },
    { type: 'move_entity', entityId: 'n1', x: 151, y: 100 },
    { type: 'move_entity', entityId: 'n1', x: 80, y: 270 },
    { type: 'move_entity', entityId: 'n1', x: Number.POSITIVE_INFINITY, y: 100 },
    { type: 'set_goal', value: 1.5 },
    { type: 'set_goal', value: 0 },
    { type: 'set_goal', value: 100 },
    { type: 'set_reward_values', value: { normalValue: 3, highValue: 3 } },
    { type: 'set_reward_values', value: { normalValue: 1, highValue: 10 } },
    { type: 'set_guard_speed', value: 25 },
    { type: 'set_guard_speed', value: 190 },
    { type: 'set_detect_radius', value: 59 },
    { type: 'set_detect_radius', value: 305 },
    { type: 'set_timer', value: { enabled: false, limit: 14 } },
    { type: 'set_timer', value: { enabled: true, limit: 31 } },
    { type: 'set_timer', value: { enabled: 'false', limit: 30 } },
    { type: 'set_theme', value: { themeId: 'remote_theme', playerSkinId: 'snack_player_01' } },
    { type: 'set_theme', value: { themeId: 'theme_snack', playerSkinId: 'unknown_skin' } },
  ];
  for (const command of invalidCommands) rejected(subject, envelope(subject, command));
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(fixture(), 2));
});

test('R0-RT-11: full budget refuses overflow, then permits one new ID after an explicit deletion', () => {
  const subject = store(fixture('budget-full'));
  assert.equal(subject.snapshot().project.scene.entities.length, 18);
  for (const kind of ['guard', 'normal', 'high']) {
    rejected(subject, envelope(subject, { type: 'add_entity', kind, x: 20, y: 20 }));
  }
  rejected(subject, envelope(subject, { type: 'copy_entity', entityId: 'n1', x: 20, y: 20 }));
  commit(subject, { type: 'remove_entity', entityId: 'n12' });
  assert.equal(commit(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }).allocatedEntityId, 'e1');
  assert.equal(subject.snapshot().project.scene.entities.length, 18);
});

test('R0-RT-11: legal zero/one/two guard edits retain stable fixture IDs', () => {
  const subject = store(fixture('scene-b'));
  const before = subject.snapshot().project.scene.entities;
  assert.equal(commit(subject, { type: 'add_entity', kind: 'guard', x: 20, y: 20 }).allocatedEntityId, 'e1');
  assert.equal(commit(subject, { type: 'add_entity', kind: 'guard', x: 100, y: 20 }).allocatedEntityId, 'e2');
  rejected(subject, envelope(subject, { type: 'add_entity', kind: 'guard', x: 200, y: 20 }));
  commit(subject, { type: 'remove_entity', entityId: 'e1' });
  commit(subject, { type: 'remove_entity', entityId: 'e2' });
  assert.deepEqual(subject.snapshot().project.scene.entities, before);
});

test('D04: all legal scalar parameter commands preserve untouched document fields and undo their full value', () => {
  const cases = [
    { command: { type: 'set_reward_values', value: { normalValue: 2, highValue: 4 } }, field: 'rewards', expected: { normalValue: 2, highValue: 4 } },
    { command: { type: 'set_guard_speed', value: 80 }, field: 'guards', expected: { speed: 80, detectRadius: 180 } },
    { command: { type: 'set_detect_radius', value: 140 }, field: 'guards', expected: { speed: 100, detectRadius: 140 } },
    { command: { type: 'set_timer', value: { enabled: true, limit: 30 } }, field: 'timer', expected: { enabled: true, limit: 30 } },
  ];
  for (const entry of cases) {
    const subject = store();
    const initial = subject.snapshot();
    const result = commit(subject, entry.command);
    assert.deepEqual(subject.snapshot().project.rules, { ...initial.project.rules, [entry.field]: entry.expected });
    assert.notEqual(result.semanticHash, initial.project.semanticHash);
    assert.deepEqual(subject.snapshot().project.scene, initial.project.scene);
    assert.deepEqual(subject.snapshot().project.presentation, initial.project.presentation);
    assert.equal(subject.snapshot().project.title, initial.project.title);
    commit(subject, { type: 'undo' });
    assert.deepEqual(subject.snapshot(), atRevision(initial, 2));
  }
});

test('D04: text normalization is limited to the empty title; text/theme edits keep the gameplay hash', () => {
  const subject = store();
  const initialHash = subject.snapshot().project.semanticHash;
  commit(subject, { type: 'set_text', field: 'title', value: '' });
  assert.equal(subject.snapshot().project.title, '未命名作品');
  commit(subject, { type: 'set_text', field: 'instructions', value: '  <b>原文</b>  ' });
  assert.equal(subject.snapshot().project.instructions, '  <b>原文</b>  ');
  commit(subject, { type: 'set_text', field: 'authorNote', value: '说明' });
  commit(subject, { type: 'set_text', field: 'designIntent', value: '' });
  assert.equal(subject.snapshot().project.designIntent, '');
  commit(subject, { type: 'set_text', field: 'designIntent', value: null });
  const beforeTheme = subject.snapshot();
  commit(subject, { type: 'set_theme', value: { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } });
  assert.equal(subject.snapshot().project.presentation.themeId, 'theme_r0_contrast');
  assert.equal(subject.snapshot().project.semanticHash, initialHash);
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(beforeTheme, 7));
  for (const command of [
    { type: 'set_text', field: 'title', value: '中'.repeat(41) },
    { type: 'set_text', field: 'instructions', value: 'x'.repeat(201) },
    { type: 'set_text', field: 'authorNote', value: 'x'.repeat(121) },
    { type: 'set_text', field: 'designIntent', value: 'x'.repeat(121) },
    { type: 'set_text', field: 'title', value: null },
    { type: 'set_text', field: 'projectId', value: 'replace-identity' },
  ]) rejected(subject, envelope(subject, command));
});

test('D04: constructor input, snapshots and command payloads cannot mutate authoritative state or undo', () => {
  const initial = fixture();
  const expectedInitial = structuredClone(initial);
  const subject = store(initial);
  initial.project.title = '外部修改';
  initial.project.rules.goal.targetScore = 99;
  initial.project.scene.entities.splice(0);
  assert.deepEqual(subject.snapshot(), expectedInitial);
  const snapshot = subject.snapshot();
  snapshot.project.title = '快照修改';
  snapshot.project.rules.guards.speed = 180;
  snapshot.project.scene.entities.reverse();
  snapshot.project.presentation.themeId = 'theme_r0_contrast';
  assert.deepEqual(subject.snapshot(), expectedInitial);
  const value = { normalValue: 2, highValue: 4 };
  commit(subject, { type: 'set_reward_values', value });
  value.normalValue = 3;
  value.highValue = 9;
  assert.deepEqual(subject.snapshot().project.rules.rewards, { normalValue: 2, highValue: 4 });
  const after = subject.snapshot();
  after.project.rules.rewards.highValue = 9;
  commit(subject, { type: 'undo' });
  assert.deepEqual(subject.snapshot(), atRevision(expectedInitial, 2));
});

test('D04: callers cannot corrupt a cached command receipt through the returned object', () => {
  const subject = store();
  const input = envelope(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 });
  const receipt = accepted(subject.execute(input));
  const expected = structuredClone(receipt);
  try { Reflect.set(receipt, 'revision', 999); } catch { /* A frozen receipt also satisfies isolation. */ }
  try { Reflect.set(receipt, 'allocatedEntityId', 'attacker-id'); } catch { /* ditto */ }
  assert.deepEqual(subject.execute(structuredClone(input)), expected);
  assert.equal(subject.snapshot().project.revision, 1);
});

test('D04: a revision at the safe-integer ceiling refuses edits with no content or allocation change', () => {
  const initial = fixture();
  initial.project.revision = Number.MAX_SAFE_INTEGER;
  const subject = store(initial);
  rejected(subject, envelope(subject, { type: 'set_text', field: 'title', value: '不可递增' }));
  rejected(subject, envelope(subject, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }));
  assert.deepEqual(subject.snapshot(), initial);
});
