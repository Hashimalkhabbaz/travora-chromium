# Browser Manager

Electron app that manages many isolated profiles of our **fingerprint-patched
Chromium**. Each profile has its own fingerprint (from
[`fingerprint-generator`](https://github.com/apify/fingerprint-suite)), cookies,
storage, proxy, name and color. The browser applies the fingerprint in C++: no
injected JavaScript, no DevTools connection.

## Run

```bash
npm install
npm start                    # open the manager UI
npm run smoke                # launch a throwaway profile, check what websites see
npm run smoke -- <proxy>     # ...through a proxy (adds timezone/geolocation/language checks)
npm run test:noise           # canvas/WebGL/audio/fonts: stable per profile, different across profiles
npm run test:compatibility   # migration preserves sessions, proxies and noise; checks backups
npm run test:editor          # manual choices, validation, persistence and Real-mode resets
npm run test:editor:ui       # isolated Electron Create/Edit/Cancel regression
npm run test:editor:native   # verify individual controls in the rebuilt Chromium
npm run audit:sites -- audit-results/run-1  # compare all saved profiles with clean stock Chrome
npm run profiles:align       # align saved OS/GPU/display values with this machine (backs up metadata)
```

The site audit opens each saved profile in turn and visits ten fingerprint test
pages, saving page text (`.txt`) and screenshots (`.png`) under the output folder.
Allow about 15 minutes for three profiles plus the stock Chrome baseline. Close
the saved profiles before running it. To test selected profiles or resume a run:

```powershell
npm run audit:sites -- audit-results/run-2 "Profile 1" "hashim" "mis"
npm run audit:sites -- audit-results/run-1 --resume
```

`--resume` skips pages that already have both saved text and a screenshot. An
`ok` line means capture completed; inspect the text to check that the website
actually returned measurements. Screenshot timeouts use a viewport fallback.
BrowserScan uses a viewport screenshot because its full-page capture can stall.
For a shorter audit, add `--sites=creepjs,browserscan,bl-webgl,bl-client-hints`.

`npm start` goes through `scripts/start.js`, which clears `ELECTRON_RUN_AS_NODE`.
VS Code leaks that variable into its terminals, and it stops Electron from starting.

The manager runs the newest installed build (`C:\src\browser\latest.txt`; pick
another in **Settings**, or set `BM_BROWSER`). A stock Google Chrome won't work:
it ignores the fingerprint.

## Edit fingerprint choices

Stop a profile, click **Edit**, and choose its settings under **Fingerprint**.
The same editor is available for new profiles. Opening or cancelling the editor
does not modify a profile. Saving validates the choices and preserves the profile
ID, cookies/storage, proxy and existing noise seed. Custom choices are applied
after host alignment so launches do not replace a chosen GPU, CPU/RAM or screen.

| Control | Available choices |
|---|---|
| WebGL metadata | Real GPU, or custom vendor; choosing a vendor fills a matching renderer automatically (NVIDIA defaults to GT 710), with 88 presets and editable strings |
| WebGPU | Real adapter, metadata based on WebGL vendor/device, explicit custom metadata, or no adapter |
| CPU / RAM | Real reported hardware, or custom thread count / 2, 4, 8, 16, 32 GB |
| Screen | Real display, predefined size, custom dimensions, or pick a random size once and save it |
| Fonts | Real installed fonts, stable per-profile subset, or an additional-font allowlist alongside Windows defaults |
| Hardware noise | Independent Canvas, WebGL image, AudioContext, ClientRects and speech-voice subset switches |
| WebRTC | Protect direct UDP with a proxy, always block direct UDP, unrestricted, or block connection creation |
| Timezone | Based on proxy IP, real system timezone, or a custom IANA timezone |
| Location | Based on proxy IP, real, custom coordinates, or Block; Ask or Always allow permission |
| Browser / display language | Based on IP/browser language, real system language, or custom locale |
| Do Not Track / acceleration | Default, On, Off |

Separate native controls require the rebuilt browser with a
`fingerprint-capabilities.json` beside its executable. The manager refuses to
launch edited profiles with older builds that would ignore these controls. The
normal installer produces this manifest and selects the new build automatically.
Profiles already running continue using their original executable until stopped.

The editor catalogue has 30 NVIDIA, 25 AMD, 20 Intel, 12 Apple and one Microsoft
renderer preset, plus the measured host renderer when it is not already listed.
These are curated strings from the bundled fingerprint-generator dataset;
the existing defaults are retained. Microsoft has one matching Direct3D11
entry in that dataset. Apple presets use Metal renderer strings.
Saved renderer strings remain unchanged when the editor is reopened.

Custom GPU metadata changes the names exposed by WebGL and WebGPU, including
worker queries and `GPUDevice.adapterInfo`. It does not emulate another physical
GPU's rendering, features, limits or performance. Based on WebGL infers the vendor
and device identifier; model-specific architecture stays empty unless supplied
through Custom metadata. WebGPU Disabled makes `requestAdapter()` return null;
the JavaScript API can still exist. WebRTC Disabled blocks new peer connections;
the constructor remains visible and throws `NotAllowedError`.

Configured coordinates are synthetic: they still respect site Ask/Block/Allow,
but do not query the system's location provider or require Windows location
permission. Real location continues to respect the system's location permissions.

ClientRects adds a tiny stable offset to layout-generated floating-point DOMRect
positions; it keeps width/height and explicit JavaScript DOMRect construction
unchanged. Speech protection filters the real voice list instead of inventing
voices. All noise uses the stored seed; disabling a switch does not discard it.
Windows default fonts are always retained, and an allowlist cannot install fonts.

Proxy UDP/forwarding/replacing WebRTC IPs, custom media-device counts, port-scan
filtering and per-profile TLS-feature controls are not implemented. They are
identified in the editor rather than presented as working switches.

## Layout

```
src/main/main.js            Electron main process + IPC handlers
src/main/store.js           settings + profiles on disk
src/main/fingerprints.js    fingerprint-generator wrapper, version/brand alignment, native config
src/main/host-hardware.js   local browser measurement of the actual OS, GPU and display scale
src/main/profile-compatibility.js  align identities with host hardware; back up changed metadata
src/main/launch-config.js   per-launch config: languages, timezone, geolocation, noise seed
src/main/languages.js       country -> browser languages ("auto" language)
src/main/proxy-geo.js       proxy check: exit IP, country, city, timezone (through the proxy)
src/main/chrome-profile.js  Chromium prefs: name/color, languages, WebRTC policy
src/main/launcher.js        start/stop browsers, proxy relay, graceful stop
src/preload.js              window.api bridge for the renderer
src/renderer/               UI (plain HTML/CSS/JS)
scripts/                    start + tests
chromium/patches/           our Chromium patches (on top of tag 154.0.8037.98)
chromium/scripts/           download / build / progress scripts for C:\src\chromium
```

Profile data lives in `%APPDATA%\browser-manager\data\` (outside OneDrive on purpose).
Set `BM_DATA_DIR` to put it somewhere else.

## What a profile controls

| What websites can see | Source |
|---|---|
| User-Agent, client hints, brand list (`Google Chrome`) | fingerprint, aligned to the real browser version |
| `navigator.platform`, CPU cores, memory (pages and workers) | fingerprint |
| `screen.*`, CSS `device-width/height` | fingerprint |
| WebGL vendor/renderer | real GPU by default, or the explicit custom editor choice |
| WebGPU metadata | real adapter by default, or the explicit custom/based-on-WebGL choice |
| Pixel ratio and color depth | measured host display; saved fingerprint matches the real values |
| Canvas, WebGL pixels, audio | real output + per-profile noise (stable per profile and site) |
| Installed fonts | Windows default fonts always; other fonts: a per-profile half |
| IP address | proxy (`host:port:user:pass`, `http://…`, `socks5://…`) |
| Timezone | proxy location |
| Geolocation (after the user allows it) | ~0.3-2 km from the proxy location |
| Languages (`navigator.languages`, `Accept-Language`, `Intl`) | proxy country with "auto" (Italy: `it-IT, it, en-US, en`), or a fixed locale |
| WebRTC | limited to the proxy when one is set (no real-IP leak) |

Without a proxy, timezone, geolocation and languages stay real, which matches the
real IP. Every launch checks the proxy first (ip-api.com, through the proxy), so a
dead proxy or wrong password is reported before the browser opens.

The window title starts with the profile name (`[lobby] Page - Chromium`), the
browser frame uses the profile color, and each profile has its own taskbar button
with a badge in its color.

## The patched Chromium

All browser-side values come from `--fingerprint-data=<base64 JSON>` (schema in
`third_party/blink/public/common/fingerprint/fingerprint_config.h`), which the
browser copies to every child process.

The build also sets `disable_fieldtrial_testing_config = true`: unofficial builds
otherwise switch on ~1100 Google experiments that stable Chrome doesn't run (one of
them reduced `navigator.languages` to a single entry).

### Rebuilding

```powershell
cd C:\src\chromium\src
git apply <project>\chromium\patches\0001-fingerprint-and-profile-label.patch   # on a fresh checkout
powershell -File <project>\chromium\scripts\build-chromium.ps1
```

`build-chromium.ps1` ends by running `install-browser.ps1`, which copies the
browser's runtime files (~460 MB) to `C:\src\browser\<version>-<time>\` and points
`latest.txt` at it. Open profiles keep running from their copy, so rebuilding
never needs them closed; new launches use the new copy. The 3 newest installs are
kept, plus any still in use.

### Known limits

- Only the host OS is offered (Windows on this PC): native fonts, emoji,
  scrollbars and speech voices must match the claimed OS. Existing profiles are
  aligned at launch, with originals in `data/compatibility-backups/`. Profile IDs,
  browser storage, proxies and noise seeds are preserved by compatibility alignment.
- GPU and display measurements come from a temporary browser without a fingerprint
  on a local page; the manager caches them per browser path and refreshes after
  display changes. This probe uses CDP only during measurement; profile launches
  still apply their config natively and do not expose a debugging port.
- WebGL parameters/extensions and WebGPU features/limits remain real. GPU
  metadata defaults to real values and can be explicitly customized in Edit.
  Shared real GPU names are common among browsers using the same hardware.
  Custom WebGL queries still perform the native GPU query before returning the
  chosen string; host-backed names use the native result directly.
- Per-profile canvas noise is retained and can be detected by tests that draw
  known colors and compare the returned pixels. Stable fingerprints do not imply
  invisible privacy protection; host compatibility does not remove CreepJS's canvas warning.
- The browser's own menus say "Chromium" (not visible to websites).
