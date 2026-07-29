import { lazy, type ComponentType } from 'react';

/**
 * `React.lazy` with recovery for chunks that fail to arrive.
 *
 * Route-level code splitting introduces a failure mode a single bundle never
 * had: the page holds a reference to a hashed chunk filename, and that file can
 * stop being fetchable while the tab stays open. Two ways that happens in
 * practice:
 *
 *  - A deploy lands while someone has the app open. The running entry chunk
 *    points at filenames the new build no longer contains, so every route the
 *    user has not visited yet is now a 404.
 *  - The network hiccups — flaky wifi, or a reverse proxy / tunnel dropping a
 *    request. Bambuddy's service worker used to answer these with `undefined`,
 *    which made the failure permanent rather than transient.
 *
 * Either way the import() rejects, and because React Router runs navigations
 * inside startTransition, React keeps the *previous* page on screen while it
 * waits. The URL changes, nothing else does, and there is no error and no
 * spinner — the link simply looks dead.
 *
 * So: retry once, and if that also fails, reload the page once to pick up a
 * fresh index.html (fixes the stale-deploy case). The reload is guarded by a
 * sessionStorage flag so a genuinely missing chunk produces one reload and then
 * a real error, rather than an infinite refresh loop.
 */

const RELOAD_FLAG = 'bambuddy:chunk-reloaded';

// React.lazy is typed against ComponentType<any>; narrowing the constraint here
// makes the factory unassignable, so match React's own signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  chunkName?: string,
) {
  return lazy(async () => {
    try {
      const mod = await factory();
      // Getting through cleanly means any earlier reload did its job; clear the
      // guard so a future stale deploy is allowed its own single reload.
      window.sessionStorage?.removeItem(RELOAD_FLAG);
      return mod;
    } catch (error) {
      console.warn(`[chunk] failed to load${chunkName ? ` ${chunkName}` : ''}, retrying`, error);

      try {
        return await factory();
      } catch (retryError) {
        const alreadyReloaded = window.sessionStorage?.getItem(RELOAD_FLAG) === '1';
        if (!alreadyReloaded) {
          // Most likely a deploy happened under us. A reload fetches the new
          // index.html, whose chunk names actually exist.
          console.warn(`[chunk] retry failed${chunkName ? ` for ${chunkName}` : ''}, reloading once`);
          window.sessionStorage?.setItem(RELOAD_FLAG, '1');
          window.location.reload();
          // Never resolves — the reload replaces this document.
          return await new Promise<{ default: T }>(() => {});
        }
        // Already reloaded once and it still fails: surface it to the error
        // boundary instead of silently hanging on the previous page.
        throw retryError;
      }
    }
  });
}
