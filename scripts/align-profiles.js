// Align saved identities with this host; original metadata is backed up first.
const path = require('path');
const { Store } = require('../src/main/store');
const { getHostHardware } = require('../src/main/host-hardware');
const { detectBrowserVersion } = require('../src/main/launcher');
const { alignStoredProfile } = require('../src/main/profile-compatibility');

(async () => {
  const store = new Store(process.env.BM_DATA_DIR || path.join(process.env.APPDATA, 'browser-manager', 'data'));
  const names = process.argv.slice(2);
  const profiles = store.listProfiles().filter(p => !names.length || names.includes(p.name));
  if (!profiles.length) throw new Error('No matching saved profiles');
  const browserPath = store.getSettings().browserPath;
  const hardware = await getHostHardware(browserPath);
  const version = detectBrowserVersion(browserPath);
  for (const current of profiles) {
    const next = alignStoredProfile(store, current, hardware, version);
    console.log(`${next.name}: ${next === current ? 'already compatible' : 'aligned'}; OS=${next.os}, DPR=${next.fingerprint.fingerprint.screen.devicePixelRatio}, GPU=${next.fingerprint.fingerprint.videoCard.renderer}`);
  }
  console.log(`Original metadata backups: ${path.join(store.root, 'compatibility-backups')}`);
})().catch(err => { console.error(err.message); process.exitCode = 1; });
