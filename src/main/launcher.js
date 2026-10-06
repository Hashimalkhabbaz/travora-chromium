const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');

/**
 * Starts and stops browser instances, one per profile.
 *
 * The browser is our patched Chromium, spawned directly with
 * --fingerprint-data=<base64 JSON>; the engine applies the fingerprint in C++
 * (no CDP, no injected JS).
 *
 * Proxies: an upstream proxy with credentials is fronted by a local relay
 * (proxy-chain) that adds the credentials, because Chromium's --proxy-server
 * cannot carry them.
 *
 * Emits: 'started' (id), 'stopped' (id), 'error' (id, message)
 */
class Launcher extends EventEmitter {
  constructor() {
    super();
    this.running = new Map(); // profileId -> { pid, onExit, stop }
  }

  isRunning(id) {
    return this.running.has(id);
  }

  runningIds() {
    return [...this.running.keys()];
  }

  /**
   * @param profile              stored profile (id, proxy, ...)
   * @param options.nativeConfig config for --fingerprint-data
   * @param options.language     --lang value (browser UI and Intl locale)
   * @param options.windowSize   { width, height } of the browser window
   * @param options.extraArgs    extra command-line switches (debugging/tests)
   */
  async launch(profile, { browserPath, userDataDir, nativeConfig, language, windowSize, extraArgs = [] }) {
    if (this.running.has(profile.id)) throw new Error('Profile is already running');
    if (!browserPath || !fs.existsSync(browserPath)) {
      throw new Error(`Browser executable not found: ${browserPath || '(not set)'}`);
    }

    const upstream = normalizeProxyUrl(profile.proxy);
    // Returns the URL unchanged when it has no credentials.
    const proxyUrl = upstream ? await anonymizeProxy({ url: upstream, port: 0 }) : null;
    const closeRelay = async () => {
      if (proxyUrl && proxyUrl !== upstream) await closeAnonymizedProxy(proxyUrl, true).catch(() => {});
    };

    const args = [
      `--user-data-dir=${userDataDir}`,
      `--fingerprint-data=${Buffer.from(JSON.stringify(nativeConfig)).toString('base64')}`,
      `--lang=${language}`,
      `--window-size=${windowSize.width},${windowSize.height}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
    args.push(...extraArgs);

    let child;
    try {
      child = spawn(browserPath, args, { stdio: 'ignore', env: browserEnv() });
    } catch (err) {
      await closeRelay();
      throw err;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    exited.then(async () => {
      await closeRelay();
      this._markStopped(profile.id);
    });
    child.on('error', (err) => {
      this.emit('error', profile.id, err.message);
      this._markStopped(profile.id);
    });

    this.running.set(profile.id, {
      pid: child.pid,
      stop: async () => {
        if (child.exitCode !== null) return;
        // Ask the browser to close its windows like a user would, so cookies,
        // session and prefs are saved; force-kill only if it does not exit.
        gracefulClose(child.pid);
        const timedOut = await Promise.race([exited.then(() => false), delay(10000).then(() => true)]);
        if (timedOut) {
          forceKill(child.pid);
          await exited;
        }
      },
    });
    this.emit('started', profile.id);
  }

  async stop(id) {
    const instance = this.running.get(id);
    if (instance) await instance.stop();
  }

  async stopAll() {
    await Promise.allSettled(this.runningIds().map((id) => this.stop(id)));
  }

  _markStopped(id) {
    if (this.running.delete(id)) this.emit('stopped', id);
  }
}

// Our Chromium build has no Google API keys (only Google's own Chrome builds
// do). "no" is Chromium's documented way to say so on purpose: it hides the
// "Google API keys are missing" bar; the affected features (browser sync,
// Safe Browsing, Translate, push) stay off either way.
function browserEnv() {
  return {
    ...process.env,
    GOOGLE_API_KEY: 'no',
    GOOGLE_DEFAULT_CLIENT_ID: 'no',
    GOOGLE_DEFAULT_CLIENT_SECRET: 'no',
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gracefulClose(pid) {
  if (process.platform === 'win32') {
    // Without /F, taskkill sends WM_CLOSE to the process' windows.
    spawn('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

function forceKill(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

/**
 * Accepted proxy formats -> URL string:
 *   http://user:pass@host:port, socks5://user:pass@host:port   (kept as is)
 *   host:port                                                  -> http://host:port
 *   host:port:user:pass   (common provider export format)      -> http://user:pass@host:port
 */
function normalizeProxyUrl(value) {
  const text = (value || '').trim();
  if (!text) return null;
  if (text.includes('://')) return text;
  const parts = text.split(':');
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(':'))}@${host}:${port}`;
  }
  return `http://${text}`;
}

/** Any format accepted by normalizeProxyUrl -> { server, username, password }; throws if malformed. */
function parseProxy(value) {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (!url.hostname || !url.port) throw new Error(`Proxy needs a host and port: ${value}`);
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

/**
 * Best-effort full version of a Chromium/Chrome executable, e.g. "154.0.8037.98".
 * The executable's own version resource is authoritative: installed Chrome
 * keeps versioned folders next to chrome.exe, but a downloaded update
 * (new_chrome.exe + a newer folder) only takes effect after a restart.
 * The folder listing is only a fallback.
 */
function detectBrowserVersion(browserPath) {
  if (!browserPath || !fs.existsSync(browserPath)) return null;
  const versionRe = /^\d+\.\d+\.\d+\.\d+$/;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${browserPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
        { encoding: 'utf8', timeout: 10000 }
      ).trim();
      if (versionRe.test(out)) return out;
    } catch {}
  }
  try {
    const dirs = fs
      .readdirSync(path.dirname(browserPath), { withFileTypes: true })
      .filter((d) => d.isDirectory() && versionRe.test(d.name))
      .map((d) => d.name)
      .sort(compareVersions);
    if (dirs.length) return dirs[dirs.length - 1];
  } catch {}
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

module.exports = { Launcher, parseProxy, normalizeProxyUrl, detectBrowserVersion };
