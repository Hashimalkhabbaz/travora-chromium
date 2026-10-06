const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateFingerprint, alignToEngineVersion, alignToHostHardware } = require('./fingerprints');
const { settingsFor, applyChoices } = require('./fingerprint-settings');

// Apply compatibility at creation and again at launch (display/GPU may change).
// Existing session storage and the per-profile noise seed are preserved.
function compatibleFingerprint(profile, hardware, version) {
  const current = profile.fingerprint;
  let fingerprint;
  if (profile.os !== hardware.os || current.fingerprint.navigator.userAgentData?.platform !== hardware.hints.platform) {
    fingerprint = generateFingerprint({ os: hardware.os, locale: profile.locale === 'auto' || profile.locale === 'real' ? 'en-US' : profile.locale, engineVersion: version, hardware });
    // Keep the chosen screen dimensions and CPU/memory identity when changing OS.
    for (const key of ['width', 'height', 'availWidth', 'availHeight']) fingerprint.fingerprint.screen[key] = current.fingerprint.screen[key];
    for (const key of ['hardwareConcurrency', 'deviceMemory']) fingerprint.fingerprint.navigator[key] = current.fingerprint.navigator[key];
  } else {
    fingerprint = structuredClone(current);
    if (version) alignToEngineVersion(fingerprint, version);
    alignToHostHardware(fingerprint, hardware);
  }
  return profile.fingerprintSettings ? applyChoices(fingerprint, settingsFor(profile), hardware) : fingerprint;
}

function alignStoredProfile(store, profile, hardware, version) {
  const fingerprint = compatibleFingerprint(profile, hardware, version);
  if (profile.os === hardware.os && JSON.stringify(profile.fingerprint) === JSON.stringify(fingerprint)) return profile;
  const backupDir = path.join(store.root, 'compatibility-backups', profile.id);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(profile, null, 2), { flag: 'wx' });
  return store.updateProfile(profile.id, { os: hardware.os, fingerprint });
}

module.exports = { compatibleFingerprint, alignStoredProfile };
