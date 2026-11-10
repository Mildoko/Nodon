import { parseStrictJson } from '../domain/json.js';
import { AiError, ENDPOINT, type Usage } from './types.js';
export interface TransportReply { rawOutput: string | null; returnedModel: string | null; finishReason: string | null; content: string | null; providerRequestId: string | null; usage: Usage | null }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Internal single native fetch. No retry, redirect, SDK, tool call or alternate URL. */
export function dispatchDeepSeek(body: string, credential: string, signal: AbortSignal): Promise<TransportReply> {
  if (typeof credential !== 'string' || credential.length === 0 || /[\r\n]/.test(credential)) throw new AiError('E_CREDENTIAL_UNAVAILABLE');
  // Invocation of fetch is synchronous with the gateway's final authority check. Await happens outside queue.
  const pending = fetch(ENDPOINT, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body, signal });
  return pending.then(async response => {
    if (!response.ok) { await response.body?.cancel(); throw new AiError('E_PROVIDER_HTTP_UNKNOWN'); }
    if (!response.body) throw new AiError('E_PROVIDER_EMPTY');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 131072) { await reader.cancel(); throw new AiError('E_PROVIDER_SIZE'); } parts.push(chunk.value); }
    } finally { reader.releaseLock(); }
    const root = record(parseStrictJson(Buffer.concat(parts).toString('utf8'))); if (!root) throw new AiError('E_PROVIDER_FORMAT');
    const providerRequestId = typeof root['id'] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(root['id']) ? root['id'] : null;
    const rawUsage = record(root['usage']); let usage: Usage | null = null;
    if (rawUsage) {
      const prompt = rawUsage['prompt_tokens'], completion = rawUsage['completion_tokens'], cached = rawUsage['prompt_cache_hit_tokens'];
      if (typeof prompt === 'number' && typeof completion === 'number' && (cached === undefined || typeof cached === 'number')) usage = { promptTokens: prompt, completionTokens: completion, cachedTokens: cached ?? 0 };
    }
    const choices = root['choices']; const choice = Array.isArray(choices) ? record(choices[0]) : null;
    const message = record(choice?.['message']);
    const rawOutput = typeof message?.['content'] === 'string' ? message['content'] : null;
    const returnedModel = typeof root['model'] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(root['model']) ? root['model'] : null;
    const finishReason = typeof choice?.['finish_reason'] === 'string' && /^[a-z_]{1,64}$/.test(choice['finish_reason']) ? choice['finish_reason'] : null;
    return { rawOutput, returnedModel, finishReason, content: finishReason === 'stop' ? rawOutput : null, providerRequestId, usage };
  });
}
