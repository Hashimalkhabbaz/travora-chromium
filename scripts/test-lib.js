// Shared helpers for the test scripts: create a throwaway profile, launch it
// exactly like the app does, and attach over CDP to read page values.
// (--remote-debugging-port is test-only; real launches don't expose CDP.)
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { Store } = require('../src/main/store');
const { Launcher, detectBrowserVersion } = require('../src/main/launcher');
const { generateFingerprint } = require('../src/main/fingerprints');
const { applyProfileSettings } = require('../src/main/chrome-profile');
const { lookupProxyGeo } = require('../src/main/proxy-geo');
const { buildLaunchConfig, newNoiseSeed } = require('../src/main/launch-config');

let nextPort = 9333;

/**
 * @param options.proxy      proxy string or ''
 * @param options.noiseSeed  hex seed, or null to disable noise
 * @param options.fingerprint reuse a fingerprint (to compare only noise)
 */
async function launchTestProfile({ proxy = '', noiseSeed = newNoiseSeed(), fingerprint, locale = 'auto', os: fpOs = 'windows' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-test-'));
  const store = new Store(root);
  const { browserPath } = store.getSettings();
  const version = detectBrowserVersion(browserPath);
  fingerprint ??= generateFingerprint({ os: fpOs, locale: 'en-US', engineVersion: version });

  let profile = store.createProfile({ name: 'test', os: fpOs, locale, proxy, color: '#1a73e8', noiseSeed, fingerprint });
  if (proxy) profile = store.updateProfile(profile.id, { proxyGeo: await lookupProxyGeo(proxy) });
  const config = buildLaunchConfig(profile, { systemLocale: 'en-US' });
  if (!noiseSeed) delete config.nativeConfig.noiseSeed;

  applyProfileSettings(store.userDataDir(profile.id), {
    name: profile.name,
    color: profile.color,
    languages: config.languages,
    proxied: Boolean(proxy),
  });

  const port = nextPort++;
  const launcher = new Launcher();
  await launcher.launch(profile, {
    browserPath,
    userDataDir: store.userDataDir(profile.id),
    nativeConfig: config.nativeConfig,
    language: config.language,
    windowSize: { width: 1200, height: 760 },
    extraArgs: [`--remote-debugging-port=${port}`],
  });

  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  if (!browser) throw new Error('Could not attach to the browser');

  return {
    profile,
    config,
    version,
    context: browser.contexts()[0],
    async close() {
      await browser.close().catch(() => {}); // disconnects CDP only
      await launcher.stopAll();
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function report(expected, seen) {
  let ok = true;
  for (const key of Object.keys(expected)) {
    const pass = JSON.stringify(seen[key]) === JSON.stringify(expected[key]);
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${key}: ${JSON.stringify(seen[key])}${pass ? '' : `\n        expected: ${JSON.stringify(expected[key])}`}`);
  }
  return ok;
}

module.exports = { launchTestProfile, report };
