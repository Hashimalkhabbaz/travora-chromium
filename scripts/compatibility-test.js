// Regression checks for preserving sessions/identity during compatibility migration.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { generateFingerprint, toNativeConfig } = require('../src/main/fingerprints');
const { HOST_OS } = require('../src/main/host-hardware');
const { alignStoredProfile } = require('../src/main/profile-compatibility');

const platform = { windows: ['Windows', 'Win32'], macos: ['macOS', 'MacIntel'], linux: ['Linux', 'Linux x86_64'] }[HOST_OS];
const hardware = {
  os: HOST_OS, platform: platform[1],
  hints: { platform: platform[0], platformVersion: '19.0.0', architecture: 'x86', bitness: '64' },
  webgl: { vendor: 'Measured vendor', renderer: 'Measured renderer' },
  devicePixelRatio: 1.5, screen: { colorDepth: 24, pixelDepth: 24 },
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-compatibility-test-'));
try {
  const store = new Store(root);
  const fingerprint = generateFingerprint({ os: HOST_OS, engineVersion: '154.0.8037.98' });
  fingerprint.fingerprint.navigator.userAgentData.platform = 'Other OS';
  fingerprint.fingerprint.screen.devicePixelRatio = 2;
  const original = store.createProfile({ name: 'Keep this identity', os: 'other-os', locale: 'auto', proxy: 'example.invalid:8080', color: '#abcdef', noiseSeed: '1234567890abcdef', fingerprint });
  const cookieMarker = path.join(store.userDataDir(original.id), 'session-marker');
  fs.writeFileSync(cookieMarker, 'existing session');
  const updated = alignStoredProfile(store, original, hardware, '154.0.8037.98');
  for (const key of ['id', 'name', 'createdAt', 'proxy', 'locale', 'color', 'noiseSeed']) assert.equal(updated[key], original[key], key + ' must be preserved');
  assert.equal(fs.readFileSync(cookieMarker, 'utf8'), 'existing session');
  assert.equal(updated.os, HOST_OS);
  assert.equal(updated.fingerprint.fingerprint.navigator.userAgentData.platform, platform[0]);
  for (const key of ['width', 'height', 'availWidth', 'availHeight']) assert.equal(updated.fingerprint.fingerprint.screen[key], original.fingerprint.fingerprint.screen[key]);
  for (const key of ['hardwareConcurrency', 'deviceMemory']) assert.equal(updated.fingerprint.fingerprint.navigator[key], original.fingerprint.fingerprint.navigator[key]);
  assert.equal(updated.fingerprint.fingerprint.screen.devicePixelRatio, 1.5);
  const native = toNativeConfig(updated.fingerprint);
  assert.equal(native.webgl, undefined, 'Host-backed GPU identity must use native GPU queries');
  assert.equal(native.screen.colorDepth, 24);
  const backups = path.join(root, 'compatibility-backups', original.id);
  assert.equal(fs.readdirSync(backups).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0]), 'utf8')), original);
  const same = alignStoredProfile(store, updated, hardware, '154.0.8037.98');
  assert.strictEqual(same, updated, 'Alignment must be idempotent');
  assert.equal(fs.readdirSync(backups).length, 1, 'No redundant backups on every launch');
  const generated = generateFingerprint({ hardware, engineVersion: '154.0.8037.98' });
  assert.deepEqual(generated.fingerprint.videoCard, hardware.webgl);
  assert.equal(generated.fingerprint.screen.devicePixelRatio, 1.5);
  assert.equal(toNativeConfig(generated).webgl, undefined);
  // A stale native-rendering marker must not silently apply to another GPU.
  const changedGpu = structuredClone(generated);
  changedGpu.fingerprint.videoCard.renderer = 'Different GPU';
  assert.equal(toNativeConfig(changedGpu).webgl.renderer, 'Different GPU');
  assert.throws(() => generateFingerprint({ os: 'other-os' }), /does not match the host OS/);
  console.log('PASS: migration preserves identity/session/proxy/noise, backs up original metadata, aligns host values, and is idempotent; new profiles reject foreign OS identities.');
} finally {
  // root is an absolute mkdtemp directory owned by this test.
  fs.rmSync(root, { recursive: true, force: true });
}
