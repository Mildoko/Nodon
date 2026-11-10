import { CommandQueue } from '../host/command-queue.js';
import { AiError, type AiAuthorityState, type RequestSnapshot } from './types.js';
export class AiAuthority {
  #state: AiAuthorityState;
  #listeners = new Set<() => void>();
  constructor(readonly queue: CommandQueue, initial: AiAuthorityState) {
    if (!Number.isSafeInteger(initial.authEpoch) || initial.authEpoch < 0 || typeof initial.adultEnabled !== 'boolean' || typeof initial.scopeEnabled !== 'boolean' || !initial.sessionId || !initial.writerToken || !initial.projectId) throw new AiError('E_AUTH_STATE');
    this.#state = { ...initial };
  }
  snapshot(): Readonly<AiAuthorityState> { return Object.freeze({ ...this.#state }); }
  onRevoke(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  check(binding: RequestSnapshot): void {
    this.queue.assertActive(); const current = this.#state;
    if (!current.adultEnabled) throw new AiError('E_ADULT_DISABLED');
    if (!current.scopeEnabled) throw new AiError('E_SCOPE');
    if (current.authEpoch !== binding.authEpoch) throw new AiError('E_AUTH_EPOCH');
    if (current.sessionId !== binding.sessionId) throw new AiError('E_SESSION');
    if (current.writerToken !== binding.writerToken) throw new AiError('E_WRITER');
    if (current.projectId !== binding.projectId) throw new AiError('E_PROJECT');
  }
  setAdult(enabled: boolean): Promise<void> { if (typeof enabled !== 'boolean') return Promise.reject(new AiError('E_AUTH_STATE')); return this.#change({ adultEnabled: enabled }); }
  setScope(enabled: boolean): Promise<void> { if (typeof enabled !== 'boolean') return Promise.reject(new AiError('E_AUTH_STATE')); return this.#change({ scopeEnabled: enabled }); }
  replaceWriter(sessionId: string, writerToken: string, projectId: string): Promise<void> {
    if (!sessionId || !writerToken || !projectId) return Promise.reject(new AiError('E_AUTH_STATE'));
    return this.#change({ sessionId, writerToken, projectId });
  }
  #change(update: Partial<AiAuthorityState>): Promise<void> {
    return this.queue.enqueue(() => {
      if (this.#state.authEpoch === Number.MAX_SAFE_INTEGER) throw new AiError('E_AUTH_EPOCH_LIMIT');
      this.#state = { ...this.#state, ...update, authEpoch: this.#state.authEpoch + 1 };
      // Listener exceptions cannot roll back revocation or prevent another listener's cleanup.
      for (const listener of this.#listeners) { try { listener(); } catch { /* Fail closed state remains authoritative. */ } }
    });
  }
}
