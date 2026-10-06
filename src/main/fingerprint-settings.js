// Explicit choices from the profile editor. Defaults preserve existing profiles.
function settingsFor(profile) {
  const fp = profile.fingerprint.fingerprint;
  const saved = profile.fingerprintSettings || {};
  return {
    webgl: { mode: 'real', ...fp.videoCard, ...saved.webgl },
    webgpu: { mode: 'real', vendor: '', architecture: '', device: '', description: '', ...(typeof saved.webgpu === 'string' ? { mode: saved.webgpu } : saved.webgpu) },
    cpu: { mode: 'custom', value: fp.navigator.hardwareConcurrency, ...saved.cpu },
    memory: { mode: 'custom', value: fp.navigator.deviceMemory, ...saved.memory },
    screen: { mode: 'custom', width: fp.screen.width, height: fp.screen.height, availWidth: fp.screen.availWidth, availHeight: fp.screen.availHeight, ...saved.screen },
    timezone: { mode: 'proxy', value: '', ...saved.timezone },
    location: { mode: 'proxy', lat: 0, lon: 0, accuracy: 100, permission: 'ask', ...saved.location },
    noise: { canvas: profile.noiseSeed !== null, webgl: profile.noiseSeed !== null, audio: profile.noiseSeed !== null, clientRects: false, speechVoices: false, ...(typeof saved.noise === 'object' ? saved.noise : {}) },
    fonts: { mode: profile.noiseSeed === null ? 'real' : 'subset', allowed: [], ...saved.fonts },
    webrtc: saved.webrtc || 'auto',
    displayLanguage: { mode: 'language', value: 'en-US', ...saved.displayLanguage },
    doNotTrack: saved.doNotTrack || 'default',
    acceleration: saved.acceleration || 'default',
  };
}

function validateSettings(input, profile) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid fingerprint settings');
  const s = settingsFor({ ...profile, fingerprintSettings: input });
  const choice = (value, allowed, label) => { if (!allowed.includes(value)) throw new Error(`Invalid ${label}`); };
  const number = (value, min, max, label, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${label}`);
  };
  const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}`); };
  choice(s.webgl.mode, ['real', 'custom'], 'WebGL mode');
  if (s.webgl.mode === 'custom') { text(s.webgl.vendor, 'WebGL vendor'); text(s.webgl.renderer, 'WebGL renderer'); s.webgl.vendor = s.webgl.vendor.trim(); s.webgl.renderer = s.webgl.renderer.trim(); }
  choice(s.webgpu.mode, ['real', 'webgl', 'custom', 'disabled'], 'WebGPU mode');
  for (const key of ['vendor', 'architecture', 'device', 'description']) {
    if (typeof s.webgpu[key] !== 'string' || s.webgpu[key].length > 512 || /[\x00-\x1f]/.test(s.webgpu[key])) throw new Error('Invalid WebGPU ' + key);
  }
  if (s.webgpu.mode === 'webgl' && s.webgl.mode === 'custom' && !gpuMetadata(s.webgl).vendor) throw new Error('For this vendor, select Custom WebGPU and enter its metadata');
  choice(s.fonts.mode, ['real', 'subset', 'custom'], 'fonts mode');
  if (!Array.isArray(s.fonts.allowed) || s.fonts.allowed.length > 200) throw new Error('Invalid font allowlist');
  s.fonts.allowed = [...new Set(s.fonts.allowed.map(font => { text(font, 'font name'); return font.trim().toLowerCase(); }))];
  if (s.fonts.mode === 'custom' && !s.fonts.allowed.length) throw new Error('Choose at least one additional font for Custom fonts');
  choice(s.cpu.mode, ['real', 'custom'], 'CPU mode');
  number(s.cpu.value, 1, 128, 'CPU cores', true);
  choice(s.memory.mode, ['real', 'custom'], 'RAM mode');
  choice(s.memory.value, [2, 4, 8, 16, 32], 'RAM size');
  choice(s.screen.mode, ['real', 'custom'], 'screen mode');
  for (const key of ['width', 'height', 'availWidth', 'availHeight']) number(s.screen[key], 320, 16384, `screen ${key}`, true);
  if (s.screen.availWidth > s.screen.width || s.screen.availHeight > s.screen.height) throw new Error('Available screen cannot exceed screen resolution');
  choice(s.timezone.mode, ['proxy', 'real', 'custom'], 'timezone mode');
  if (s.timezone.mode === 'custom') {
    text(s.timezone.value, 'timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: s.timezone.value }).format(); } catch { throw new Error('Use a valid timezone, e.g. Europe/Rome'); }
  }
  choice(s.location.mode, ['proxy', 'real', 'custom', 'block'], 'location mode');
  choice(s.location.permission, ['ask', 'allow'], 'location permission');
  number(s.location.lat, -90, 90, 'latitude'); number(s.location.lon, -180, 180, 'longitude'); number(s.location.accuracy, 1, 100000, 'location accuracy');
  for (const key of ['canvas', 'webgl', 'audio', 'clientRects', 'speechVoices']) if (typeof s.noise[key] !== 'boolean') throw new Error('Invalid ' + key + ' noise');
  choice(s.webrtc, ['auto', 'real', 'block-udp', 'disabled'], 'WebRTC policy');
  choice(s.displayLanguage.mode, ['language', 'real', 'custom'], 'display language');
  if (s.displayLanguage.mode === 'custom') {
    try { s.displayLanguage.value = Intl.getCanonicalLocales(s.displayLanguage.value)[0]; if (!s.displayLanguage.value) throw new Error(); } catch { throw new Error('Invalid display language'); }
  }
  choice(s.doNotTrack, ['default', 'on', 'off'], 'Do Not Track');
  choice(s.acceleration, ['default', 'on', 'off'], 'hardware acceleration');
  return s;
}

// Apply after host compatibility, so explicit choices survive every launch.
function applyChoices(fingerprint, settings, hardware) {
  const fp = fingerprint.fingerprint;
  if (settings.webgl.mode === 'custom') {
    fp.videoCard = { vendor: settings.webgl.vendor, renderer: settings.webgl.renderer };
    delete fingerprint.nativeRendering;
  }
  fp.navigator.hardwareConcurrency = settings.cpu.mode === 'real' ? hardware.hardwareConcurrency : settings.cpu.value;
  fp.navigator.deviceMemory = settings.memory.mode === 'real' ? hardware.deviceMemory : settings.memory.value;
  const dimensions = settings.screen.mode === 'real' ? hardware.screen : settings.screen;
  for (const key of ['width', 'height', 'availWidth', 'availHeight']) fp.screen[key] = dimensions[key];
  return fingerprint;
}

function browserChoices(profile, systemLocale) {
  const s = settingsFor(profile);
  return {
    webrtcPolicy: s.webrtc === 'real' ? 'default' : s.webrtc === 'block-udp' || profile.proxy ? 'disable_non_proxied_udp' : 'default',
    locationPermission: profile.fingerprintSettings ? (s.location.mode === 'block' ? 2 : s.location.permission === 'allow' ? 1 : 3) : undefined,
    doNotTrack: profile.fingerprintSettings ? s.doNotTrack : undefined,
    acceleration: profile.fingerprintSettings ? s.acceleration : undefined,
    displayLanguage: s.displayLanguage.mode === 'real' ? systemLocale : s.displayLanguage.mode === 'custom' ? s.displayLanguage.value : null,
    extraArgs: [],
  };
}

// WebGPU's identifiers are separate from WebGL strings. A model-specific
// architecture is not inferred from the vendor: the user can enter it explicitly.
function gpuMetadata(webgl) {
  const vendor = ['nvidia', 'amd', 'intel', 'apple', 'microsoft'].find(v => webgl.vendor.toLowerCase().includes(v)) || '';
  const device = webgl.renderer.match(/\(0x([a-f0-9]+)\)/i)?.[1]?.toLowerCase() || '';
  return { vendor, architecture: '', device, description: '' };
}

function hasNoise(settings) { return Object.values(settings.noise).some(Boolean) || settings.fonts.mode === 'subset'; }

function assertNativeSettings(profile, browserPath) {
  if (!profile.fingerprintSettings) return;
  const fs = require('node:fs');
  const path = require('node:path');
  let capabilities;
  try { capabilities = JSON.parse(fs.readFileSync(path.join(path.dirname(browserPath), 'fingerprint-capabilities.json'), 'utf8')); } catch {}
  if (capabilities?.schema !== 2) throw new Error('This Chromium build does not support the fingerprint editor controls. Select the rebuilt browser in Settings.');
}

module.exports = { settingsFor, validateSettings, applyChoices, browserChoices, gpuMetadata, hasNoise, assertNativeSettings };
