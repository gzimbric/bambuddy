import { useEffect, useMemo, useState, startTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Activity, X, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api/client';
import { chunkRegistry, subscribeChunks } from '../utils/lazyWithRetry';

/**
 * Developer-mode overlay.
 *
 * Self-gating: it reads ui-preferences itself and renders nothing unless
 * developer mode plus one of its sub-options is on, so the mount site in Layout
 * stays a single unconditional line.
 *
 * ---------------------------------------------------------------------------
 * A diagnostic panel must not perturb what it measures.
 *
 * The first version subscribed to the TanStack query cache and called setState
 * on every cache event, plus a 1s interval, plus a setState per PerformanceEntry.
 * On an idle instance that is harmless. On one with a live print it is not: the
 * WebSocket drives cache writes continuously, so the overlay emitted a steady
 * stream of default-priority updates.
 *
 * React Router runs navigations inside startTransition — deliberately low
 * priority, so a route change never blocks input. A continuous stream of
 * higher-priority updates anywhere in the same root starves that transition:
 * React keeps restarting the render and never commits it. The URL changes
 * (history is synchronous) while useLocation() never advances, so the route's
 * lazy chunk is never even requested. Every sidebar link looks dead, with no
 * error and no spinner to explain it.
 *
 * Hence the rules below:
 *   - ONE interval, not a subscription firing at cache-event rate.
 *   - Every update wrapped in startTransition, so overlay refreshes can never
 *     outrank a navigation.
 *   - Poll performance entries rather than setState per observed entry.
 *   - No function calls in dependency arrays (they re-evaluate every render).
 * ---------------------------------------------------------------------------
 */

const POLL_MS = 1000;

interface ChunkEntry {
  name: string;
  size: number;
  duration: number;
  at: number;
  cached: boolean;
}

const fmtBytes = (b: number) => {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const shortName = (url: string) => {
  const file = url.split('/').pop() ?? url;
  return file.replace(/-[A-Za-z0-9_]{8,}\.js$/, '.js');
};

interface QueryRow {
  key: string;
  status: string;
  fetching: boolean;
  stale: boolean;
  observers: number;
}

export function DevPerfOverlay() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [tab, setTab] = useState<'routes' | 'queries'>('routes');
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const [chunks, setChunks] = useState<ChunkEntry[]>([]);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [imports, setImports] = useState<Array<{ name: string; state: string; startedAt: number }>>([]);
  const [now, setNow] = useState(Date.now());

  const { data: prefs } = useQuery({
    queryKey: ['ui-preferences'],
    queryFn: api.getUiPreferences,
    staleTime: 30_000,
  });

  const devMode = prefs?.developer_mode ?? false;
  const showRoutes = devMode && (prefs?.dev_perf_overlay ?? false);
  const showQueries = devMode && (prefs?.dev_query_devtools ?? false);
  const verbose = devMode && (prefs?.dev_verbose_logging ?? false);
  const visible = showRoutes || showQueries;

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__BAMBUDDY_VERBOSE__ = verbose;
  }, [verbose]);

  // Single low-priority poll for everything the panel displays.
  useEffect(() => {
    if (!visible || dismissed) return;

    const sample = () => {
      const nextChunks: ChunkEntry[] = [];
      if (showRoutes) {
        for (const e of performance.getEntriesByType('resource')) {
          const r = e as PerformanceResourceTiming;
          if (r.initiatorType !== 'script' && !r.name.endsWith('.js')) continue;
          // Cache hits report transferSize 0 with a real decodedBodySize.
          // Firefox reports all three as 0, hence the '—' fallback.
          const cached = r.transferSize === 0 && r.decodedBodySize > 0;
          nextChunks.push({
            name: r.name,
            size: r.transferSize || r.encodedBodySize || r.decodedBodySize || 0,
            duration: r.duration,
            at: r.startTime,
            cached,
          });
        }
      }

      const nextQueries: QueryRow[] = showQueries
        ? queryClient
            .getQueryCache()
            .getAll()
            .map((q) => ({
              key: JSON.stringify(q.queryKey),
              status: q.state.status,
              fetching: q.state.fetchStatus === 'fetching',
              stale: q.isStale(),
              observers: q.getObserversCount(),
            }))
            .sort((a, b) => b.observers - a.observers || a.key.localeCompare(b.key))
        : [];

      const nextImports = Array.from(chunkRegistry.values())
        .filter((r) => r.state !== 'ok')
        .map((r) => ({ name: r.name, state: r.state, startedAt: r.startedAt }));

      // Low priority: a panel refresh must never preempt a navigation.
      startTransition(() => {
        setChunks(nextChunks);
        setQueries(nextQueries);
        setImports(nextImports);
        setNow(Date.now());
      });
    };

    sample();
    const iv = setInterval(sample, POLL_MS);
    // Nudge on import state changes too, still at transition priority.
    const unsub = subscribeChunks(() => startTransition(sample));
    return () => {
      clearInterval(iv);
      unsub();
    };
  }, [visible, dismissed, showRoutes, showQueries, queryClient]);

  const totalJs = useMemo(() => chunks.reduce((sum, c) => sum + c.size, 0), [chunks]);
  const cachedCount = useMemo(() => chunks.filter((c) => c.cached).length, [chunks]);
  const sortedChunks = useMemo(() => chunks.slice().sort((a, b) => a.at - b.at), [chunks]);

  if (!visible || dismissed) return null;

  return (
    <div className="fixed bottom-3 right-3 z-[9999] w-[360px] max-w-[calc(100vw-1.5rem)] bg-bambu-dark-secondary/95 backdrop-blur border border-bambu-dark-tertiary rounded-lg shadow-xl text-xs font-mono">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bambu-dark-tertiary">
        <Activity className="w-3.5 h-3.5 text-bambu-green shrink-0" />
        <span className="text-white font-sans font-medium">devmode</span>
        <span className="text-bambu-gray truncate">{location.pathname}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="p-1 text-bambu-gray hover:text-white"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => setDismissed(true)} className="p-1 text-bambu-gray hover:text-white" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {showRoutes && showQueries && (
            <div className="flex border-b border-bambu-dark-tertiary font-sans">
              {(['routes', 'queries'] as const).map((tk) => (
                <button
                  key={tk}
                  onClick={() => setTab(tk)}
                  className={`flex-1 px-3 py-1.5 capitalize ${
                    tab === tk ? 'text-bambu-green border-b-2 border-bambu-green' : 'text-bambu-gray hover:text-white'
                  }`}
                >
                  {tk}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[45vh] overflow-y-auto p-3 space-y-1">
            {imports.length > 0 && (
              <div className="mb-2 border border-amber-500/40 bg-amber-500/10 rounded p-1.5 font-sans">
                <div className="text-amber-300 mb-1">dynamic imports in flight / failed</div>
                {imports.map((r) => (
                  <div key={r.name} className="flex justify-between gap-2">
                    <span className="text-white truncate">{r.name}</span>
                    <span className="text-amber-300 shrink-0">
                      {r.state}
                      {r.state === 'loading' ? ` ${((now - r.startedAt) / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {showRoutes && (!showQueries || tab === 'routes') && (
              <>
                <div className="flex justify-between text-bambu-gray font-sans mb-2">
                  <span>
                    {chunks.length} JS chunks
                    {cachedCount > 0 && <span className="text-bambu-gray/60"> · {cachedCount} cached</span>}
                  </span>
                  <span className="text-white">{fmtBytes(totalJs)}</span>
                </div>
                {chunks.length === 0 && <p className="text-bambu-gray">No script timings recorded.</p>}
                {cachedCount > 0 && (
                  <p className="text-bambu-gray/50 font-sans pb-1">* served from cache (decoded size)</p>
                )}
                {sortedChunks.map((c) => (
                  <div key={c.name} className="flex items-baseline gap-2">
                    <span className="text-white truncate flex-1" title={c.name}>
                      {shortName(c.name)}
                    </span>
                    <span className={`shrink-0 ${c.cached ? 'text-bambu-gray/50' : 'text-bambu-gray'}`}>
                      {fmtBytes(c.size)}
                      {c.cached && '*'}
                    </span>
                    <span className="text-bambu-gray/60 shrink-0 w-14 text-right">
                      {c.duration < 1 ? '<1ms' : `${c.duration.toFixed(0)}ms`}
                    </span>
                  </div>
                ))}
              </>
            )}

            {showQueries && (!showRoutes || tab === 'queries') && (
              <>
                <div className="flex justify-between text-bambu-gray font-sans mb-2">
                  <span>{queries.length} cached queries</span>
                  <span>{queries.filter((q) => q.fetching).length} fetching</span>
                </div>
                {queries.map((q) => (
                  <div key={q.key} className="flex items-baseline gap-2">
                    <span
                      className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                        q.fetching
                          ? 'bg-blue-400'
                          : q.status === 'error'
                            ? 'bg-red-400'
                            : q.stale
                              ? 'bg-amber-400'
                              : 'bg-bambu-green'
                      }`}
                    />
                    <span className="text-white truncate flex-1" title={q.key}>
                      {q.key}
                    </span>
                    <span className="text-bambu-gray/60 shrink-0">{q.observers}×</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default DevPerfOverlay;
