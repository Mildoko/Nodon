/** One Node authority queue, shared by commands, AI gates and revocations. Never await in a job. */
export class CommandQueue {
  #next = 0;
  #active: number | null = null;
  #pending: Array<() => void> = [];
  #scheduled = false;
  enqueue<T>(job: (sequence: number) => T): Promise<T> {
    if (this.#next === Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('E_QUEUE_LIMIT'));
    const sequence = ++this.#next;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.push(() => {
        this.#active = sequence;
        try {
          const value = job(sequence);
          if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) throw new Error('E_ASYNC_QUEUE_JOB');
          resolve(value);
        } catch (error) { reject(error); }
        finally { this.#active = null; }
      });
    });
    if (!this.#scheduled) { this.#scheduled = true; queueMicrotask(() => this.#drain()); }
    return result;
  }
  assertActive(): number { if (this.#active === null) throw new Error('E_QUEUE_REQUIRED'); return this.#active; }
  #drain(): void {
    try { while (this.#pending.length) this.#pending.shift()?.(); }
    finally { this.#scheduled = false; }
  }
}
