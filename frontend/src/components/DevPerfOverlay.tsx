import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Activity, X, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api/client';

/**
 * Developer-mode overlay.
 *
 * Self-gating like DeveloperDiagnostics: it reads the ui-preferences query
 * itself and renders nothing unless developer mode plus at least one of its
 * sub-options is on. That keeps the mount site in App/Layout a single
 * unconditional line and means no other component needs to know about it.
 *
 * The Routes tab exists to make route-level code splitting observable. Before
 * splitting there was one ~8 MB chunk, so "which chunks loaded" was a question
 * with a boring answer; now each route pulls its own file and this shows the
 * cost of a navigation directly.
 */

interface ChunkEntry {
  name: string;
  size: number;
  duration: number;
  at: number;
}

const fmtBytes = (b: number) => {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const shortName = (url: string) => {
  const file = url.split('/').pop() ?? url;
  // Vite names chunks like `PrintersPage-Bd3f9a1c.js`; the hash is noise here.
  return file.replace(/-[A-Za-z0-9_]{8,}\.js$/, '.js');
};

export function DevPerfOverlay() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [tab, setTab] = useState<'routes' | 'queries'>('routes');
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [chunks, setChunks] = useState<ChunkEntry[]>([]);
  const [, forceTick] = useState(0);

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

  // Verbose transport logging is read by the camera/websocket components off a
  // global, because they're deep in the tree and re-plumbing a context through
  // them for a debug flag isn't worth it.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__BAMBUDDY_VERBOSE__ = verbose;
  }, [verbose]);

  // Collect script resource timings. Chunks that loaded before this mounted are
  // picked up from the existing buffer, then new ones stream in via the observer.
  useEffect(() => {
    if (!showRoutes) return;
    const take = (entries: PerformanceEntryList) => {
      const next: ChunkEntry[] = [];
      for (const e of entries) {
        const r = e as PerformanceResourceTiming;
        if (r.initiatorType !== 'script' && !r.name.endsWith('.js')) continue;
        next.push({
          name: r.name,
          size: r.transferSize || r.encodedBodySize || 0,
          duration: r.duration,
          at: r.startTime,
        });
      }
      if (next.length) {
        setChunks((prev) => {
          const seen = new Set(prev.map((c) => c.name));
          return [...prev, ...next.filter((c) => !seen.has(c.name))];
        });
      }
    };
    take(performance.getEntriesByType('resource'));
    const obs = new PerformanceObserver((list) => take(list.getEntries()));
    obs.observe({ type: 'resource', buffered: true });
    return () => obs.disconnect();
  }, [showRoutes]);

  // The query cache mutates outside React, so subscribe and tick to re-render.
  useEffect(() => {
    if (!showQueries) return;
    const unsub = queryClient.getQueryCache().subscribe(() => forceTick((n) => n + 1));
    const iv = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, [showQueries, queryClient]);

  const totalJs = useMemo(() => chunks.reduce((sum, c) => sum + c.size, 0), [chunks]);

  const queries = useMemo(() => {
    if (!showQueries) return [];
    return queryClient
      .getQueryCache()
      .getAll()
      .map((q) => ({
        key: JSON.stringify(q.queryKey),
        status: q.state.status,
        fetching: q.state.fetchStatus === 'fetching',
        stale: q.isStale(),
        observers: q.getObserversCount(),
        updatedAt: q.state.dataUpdatedAt,
      }))
      .sort((a, b) => b.observers - a.observers || a.key.localeCompare(b.key));
  }, [showQueries, queryClient, location.pathname, chunks.length, queryClient.getQueryCache().getAll().length]);

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
            {(showRoutes && (!showQueries || tab === 'routes')) && (
              <>
                <div className="flex justify-between text-bambu-gray font-sans mb-2">
                  <span>{chunks.length} JS chunks</span>
                  <span className="text-white">{fmtBytes(totalJs)} transferred</span>
                </div>
                {chunks.length === 0 && <p className="text-bambu-gray">No script timings recorded.</p>}
                {chunks
                  .slice()
                  .sort((a, b) => a.at - b.at)
                  .map((c) => (
                    <div key={c.name} className="flex items-baseline gap-2">
                      <span className="text-white truncate flex-1" title={c.name}>
                        {shortName(c.name)}
                      </span>
                      <span className="text-bambu-gray shrink-0">{fmtBytes(c.size)}</span>
                      <span className="text-bambu-gray/60 shrink-0 w-14 text-right">{c.duration.toFixed(0)}ms</span>
                    </div>
                  ))}
              </>
            )}

            {(showQueries && (!showRoutes || tab === 'queries')) && (
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
                          ? 'bg-blue-400 animate-pulse'
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
