export type EntityKind = 'player' | 'guard' | 'normal' | 'high';
export interface Entity { id: string; kind: EntityKind; x: number; y: number }
export interface Scene { worldId: 'rect_960_540'; width: 960; height: 540; entities: Entity[] }
export interface Rules {
  goal: { targetScore: number };
  rewards: { normalValue: number; highValue: number };
  guards: { speed: number; detectRadius: number };
  timer: { enabled: boolean; limit: number };
}
export interface Presentation { themeId: 'theme_snack' | 'theme_r0_contrast'; playerSkinId: 'snack_player_01' }
export interface Document {
  formatVersion: '3.0-review.3'; runtimeVersion: 'collect-chase@1'; catalogVersion: 'workshop-core@1';
  project: {
    projectId: string; revision: number; title: string; instructions: string; authorNote: string;
    designIntent: string | null; sourceProject: null; scene: Scene; rules: Rules;
    presentation: Presentation; semanticHash: string;
  };
}
export interface ValidationError { code: string; path: string; message: string }
export class DomainError extends Error {
  readonly code: string;
  readonly errors: ValidationError[];
  constructor(code: string, errors: ValidationError[] = [{ code, path: '', message: code }]) {
    super(errors.map(error => `${error.path}: ${error.message}`).join('; '));
    this.name = 'DomainError'; this.code = code; this.errors = errors;
  }
}
export type Operation =
  | { op: 'set_goal'; expectedValue: number; value: number }
  | { op: 'set_reward_values'; expectedValue: Rules['rewards']; value: Rules['rewards'] }
  | { op: 'set_guard_speed' | 'set_detect_radius'; expectedValue: number; value: number }
  | { op: 'set_timer'; expectedValue: Rules['timer']; value: Rules['timer'] }
  | { op: 'move_entity'; entityId: string; expectedValue: { x: number; y: number }; value: { x: number; y: number } }
  | { op: 'set_theme'; expectedValue: Presentation; value: Presentation };
export interface CandidateHashInput {
  projectId: string; requestId: string; baseRevision: number; baseSemanticHash: string;
  runtimeVersion: 'collect-chase@1'; catalogVersion: 'workshop-core@1';
  ruleRegistryVersion: 'collect-chase-rules@1'; trialPolicyVersion: 'collect-chase-candidate-trial@2';
  operations: Operation[]; candidateState: { scene: Scene; rules: Rules; presentation: Presentation };
}
export type ManualCommand =
  | { type: 'set_text'; field: 'title' | 'instructions' | 'authorNote' | 'designIntent'; value: string | null }
  | { type: 'set_goal' | 'set_guard_speed' | 'set_detect_radius'; value: number }
  | { type: 'set_reward_values'; value: Rules['rewards'] }
  | { type: 'set_timer'; value: Rules['timer'] }
  | { type: 'set_theme'; value: Presentation }
  | { type: 'move_entity'; entityId: string; x: number; y: number }
  | { type: 'add_entity'; kind: Exclude<EntityKind, 'player'>; x: number; y: number }
  | { type: 'copy_entity'; entityId: string; x: number; y: number }
  | { type: 'remove_entity'; entityId: string }
  | { type: 'undo' };
export interface CommandEnvelope {
  commandId: string; sessionId: string; writerToken: string; projectId: string;
  expectedRevision: number; command: ManualCommand;
}
export type CommandResult =
  | { ok: true; changed: true; revision: number; semanticHash: string; allocatedEntityId?: string }
  | { ok: false; code: string; errors: ValidationError[]; currentRevision: number };
