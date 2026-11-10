import { assertDocument, canonicalJson, DomainError, type CommandEnvelope, type CommandResult, type Document, type ManualCommand } from '../domain/index.js';
import { consumeCommitPermit } from '../trial/commit-permit.js';
import { cloneJson } from '../domain/json.js';
import { assertSchema, checkEnvelope } from '../domain/schema.js';

export interface ProjectStoreOptions { sessionId: string; writerToken: string }

/** Sole in-memory document owner. AI confirmation intentionally has no public commit shortcut. */
export class ProjectStore {
  #document: Document;
  readonly #sessionId: string;
  readonly #writerToken: string;
  #before: Document | null = null;
  #nextEntity = 1;
  readonly #issued = new Set<string>();
  readonly #results = new Map<string, { payload: string; result: CommandResult }>();

  constructor(initialDocument: Document, options: ProjectStoreOptions) {
    if (!options.sessionId || typeof options.sessionId !== 'string' || !options.writerToken || typeof options.writerToken !== 'string') throw new DomainError('E_SESSION');
    this.#document = assertDocument(initialDocument);
    this.#sessionId = options.sessionId; this.#writerToken = options.writerToken;
    for (const entity of this.#document.project.scene.entities) this.#issued.add(entity.id);
  }
  authorizes(binding: { sessionId: string; writerToken: string; projectId: string }): boolean {
    return binding.sessionId === this.#sessionId && binding.writerToken === this.#writerToken && binding.projectId === this.#document.project.projectId;
  }
  snapshot(): Document { return cloneJson(this.#document); }

  hasCachedCommand(commandId: string): boolean { return this.#results.has(commandId); }
  /** Read-only admission query: malformed/unauthorized envelopes never claim a shared command ID. */
  acceptedCommandId(input: unknown): string | null {
    try { assertSchema(checkEnvelope, input); }
    catch (error) { if (error instanceof DomainError) return null; throw error; }
    const envelope = input as CommandEnvelope;
    return this.authorizes(envelope) ? envelope.commandId : null;
  }
  preview(input: unknown): CommandResult { return this.#execute(input, false); }
  execute(input: unknown): CommandResult { return this.#execute(input, true); }
  /** Identity-based capability; JSON cannot forge this Node-only, once-consumed permit. */
  commitCandidate(permit: object, owner: object): CommandResult {
    const { draft: input, baseRevision } = consumeCommitPermit(permit, owner);
    if (baseRevision !== this.#document.project.revision) throw new DomainError('E_REVISION_CONFLICT');
    if (baseRevision === Number.MAX_SAFE_INTEGER) throw new DomainError('E_REVISION_LIMIT');
    const draft = assertDocument(input);
    if (draft.project.projectId !== this.#document.project.projectId || draft.project.revision !== baseRevision) throw new DomainError('E_PROJECT');
    const before = this.#document; draft.project.revision = baseRevision + 1;
    this.#document = draft; this.#before = cloneJson(before);
    return { ok: true, changed: true, revision: draft.project.revision, semanticHash: draft.project.semanticHash };
  }

  #execute(input: unknown, commit: boolean): CommandResult {
    const failure = (error: DomainError): CommandResult => ({ ok: false, code: error.code, errors: cloneJson(error.errors), currentRevision: this.#document.project.revision });
    let envelope: CommandEnvelope;
    try { assertSchema(checkEnvelope, input); envelope = cloneJson(input) as CommandEnvelope; }
    catch (error) { if (error instanceof DomainError) return failure(error); throw error; }
    if (envelope.sessionId !== this.#sessionId) return failure(new DomainError('E_SESSION'));
    if (envelope.writerToken !== this.#writerToken) return failure(new DomainError('E_WRITER'));
    if (envelope.projectId !== this.#document.project.projectId) return failure(new DomainError('E_PROJECT'));
    // Normalization is limited to the contract's one empty-title default.
    if (envelope.command.type === 'set_text' && envelope.command.field === 'title' && envelope.command.value === '') envelope.command.value = '未命名作品';
    const payload = canonicalJson(envelope); const previous = this.#results.get(envelope.commandId);
    if (previous) return previous.payload === payload ? cloneJson(previous.result) : failure(new DomainError('E_IDEMPOTENCY_CONFLICT'));
    let result: CommandResult;
    try {
      if (envelope.expectedRevision !== this.#document.project.revision) throw new DomainError('E_REVISION_CONFLICT');
      if (this.#document.project.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('E_REVISION_LIMIT');
      const current = this.#document; let draft = cloneJson(current);
      let allocatedEntityId: string | undefined; let nextEntity = this.#nextEntity;
      const cmd = envelope.command;
      if (cmd.type === 'undo') {
        if (!this.#before) throw new DomainError('E_NO_UNDO');
        draft = cloneJson(this.#before);
        draft.project.projectId = current.project.projectId; draft.project.sourceProject = current.project.sourceProject;
      } else {
        const allocation = (): string => {
          while (nextEntity < Number.MAX_SAFE_INTEGER && this.#issued.has(`e${nextEntity}`)) nextEntity++;
          if (nextEntity >= Number.MAX_SAFE_INTEGER) throw new DomainError('E_ENTITY_ID_LIMIT');
          allocatedEntityId = `e${nextEntity++}`; return allocatedEntityId;
        };
        this.#applyManual(draft, cmd, allocation);
      }
      draft.project.revision = current.project.revision;
      draft = assertDocument(draft);
      if (canonicalJson(draft) === canonicalJson(current)) throw new DomainError('E_NO_CHANGE');
      draft.project.revision = current.project.revision + 1;
      // Everything above is speculative; this synchronous assignment section is the commit.
      if (commit) {
        this.#document = draft;
        this.#before = cmd.type === 'undo' ? null : cloneJson(current);
        if (allocatedEntityId !== undefined) { this.#issued.add(allocatedEntityId); this.#nextEntity = nextEntity; }
      }
      result = { ok: true, changed: true, revision: draft.project.revision, semanticHash: draft.project.semanticHash,
        ...(allocatedEntityId === undefined ? {} : { allocatedEntityId }) };
    } catch (error) { if (error instanceof DomainError) result = failure(error); else throw error; }
    if (commit) this.#results.set(envelope.commandId, { payload, result: cloneJson(result) });
    return cloneJson(result);
  }

  #applyManual(draft: Document, cmd: Exclude<ManualCommand, { type: 'undo' }>, allocation: () => string): void {
    const project = draft.project;
    switch (cmd.type) {
      case 'set_text': {
        if (cmd.field === 'designIntent') project.designIntent = cmd.value;
        else { if (typeof cmd.value !== 'string') throw new DomainError('E_SCHEMA'); project[cmd.field] = cmd.value; }
        break;
      }
      case 'set_goal': project.rules.goal.targetScore = cmd.value; break;
      case 'set_reward_values': project.rules.rewards = cloneJson(cmd.value); break;
      case 'set_guard_speed': project.rules.guards.speed = cmd.value; break;
      case 'set_detect_radius': project.rules.guards.detectRadius = cmd.value; break;
      case 'set_timer': project.rules.timer = cloneJson(cmd.value); break;
      case 'set_theme': project.presentation = cloneJson(cmd.value); break;
      case 'add_entity': project.scene.entities.push({ id: allocation(), kind: cmd.kind, x: cmd.x, y: cmd.y }); break;
      case 'move_entity': case 'copy_entity': case 'remove_entity': {
        const index = project.scene.entities.findIndex(entity => entity.id === cmd.entityId); const entity = project.scene.entities[index];
        if (!entity) throw new DomainError('E_ENTITY_NOT_FOUND', [{ code: 'E_ENTITY_NOT_FOUND', path: '/command/entityId', message: 'Entity ID does not exist' }]);
        if (cmd.type === 'move_entity') { entity.x = cmd.x; entity.y = cmd.y; }
        else {
          if (entity.kind === 'player') throw new DomainError('E_PLAYER_PROTECTED', [{ code: 'E_PLAYER_PROTECTED', path: '/command/entityId', message: 'Player cannot be copied or removed' }]);
          if (cmd.type === 'copy_entity') project.scene.entities.push({ id: allocation(), kind: entity.kind, x: cmd.x, y: cmd.y });
          else project.scene.entities.splice(index, 1);
        }
        break;
      }
    }
  }
}
export { ProjectStore as NodeProjectStore };
