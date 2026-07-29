import { useEffect, useRef, useState } from 'react';

// Verbose transport logging, toggled by the developer-mode sub-option. Reads a
// global because this component is mounted deep in the printer card tree and a
// context just for a debug flag isn't worth the plumbing.
const devLog = (...args: unknown[]) => {
  if ((window as unknown as Record<string, unknown>).__BAMBUDDY_VERBOSE__) {
    console.debug('[mse]', ...args);
  }
};


/**
 * H.264 passthrough camera player.
 *
 * The MJPEG endpoint re-encodes every frame server-side (~1 CPU core and
 * ~11 Mbps at 1080p) and, because it renders into an <img> via
 * multipart/x-mixed-replace, the browser has no jitter buffer and no error
 * recovery — a single truncated boundary freezes on the last frame forever.
 *
 * RTSP-capable printers already emit H.264, so the backend remuxes it into
 * fragmented MP4 and ships it over the app's own WebSocket origin. The browser
 * hardware-decodes it through Media Source Extensions: same picture, ~1 Mbps,
 * a few percent of a core, and a real jitter buffer.
 *
 * Renders nothing itself on failure — it reports upward via onUnsupported so
 * the parent can fall back to the MJPEG <img> (which chamber-image printers —
 * A1 / A1 mini / P1P / P1S — must keep using regardless).
 */

// Matches the backend close codes.
const WS_UNAUTHORIZED = 4401;
const WS_NOT_RTSP_CAPABLE = 4415;

// Keep the buffered range short: this is a live view, so drifting behind is
// worse than dropping history. Anything older than this behind the playhead is
// evicted, which also stops SourceBuffer quota errors on long sessions.
const MAX_BUFFER_SECONDS = 10;

export interface MseCameraVideoProps {
  printerId: number;
  token?: string | null;
  className?: string;
  style?: React.CSSProperties;
  /** Called when MSE can't be used, so the caller can fall back to MJPEG. */
  onUnsupported?: (reason: string) => void;
  /** Called once the first frames actually render. */
  onPlaying?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export function MseCameraVideo({
  printerId,
  token,
  className,
  style,
  onUnsupported,
  onPlaying,
  onMouseDown,
}: MseCameraVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumping this remounts the whole MSE pipeline after a stall.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Codec string must match what the printer emits (H.264 High@4.1). If the
    // browser can't do MSE at all (older iOS Safari), bail immediately.
    const MIME = 'video/mp4; codecs="avc1.640029"';
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(MIME)) {
      setFailed(true);
      onUnsupported?.('MediaSource unsupported in this browser');
      return;
    }

    let ws: WebSocket | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    let disposed = false;
    const pending: ArrayBuffer[] = [];

    // Stall watchdog.
    //
    // The socket staying open is not evidence that video is arriving. The
    // printer allows one camera connection, so when another client (Bambu
    // Studio, Handy, another Bambuddy) takes or releases the camera, the
    // upstream RTSP session can die without our WebSocket ever closing. No
    // error fires, no fragments arrive, and MSE simply holds the last decoded
    // frame — the picture freezes with nothing to indicate why.
    //
    // Server-side recovery exists but is slow for a watched stream: the
    // janitor runs on a 60s timer and only reaps after 30s without frames, so
    // a viewer can stare at a frozen image for well over a minute. Watching
    // for fragment arrival here catches it in seconds.
    let lastFragmentAt = Date.now();
    let stallTimer: number | null = null;
    let reconnects = 0;
    const STALL_MS = 8000;
    const MAX_RECONNECTS = 2;

    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);

    /** Feed the SourceBuffer one chunk at a time; it can only take one append. */
    const pump = () => {
      if (disposed || !sourceBuffer || sourceBuffer.updating) return;
      const next = pending.shift();
      if (!next) return;
      try {
        sourceBuffer.appendBuffer(next);
      } catch {
        // QuotaExceeded is the common one — drop what we're holding and let
        // the eviction below catch up rather than tearing the stream down.
        pending.length = 0;
      }
    };

    const onUpdateEnd = () => {
      if (disposed || !sourceBuffer || sourceBuffer.updating) return;
      // Evict anything well behind the playhead so memory stays flat.
      try {
        const buffered = sourceBuffer.buffered;
        if (buffered.length > 0) {
          const end = buffered.end(buffered.length - 1);
          const start = buffered.start(0);
          if (end - start > MAX_BUFFER_SECONDS) {
            sourceBuffer.remove(start, end - MAX_BUFFER_SECONDS);
            return; // removal triggers another updateend
          }
          // Live edge: if we've drifted behind (tab was backgrounded), skip forward.
          if (video.currentTime < end - MAX_BUFFER_SECONDS) {
            video.currentTime = end - 0.5;
          }
        }
      } catch {
        /* buffered can throw while the source is closing */
      }
      pump();
    };

    mediaSource.addEventListener('sourceopen', () => {
      if (disposed) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(MIME);
        sourceBuffer.mode = 'segments';
        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        devLog('source buffer open', MIME);
      } catch {
        setFailed(true);
        devLog('addSourceBuffer failed — falling back to MJPEG');
        onUnsupported?.('addSourceBuffer failed');
        return;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      ws = new WebSocket(`${proto}//${window.location.host}/api/v1/printers/${printerId}/camera/mse${qs}`);
      ws.binaryType = 'arraybuffer';

      ws.onmessage = (ev) => {
        if (disposed) return;
        lastFragmentAt = Date.now();
        const buf = ev.data as ArrayBuffer;
        devLog('fragment', buf.byteLength, 'bytes · queue', pending.length);
        pending.push(buf);
        pump();
      };

      // Poll rather than reset a timer per fragment — one interval is cheaper
      // than thousands of clearTimeout/setTimeout pairs at 15fps.
      if (stallTimer === null) {
        stallTimer = window.setInterval(() => {
          if (disposed) return;
          const idle = Date.now() - lastFragmentAt;
          if (idle < STALL_MS) return;

          if (reconnects >= MAX_RECONNECTS) {
            devLog('stalled', idle, 'ms and out of retries — falling back');
            if (stallTimer !== null) window.clearInterval(stallTimer);
            stallTimer = null;
            setFailed(true);
            onUnsupported?.('stream stalled');
            return;
          }

          // Closing the socket drops our subscriber count, which lets the
          // server tear the dead upstream down instead of fanning it out to a
          // reconnecting client. The remount then dials a fresh one.
          reconnects += 1;
          devLog('stalled', idle, 'ms — reconnecting', reconnects, 'of', MAX_RECONNECTS);
          lastFragmentAt = Date.now();
          try {
            ws?.close(4000, 'stalled');
          } catch {
            /* already closing */
          }
        }, 2000);
      }
      ws.onerror = () => {
        if (disposed) return;
        setFailed(true);
        devLog('websocket error');
        onUnsupported?.('websocket error');
      };
      ws.onclose = (ev) => {
        if (disposed) return;
        // 4000 is our own stall close. Re-dialling means a full remount of this
        // effect, which rebuilds the MediaSource — the existing buffer holds
        // fragments from a stream that no longer exists.
        if (ev.code === 4000) {
          devLog('reconnecting after stall');
          setReconnectNonce((n) => n + 1);
          return;
        }
        // 4415 = printer has no H.264 (chamber-image model) → MJPEG is correct.
        // 4401 = auth; anything else = upstream ended. Fall back either way.
        const reason =
          ev.code === WS_NOT_RTSP_CAPABLE
            ? 'printer has no H.264 stream'
            : ev.code === WS_UNAUTHORIZED
              ? 'unauthorised'
              : 'stream closed';
        setFailed(true);
        devLog('websocket closed', ev.code, reason);
        onUnsupported?.(reason);
      };
    });

    return () => {
      disposed = true;
      if (stallTimer !== null) {
        window.clearInterval(stallTimer);
        stallTimer = null;
      }
      try { ws?.close(); } catch { /* already closed */ }
      try {
        if (sourceBuffer) sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch { /* teardown races are benign */ }
      try { URL.revokeObjectURL(video.src); } catch { /* noop */ }
      video.removeAttribute('src');
      video.load();
    };
    // token/printerId changes rebuild the socket; callbacks are refs in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // reconnectNonce is a deliberate dependency: bumping it tears down and
    // rebuilds the MediaSource after a stall.
  }, [printerId, token, reconnectNonce]);

  if (failed) return null;

  return (
    <video
      ref={videoRef}
      className={className}
      style={style}
      autoPlay
      muted
      playsInline
      onPlaying={onPlaying}
      onMouseDown={onMouseDown}
    />
  );
}

export default MseCameraVideo;
