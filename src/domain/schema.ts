import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { assertJson, escapePointer } from './json.js';
import { DomainError, type ValidationError } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const object = (properties: Record<string, unknown>): object => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const integer = (minimum: number, maximum: number, multipleOf = 1): object => ({ type: 'integer', minimum, maximum, multipleOf });
export const idSchema = { type: 'string', minLength: 1, maxLength: 96, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])' };
export const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\\s\\S])' };
export const revisionSchema = integer(0, Number.MAX_SAFE_INTEGER);
export const hashSchema = { type: 'string', pattern: '^sha256:[0-9a-f]{64}(?![\\s\\S])' };
export const coordinates = { x: integer(20, 940, 10), y: integer(20, 520, 10) };
const target = integer(1, 99); const speed = integer(20, 180, 10); const radius = integer(60, 300, 10);
export const rewardsSchema = object({ normalValue: integer(1, 3), highValue: integer(2, 9) });
export const timerSchema = object({ enabled: { type: 'boolean' }, limit: integer(15, 120, 5) });
export const presentationSchema = object({ themeId: { enum: ['theme_snack', 'theme_r0_contrast'] }, playerSkinId: { const: 'snack_player_01' } });
export const sceneSchema = object({ worldId: { const: 'rect_960_540' }, width: { const: 960 }, height: { const: 540 }, entities: {
  type: 'array', minItems: 1, maxItems: 18, items: object({ id: idSchema, kind: { enum: ['player', 'guard', 'normal', 'high'] }, ...coordinates }),
} });
export const rulesSchema = object({ goal: object({ targetScore: target }), rewards: rewardsSchema, guards: object({ speed, detectRadius: radius }), timer: timerSchema });
export const documentSchema = object({
  formatVersion: { const: '3.0-review.3' }, runtimeVersion: { const: 'collect-chase@1' }, catalogVersion: { const: 'workshop-core@1' },
  project: object({ projectId: idSchema, revision: revisionSchema, title: { type: 'string', minLength: 1 }, instructions: { type: 'string' },
    authorNote: { type: 'string' }, designIntent: { type: ['string', 'null'] }, sourceProject: { type: 'null' },
    scene: sceneSchema, rules: rulesSchema, presentation: presentationSchema, semanticHash: hashSchema }),
});
const op = (name: string, shape: object, extra = {}): object => object({ op: { const: name }, expectedValue: shape, value: shape, ...extra });
export const operationsSchema = { type: 'array', minItems: 1, maxItems: 3, items: { oneOf: [
  op('set_goal', target), op('set_reward_values', rewardsSchema), op('set_guard_speed', speed), op('set_detect_radius', radius),
  op('set_timer', timerSchema), op('move_entity', object(coordinates), { entityId: idSchema }), op('set_theme', presentationSchema),
] } };
const command = (name: string, props = {}): object => object({ type: { const: name }, ...props });
export const manualCommandSchema = { oneOf: [
  ...['title', 'instructions', 'authorNote'].map(field => command('set_text', { field: { const: field }, value: { type: 'string' } })),
  command('set_text', { field: { const: 'designIntent' }, value: { type: ['string', 'null'] } }),
  command('set_goal', { value: target }), command('set_reward_values', { value: rewardsSchema }), command('set_guard_speed', { value: speed }),
  command('set_detect_radius', { value: radius }), command('set_timer', { value: timerSchema }), command('set_theme', { value: presentationSchema }),
  command('move_entity', { entityId: idSchema, ...coordinates }), command('add_entity', { kind: { enum: ['guard', 'normal', 'high'] }, ...coordinates }),
  command('copy_entity', { entityId: idSchema, ...coordinates }), command('remove_entity', { entityId: idSchema }), command('undo'),
] };
export const envelopeSchema = object({ commandId: uuidSchema, sessionId: { type: 'string', minLength: 1 }, writerToken: { type: 'string', minLength: 1 },
  projectId: idSchema, expectedRevision: revisionSchema, command: manualCommandSchema });
export const candidateSchema = object({ projectId: idSchema, requestId: uuidSchema, baseRevision: revisionSchema, baseSemanticHash: hashSchema,
  runtimeVersion: { const: 'collect-chase@1' }, catalogVersion: { const: 'workshop-core@1' }, ruleRegistryVersion: { const: 'collect-chase-rules@1' },
  trialPolicyVersion: { const: 'collect-chase-candidate-trial@2' }, operations: operationsSchema,
  candidateState: object({ scene: sceneSchema, rules: rulesSchema, presentation: presentationSchema }),
});
export const checkDocument = ajv.compile(documentSchema);
export const checkOperations = ajv.compile(operationsSchema);
export const checkEnvelope = ajv.compile(envelopeSchema);
export const checkCandidate = ajv.compile(candidateSchema);
export function schemaErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map(error => ({ code: 'E_SCHEMA', path: error.instancePath +
    (error.keyword === 'required' ? `/${escapePointer(String(error.params['missingProperty']))}` :
      error.keyword === 'additionalProperties' ? `/${escapePointer(String(error.params['additionalProperty']))}` : ''), message: error.message ?? 'Invalid value' }));
}
export function assertSchema(check: ValidateFunction, input: unknown): void {
  assertJson(input);
  if (!check(input)) throw new DomainError('E_SCHEMA', schemaErrors(check.errors));
}
