// Compare Real and Custom GPU choices using copied metadata and isolated storage.
// The saved profile and its open browser are never altered or stopped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');
const { settingsFor, validateSettings } = require('../src/main/fingerprint-settings');
const { auditProfile } = require('./site-audit');

(async () => {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/editor-site-audit.js <outputDir> --sites=browserscan,creepjs,bl-webgl');
  const saved = new Store(process.env.BM_DATA_DIR || path.join(process.env.APPDATA, 'browser-manager/data'));
  const source = saved.listProfiles()[0];
  if (!source) throw new Error('No saved profile to copy for site verification');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-editor-audit-'));
  try {
    const store = new Store(root); store.saveSettings(saved.getSettings());
    for (const mode of ['real', 'custom']) {
      const settings = settingsFor(source);
      settings.webgl.mode = mode;
      settings.webgpu.mode = mode === 'custom' ? 'webgl' : 'real';
      if (mode === 'custom') {
        settings.webgl.vendor = 'Google Inc. (NVIDIA)';
        settings.webgl.renderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)';
      }
      const profile = store.createProfile({ ...source, name: mode + '-gpu', fingerprintSettings: validateSettings(settings, source) });
      console.log(`Auditing ${mode} GPU choice in temporary profile storage; original profile and seed unchanged.`);
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try { await auditProfile(store, profile, path.join(output, mode + '-gpu')); done = true; }
        catch (err) { if (attempt || !err.message.startsWith('Proxy check failed:')) throw err; console.log('Retrying transient proxy check failure.'); }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
