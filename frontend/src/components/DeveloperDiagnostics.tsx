import { useQuery } from '@tanstack/react-query';
import { Wrench, RefreshCw } from 'lucide-react';
import { api, getAuthToken } from '../api/client';

/**
 * Developer-mode diagnostics for a printer's camera subsystem.
 *
 * Surfaces the state you'd otherwise have to read from server logs: which
 * transports the model can serve, whether an upstream is currently dialled and
 * how many viewers share it, and whether the shared JPEG frame buffer is warm.
 *
 * That last one matters more than it looks: snapshots, Obico polling and plate
 * detection all read that buffer instead of opening a second camera socket
 * (Bambu firmware allows exactly one). A live stream with an empty buffer means
 * those consumers are silently starving.
 *
 * Rendered only when developer mode is enabled in Settings.
 */

interface CameraDiagnostics {
  model: string | null;
  transports: { mjpeg: boolean; mse: boolean; reason: string };
  camera_port: number;
  upstream: {
    active_stream_keys: string[];
    chamber_stream_keys: string[];
    is_active: boolean;
    subscribers: Record<string, number>;
  };
  frame_buffer: { has_frame: boolean; frame_bytes: number; seconds_since_frame: number | null };
  ffmpeg: { path: string | null; tracked_pids: number[] };
}

function Row({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-bambu-gray shrink-0">{label}</span>
      <span className={`text-right font-mono text-[11px] ${warn ? 'text-amber-400' : 'text-white'}`}>{value}</span>
    </div>
  );
}

export function DeveloperDiagnostics({ printerId }: { printerId: number }) {
  // Self-gating: the panel decides its own visibility from the setting rather
  // than relying on the caller to have a settings query in scope.
  const { data: uiPrefs } = useQuery({
    queryKey: ['ui-preferences'],
    queryFn: api.getUiPreferences,
  });
  const enabled = uiPrefs?.developer_mode ?? false;
  const showRawState = enabled && (uiPrefs?.dev_raw_state ?? false);

  const { data, isLoading, refetch, isFetching } = useQuery<CameraDiagnostics>({
    queryKey: ['camera-dev-diagnostics', printerId],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`/api/v1/printers/${printerId}/camera/dev-diagnostics`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`diagnostics failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000,
    enabled,
  });

  const { data: rawState } = useQuery({
    queryKey: ['printer-raw-state', printerId],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`/api/v1/printers/${printerId}/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`status failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000,
    enabled: showRawState,
  });

  if (!enabled) return null;
  if (isLoading) return <p className="text-xs text-bambu-gray">Loading diagnostics…</p>;
  if (!data) return <p className="text-xs text-amber-400">Diagnostics unavailable</p>;

  const streaming = data.upstream.is_active;
  // A dialled upstream that isn't filling the frame buffer starves snapshots.
  const staleBuffer = streaming && !data.frame_buffer.has_frame;
  const viewers = Object.values(data.upstream.subscribers).reduce((a, b) => a + b, 0);

  return (
    <div className="mt-2 p-2 rounded-lg bg-bambu-dark-secondary border border-amber-500/20 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-white font-medium">
          <Wrench className="w-3.5 h-3.5 text-bambu-green" /> Camera subsystem
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          className="p-1 rounded text-bambu-gray hover:text-white hover:bg-white/10"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-bambu-dark rounded-lg p-2">
        <Row label="Model / port" value={`${data.model ?? '?'} · :${data.camera_port}`} />
        <Row
          label="Transports"
          value={`MJPEG ${data.transports.mjpeg ? '✓' : '✗'} · MSE ${data.transports.mse ? '✓' : '✗'}`}
        />
        <Row label="" value={<span className="text-bambu-gray">{data.transports.reason}</span>} />
      </div>

      <div className="bg-bambu-dark rounded-lg p-2">
        <Row label="Upstream" value={streaming ? 'dialled' : 'idle'} />
        <Row label="Stream keys" value={data.upstream.active_stream_keys.join(', ') || '—'} />
        <Row label="Viewers sharing" value={String(viewers)} />
        <Row
          label="Frame buffer"
          value={
            data.frame_buffer.has_frame
              ? `${(data.frame_buffer.frame_bytes / 1024).toFixed(0)} KB · ${data.frame_buffer.seconds_since_frame?.toFixed(1) ?? '?'}s ago`
              : 'empty'
          }
          warn={staleBuffer}
        />
        {staleBuffer && (
          <p className="text-amber-400 mt-1">
            Upstream is dialled but the buffer is empty — snapshots and Obico will starve.
          </p>
        )}
        <Row label="ffmpeg PIDs" value={data.ffmpeg.tracked_pids.join(', ') || '—'} />
      </div>

      {/* Raw state inspector — gated behind its own sub-option because the
          payload is large and only useful when filing a bug. */}
      {showRawState && (
        <div className="bg-bambu-dark rounded-lg p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-bambu-gray">Raw printer state</span>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(rawState ?? {}, null, 2));
              }}
              className="text-bambu-green hover:underline"
            >
              copy
            </button>
          </div>
          <pre className="max-h-48 overflow-auto text-[10px] leading-tight text-bambu-gray whitespace-pre-wrap break-all">
            {rawState ? JSON.stringify(rawState, null, 2) : 'unavailable'}
          </pre>
        </div>
      )}
    </div>
  );
}

export default DeveloperDiagnostics;
