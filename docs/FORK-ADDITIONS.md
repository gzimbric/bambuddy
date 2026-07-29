# Fork additions

This is a fork of [maziggy/bambuddy](https://github.com/maziggy/bambuddy). Everything not listed here matches upstream.

Four pieces of work live in this fork. They're at different stages, and the table says which is which — nothing below is merged upstream yet.

| Addition | What it gives you | Status |
|---|---|---|
| [P2S/X2D accessory fans](#1-p2sx2d-accessory-fans) | Control + monitoring for two fans upstream drops | Proposed upstream — [#2691](https://github.com/maziggy/bambuddy/pull/2691) |
| [Dev Mode](#2-dev-mode) | In-app diagnostics, stream selection, live perf panel | Fork only |
| [Route code splitting](#3-route-level-code-splitting) | First load drops 8.4 MB → 4.5 MB | Fork only |
| [Camera reliability](#4-camera-reliability) | H.264 passthrough, fewer dropped streams | Fork only; two fixes are upstream bugs |

---

## 1. P2S/X2D accessory fans

The P2S and X2D have two fans Bambuddy doesn't expose: the **left auxiliary part cooling fan** and the **chamber exhaust fan**. On the P2S both are add-on kits ([left aux](https://us.store.bambulab.com/products/auxiliary-part-cooling-fan-left), [exhaust kit](https://us.store.bambulab.com/products/external-exhaust-fan-kit-p2s)); on the X2D they ship from the factory.

| Fan | Upstream | This fork |
|---|---|---|
| Left auxiliary part cooling | not shown, not controllable | monitored **and** controllable (0–100%) |
| Chamber exhaust | shown on every P2S as "Chamber Fan" | labelled **"Exhaust"**, shown only when fitted |

### Why the left aux fan was invisible

It is reported **only** inside `device.airduct.parts`, as decoded part id 10. The firmware never mirrors it into any flat `big_fanX_speed` field — which is why no amount of reading the obvious fields would have found it.

The mapping below was derived empirically, by toggling each fan individually on the printer's touchscreen while capturing MQTT, in both cooling and heating airduct modes:

| Fan | MQTT field | airduct id | On a base P2S? |
|---|---|---|---|
| Part cooling | `cooling_fan_speed` | 1 | built-in |
| Aux (right) | `big_fan1_speed` | 2 | built-in |
| Exhaust | `big_fan2_speed` | 3 | kit |
| **Left aux** | *(airduct only — no flat field)* | **10** | kit |

Because `airduct.parts` lists only fans that physically exist, it doubles as kit detection — so badges appear only when the hardware is really there, and a base P2S is unaffected.

Two decoding rules matter, both mirroring Bambu Studio's `DevFan::ParseV3_0`:

- Part id is `raw_id >> 4` (raw 160 → id 10).
- Part state is **bit-packed** like its sibling `range` (`end << 16 | start`), so mask to the low 8 bits *before* clamping. Without the mask a packed value clamps to 100 instead of decoding — e.g. `(60 << 16) | 45` reads as 100 rather than 45.

### API

```http
POST /api/v1/printers/{id}/fan-speed?fan=aux2&speed=50
```

`fan` accepts `part` | `aux` | `aux2` | `chamber`. `aux2` sends `M106 P10` — the command Bambu's own P2S machine profiles use — and is rejected with a 400 on printers that don't report the fan.

Two fields join the status payload, WebSocket broadcasts and the MQTT relay:

| Field | Meaning |
|---|---|
| `left_aux_fan_speed` | `0–100`, or `null` when not fitted |
| `exhaust_fan_present` | `true` when airduct part 3 is reported |

---

## 2. Dev Mode

> **Not to be confused with Bambu's Developer Mode**, the printer-side setting that enables LAN control. This is a Bambuddy-side diagnostics toggle and has nothing to do with the printer's configuration.

Settings → Developer Mode. Off by default, with a warning, and a `devmode` badge appears next to the version in the sidebar while it's on.

Enabling it unlocks:

- **Camera subsystem panel** on each printer card — transports available, whether the upstream is dialled, stream keys, frame-buffer age, ffmpeg PIDs, and *which consumer* is using the camera.
- **Camera transport override** — force MJPEG or H.264/MSE instead of automatic selection, to A/B them.
- **Bundle & route performance overlay** — which route chunks have loaded, their transferred size, fetch time.
- **Query cache inspector** — every cached query, its status and staleness.
- **Raw printer state inspector** — the unparsed MQTT payload, handy when filing a bug.
- **Verbose transport logging** — camera and WebSocket events to the console.

Each sub-option persists independently, so turning dev mode off and back on doesn't lose your setup.

### Consumer attribution

The camera panel distinguishes **browser viewers** from **backend consumers**. This matters more than it sounds: Obico failure detection, the snapshot endpoint and timelapse all use the camera without any browser involved, and none of them increment the WebSocket subscriber count. A panel reporting only subscribers shows "0 viewers" while something is legitimately holding the camera, which reads as a leak and isn't one.

### A note on measuring things

Browsers disagree about Resource Timing for cached responses. Chrome fills in `decodedBodySize`, so a cached chunk still reports its real size; Firefox reports zero for all three size fields and collapses duration to ~0. On one build with the same warm cache, Chrome read `4.30 MB / 539ms` where Firefox read `— / <1ms` for every row. The overlay detects this and says so rather than presenting a column of blanks.

---

## 3. Route-level code splitting

Upstream ships the frontend as a single chunk. Every first visit downloaded the whole application — including three.js (gcode viewer only) and recharts (statistics only) — before rendering anything.

| | Before | After |
|---|---|---|
| JS chunks | 1 | 123 |
| Initial download | 8.4 MB (2.2 MB gzipped) | 4.5 MB (1.37 MB gzipped) |

Heavy routes now load on demand: `FileUploadModal` 1.2 MB, `SettingsPage` 631 kB, `RichTextEditor` 382 kB, the recharts bundle 319 kB, `PrintersPage` 312 kB. `LoginPage` and `SetupPage` stay eager so the logged-out first paint doesn't gain a spinner before the spinner.

There's still ~4.5 MB in the entry chunk worth chasing — something shared is pulling weight it doesn't need to.

### Two traps worth documenting

**Suspense boundary placement.** Putting the boundary outside `<Routes>` means a suspending route unmounts the *entire* subtree — auth guard, WebSocket provider, sidebar — and rebuilds it on every navigation, tearing down and reconnecting the socket each time. The boundaries belong around `<Outlet />` inside the layouts, so only the page area suspends.

**Chunks that stop existing.** A deploy while someone has the app open leaves their running entry chunk pointing at filenames the new build doesn't contain. Every unvisited route becomes a 404 — and because React Router runs navigations inside `startTransition`, React keeps showing the old page rather than flashing a fallback. The link just looks dead: no error, no spinner. `lazyWithRetry()` handles it — retry, then reload once for a fresh `index.html`, guarded so a genuinely missing chunk errors instead of refresh-looping. It also races each import against a timeout, because a *hung* request never rejects and so never triggers a plain `catch`.

---

## 4. Camera reliability

### H.264 passthrough (MSE)

Upstream transcodes the printer's RTSP feed to MJPEG and displays it in an `<img>`. MJPEG has no inter-frame compression, so the same 1080p feed costs far more than it needs to, and `multipart/x-mixed-replace` has no jitter buffer — one truncated boundary and the browser silently freezes on the last frame.

This fork remuxes H.264 into fragmented MP4 over a WebSocket and plays it via Media Source Extensions, with automatic fallback to MJPEG:

| | MJPEG transcode | H.264 remux |
|---|---|---|
| Bandwidth | ~11.3 Mbps | ~1.0 Mbps |
| Server CPU | ~101% | ~1–9% |

Only the RTSPS/322 family benefits (X1 / X1C / X1E / X2D / P2S / H2C / H2D / H2D Pro / H2S). A1 / A1 Mini / P1P / P1S use the `chamber_image` protocol on port 6000 and keep the MJPEG path.

MSE was chosen over WebRTC deliberately: Cloudflare Zero Trust tunnels proxy HTTP and WebSocket only, so WebRTC negotiates a transport that can never connect and then falls back after a timeout — which *looks* broken.

### Concurrent capture coalescing

Bambu firmware allows exactly **one** camera connection. Upstream already stops each consumer competing with the fan-out broadcaster, but nothing coordinated the one-shot capturers with *each other*. With no viewer attached, the Obico poll loop and `/camera/snapshot` each open their own RTSP socket. Observed on a live P2S:

```
13:08:22,165  [SNAPSHOT] Capturing fresh frame for printer 1
13:08:22,167  Capturing camera frame bytes ... RTSP
13:08:22,374  Capturing camera frame bytes ... RTSP   <- second socket
```

Two sockets 207 ms apart for a slot that fits one — which is how the fan-out stream ends up with an `RTSP read timeout` and gets reaped as stale.

`capture_camera_frame_bytes` now single-flights per printer: the first caller captures, everyone arriving mid-flight awaits the same result. Verified against a live P2S — **5 simultaneous callers, 1 RTSP connection, 5 frames returned**. Coalescing is not caching: sequential calls still capture fresh, and a failed leader doesn't poison its followers.

**This is an upstream bug**, not something this fork introduced. It affects any single-connection printer running Obico.

### Service worker

`sw.js` answered a failed JS/CSS fetch with `caches.match(request)`, which resolves to `undefined` for a chunk the cache has never seen — and `respondWith(undefined)` throws. One dropped request made that asset permanently unfetchable for the life of the page.

That was survivable with a single bundle, since everything was already loaded. With split routes it is not. It now falls back to cache, retries the network, and finally returns a real 504 so the failure surfaces instead of hanging. Cache names are bumped so existing clients purge stale entries on the next load.

**Also an upstream bug**, latent for everyone today — it only becomes visible once routes are split.

---

## Building this fork

```bash
git clone -b feature/developer-mode https://github.com/gzimbric/bambuddy.git
cd bambuddy
docker build -t bambuddy:fork .
```

Run it exactly as you would upstream Bambuddy, substituting the `bambuddy:fork` image.

For the accessory-fan work alone, without the rest, use `-b feature/p2s-x2d-accessory-fans` — that branch is kept clean for upstream review.

## Branches

| Branch | Contents |
|---|---|
| `feature/p2s-x2d-accessory-fans` | The upstream PR branch. Fans only, docs-free by CONTRIBUTING's rules |
| `feature/developer-mode` | Dev mode, code splitting, camera work — built on top of upstream `dev` |
| `main` | Upstream plus this documentation |
| `pr-assets` | Screenshots referenced by the upstream PR — **do not delete**, the PR images break |
