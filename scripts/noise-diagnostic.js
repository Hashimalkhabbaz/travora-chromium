// Isolated control: compare existing noisy results with the same identity and
// proxy but no noise. Never change the saved profile or its browser-data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { auditProfile } = require('./site-audit');

(async () => {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/noise-diagnostic.js <outDir> --sites=creepjs,browserscan');
  const saved = new Store(process.env.BM_DATA_DIR || path.join(process.env.APPDATA, 'browser-manager', 'data'));
  const source = saved.listProfiles()[0];
  if (!source) throw new Error('No saved profile for the diagnostic control');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-noise-control-'));
  try {
    const control = new Store(root);
    control.saveSettings(saved.getSettings());
    const profile = control.createProfile({ ...source, name: 'noise-disabled-control', noiseSeed: null });
    console.log('Noise-disabled control uses temporary profile storage; saved profile noise is preserved.');
    await auditProfile(control, profile, output);
  } finally {
    // root is the absolute mkdtemp directory created by this diagnostic.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
