// Visit public fingerprint test sites with each saved profile (patched
// browser, launched exactly like the app does) and with the real machine
// (stock Google Chrome, clean temporary profile), saving each page's text and a
// screenshot for comparison.
//
//   node scripts/site-audit.js <outDir> [profileName ...] [--resume] [--sites=creepjs,browserscan,...]
//
// Pages are read through a bare CDP connection that never calls Runtime.enable
// or attaches during page load: the usual automation tools enable domains that
// BrowserScan/CreepJS detect, which would report the test tool instead of the
// browser.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../src/main/store');
const { Launcher, detectBrowserVersion } = require('../src/main/launcher');
const { getHostHardware } = require('../src/main/host-hardware');
const { alignStoredProfile } = require('../src/main/profile-compatibility');
const { lookupProxyGeo } = require('../src/main/proxy-geo');
const { buildLaunchConfig } = require('../src/main/launch-config');
const { applyProfileSettings } = require('../src/main/chrome-profile');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9555;
const RESUME = process.argv.includes('--resume');
const selectedSites = process.argv.find(arg => arg.startsWith('--sites='))?.slice('--sites='.length).split(',');

// [label, url, seconds to let the site finish its checks]
const PAGES = [
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/', 25],
  ['browserscan', 'https://www.browserscan.net/', 30],
  ['amiunique', 'https://amiunique.org/fingerprint', 30],
  ['bl-ip', 'https://browserleaks.com/ip', 12],
  ['bl-webrtc', 'https://browserleaks.com/webrtc', 15],
  ['bl-canvas', 'https://browserleaks.com/canvas', 12],
  ['bl-webgl', 'https://browserleaks.com/webgl', 12],
  ['bl-fonts', 'https://browserleaks.com/fonts', 20],
  ['bl-client-hints', 'https://browserleaks.com/client-hints', 10],
  ['bl-javascript', 'https://browserleaks.com/javascript', 12],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function waitForDebugger() {
  for (let i = 0; i < 100; i++) {
    try {
      return await http('GET', `http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(200);
    }
  }
  throw new Error('browser did not expose the debugging port');
}

// Minimal CDP session on one page target.
async function withPage(wsUrl, fn) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timed out')); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (err) => { clearTimeout(timer); reject(err); };
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const request = pending.get(msg.id);
      clearTimeout(request.timer);
      request.resolve(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP connection is not open'));
        return;
      }
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`${method} timed out after 20 seconds`));
      }, 20000);
      pending.set(msgId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  ws.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  };
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

async function visit(outDir, label, url, seconds) {
  // Opening the tab via the HTTP endpoint loads the page with nothing attached.
  const target = await http('PUT', `http://127.0.0.1:${PORT}/json/new?${encodeURI(url)}`);
  try {
    await sleep(seconds * 1000);
    await withPage(target.webSocketDebuggerUrl, async (send) => {
      const readText = () => send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : ""', returnByValue: true,
      });
      let text = await readText();
      // The layout's default score is not a measurement. Give slow API calls
      // a bounded extra wait, then clearly report incomplete results.
      if (label === 'browserscan') {
        const populated = () => /^\d+\.\d+\.\d+\.\d+$/m.test(text.result?.result?.value || '') && /Chrome \d/.test(text.result?.result?.value || '');
        for (let retry = 0; !populated() && retry < 3; retry++) {
          await sleep(10000);
          text = await readText();
        }
        if (!populated()) console.log('incomplete BrowserScan measurements (default score ignored)');
      }
      fs.writeFileSync(path.join(outDir, `${label}.txt`), text.result?.result?.value || `(no text: ${JSON.stringify(text.result || text.error)})`);
      // Window-based fallback captures need this page to be visible.
      await send('Page.bringToFront');
      let shot;
      try {
        // Full-page capture can stall on BrowserScan; use its viewport instead.
        shot = await send('Page.captureScreenshot', label === 'browserscan'
          ? { format: 'png', captureBeyondViewport: false, fromSurface: false }
          : { format: 'png', captureBeyondViewport: true });
        if (!shot.result?.data) throw new Error(JSON.stringify(shot.error || 'No screenshot data'));
      } catch (err) {
        console.log(`screenshot unavailable (${err.message}); capturing viewport`);
        shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false });
        if (!shot.result?.data) throw new Error(JSON.stringify(shot.error || 'No screenshot data'));
      }
      fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(shot.result.data, 'base64'));
    });
  } finally {
    await http('GET', `http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
  }
}

async function runPages(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [label, url, seconds] of PAGES) {
    if (selectedSites && !selectedSites.includes(label)) continue;
    if (RESUME && fs.existsSync(path.join(outDir, `${label}.txt`)) && fs.existsSync(path.join(outDir, `${label}.png`))) {
      console.log(`  ${label}... already saved`);
      continue;
    }
    process.stdout.write(`  ${label}... `);
    try {
      await visit(outDir, label, url, seconds);
      console.log('ok');
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }
}

async function auditRealMachine(outDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-'));
  const child = spawn(STOCK_CHROME, [
    `--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    await waitForDebugger();
    await runPages(outDir);
  } finally {
    spawn('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    await sleep(1000);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function auditProfile(store, profile, outDir) {
  // Same steps as the app's launch handler (src/main/main.js).
  const browserPath = store.getSettings().browserPath;
  const hardware = await getHostHardware(browserPath);
  profile = alignStoredProfile(store, profile, hardware, detectBrowserVersion(browserPath));
  if (profile.proxy) profile = store.updateProfile(profile.id, { proxyGeo: await lookupProxyGeo(profile.proxy) });
  const config = buildLaunchConfig(profile, { systemLocale: 'en-US' });
  const { nativeConfig, language, languages } = config;
  applyProfileSettings(store.userDataDir(profile.id), {
    name: profile.name,
    color: profile.color || '#1a73e8',
    languages,
    proxied: Boolean(profile.proxy),
    webrtcPolicy: config.webrtcPolicy,
    locationPermission: config.locationPermission,
    doNotTrack: config.doNotTrack,
    acceleration: config.acceleration,
  });
  const fake = profile.fingerprint.fingerprint.screen;
  const launcher = new Launcher();
  await launcher.launch(profile, {
    browserPath,
    userDataDir: store.userDataDir(profile.id),
    nativeConfig,
    language,
    windowSize: { width: Math.min(fake.availWidth, hardware.screen.availWidth), height: Math.min(fake.availHeight, hardware.screen.availHeight) },
    extraArgs: [...config.extraArgs, `--remote-debugging-port=${PORT}`],
  });
  try {
    await waitForDebugger();
    await runPages(outDir);
  } finally {
    await launcher.stopAll();
    await sleep(1000);
  }
}

async function main() {
  const outRoot = process.argv[2];
  const only = process.argv.slice(3).filter(arg => arg !== '--resume' && !arg.startsWith('--sites='));
  if (!outRoot) throw new Error('Usage: node scripts/site-audit.js <outDir> [profileName ...] [--resume]');
  if (selectedSites?.some(label => !PAGES.some(page => page[0] === label))) throw new Error('Unknown --sites label. Valid labels: ' + PAGES.map(page => page[0]).join(', '));
  const store = new Store(process.env.BM_DATA_DIR || path.join(process.env.APPDATA, 'browser-manager', 'data'));

  if (!only.length || only.includes('real')) {
    console.log('real machine (stock Chrome, clean profile)');
    await auditRealMachine(path.join(outRoot, 'real'));
  }
  for (const profile of store.listProfiles()) {
    if (only.length && !only.includes(profile.name)) continue;
    console.log(`profile "${profile.name}"`);
    await auditProfile(store, profile, path.join(outRoot, profile.name.replace(/[^\w-]+/g, '_')));
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { auditProfile };
