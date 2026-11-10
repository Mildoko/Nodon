import { assertDocument, validatePlayability } from './document.js';
import { canonicalJson, cloneJson } from './json.js';
import { assertSchema, checkOperations } from './schema.js';
import { DomainError, type Document, type Operation } from './types.js';

export function applyOperations(doc: Document, input: unknown): Document {
  const draft = assertDocument(doc);
  assertSchema(checkOperations, input);
  const operations = cloneJson(input) as Operation[];
  const fail = (code: string, index: number, message: string, field = ''): never => {
    throw new DomainError(code, [{ code, path: `/operations/${index}${field}`, message }]);
  };
  operations.forEach((operation, index) => {
    const { rules, scene } = draft.project;
    let current: unknown;
    switch (operation.op) {
      case 'set_goal': current = rules.goal.targetScore; break;
      case 'set_reward_values':
        if (!scene.entities.some(entity => entity.kind === 'normal' || entity.kind === 'high')) fail('E_NO_REWARD', index, 'No reward exists');
        if (operation.expectedValue.highValue <= operation.expectedValue.normalValue || operation.value.highValue <= operation.value.normalValue) fail('E_REWARD_ORDER', index, 'highValue must exceed normalValue');
        current = rules.rewards; break;
      case 'set_guard_speed': case 'set_detect_radius':
        if (!scene.entities.some(entity => entity.kind === 'guard')) fail('E_NO_GUARD', index, 'No guard exists');
        current = operation.op === 'set_guard_speed' ? rules.guards.speed : rules.guards.detectRadius; break;
      case 'set_timer': current = rules.timer; break;
      case 'set_theme': current = draft.project.presentation; break;
      case 'move_entity': {
        const entity = scene.entities.find(item => item.id === operation.entityId);
        if (!entity) return fail('E_ENTITY_NOT_FOUND', index, 'Entity ID does not exist', '/entityId');
        current = { x: entity.x, y: entity.y }; break;
      }
    }
    if (canonicalJson(current) !== canonicalJson(operation.expectedValue)) fail('E_EXPECTED_VALUE', index, 'Expected value differs from current draft', '/expectedValue');
    switch (operation.op) {
      case 'set_goal': rules.goal.targetScore = operation.value; break;
      case 'set_reward_values': rules.rewards = cloneJson(operation.value); break;
      case 'set_guard_speed': rules.guards.speed = operation.value; break;
      case 'set_detect_radius': rules.guards.detectRadius = operation.value; break;
      case 'set_timer': rules.timer = cloneJson(operation.value); break;
      case 'set_theme': draft.project.presentation = cloneJson(operation.value); break;
      case 'move_entity': {
        const entity = scene.entities.find(item => item.id === operation.entityId);
        if (!entity) return fail('E_ENTITY_NOT_FOUND', index, 'Entity ID does not exist', '/entityId');
        entity.x = operation.value.x; entity.y = operation.value.y; break;
      }
    }
  });
  const result = assertDocument(draft);
  if (canonicalJson({ scene: result.project.scene, rules: result.project.rules, presentation: result.project.presentation }) ===
    canonicalJson({ scene: doc.project.scene, rules: doc.project.rules, presentation: doc.project.presentation })) throw new DomainError('E_NO_CHANGE');
  if (operations.some(operation => operation.op !== 'set_theme')) {
    const playable = validatePlayability(result);
    if (!playable.playable) throw new DomainError(playable.errors[0]?.code ?? 'E_NOT_PLAYABLE', playable.errors);
  }
  return result;
}
