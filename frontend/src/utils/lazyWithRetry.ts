import { lazy, type ComponentType } from 'react';

/**
 * `React.lazy` with recovery for chunks that fail to arrive.
 *
 * Route-level code splitting introduces a failure mode a single bundle never
 * had: the page holds a reference to a hashed chunk filename, and that file can
 * stop being fetchable while the tab stays open — a deploy replaced it, or the
 * network/proxy dropped the request.
 *
 * The failure is invisible without help. React Router runs navigations inside
 * startTransition, and React deliberately keeps the *previous* page on screen
 * during a transition rather than flashing a fallback. So a chunk that never
 * arrives looks like a dead nav link: the URL changes, nothing else does, no
 * error and no spinner.
 *
 * Three cases are handled, and the third is the one that matters most:
 *   1. import() rejects            -> retry once, then reload once.
 *   2. import() rejects again      -> reload once to pick up a fresh index.html.
 *   3. import() never settles      -> a hung request produces no rejection at
 *      all, so plain try/catch never runs. Everything is raced against a
 *      timeout to convert the hang into case 1.
 *
 * The reload is guarded by a sessionStorage flag so a genuinely missing chunk
 * surfaces a real error instead of looping.
 */

const RELOAD_FLAG = 'bambuddy:chunk-reloaded';
const LOAD_TIMEOUT_MS = 8000;

export type ChunkState = 'loading' | 'ok' | 'retrying' | 'failed';

interface ChunkRecord {
  name: string;
  state: ChunkState;
  startedAt: number;
  ms?: number;
  error?: string;
}

/**
 * Live registry of dynamic-import attempts, surfaced by the developer-mode
 * overlay. Diagnosing this class of bug from a screenshot is otherwise
 * impossible — "pending for 40s" and "rejected immediately" look identical on
 * screen, and they have opposite causes.
 */
const listeners = new Set<() => void>();
export const chunkRegistry = new Map<string, ChunkRecord>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeChunks(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function mark(name: string, state: ChunkState, extra?: Partial<ChunkRecord>) {
  const existing = chunkRegistry.get(name);
  const startedAt = existing?.startedAt ?? Date.now();
  chunkRegistry.set(name, {
    name,
    state,
    startedAt,
    ms: state === 'loading' ? undefined : Date.now() - startedAt,
    ...extra,
  });
  emit();
}

function withTimeout<R>(promise: Promise<R>, ms: number, label: string): Promise<R> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`chunk ${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function lazyWithRetry<T extends ComponentType<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
  factory: () => Promise<{ default: T }>,
  chunkName = 'chunk',
) {
  return lazy(async () => {
    mark(chunkName, 'loading');
    try {
      const mod = await withTimeout(factory(), LOAD_TIMEOUT_MS, chunkName);
      mark(chunkName, 'ok');
      window.sessionStorage?.removeItem(RELOAD_FLAG);
      return mod;
    } catch (error) {
      console.warn(`[chunk] ${chunkName} failed, retrying`, error);
      mark(chunkName, 'retrying', { error: String(error) });

      try {
        const mod = await withTimeout(factory(), LOAD_TIMEOUT_MS, chunkName);
        mark(chunkName, 'ok');
        return mod;
      } catch (retryError) {
        mark(chunkName, 'failed', { error: String(retryError) });
        const alreadyReloaded = window.sessionStorage?.getItem(RELOAD_FLAG) === '1';
        if (!alreadyReloaded) {
          console.warn(`[chunk] ${chunkName} retry failed, reloading once`);
          window.sessionStorage?.setItem(RELOAD_FLAG, '1');
          window.location.reload();
          // Never resolves — the reload replaces this document.
          return await new Promise<{ default: T }>(() => {});
        }
        throw retryError;
      }
    }
  });
}
