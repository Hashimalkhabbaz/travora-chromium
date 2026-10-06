const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * File-based storage for settings and browser profiles.
 *
 *   <root>/settings.json
 *   <root>/profiles/<id>/profile.json     profile metadata + fingerprint
 *   <root>/profiles/<id>/fingerprint.json the generated fingerprint (for reference)
 *   <root>/profiles/<id>/browser-data/    Chromium --user-data-dir
 *
 * The root lives in Electron's userData dir (outside OneDrive) so cloud sync
 * never touches locked browser files.
 */
class Store {
  constructor(root) {
    this.root = root;
    this.profilesDir = path.join(root, 'profiles');
    fs.mkdirSync(this.profilesDir, { recursive: true });
  }

  // ---------- settings ----------

  get settingsFile() {
    return path.join(this.root, 'settings.json');
  }

  getSettings() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {}
    // Follow the newest installed build unless a custom browser was chosen.
    // A stock Google Chrome (saved by an early version with a JS-injection
    // mode) is replaced too: only our patched Chromium applies fingerprints.
    if (!saved.browserPath || isManagedBuild(saved.browserPath) || isStockChrome(saved.browserPath)) {
      saved.browserPath = defaultBrowserPath();
    }
    return { browserPath: saved.browserPath };
  }

  saveSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    writeJson(this.settingsFile, next);
    return next;
  }

  // ---------- profiles ----------

  profileDir(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(`Invalid profile id: ${id}`);
    return path.join(this.profilesDir, id);
  }

  userDataDir(id) {
    return path.join(this.profileDir(id), 'browser-data');
  }

  fingerprintFile(id) {
    return path.join(this.profileDir(id), 'fingerprint.json');
  }

  listProfiles() {
    return fs
      .readdirSync(this.profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.getProfile(d.name))
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getProfile(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.profileDir(id), 'profile.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  createProfile({ name, os, locale, proxy, color, noiseSeed, fingerprint }) {
    const now = new Date().toISOString();
    const profile = {
      id: crypto.randomUUID(),
      name: name || 'Untitled profile',
      os,
      locale,
      proxy: proxy || '',
      color,
      noiseSeed,
      fingerprint,
      createdAt: now,
      updatedAt: now,
    };
    this._write(profile);
    return profile;
  }

  updateProfile(id, patch) {
    const current = this.getProfile(id);
    if (!current) throw new Error(`Profile not found: ${id}`);
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    this._write(next);
    return next;
  }

  deleteProfile(id) {
    fs.rmSync(this.profileDir(id), { recursive: true, force: true });
  }

  _write(profile) {
    fs.mkdirSync(this.userDataDir(profile.id), { recursive: true });
    writeJson(path.join(this.profileDir(profile.id), 'profile.json'), profile);
    writeJson(this.fingerprintFile(profile.id), profile.fingerprint);
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// build-chromium.ps1 builds into out\Release, then install-browser.ps1 copies
// each build into C:\src\browser\<version>-<time>\ and records the newest in
// latest.txt. Browsers run from those copies, so a rebuild never touches
// files that open profiles are using.
const BUILD_OUTPUT_PATH = 'C:\\src\\chromium\\src\\out\\Release\\chrome.exe';
const INSTALL_ROOT = 'C:\\src\\browser';

function defaultBrowserPath() {
  if (process.env.BM_BROWSER) return process.env.BM_BROWSER;
  try {
    const latest = fs.readFileSync(path.join(INSTALL_ROOT, 'latest.txt'), 'utf8').trim();
    if (latest && fs.existsSync(latest)) return latest;
  } catch {}
  return BUILD_OUTPUT_PATH;
}

// Paths that mean "our build" rather than a deliberate custom choice.
function isManagedBuild(browserPath) {
  const p = path.resolve(browserPath).toLowerCase();
  return p === BUILD_OUTPUT_PATH.toLowerCase() || p.startsWith(INSTALL_ROOT.toLowerCase() + path.sep);
}

function isStockChrome(browserPath) {
  return /[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/i.test(browserPath);
}

module.exports = { Store };
