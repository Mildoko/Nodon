import { createHash } from 'node:crypto';
import { canonicalJson, cloneJson } from './json.js';
import { assertSchema, checkCandidate } from './schema.js';
import { type CandidateHashInput, type Document, type Scene } from './types.js';

export function canonicalSHA256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
export function normalizedScene(scene: Scene): Scene {
  const copy = cloneJson(scene);
  copy.entities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return copy;
}
export function semanticHash(doc: Document): string {
  return canonicalSHA256({ scene: normalizedScene(doc.project.scene), rules: doc.project.rules, runtimeVersion: doc.runtimeVersion });
}
export function candidateHash(input: CandidateHashInput): string {
  assertSchema(checkCandidate, input);
  return canonicalSHA256({ ...input, candidateState: { ...input.candidateState, scene: normalizedScene(input.candidateState.scene) } });
}
