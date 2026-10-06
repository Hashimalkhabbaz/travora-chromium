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
npm run audit:sites -- audit-results/run-1  # compare all saved profiles with clean stock Chrome
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

`npm start` goes through `scripts/start.js`, which clears `ELECTRON_RUN_AS_NODE`.
VS Code leaks that variable into its terminals, and it stops Electron from starting.

The manager runs the newest installed build (`C:\src\browser\latest.txt`; pick
another in **Settings**, or set `BM_BROWSER`). A stock Google Chrome won't work:
it ignores the fingerprint.

## Layout

```
src/main/main.js            Electron main process + IPC handlers
src/main/store.js           settings + profiles on disk
src/main/fingerprints.js    fingerprint-generator wrapper, version/brand alignment, native config
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
| WebGL vendor/renderer | fingerprint |
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
powershell -File C:\src\build-chromium.ps1     # minutes after the first build
```

`build-chromium.ps1` ends by running `install-browser.ps1`, which copies the
browser's runtime files (~460 MB) to `C:\src\browser\<version>-<time>\` and points
`latest.txt` at it. Open profiles keep running from their copy, so rebuilding
never needs them closed; new launches use the new copy. The 3 newest installs are
kept, plus any still in use.

### Known limits

- Use **Windows** fingerprints on this PC (the default). macOS/Linux are offered
  as "not recommended": fonts, emoji, scrollbars and WebGL details reveal Windows.
- `devicePixelRatio` is real; WebGL parameters/extensions and WebGPU adapter info are real.
- The browser's own menus say "Chromium" (not visible to websites).
