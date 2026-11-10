import { DomainError } from './types.js';

/** Reject values JSON.stringify would silently drop, coerce, or invoke. */
export function assertJson(value: unknown, path = '', ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) throw new DomainError('E_JSON_VALUE', [{ code: 'E_JSON_VALUE', path, message: 'Expected a finite JSON value' }]);
  const proto: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    throw new DomainError('E_JSON_VALUE', [{ code: 'E_JSON_VALUE', path, message: 'Prototype objects are not accepted' }]);
  }
  if (ancestors.has(value)) throw new DomainError('E_JSON_VALUE', [{ code: 'E_JSON_VALUE', path, message: 'Cyclic value' }]);
  if (ancestors.size >= 128) throw new DomainError('E_JSON_DEPTH', [{ code: 'E_JSON_DEPTH', path, message: 'JSON nesting exceeds 128' }]);
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'symbol')) throw new DomainError('E_JSON_VALUE', [{ code: 'E_JSON_VALUE', path, message: 'Symbol keys are not JSON' }]);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) throw new DomainError('E_JSON_VALUE', [{ code: 'E_JSON_VALUE', path, message: 'Sparse or extended arrays are not JSON' }]);
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new DomainError('E_JSON_VALUE');
      assertJson(descriptor.value, `${path}/${i}`, ancestors);
    }
  } else {
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new DomainError('E_JSON_VALUE');
      assertJson(descriptor.value, `${path}/${escapePointer(key)}`, ancestors);
    }
  }
  ancestors.delete(value);
}
export function escapePointer(key: string): string { return key.replaceAll('~', '~0').replaceAll('/', '~1'); }
export function canonicalJson(value: unknown): string {
  assertJson(value);
  function encode(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(item) as string;
  }
  return encode(value);
}
export function cloneJson<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }

/** The JSON scanner preserves duplicate-key information before JSON.parse loses it. */
export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string') throw new DomainError('E_JSON_PARSE');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new DomainError('E_JSON_SIZE');
  let offset = 0;
  const fail = (path: string): never => { throw new DomainError('E_JSON_PARSE', [{ code: 'E_JSON_PARSE', path, message: `Invalid JSON at offset ${offset}` }]); };
  const space = (): void => { while (offset < text.length && /[\x20\x09\x0a\x0d]/.test(text[offset] as string)) offset++; };
  function string(path: string): string {
    const begin = offset++;
    while (offset < text.length) {
      const ch = text[offset++];
      if (ch === '"') { try { return JSON.parse(text.slice(begin, offset)) as string; } catch { return fail(path); } }
      if (ch === '\\') offset++;
    }
    return fail(path);
  }
  function value(path: string, depth: number): void {
    if (depth > 128) throw new DomainError('E_JSON_DEPTH', [{ code: 'E_JSON_DEPTH', path, message: 'JSON nesting exceeds 128' }]);
    space(); const ch = text[offset];
    if (ch === '"') { string(path); return; }
    if (ch === '{') {
      offset++; space(); const seen = new Set<string>();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        space(); if (text[offset] !== '"') fail(path);
        const key = string(path); const child = `${path}/${escapePointer(key)}`;
        if (seen.has(key)) throw new DomainError('E_DUPLICATE_KEY', [{ code: 'E_DUPLICATE_KEY', path: child, message: 'Duplicate JSON key' }]);
        seen.add(key); space(); if (text[offset++] !== ':') fail(child);
        value(child, depth + 1); space(); const delimiter = text[offset++];
        if (delimiter === '}') return; if (delimiter !== ',') fail(path);
      }
    }
    if (ch === '[') {
      offset++; space(); if (text[offset] === ']') { offset++; return; }
      let index = 0;
      for (;;) { value(`${path}/${index++}`, depth + 1); space(); const delimiter = text[offset++]; if (delimiter === ']') return; if (delimiter !== ',') fail(path); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!token) fail(path); else offset += token[0].length;
  }
  value('', 0); space(); if (offset !== text.length) fail('');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return fail(''); }
  assertJson(parsed);
  return parsed;
}
