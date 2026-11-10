import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DomainError, applyOperations, assertDocument, candidateHash, canonicalJson,
  parseDocument, parseStrictJson, semanticHash, validateDocument, validatePlayability,
  type CandidateHashInput, type Document, type Entity, type Operation,
} from '../src/domain/index.js';

// Independent authoring expectations are frozen T00 JSON bytes and digests.
// These tests cover domain branches only, not a real trial/run or whole-case pass.
interface SemanticVector { fixture: string; fileHash: string; semanticHash: string; canonicalJson: string }
interface GoldenCandidate {
  hashInput: CandidateHashInput; canonicalUtf8: string; expectedCandidateHash: string;
  expectedBaseSemanticHash: string; expectedCandidateSemanticHash: string;
}
const vectors = (JSON.parse(read('verification/fixture-hash-vectors.json')) as { vectors: SemanticVector[] }).vectors;
const golden = (JSON.parse(read('verification/case-manifest.json')) as { goldenCandidateVector: GoldenCandidate }).goldenCandidateVector;
const contrast = { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } as const;

function read(path: string): string { return readFileSync(resolve(process.cwd(), path), 'utf8'); }
function fixture(name = 'scene-a'): Document { return parseDocument(read(`verification/fixtures/${name}.json`)); }
function sha(bytes: string): string { return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`; }
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function replace(input: unknown, path: readonly string[], value: unknown): unknown {
  const copy: unknown = structuredClone(input);
  let current = object(copy);
  for (const key of path.slice(0, -1)) current = object(current[key]);
  const last = path.at(-1);
  assert.notEqual(last, undefined);
  current[last!] = value;
  return copy;
}
function invalid(input: unknown): void {
  const result = validateDocument(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.equal(typeof error.code, 'string');
    assert.ok(error.code.length > 0);
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.message, 'string');
  }
  assert.throws((): Document => assertDocument(input), DomainError);
}
function fails(action: () => unknown, code?: string): void {
  assert.throws(action, (error: unknown): boolean => {
    assert.ok(error instanceof DomainError);
    assert.ok(error.code.length > 0);
    assert.ok(error.errors.length > 0);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}
function entity(doc: Document, id: string): Entity {
  const found = doc.project.scene.entities.find((item: Entity): boolean => item.id === id);
  assert.ok(found);
  return found;
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown): unknown => reverseKeys(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(object(value)).reverse().map(([key, entry]: [string, unknown]): [string, unknown] => [key, reverseKeys(entry)]));
  }
  return value;
}
function candidateWith(doc: Document, operations: Operation[]): CandidateHashInput {
  const candidate = applyOperations(doc, operations);
  return {
    projectId: doc.project.projectId, requestId: golden.hashInput.requestId,
    baseRevision: doc.project.revision, baseSemanticHash: golden.expectedBaseSemanticHash,
    runtimeVersion: doc.runtimeVersion, catalogVersion: doc.catalogVersion,
    ruleRegistryVersion: 'collect-chase-rules@1', trialPolicyVersion: 'collect-chase-candidate-trial@2',
    operations, candidateState: {
      scene: candidate.project.scene, rules: candidate.project.rules, presentation: candidate.project.presentation,
    },
  };
}

test('R0-HASH-01: all T00 fixture bytes and semantic digests match independent frozen vectors', (): void => {
  assert.equal(vectors.length, 19);
  for (const vector of vectors) {
    const bytes = read(vector.fixture);
    assert.equal(sha(bytes), vector.fileHash, vector.fixture);
    assert.equal(sha(vector.canonicalJson), vector.semanticHash, vector.fixture);
    const doc = parseDocument(bytes);
    assert.equal(semanticHash(doc), vector.semanticHash, vector.fixture);
    assert.equal(doc.project.semanticHash, vector.semanticHash, vector.fixture);
    assert.equal(canonicalJson(JSON.parse(vector.canonicalJson) as unknown), vector.canonicalJson);
  }
  const risk = vectors.find((entry: SemanticVector): boolean => entry.fixture.endsWith('/scene-a-goal6.json'));
  assert.ok(risk);
  assert.equal(risk.semanticHash, 'sha256:7a0710df8324cf21b85d04ba8fa62f03f62feb3c46e95dca31557facd488aaf9');
});

test('R0-HASH-01: key/entity reordering is invariant and does not mutate entity order', (): void => {
  const doc = fixture();
  const reversed = assertDocument(reverseKeys(doc));
  reversed.project.scene.entities.reverse();
  const before = structuredClone(reversed);
  assert.equal(semanticHash(reversed), golden.expectedBaseSemanticHash);
  assert.deepEqual(reversed, before);
  assert.equal(semanticHash(doc), golden.expectedBaseSemanticHash);
});

test('R0-HASH-01: excluded metadata changes individually preserve gameplay digest', (): void => {
  const base = fixture();
  const variants: Array<readonly [readonly string[], unknown]> = [
    [['project', 'projectId'], 'different-project'], [['project', 'revision'], 9],
    [['project', 'title'], '另一个标题'], [['project', 'instructions'], '另一段玩法说明'],
    [['project', 'authorNote'], '作者注记'], [['project', 'designIntent'], '设计目标'],
    [['project', 'presentation'], contrast],
  ];
  for (const [path, value] of variants) assert.equal(semanticHash(assertDocument(replace(base, path, value))), golden.expectedBaseSemanticHash, path.join('/'));
  // Lower-level projection probes do not authorize unsupported execution versions.
  const versionProbe = replace(base, ['formatVersion'], 'unsupported-format') as Document;
  assert.equal(semanticHash(versionProbe), golden.expectedBaseSemanticHash);
  invalid(versionProbe);
  const catalogProbe = replace(base, ['catalogVersion'], 'unsupported-catalog') as Document;
  assert.equal(semanticHash(catalogProbe), golden.expectedBaseSemanticHash);
  invalid(catalogProbe);
  const runtimeProbe = replace(base, ['runtimeVersion'], 'collect-chase@999') as Document;
  assert.notEqual(semanticHash(runtimeProbe), golden.expectedBaseSemanticHash);
  invalid(runtimeProbe);
  const moved = fixture();
  entity(moved, 'h1').x = 650;
  assert.notEqual(semanticHash(moved), golden.expectedBaseSemanticHash);
});

test('strict canonical JSON preserves arrays, UTF-16 key order, strings and -0', (): void => {
  assert.equal(canonicalJson({ z: [2, 1], a: -0, text: '\u00e9\ne\u0301' }), '{"a":0,"text":"é\\né","z":[2,1]}');
  assert.equal(canonicalJson({ a: 1, Z: 2, _: 3, '𐀀': 4, '\ue000': 5 }), '{"Z":2,"_":3,"a":1,"𐀀":4,"":5}');
  assert.notEqual(canonicalJson('é'), canonicalJson('e\u0301'));
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, new Date(0), { bad: undefined }, { bad: (): number => 1 }, [, 1]]) {
    fails((): string => canonicalJson(value));
  }
});

test('R0-HASH-02: product candidate bytes/digests equal frozen independent golden vector', (): void => {
  assert.equal(sha(golden.canonicalUtf8), 'sha256:560da260f37a0fa316b6884b5676146a8d4e2890e9fb0f24e755b99ffb5f8b5e');
  assert.equal(golden.expectedCandidateHash, 'sha256:560da260f37a0fa316b6884b5676146a8d4e2890e9fb0f24e755b99ffb5f8b5e');
  assert.equal(canonicalJson(golden.hashInput), golden.canonicalUtf8);
  assert.equal(candidateHash(golden.hashInput), golden.expectedCandidateHash);
  const base = fixture();
  const actual = candidateWith(base, structuredClone(golden.hashInput.operations));
  assert.equal(candidateHash(actual), golden.expectedCandidateHash);
  const candidate = applyOperations(base, golden.hashInput.operations);
  assert.equal(semanticHash(candidate), golden.expectedCandidateSemanticHash);
  assert.deepEqual(candidate.project.rules, golden.hashInput.candidateState.rules);
});

test('R0-HASH-02: entity/key order invariant; operation order and expectedValue participate', (): void => {
  const reordered = reverseKeys(golden.hashInput) as CandidateHashInput;
  reordered.candidateState.scene.entities.reverse();
  const before = structuredClone(reordered);
  assert.equal(candidateHash(reordered), golden.expectedCandidateHash);
  assert.deepEqual(reordered, before);
  const reversed = structuredClone(golden.hashInput);
  reversed.operations.reverse();
  assert.notEqual(candidateHash(reversed), golden.expectedCandidateHash);
  const reverseCandidate = applyOperations(fixture(), reversed.operations);
  assert.equal(semanticHash(reverseCandidate), golden.expectedCandidateSemanticHash);
  const changedExpected = structuredClone(golden.hashInput);
  changedExpected.operations[0] = { op: 'set_goal', expectedValue: 9, value: 6 };
  assert.notEqual(candidateHash(changedExpected), golden.expectedCandidateHash);
});

test('R0-HASH-02: candidate theme, baseline identity and trusted versions participate', (): void => {
  const variants: Array<readonly [readonly string[], unknown]> = [
    [['projectId'], 'another-project'], [['requestId'], 'a1000000-0000-4000-8000-000000000003'],
    [['baseRevision'], 1], [['baseSemanticHash'], 'sha256:' + '0'.repeat(64)],
    [['candidateState', 'presentation'], contrast],
  ];
  for (const [path, value] of variants) assert.notEqual(candidateHash(replace(golden.hashInput, path, value) as CandidateHashInput), golden.expectedCandidateHash, path.join('/'));
  const themed = fixture();
  themed.project.presentation = { ...contrast };
  assert.equal(semanticHash(themed), golden.expectedBaseSemanticHash);
  for (const key of ['buildHash', 'authEpoch', 'inputScript']) {
    fails((): string => candidateHash({ ...golden.hashInput, [key]: 'forbidden-extra' }));
  }
  const missing = { ...golden.hashInput } as Partial<CandidateHashInput>;
  delete missing.trialPolicyVersion;
  fails((): string => candidateHash(missing as CandidateHashInput));
});

test('strict Document entry rejects unknown fields at every object layer', (): void => {
  const base = fixture();
  const paths: string[][] = [[], ['project'], ['project', 'scene'], ['project', 'rules'],
    ['project', 'rules', 'goal'], ['project', 'rules', 'rewards'], ['project', 'rules', 'guards'],
    ['project', 'rules', 'timer'], ['project', 'presentation']];
  for (const path of paths) {
    let container: unknown = base;
    for (const key of path) container = object(container)[key];
    invalid(replace(base, path.length === 0 ? ['unexpected'] : [...path, 'unexpected'], 'https://example.invalid/script'));
  }
  const entityExtra = fixture();
  entityExtra.project.scene.entities[0] = { ...entity(entityExtra, 'p'), radius: 12 } as Entity;
  invalid(entityExtra);
  for (const key of ['counts', 'totalScore', 'ruleId', 'registry', 'exportedAt', 'snapshots']) invalid({ ...base, [key]: 1 });
});

test('JSON entry rejects duplicates (including escaped keys), trailing input and oversize bytes', (): void => {
  const text = read('verification/fixtures/scene-a.json');
  const duplicates = [
    text.replace('"formatVersion":', '"formatVersion":"3.0-review.3","formatVersion":'),
    text.replace('"targetScore": 10', '"targetScore":10,"target\\u0053core":10'),
    text.replace('"x": 80', '"x":80,"x":80'),
  ];
  for (const input of [...duplicates, text + '{}', '{', 'null', '[1]', '\ufeff' + text]) fails((): Document => parseDocument(input));
  fails((): Document => parseDocument(' '.repeat(1_048_577) + text));
  // Repeated names in separate entities are legal, not duplicate object members.
  assert.equal(parseDocument(text).project.scene.entities.length, 12);
});

test('untrusted in-memory inputs reject non-JSON values and non-plain prototypes', (): void => {
  const base = fixture();
  for (const value of [undefined, NaN, Infinity, -Infinity, '80', 80.1, 9007199254740992]) invalid(replace(base, ['project', 'scene'], { ...base.project.scene, entities: [{ ...entity(base, 'p'), x: value }, ...base.project.scene.entities.slice(1)] }));
  invalid({ ...base, project: Object.assign(Object.create({ injected: true }) as object, base.project) });
  invalid(replace(base, ['project', 'authorNote'], (): string => 'text'));
  invalid(replace(base, ['project', 'designIntent'], new Date(0)));
});

test('required fields, fixed versions/world/presentation and controlled ID references are strict', (): void => {
  const base = fixture();
  for (const [path, value] of [
    [['formatVersion'], '3.0'], [['runtimeVersion'], 'collect-chase@999'], [['catalogVersion'], 'unknown'],
    [['project', 'sourceProject'], {}], [['project', 'scene', 'width'], 961], [['project', 'scene', 'height'], 541],
    [['project', 'scene', 'worldId'], 'other'], [['project', 'presentation'], { themeId: 'theme_r0_contrast', playerSkinId: 'other' }],
    [['project', 'presentation'], { themeId: 'https://example.invalid', playerSkinId: 'snack_player_01' }],
  ] as Array<[string[], unknown]>) invalid(replace(base, path, value));
  for (const id of ['', ' has-space', '中文', 'a/b', '-start', 'x'.repeat(97)]) invalid(replace(base, ['project', 'projectId'], id));
  assert.equal(assertDocument(replace(base, ['project', 'projectId'], 'A' + 'x'.repeat(95))).project.projectId.length, 96);
  for (const revision of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1]) invalid(replace(base, ['project', 'revision'], revision));
  assert.equal(assertDocument(replace(base, ['project', 'revision'], Number.MAX_SAFE_INTEGER)).project.revision, Number.MAX_SAFE_INTEGER);
  const missing = structuredClone(base) as Partial<Document>;
  delete missing.catalogVersion;
  invalid(missing);
  const duplicateId = fixture();
  entity(duplicateId, 'h1').id = 'n1';
  invalid(duplicateId);
});

test('text limits count UTF-16 without trim, truncate or HTML evaluation', (): void => {
  const base = fixture();
  const limits: Array<readonly [string, number]> = [['title', 40], ['instructions', 200], ['authorNote', 120], ['designIntent', 120]];
  for (const [field, limit] of limits) {
    assert.equal(object(assertDocument(replace(base, ['project', field], 'x'.repeat(limit))).project)[field], 'x'.repeat(limit));
    invalid(replace(base, ['project', field], 'x'.repeat(limit + 1)));
  }
  assert.equal(assertDocument(replace(base, ['project', 'title'], '😀'.repeat(20))).project.title.length, 40);
  invalid(replace(base, ['project', 'title'], '😀'.repeat(21)));
  invalid(replace(base, ['project', 'title'], ''));
  assert.equal(assertDocument(replace(base, ['project', 'title'], '  ')).project.title, '  ');
  assert.equal(assertDocument(replace(base, ['project', 'instructions'], '<script>literal</script>')).project.instructions, '<script>literal</script>');
  assert.equal(assertDocument(replace(base, ['project', 'designIntent'], '')).project.designIntent, '');
});

test('rule ranges/steps reject fractional, coercible and disabled-timer invalid values', (): void => {
  const base = fixture();
  const ranges: Array<readonly [readonly string[], readonly number[], readonly unknown[]]> = [
    [['goal', 'targetScore'], [1, 99], [0, 100, 1.5, '6']],
    [['guards', 'speed'], [20, 180], [10, 190, 25, 20.5]],
    [['guards', 'detectRadius'], [60, 300], [50, 310, 65]],
    [['timer', 'limit'], [15, 120], [10, 125, 16, 15.5]],
  ];
  for (const [path, legal, illegal] of ranges) {
    for (const value of legal) assert.equal(validateDocument(replace(base, ['project', 'rules', ...path], value)).valid, true);
    for (const value of illegal) invalid(replace(base, ['project', 'rules', ...path], value));
  }
  for (const rewards of [{ normalValue: 1, highValue: 2 }, { normalValue: 3, highValue: 9 }]) assert.equal(validateDocument(replace(base, ['project', 'rules', 'rewards'], rewards)).valid, true);
  for (const rewards of [{ normalValue: 0, highValue: 3 }, { normalValue: 4, highValue: 9 }, { normalValue: 1, highValue: 10 }, { normalValue: 2, highValue: 2 }, { normalValue: 3, highValue: 2 }]) invalid(replace(base, ['project', 'rules', 'rewards'], rewards));
  invalid(replace(base, ['project', 'rules', 'timer', 'enabled'], 0));
  invalid(replace(fixture('scene-b'), ['project', 'rules', 'guards', 'speed'], 25));
});

test('entity count maxima, one player and initial world/grid/spacing boundaries', (): void => {
  const full = fixture('budget-full');
  assert.equal(full.project.scene.entities.length, 18);
  assert.equal(validateDocument(full).valid, true);
  for (const kind of ['guard', 'normal', 'high'] as const) {
    const tooMany = structuredClone(full);
    tooMany.project.scene.entities.push({ id: 'extra', kind, x: 20, y: 20 });
    invalid(tooMany);
  }
  const noPlayer = fixture();
  noPlayer.project.scene.entities = noPlayer.project.scene.entities.filter((item: Entity): boolean => item.kind !== 'player');
  invalid(noPlayer);
  const twoPlayers = fixture();
  twoPlayers.project.scene.entities.push({ id: 'p2', kind: 'player', x: 20, y: 20 });
  invalid(twoPlayers);
  for (const point of [{ x: 20, y: 20 }, { x: 940, y: 520 }]) {
    const edge = fixture('scene-b');
    Object.assign(entity(edge, 'p'), point);
    assert.equal(validateDocument(edge).valid, true);
  }
  for (const point of [{ x: 10, y: 20 }, { x: 950, y: 20 }, { x: 20, y: 10 }, { x: 20, y: 530 }, { x: 21, y: 20 }]) {
    const bad = fixture('scene-b');
    Object.assign(entity(bad, 'p'), point);
    invalid(bad);
  }
  const equalDistance = fixture();
  equalDistance.project.scene.entities = [{ id: 'p', kind: 'player', x: 20, y: 20 }, { id: 'g', kind: 'guard', x: 50, y: 20 }];
  assert.equal(validateDocument(equalDistance).valid, true); // 12 + 14 + 4 = 30, equality legal.
  entity(equalDistance, 'g').x = 40;
  invalid(equalDistance);
  const rewardPair = fixture();
  rewardPair.project.scene.entities = [{ id: 'p', kind: 'player', x: 80, y: 270 }, { id: 'n1', kind: 'normal', x: 20, y: 20 }, { id: 'n2', kind: 'normal', x: 40, y: 20 }];
  invalid(rewardPair); // All pairs checked, not just distance from player.
});

test('structure/playability distinguish empty and impossible-goal drafts without changing source', (): void => {
  const base = fixture();
  assert.deepEqual({ ...validatePlayability(base), errors: [] }, { playable: true, totalScore: 14, rewardCount: 10, errors: [] });
  const draft = fixture();
  draft.project.rules.goal.targetScore = 15;
  assert.equal(validateDocument(draft).valid, true);
  const before = structuredClone(draft);
  const result = validatePlayability(draft);
  assert.equal(result.playable, false);
  assert.equal(result.totalScore, 14);
  assert.equal(result.rewardCount, 10);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(draft, before);
  const empty = fixture();
  empty.project.scene.entities = empty.project.scene.entities.filter((item: Entity): boolean => item.kind === 'player' || item.kind === 'guard');
  assert.equal(validateDocument(empty).valid, true);
  const emptyResult = validatePlayability(empty);
  assert.equal(emptyResult.playable, false);
  assert.equal(emptyResult.totalScore, 0);
  assert.equal(emptyResult.rewardCount, 0);
  const b = validatePlayability(fixture('scene-b'));
  assert.equal(b.playable, true);
  assert.equal(b.totalScore, 5);
  assert.equal(b.rewardCount, 5);
});

test('caller-supplied well-shaped semantic hash is recomputed; malformed hash still rejects', (): void => {
  const base = fixture();
  const forged = replace(base, ['project', 'semanticHash'], 'sha256:' + '0'.repeat(64));
  assert.equal(assertDocument(forged).project.semanticHash, golden.expectedBaseSemanticHash);
  assert.equal(parseDocument(JSON.stringify(forged)).project.semanticHash, golden.expectedBaseSemanticHash);
  invalid(replace(base, ['project', 'semanticHash'], 'not-a-digest'));
});

test('R0-RT-14 domain only: all seven controlled operations load exact full values', (): void => {
  const cases: Array<readonly [Operation, (doc: Document) => unknown, unknown]> = [
    [{ op: 'set_goal', expectedValue: 10, value: 6 }, (doc: Document): number => doc.project.rules.goal.targetScore, 6],
    [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }, (doc: Document): unknown => doc.project.rules.rewards, { normalValue: 2, highValue: 4 }],
    [{ op: 'set_guard_speed', expectedValue: 100, value: 80 }, (doc: Document): number => doc.project.rules.guards.speed, 80],
    [{ op: 'set_detect_radius', expectedValue: 180, value: 140 }, (doc: Document): number => doc.project.rules.guards.detectRadius, 140],
    [{ op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } }, (doc: Document): unknown => doc.project.rules.timer, { enabled: true, limit: 30 }],
    [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } }, (doc: Document): unknown => ({ x: entity(doc, 'h1').x, y: entity(doc, 'h1').y }), { x: 540, y: 220 }],
    [{ op: 'set_theme', expectedValue: { themeId: 'theme_snack', playerSkinId: 'snack_player_01' }, value: contrast }, (doc: Document): unknown => doc.project.presentation, contrast],
  ];
  for (const [operation, get, expected] of cases) {
    const base = fixture();
    const before = structuredClone(base);
    const result = applyOperations(base, [operation]);
    assert.deepEqual(get(result), expected, operation.op);
    assert.deepEqual(base, before, operation.op);
    assert.equal(result.project.projectId, base.project.projectId);
    assert.equal(result.project.revision, 0); // Pure candidate application does not commit Store revision.
    assert.equal(result.project.semanticHash, semanticHash(result));
    assert.equal(result.project.title, base.project.title);
    assert.equal(result.project.scene.entities.length, 12);
  }
});

test('R0-CMD-01 domain: bad final overlap rejects entire batch and preserves baseline', (): void => {
  const base = fixture();
  const before = structuredClone(base);
  fails((): Document => applyOperations(base, [
    { op: 'set_goal', expectedValue: 10, value: 6 },
    { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 100 } },
  ]));
  assert.deepEqual(base, before);
  assert.equal(base.project.rules.goal.targetScore, 10);
  const occupied = fixture();
  occupied.project.scene.entities.push({ id: 'e1', kind: 'normal', x: 540, y: 220 });
  assert.equal(validateDocument(occupied).valid, true);
  fails((): Document => applyOperations(occupied, [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } }]));
});

test('candidate results share no mutable scene/rules/presentation references with their baseline', (): void => {
  const base = fixture();
  const before = structuredClone(base);
  const result = applyOperations(base, [{ op: 'set_goal', expectedValue: 10, value: 6 }]);
  entity(result, 'p').x = 90;
  result.project.rules.guards.speed = 80;
  result.project.rules.rewards.normalValue = 2;
  result.project.rules.timer.limit = 30;
  result.project.presentation.themeId = 'theme_r0_contrast';
  result.project.scene.entities.push({ id: 'isolated', kind: 'normal', x: 20, y: 20 });
  assert.deepEqual(base, before);
});

test('R0-CMD-01 domain: legal two-entity swap waits for final spatial validation', (): void => {
  const base = fixture();
  const before = structuredClone(base);
  const result = applyOperations(base, [
    { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 780, y: 350 } },
    { op: 'move_entity', entityId: 'h2', expectedValue: { x: 780, y: 350 }, value: { x: 660, y: 190 } },
  ]);
  assert.deepEqual(entity(result, 'h1'), { id: 'h1', kind: 'high', x: 780, y: 350 });
  assert.deepEqual(entity(result, 'h2'), { id: 'h2', kind: 'high', x: 660, y: 190 });
  assert.deepEqual(base, before);
  assert.equal(validatePlayability(result).playable, true);
});

test('R0-CMD-01 domain: sequential expectedValue and net-no-change batch semantics', (): void => {
  const base = fixture();
  const before = structuredClone(base);
  const valid = [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 8, value: 6 }];
  assert.equal(applyOperations(base, valid).project.rules.goal.targetScore, 6);
  fails((): Document => applyOperations(base, [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 10, value: 6 }]));
  fails((): Document => applyOperations(base, [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 8, value: 10 }]), 'E_NO_CHANGE');
  fails((): Document => applyOperations(base, [{ op: 'set_goal', expectedValue: 10, value: 10 }]), 'E_NO_CHANGE');
  assert.deepEqual(base, before);
});

test('operation shape, batch limits and local value/range checks reject before any mutation', (): void => {
  const base = fixture();
  const before = structuredClone(base);
  const bad: unknown[] = [[], null, {}, [{ op: 'add_entity', kind: 'normal', x: 20, y: 20 }],
    [{ op: 'copy_entity', entityId: 'n1', x: 20, y: 20 }], [{ op: 'remove_entity', entityId: 'n1' }],
    [{ op: 'set_goal', value: 6 }], [{ op: 'set_goal', expectedValue: '10', value: 6 }],
    [{ op: 'set_goal', expectedValue: 10, value: 6.1 }], [{ op: 'set_goal', expectedValue: 10, value: 6, script: 'bad' }],
    [{ op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true } }],
    [{ op: 'set_timer', expectedValue: { enabled: false, limit: 45, extra: 1 }, value: { enabled: true, limit: 30 } }],
    [{ op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 16 } }],
    [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 3, highValue: 2 } }],
    [{ op: 'set_theme', expectedValue: base.project.presentation, value: { themeId: 'theme_r0_contrast', playerSkinId: 'wrong' } }],
    [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 541, y: 220 } }],
    [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 }, kind: 'guard' }],
    [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 8, value: 7 }, { op: 'set_goal', expectedValue: 7, value: 6 }, { op: 'set_goal', expectedValue: 6, value: 5 }],
    // An invalid intermediate field cannot be repaired later; only final spacing/playability is deferred.
    [{ op: 'set_goal', expectedValue: 10, value: 100 }, { op: 'set_goal', expectedValue: 100, value: 6 }],
  ];
  for (const operations of bad) {
    fails((): Document => applyOperations(base, operations));
    assert.deepEqual(base, before);
  }
  assert.equal(applyOperations(base, [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 8, value: 7 }, { op: 'set_goal', expectedValue: 7, value: 6 }]).project.rules.goal.targetScore, 6);
});

test('R0-CAND-01 domain: missing categories/IDs reject explicit applicable operations', (): void => {
  const b = fixture('scene-b');
  for (const operation of [{ op: 'set_guard_speed', expectedValue: 100, value: 80 }, { op: 'set_detect_radius', expectedValue: 180, value: 140 }]) fails((): Document => applyOperations(b, [operation]), 'E_NO_GUARD');
  fails((): Document => applyOperations(b, [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } }]), 'E_ENTITY_NOT_FOUND');
  const noRewards = fixture();
  noRewards.project.scene.entities = noRewards.project.scene.entities.filter((item: Entity): boolean => item.kind === 'guard' || item.kind === 'player');
  fails((): Document => applyOperations(noRewards, [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }]), 'E_NO_REWARD');
});

test('R0-CAND-01 domain: unchanged impossible goal blocks gameplay, full repair succeeds', (): void => {
  const draft = fixture();
  draft.project.rules.goal.targetScore = 15;
  const before = structuredClone(draft);
  const timer: Operation = { op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } };
  fails((): Document => applyOperations(draft, [timer]));
  fails((): Document => applyOperations(draft, [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } }]));
  const repaired = applyOperations(draft, [{ op: 'set_goal', expectedValue: 15, value: 6 }, timer]);
  assert.equal(repaired.project.rules.goal.targetScore, 6);
  assert.deepEqual(repaired.project.rules.timer, { enabled: true, limit: 30 });
  assert.equal(validatePlayability(repaired).playable, true);
  assert.deepEqual(draft, before);
});

test('R0-CAND-01 domain: pure theme draft exception is semantic only; mixed gameplay must be playable', (): void => {
  const draft = fixture();
  draft.project.rules.goal.targetScore = 15;
  const theme: Operation = { op: 'set_theme', expectedValue: { themeId: 'theme_snack', playerSkinId: 'snack_player_01' }, value: contrast };
  const themed = applyOperations(draft, [theme]);
  assert.equal(semanticHash(themed), semanticHash(draft));
  assert.equal(validatePlayability(themed).playable, false);
  assert.deepEqual(themed.project.presentation, contrast);
  fails((): Document => applyOperations(draft, [theme, { op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } }]));
  const noRewards = fixture();
  noRewards.project.scene.entities = noRewards.project.scene.entities.filter((item: Entity): boolean => item.kind === 'guard' || item.kind === 'player');
  noRewards.project.rules.goal.targetScore = 1;
  fails((): Document => applyOperations(noRewards, [{ op: 'set_goal', expectedValue: 1, value: 1 }]));
  fails((): Document => applyOperations(noRewards, [{ op: 'set_goal', expectedValue: 1, value: 2 }]));
  assert.equal(validatePlayability(applyOperations(noRewards, [theme])).playable, false);
});

test('generic strict JSON rejects exponent overflow and nesting beyond 128 levels', (): void => {
  // Generic JSON entry must reject these before a Document schema is involved.
  fails((): unknown => parseStrictJson('{"value":1e999}'));
  fails((): unknown => parseStrictJson('['.repeat(130) + '0' + ']'.repeat(130)));
  fails((): unknown => parseStrictJson('{"value":'.repeat(130) + '0' + '}'.repeat(130)));
});

test('controlled IDs and SHA reject a legal prefix followed by a newline, including JSON escapes', (): void => {
  const base = fixture();
  const badEntity = fixture();
  entity(badEntity, 'p').id = 'p\n';
  const invalidDocuments: unknown[] = [
    replace(base, ['project', 'projectId'], base.project.projectId + '\n'),
    badEntity,
    replace(base, ['project', 'semanticHash'], base.project.semanticHash + '\n'),
  ];
  for (const input of invalidDocuments) {
    invalid(input);
    const escaped = JSON.stringify(input);
    assert.ok(escaped.includes('\\n'));
    fails((): Document => parseDocument(escaped));
    fails((): Document => parseDocument(escaped.replaceAll('\\n', '\\u000a')));
  }
});
