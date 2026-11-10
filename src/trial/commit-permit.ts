import { DomainError, type Document } from '../domain/index.js';
interface CommitPayload { owner: object; draft: Document; baseRevision: number }
const permits = new WeakMap<object, CommitPayload>();
/** Node-internal capability factory. Never route this function or serialize a permit. */
export function issueCommitPermit(owner: object, draft: Document, baseRevision: number): object {
  const permit = Object.freeze({}); permits.set(permit, { owner, draft: structuredClone(draft), baseRevision }); return permit;
}
export function consumeCommitPermit(permit: object, owner: object): Omit<CommitPayload, 'owner'> {
  const payload = permits.get(permit);
  if (!payload || payload.owner !== owner) throw new DomainError('E_CANDIDATE_PERMIT');
  permits.delete(permit); return { draft: payload.draft, baseRevision: payload.baseRevision };
}
