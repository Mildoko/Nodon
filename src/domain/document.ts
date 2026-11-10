import { assertJson, cloneJson, parseStrictJson } from './json.js';
import { semanticHash } from './hash.js';
import { checkDocument, schemaErrors } from './schema.js';
import { DomainError, type Document, type EntityKind, type ValidationError } from './types.js';

export type DocumentValidation = { valid: true; document: Document; errors: [] } | { valid: false; errors: ValidationError[] };
export const ENTITY_RADII: Readonly<Record<EntityKind, number>> = Object.freeze({ player: 12, guard: 14, normal: 10, high: 10 });
export function validateDocument(input: unknown): DocumentValidation {
  try { assertJson(input); } catch (error) {
    if (error instanceof DomainError) return { valid: false, errors: error.errors };
    throw error;
  }
  if (!checkDocument(input)) return { valid: false, errors: schemaErrors(checkDocument.errors) };
  const doc = input as Document; const errors: ValidationError[] = [];
  const add = (code: string, path: string, message: string): void => { errors.push({ code, path, message }); };
  for (const [field, maximum] of [['title', 40], ['instructions', 200], ['authorNote', 120], ['designIntent', 120]] as const) {
    const text = doc.project[field];
    if (text !== null && text.length > maximum) add('E_TEXT_LENGTH', `/project/${field}`, `Maximum ${maximum} UTF-16 code units`);
  }
  const counts: Record<EntityKind, number> = { player: 0, guard: 0, normal: 0, high: 0 }; const ids = new Set<string>();
  const entities = doc.project.scene.entities;
  entities.forEach((entity, index) => {
    counts[entity.kind]++;
    if (ids.has(entity.id)) add('E_DUPLICATE_ID', `/project/scene/entities/${index}/id`, 'Entity ID must be unique');
    ids.add(entity.id);
    for (let j = 0; j < index; j++) {
      const other = entities[j]; if (!other) continue;
      const minimum = ENTITY_RADII[entity.kind] + ENTITY_RADII[other.kind] + 4;
      if ((entity.x - other.x) ** 2 + (entity.y - other.y) ** 2 < minimum ** 2) add('E_ENTITY_SPACING', `/project/scene/entities/${index}`, `Too close to ${other.id}`);
    }
  });
  if (counts.player !== 1) add('E_ENTITY_COUNT', '/project/scene/entities', 'Exactly one player required');
  for (const [kind, maximum] of [['guard', 2], ['normal', 12], ['high', 3]] as const) {
    if (counts[kind] > maximum) add('E_ENTITY_COUNT', '/project/scene/entities', `${kind} count exceeds ${maximum}`);
  }
  if (doc.project.rules.rewards.highValue <= doc.project.rules.rewards.normalValue) add('E_REWARD_ORDER', '/project/rules/rewards/highValue', 'highValue must exceed normalValue');
  if (errors.length) return { valid: false, errors };
  const document = cloneJson(doc); document.project.semanticHash = semanticHash(document);
  return { valid: true, document, errors: [] };
}
export function assertDocument(input: unknown): Document {
  const result = validateDocument(input);
  if (!result.valid) throw new DomainError(result.errors[0]?.code ?? 'E_DOCUMENT', result.errors);
  return result.document;
}
export function parseDocument(text: string): Document { return assertDocument(parseStrictJson(text)); }
export function validatePlayability(doc: Document): { playable: boolean; totalScore: number; rewardCount: number; errors: ValidationError[] } {
  const valid = validateDocument(doc);
  if (!valid.valid) return { playable: false, totalScore: 0, rewardCount: 0, errors: valid.errors };
  const { entities } = valid.document.project.scene; const { rules } = valid.document.project;
  let totalScore = 0, rewardCount = 0;
  for (const entity of entities) {
    if (entity.kind === 'normal' || entity.kind === 'high') { rewardCount++; totalScore += entity.kind === 'normal' ? rules.rewards.normalValue : rules.rewards.highValue; }
  }
  const errors: ValidationError[] = [];
  if (!rewardCount) errors.push({ code: 'E_NO_REWARD', path: '/project/scene/entities', message: 'At least one reward required for play' });
  if (rules.goal.targetScore > totalScore) errors.push({ code: 'E_UNREACHABLE_GOAL', path: '/project/rules/goal/targetScore', message: 'Target exceeds total reward score' });
  return { playable: errors.length === 0, totalScore, rewardCount, errors };
}
