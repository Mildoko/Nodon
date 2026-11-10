import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson, cloneJson } from '../domain/json.js';
import { CommandQueue } from '../host/command-queue.js';
import { AiError, INPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP, RESERVATION_NANO_CNY, TOTAL_AMOUNT_CAP_NANO_CNY, TOTAL_TOKEN_CAP, type AttemptRecord, type GatewayResult, type Usage } from './types.js';
export interface FrozenRequestManifest {
  manifestVersion: 'r0-model-requests@1';
  budget: { logicalRequests: number; maxProviderAttemptsPerLogicalRequest: number; maxProviderAttemptsTotal: number; concurrency: number; implicitSDKRetries: number };
  slots: Array<{ requestSlotID: string; parentSlotID: string | null; maxProviderAttempts: number; reservedAttemptIDs: string[] }>;
}
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
interface LogicalRow { request_id: string; slot_id: string; payload_hash: string; key_hash: string; canceled: number }
/** Synchronous SQLite transactions participate in the same authority queue. No reset/refund API. */
export class AiLedger {
  #db: DatabaseSync;
  #slots: Map<string, FrozenRequestManifest['slots'][number]>;
  constructor(readonly queue: CommandQueue, path: string, manifest: FrozenRequestManifest) {
    const budget = manifest.budget;
    if (manifest.manifestVersion !== 'r0-model-requests@1' || budget.logicalRequests !== 38 || budget.maxProviderAttemptsPerLogicalRequest !== 2 || budget.maxProviderAttemptsTotal !== 76 || budget.concurrency !== 1 || budget.implicitSDKRetries !== 0 || manifest.slots.length !== 38) throw new AiError('E_MANIFEST');
    this.#slots = new Map(); const attempts = new Set<string>();
    for (const slot of manifest.slots) {
      if (!/^[A-Za-z0-9-]{1,96}$/.test(slot.requestSlotID) || this.#slots.has(slot.requestSlotID) || slot.maxProviderAttempts !== 2 || slot.reservedAttemptIDs.length !== 2) throw new AiError('E_MANIFEST');
      for (const [index, id] of slot.reservedAttemptIDs.entries()) {
        if (id !== `${slot.requestSlotID}-A${index + 1}` || attempts.has(id)) throw new AiError('E_MANIFEST'); attempts.add(id);
      }
      this.#slots.set(slot.requestSlotID, cloneJson(slot));
    }
    for (const slot of this.#slots.values()) if (slot.parentSlotID !== null && !this.#slots.has(slot.parentSlotID)) throw new AiError('E_MANIFEST');
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS ai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_logical (request_id TEXT PRIMARY KEY, slot_id TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, canceled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_result (request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(request_id,attempt_id));
      CREATE TABLE IF NOT EXISTS ai_attempt (attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(request_id,ordinal));`);
    const binding = digest(manifest);
    const old = this.#db.prepare('SELECT value FROM ai_meta WHERE key=?').get('manifest') as { value: string } | undefined;
    if (old && old.value !== binding) { this.#db.close(); throw new AiError('E_LEDGER_MANIFEST'); }
    if (!old) this.#db.prepare('INSERT INTO ai_meta(key,value) VALUES(?,?)').run('manifest', binding);
  }
  #transaction<T>(job: () => T): T {
    this.queue.assertActive(); this.#db.exec('BEGIN IMMEDIATE');
    try { const result = job(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  register(slotId: string, requestId: string, key: string, payloadHash: string): boolean {
    return this.#transaction(() => {
      if (!this.#slots.has(slotId)) throw new AiError('E_REQUEST_SLOT');
      const old = this.#db.prepare('SELECT * FROM ai_logical WHERE request_id=? OR slot_id=? OR key_hash=?').all(requestId, slotId, digest(key)) as unknown as LogicalRow[];
      if (old.length) {
        if (old.length !== 1 || old[0]?.request_id !== requestId || old[0].slot_id !== slotId || old[0].key_hash !== digest(key) || old[0].payload_hash !== payloadHash) throw new AiError('E_IDEMPOTENCY_CONFLICT');
        return false;
      }
      this.#db.prepare('INSERT INTO ai_logical(request_id,slot_id,payload_hash,key_hash) VALUES(?,?,?,?)').run(requestId, slotId, payloadHash, digest(key));
      return true;
    });
  }
  canceled(requestId: string): boolean {
    const row = this.#db.prepare('SELECT canceled FROM ai_logical WHERE request_id=?').get(requestId) as { canceled: number } | undefined;
    return !row || row.canceled !== 0;
  }
  cancel(requestId: string): void { this.queue.assertActive(); this.#db.prepare('UPDATE ai_logical SET canceled=1 WHERE request_id=?').run(requestId); }
  invalidateAll(): void { this.queue.assertActive(); this.#db.exec('UPDATE ai_logical SET canceled=1'); }
  attempts(requestId?: string): AttemptRecord[] {
    const statement = requestId === undefined ? this.#db.prepare('SELECT record FROM ai_attempt ORDER BY rowid') : this.#db.prepare('SELECT record FROM ai_attempt WHERE request_id=? ORDER BY ordinal');
    const rows = (requestId === undefined ? statement.all() : statement.all(requestId)) as { record: string }[];
    return rows.map(row => JSON.parse(row.record) as AttemptRecord);
  }
  reserve(requestId: string, epoch: number, sequence: number, repairOf?: string): AttemptRecord {
    return this.#transaction(() => {
      const logical = this.#db.prepare('SELECT * FROM ai_logical WHERE request_id=?').get(requestId) as LogicalRow | undefined;
      if (!logical || logical.canceled) throw new AiError('E_REQUEST_CANCELED');
      const all = this.attempts(); const previous = all.filter(attempt => attempt.requestId === requestId);
      if (all.some(attempt => attempt.state !== 'accounted')) throw new AiError('E_IN_FLIGHT_UNKNOWN');
      if (previous.length >= 2 || all.length >= 76) throw new AiError('E_ATTEMPT_LIMIT');
      const first = previous[0];
      if (previous.length === 0 ? repairOf !== undefined : previous.length !== 1 || first === undefined || first.attemptId !== repairOf || first.outcome !== 'invalid_response') throw new AiError('E_REPAIR_NOT_ELIGIBLE');
      if ((all.length + 1) * RESERVATION_NANO_CNY > TOTAL_AMOUNT_CAP_NANO_CNY || (all.length + 1) * (INPUT_TOKEN_CAP + OUTPUT_TOKEN_CAP) > TOTAL_TOKEN_CAP) throw new AiError('E_BUDGET');
      const ordinal = previous.length + 1; const attemptId = this.#slots.get(logical.slot_id)?.reservedAttemptIDs[ordinal - 1];
      if (!attemptId) throw new AiError('E_REQUEST_SLOT');
      const record: AttemptRecord = { attemptId, requestId, requestSlotID: logical.slot_id, ordinal, state: 'reserved', reservationNanoCNY: RESERVATION_NANO_CNY, queueSequence: sequence, authEpoch: epoch, authorizationCheckedAt: new Date().toISOString(), returnedModel: null, finishReason: null, rawOutput: null, dispatchAt: null, providerRequestId: null, usage: null, usageCalculatedNanoCNY: null, costStatus: 'reserved_unknown', outcome: 'pending' };
      this.#db.prepare('INSERT INTO ai_attempt(attempt_id,request_id,ordinal,record) VALUES(?,?,?,?)').run(attemptId, requestId, ordinal, canonicalJson(record));
      return cloneJson(record);
    });
  }
  markDispatch(attemptId: string): AttemptRecord {
    return this.#update(attemptId, record => {
      if (record.state !== 'reserved') throw new AiError('E_ATTEMPT_STATE');
      record.state = 'in_flight'; record.dispatchAt = new Date().toISOString();
    });
  }
  unknown(attemptId: string, outcome: 'transport_unknown' | 'canceled' | 'timeout'): AttemptRecord {
    return this.#update(attemptId, record => { if (record.state !== 'accounted') { record.state = 'unknown'; record.outcome = outcome; } });
  }
  complete(attemptId: string, usage: Usage | null, providerRequestId: string | null, outcome: 'parsed' | 'invalid_response', rawOutput: string | null = null, returnedModel: string | null = null, finishReason: string | null = null): AttemptRecord {
    return this.#update(attemptId, record => {
      if (record.state === 'accounted') throw new AiError('E_ALREADY_ACCOUNTED');
      record.returnedModel = returnedModel; record.finishReason = finishReason; record.rawOutput = rawOutput; record.providerRequestId = providerRequestId; record.outcome = outcome;
      if (usage === null) { record.state = 'unknown'; return; }
      if (![usage.promptTokens, usage.completionTokens, usage.cachedTokens].every(number => Number.isSafeInteger(number) && number >= 0) || usage.cachedTokens > usage.promptTokens || usage.promptTokens > INPUT_TOKEN_CAP || usage.completionTokens > OUTPUT_TOKEN_CAP) { record.state = 'unknown'; return; }
      record.usage = { ...usage };
      record.usageCalculatedNanoCNY = (usage.promptTokens - usage.cachedTokens) * 2000 + usage.cachedTokens * 40 + usage.completionTokens * 8000;
      record.costStatus = 'usage_calculated_pending_bill'; record.state = 'accounted';
      // Keep the full peak reservation charged to the cap. This is never a claim of settled billing.
    });
  }
  #update(id: string, update: (record: AttemptRecord) => void): AttemptRecord {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT record FROM ai_attempt WHERE attempt_id=?').get(id) as { record: string } | undefined;
      if (!row) throw new AiError('E_ATTEMPT_UNKNOWN'); const record = JSON.parse(row.record) as AttemptRecord;
      update(record); this.#db.prepare('UPDATE ai_attempt SET record=? WHERE attempt_id=?').run(canonicalJson(record), id);
      return cloneJson(record);
    });
  }
  result(requestId: string): GatewayResult | null {
    const row = this.#db.prepare('SELECT result FROM ai_result WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(requestId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as GatewayResult : null;
  }
  saveResult(requestId: string, attemptId: string, result: GatewayResult): void {
    this.queue.assertActive(); this.#db.prepare('INSERT OR REPLACE INTO ai_result(request_id,attempt_id,result) VALUES(?,?,?)').run(requestId, attemptId, canonicalJson(result));
  }
  budget(): { attempts: number; reservedNanoCNY: number; reservedTokens: number; inFlight: number; billingStatus: 'pending_bill_verification' } {
    const all = this.attempts(); return { attempts: all.length, reservedNanoCNY: all.length * RESERVATION_NANO_CNY, reservedTokens: all.length * (INPUT_TOKEN_CAP + OUTPUT_TOKEN_CAP), inFlight: all.filter(item => item.state !== 'accounted').length, billingStatus: 'pending_bill_verification' };
  }
  close(): void { this.#db.close(); }
}
