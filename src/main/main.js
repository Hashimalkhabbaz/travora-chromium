const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const { Store } = require('./store');
const { Launcher, detectBrowserVersion, parseProxy } = require('./launcher');
const { generateFingerprint, summarize, OS_OPTIONS } = require('./fingerprints');
const { getHostHardware, HOST_OS } = require('./host-hardware');
const { alignStoredProfile, compatibleFingerprint } = require('./profile-compatibility');
const { settingsFor, validateSettings, hasNoise } = require('./fingerprint-settings');
const { buildLaunchConfig, newNoiseSeed } = require('./launch-config');
const { applyProfileSettings, pickColor, PALETTE } = require('./chrome-profile');
const { lookupProxyGeo } = require('./proxy-geo');

let mainWindow;
let store;
const launcher = new Launcher();

const versionCache = new Map(); // browserPath -> version
let hardwareNeedsRefresh = false;
async function browserHardware() {
  const refresh = hardwareNeedsRefresh;
  hardwareNeedsRefresh = false;
  return getHostHardware(store.getSettings().browserPath, { refresh });
}
function browserVersion() {
  const { browserPath } = store.getSettings();
  if (!versionCache.has(browserPath)) versionCache.set(browserPath, detectBrowserVersion(browserPath));
  return versionCache.get(browserPath);
}

function toView(profile) {
  return {
    id: profile.id,
    name: profile.name,
    os: profile.os,
    locale: profile.locale,
    proxy: profile.proxy,
    proxyHost: proxyHost(profile.proxy),
    proxyGeo: profile.proxy && profile.proxyGeo?.proxy === profile.proxy ? profile.proxyGeo : null,
    color: profileColor(profile),
    createdAt: profile.createdAt,
    running: launcher.isRunning(profile.id),
    summary: summarize(profile.fingerprint),
  };
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

// Profiles created before colors existed get a stable color derived from their id.
function profileColor(profile) {
  return profile.color || pickColor(parseInt(profile.id.slice(0, 8), 16));
}

// The window must fit inside both the fake screen (a window larger than the
// screen it claims to be on is a giveaway) and the real one.
function windowSizeFor(profile) {
  const fake = profile.fingerprint.fingerprint.screen;
  const real = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(fake.availWidth || fake.width, real.width),
    height: Math.min(fake.availHeight || fake.height, real.height),
  };
}

function validateColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) throw new Error(`Invalid color: ${color}`);
  return color.toLowerCase();
}

function proxyHost(proxy) {
  try {
    return proxy ? new URL(parseProxy(proxy).server).host : '';
  } catch {
    return 'invalid';
  }
}

// 'auto' (follow the proxy's country) or a locale like 'it-IT' / 'en'.
function validateLanguage(language) {
  const value = (language || 'auto').trim();
  if (value === 'auto' || value === 'real') return value;
  try { if (Intl.getCanonicalLocales(value).length === 1) return Intl.getCanonicalLocales(value)[0]; } catch {}
  throw new Error(`Invalid language: ${language} (use "auto" or e.g. it-IT)`);
}

function validateProxy(proxy) {
  if (!proxy) return '';
  parseProxy(proxy); // throws on malformed input
  return proxy.trim();
}

function registerIpc() {
  ipcMain.handle('profiles:editData', async (_e, id) => {
    const hardware = await browserHardware();
    const profile = id ? store.getProfile(id) : { fingerprint: generateFingerprint({ hardware, engineVersion: browserVersion() }), noiseSeed: 'preview' };
    if (!profile) throw new Error('Profile not found');
    return { settings: settingsFor(profile), hardware };
  });
  ipcMain.handle('app:init', () => ({
    settings: store.getSettings(),
    browserVersion: browserVersion(),
    osOptions: OS_OPTIONS,
    palette: PALETTE,
    profiles: store.listProfiles().map(toView),
  }));

  ipcMain.handle('settings:save', (_e, patch) => {
    const allowed = {};
    if (typeof patch.browserPath === 'string') allowed.browserPath = patch.browserPath.trim();
    const settings = store.saveSettings(allowed);
    return { settings, browserVersion: browserVersion() };
  });

  ipcMain.handle('settings:browse', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select browser executable',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('profiles:create', async (_e, { name, os, locale, proxy, color, fingerprintSettings }) => {
    const language = validateLanguage(locale);
    const hardware = await browserHardware();
    const fingerprint = generateFingerprint({
      os,
      locale: language === 'auto' || language === 'real' ? app.getLocale() : language,
      engineVersion: browserVersion(),
      hardware,
    });
    const draft = {
      name,
      os,
      locale: language,
      proxy: validateProxy(proxy),
      color: color ? validateColor(color) : pickColor(store.listProfiles().length),
      noiseSeed: newNoiseSeed(),
      fingerprint,
    };
    if (fingerprintSettings) {
      draft.fingerprintSettings = validateSettings(fingerprintSettings, draft);
      draft.fingerprint = compatibleFingerprint(draft, hardware, browserVersion());
    }
    const profile = store.createProfile(draft);
    return toView(profile);
  });

  ipcMain.handle('profiles:update', async (_e, { id, name, proxy, color, locale, fingerprintSettings }) => {
    const current = store.getProfile(id);
    if (!current) throw new Error('Profile not found');
    if (launcher.isRunning(id)) throw new Error('Stop the browser before editing its settings');
    const nextProxy = validateProxy(proxy);
    const patch = { name, proxy: nextProxy, color: validateColor(color), locale: validateLanguage(locale) };
    if (current && current.proxy !== nextProxy) patch.proxyGeo = null; // location must be re-checked
    if (fingerprintSettings) {
      patch.fingerprintSettings = validateSettings(fingerprintSettings, current);
      const hardware = await browserHardware();
      patch.fingerprint = compatibleFingerprint({ ...current, ...patch }, hardware, browserVersion());
      patch.os = HOST_OS;
      if (hasNoise(patch.fingerprintSettings) && !current.noiseSeed) patch.noiseSeed = newNoiseSeed();
    }
    return toView(store.updateProfile(id, patch));
  });

  ipcMain.handle('profiles:regenerate', async (_e, id) => {
    if (launcher.isRunning(id)) throw new Error('Stop the browser before regenerating its fingerprint');
    const profile = store.getProfile(id);
    let fingerprint = generateFingerprint({
      os: HOST_OS,
      locale: profile.locale === 'auto' || profile.locale === 'real' ? app.getLocale() : profile.locale,
      engineVersion: browserVersion(),
      hardware: await browserHardware(),
    });
    if (profile.fingerprintSettings) fingerprint = compatibleFingerprint({ ...profile, os: HOST_OS, fingerprint }, await browserHardware(), browserVersion());
    // A new identity also gets new canvas/audio/font noise.
    return toView(store.updateProfile(id, { os: HOST_OS, fingerprint, noiseSeed: newNoiseSeed() }));
  });

  ipcMain.handle('profiles:checkProxy', async (_e, id) => {
    const profile = store.getProfile(id);
    if (!profile?.proxy) throw new Error('This profile has no proxy');
    const proxyGeo = await lookupProxyGeo(profile.proxy);
    return toView(store.updateProfile(id, { proxyGeo }));
  });

  ipcMain.handle('profiles:delete', async (_e, id) => {
    await launcher.stop(id);
    store.deleteProfile(id);
  });

  ipcMain.handle('profiles:launch', async (_e, id) => {
    let profile = store.getProfile(id);
    if (!profile) throw new Error('Profile not found');
    if (launcher.isRunning(id)) throw new Error('Profile is already running');
    const settings = store.getSettings();
    profile = alignStoredProfile(store, profile, await browserHardware(), browserVersion());

    if (!profile.noiseSeed && hasNoise(settingsFor(profile))) profile = store.updateProfile(id, { noiseSeed: newNoiseSeed() });

    // With a proxy, websites see the proxy's location: timezone, geolocation and
    // (language "auto") languages follow it. Checked on every launch, which also
    // catches a dead proxy before the browser opens.
    if (profile.proxy) {
      profile = store.updateProfile(id, { proxyGeo: await lookupProxyGeo(profile.proxy) });
    }
    const config = buildLaunchConfig(profile, { systemLocale: app.getLocale() });
    const { nativeConfig, language, languages } = config;

    // Name/color shown inside the browser, languages, and WebRTC leak protection.
    applyProfileSettings(store.userDataDir(id), {
      name: profile.name,
      color: profileColor(profile),
      languages,
      proxied: Boolean(profile.proxy),
      webrtcPolicy: config.webrtcPolicy,
      locationPermission: config.locationPermission,
      doNotTrack: config.doNotTrack,
      acceleration: config.acceleration,
    });

    await launcher.launch(profile, {
      browserPath: settings.browserPath,
      userDataDir: store.userDataDir(id),
      nativeConfig,
      language,
      windowSize: windowSizeFor(profile),
      extraArgs: config.extraArgs,
    });
  });

  ipcMain.handle('profiles:stop', (_e, id) => launcher.stop(id));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    title: 'Browser Manager',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  store = new Store(process.env.BM_DATA_DIR || path.join(app.getPath('userData'), 'data'));

  launcher.on('started', (id) => send('profiles:status', { id, running: true }));
  launcher.on('stopped', (id) => send('profiles:status', { id, running: false }));
  launcher.on('error', (id, message) => send('profiles:error', { id, message }));

  registerIpc();
  screen.on('display-metrics-changed', () => { hardwareNeedsRefresh = true; });
  createWindow();
});

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting || launcher.runningIds().length === 0) return;
  event.preventDefault();
  quitting = true;
  await launcher.stopAll();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
