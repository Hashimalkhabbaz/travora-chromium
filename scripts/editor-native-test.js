// Verify the installed native engine, using only throwaway browser profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { generateFingerprint } = require('../src/main/fingerprints');
const { getHostHardware } = require('../src/main/host-hardware');
const { Store } = require('../src/main/store');
const { detectBrowserVersion } = require('../src/main/launcher');
const { settingsFor, validateSettings, assertNativeSettings } = require('../src/main/fingerprint-settings');
const { launchTestProfile } = require('./test-lib');

async function capture() {
  const sha = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#347ac2'; ctx.fillRect(0, 0, 128, 64); ctx.font = '18px Arial'; ctx.fillStyle = '#fff'; ctx.fillText('Profile pixels', 4, 32);
  const canvas = await sha(new TextEncoder().encode(c.toDataURL()));
  const repeated = await sha(new TextEncoder().encode(c.toDataURL()));
  const canvasPixels = await sha(ctx.getImageData(0, 0, 128, 64).data);
  const blob = await new Promise(resolve => c.toBlob(resolve));
  const canvasBlob = await sha(await blob.arrayBuffer());
  const offscreen = new OffscreenCanvas(128, 64), oc = offscreen.getContext('2d');
  oc.fillStyle = '#347ac2'; oc.fillRect(0, 0, 128, 64); oc.font = '18px Arial'; oc.fillStyle = '#fff'; oc.fillText('Profile pixels', 4, 32);
  const offscreenBlob = await sha(await (await offscreen.convertToBlob()).arrayBuffer());
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  const gl = gc.getContext('webgl', { preserveDrawingBuffer: true }); gl.clearColor(0.2, 0.4, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(64 * 64 * 4); gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const webglPixels = await sha(px), webglImage = await sha(new TextEncoder().encode(gc.toDataURL()));
  const gb = await new Promise(resolve => gc.toBlob(resolve)); const webglBlob = await sha(await gb.arrayBuffer());
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = { vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
  const ac = new OfflineAudioContext(1, 5000, 44100), osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000; osc.connect(ac.destination); osc.start();
  const samples = (await ac.startRendering()).getChannelData(0); const audio = await sha(samples.buffer);
  const rectEl = document.createElement('div'); rectEl.style.cssText = 'width:200px;height:50px'; document.body.append(rectEl);
  const rect = rectEl.getBoundingClientRect().toJSON(), rectAgain = rectEl.getBoundingClientRect().toJSON();
  const literalRect = new DOMRect(12, 20, 200, 70).toJSON();
  await new Promise(resolve => { const timeout = setTimeout(resolve, 1500); speechSynthesis.onvoiceschanged = () => { clearTimeout(timeout); resolve(); }; if (speechSynthesis.getVoices().length) { clearTimeout(timeout); resolve(); } });
  const voices = speechSynthesis.getVoices().map(v => v.name);
  const adapter = await navigator.gpu?.requestAdapter();
  const metadata = info => info ? Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(k => [k, info[k]])) : null;
  let deviceInfo = null;
  if (adapter) { const device = await adapter.requestDevice(); deviceInfo = metadata(device.adapterInfo); device.destroy(); }
  let rtc;
  try { const pc = new RTCPeerConnection(); pc.close(); rtc = 'allowed'; } catch (e) { rtc = e.name; }
  const locationPermission = (await navigator.permissions.query({ name: 'geolocation' })).state;
  const position = locationPermission === 'granted' ? await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }), reject, { timeout: 5000 })) : null;
  const fonts = ['Arial', 'Garamond', 'Rockwell', 'Arial Narrow', 'Book Antiqua', 'Century', 'Agency FB', 'Tw Cen MT'].filter(font => {
    const context = document.createElement('canvas').getContext('2d'); context.font = '40px monospace'; const base = context.measureText('mmmmmmlli10O').width; context.font = `40px "${font}", monospace`; return context.measureText('mmmmmmlli10O').width !== base;
  });
  const worker = await new Promise((resolve, reject) => {
    const code = `(${async function() {
      const gc = new OffscreenCanvas(64, 64), gl = gc.getContext('webgl'); const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const adapter = await navigator.gpu?.requestAdapter();
      const gpuInfo = adapter ? Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(k => [k, adapter.info[k]])) : null;
      const canvas = new OffscreenCanvas(128, 64), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#347ac2'; ctx.fillRect(0, 0, 128, 64); ctx.font = '18px Arial'; ctx.fillStyle = '#fff'; ctx.fillText('Profile pixels', 4, 32);
      const canvasBlob = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await canvas.convertToBlob()).arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      self.postMessage({ vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), gpuInfo, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, canvasBlob });
    }})().catch(e => self.postMessage({ error: String(e) }));`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), w = new Worker(url);
    const timeout = setTimeout(() => { w.terminate(); URL.revokeObjectURL(url); reject(new Error('Worker measurement timed out')); }, 10000);
    w.onmessage = e => { clearTimeout(timeout); w.terminate(); URL.revokeObjectURL(url); resolve(e.data); };
  });
  const headers = await (await fetch('/headers')).json();
  return { canvas, repeated, canvasPixels, canvasBlob, offscreenBlob, webglPixels, webglImage, webglBlob, audio, gpu, adapterInfo: metadata(adapter?.info), deviceInfo, rect, rectAgain, literalRect, voices, rtc, position, locationPermission, fonts, worker, headers, languages: [...navigator.languages], cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, screen: [screen.width, screen.height], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, dnt: navigator.doNotTrack };
}

(async () => {
  const store = new Store(path.join(process.env.APPDATA, 'browser-manager/data'));
  const browserPath = store.getSettings().browserPath;
  const hardware = await getHostHardware(browserPath), version = detectBrowserVersion(browserPath);
  const fingerprint = generateFingerprint({ hardware, engineVersion: version });
  const profile = { fingerprint, noiseSeed: '0123456789abcdef' };
  const base = settingsFor(profile); base.fonts.mode = 'real'; for (const key of Object.keys(base.noise)) base.noise[key] = false;
  assertNativeSettings({ fingerprintSettings: base }, browserPath);
  const cases = { real: structuredClone(base) };
  for (const key of ['canvas', 'webgl', 'audio']) { cases[key] = structuredClone(base); cases[key].noise[key] = true; }
  const custom = cases.custom = structuredClone(base);
  custom.webgl = { mode: 'custom', vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)' };
  custom.webgpu = { mode: 'custom', vendor: 'nvidia', architecture: 'ampere', device: '2484', description: 'NVIDIA GeForce RTX 3070' };
  custom.cpu.value = 8; custom.memory.value = 8; custom.screen = { mode: 'custom', width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
  custom.timezone = { mode: 'custom', value: 'Asia/Tokyo' }; custom.location = { mode: 'custom', lat: 35, lon: 139, accuracy: 50, permission: 'allow' };
  custom.noise.clientRects = custom.noise.speechVoices = true; custom.webrtc = 'disabled'; custom.doNotTrack = 'on';
  const disabled = cases.disabled = structuredClone(base); disabled.webgpu.mode = 'disabled'; disabled.location.mode = 'block'; disabled.fonts = { mode: 'custom', allowed: ['garamond'] };
  const server = http.createServer((req, res) => {
    if (req.url === '/headers') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ dnt: req.headers.dnt || null, language: req.headers['accept-language'] })); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Native editor test</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const results = {};
  try {
    for (const [label, settings] of Object.entries(cases)) {
      const run = await launchTestProfile({ fingerprint, noiseSeed: profile.noiseSeed, locale: label === 'custom' ? 'ja-JP' : 'auto', fingerprintSettings: validateSettings(settings, profile) });
      try {
        const page = await run.context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
        results[label] = await page.evaluate(capture); console.log('Measured ' + label);
      } finally { await run.close(); }
    }
  } finally { server.close(); }
  const out = path.resolve('audit-results/editor-verification'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'native-results.json'), JSON.stringify({ browserPath, version, results }, null, 2));
  const real = results.real;
  for (const [label, result] of Object.entries(results)) {
    assert.equal(result.canvas, result.repeated, label + ' repeated canvas');
    assert.deepEqual(result.rect, result.rectAgain, label + ' repeated rectangles');
    assert.equal(result.literalRect.x, 12); assert.equal(result.literalRect.y, 20);
    assert(!result.worker.error, result.worker.error);
    assert.equal(result.worker.vendor, result.gpu.vendor); assert.equal(result.worker.renderer, result.gpu.renderer);
    assert.deepEqual(result.worker.gpuInfo, result.adapterInfo);
    assert.equal(result.worker.cores, result.cores); assert.equal(result.worker.memory, result.memory);
    assert.equal(result.worker.canvasBlob, result.offscreenBlob, label + ' worker canvas must match the page');
  }
  for (const label of ['canvas', 'webgl', 'audio']) {
    for (const field of ['canvas', 'canvasPixels', 'canvasBlob', 'offscreenBlob', 'webglPixels', 'webglImage', 'webglBlob', 'audio']) {
      const affected = label === 'canvas' ? ['canvas', 'canvasPixels', 'canvasBlob', 'offscreenBlob'].includes(field) : label === 'webgl' ? field.startsWith('webgl') : field === 'audio';
      assert.equal(results[label][field] !== real[field], affected, label + ' must isolate ' + field);
    }
  }
  assert.equal(results.custom.gpu.renderer, custom.webgl.renderer);
  assert.deepEqual(results.custom.adapterInfo, { vendor: 'nvidia', architecture: 'ampere', device: '2484', description: 'NVIDIA GeForce RTX 3070' });
  assert.deepEqual(results.custom.deviceInfo, results.custom.adapterInfo);
  assert.equal(results.custom.cores, 8); assert.equal(results.custom.memory, 8); assert.deepEqual(results.custom.screen, [1920, 1080]);
  assert.equal(results.custom.timezone, 'Asia/Tokyo'); assert.equal(results.custom.dnt, '1'); assert.equal(results.custom.rtc, 'NotAllowedError');
  assert.equal(results.custom.headers.dnt, '1'); assert.equal(results.custom.languages[0], 'ja-JP'); assert(results.custom.headers.language.startsWith('ja-JP'));
  assert.deepEqual(results.custom.position, { lat: 35, lon: 139, accuracy: 50 });
  assert.notDeepEqual(results.custom.rect, real.rect); assert.equal(results.custom.rect.width, real.rect.width);
  assert(results.custom.voices.length >= 1 && results.custom.voices.length <= real.voices.length);
  assert.equal(results.disabled.adapterInfo, null); assert.equal(results.disabled.locationPermission, 'denied');
  assert(results.disabled.fonts.includes('Arial'), 'Default font must remain available');
  if (real.fonts.includes('Garamond')) assert(results.disabled.fonts.includes('Garamond'), 'Allowed font must remain available');
  for (const font of ['Rockwell', 'Book Antiqua', 'Agency FB', 'Tw Cen MT']) assert(!results.disabled.fonts.includes(font), 'Unlisted additional font must be hidden: ' + font);
  console.log('PASS: independent canvas/WebGL/audio switches including blob and offscreen paths; custom WebGL/WebGPU in pages/workers/devices; native CPU/RAM/screen/timezone/location/DNT; blocked WebRTC/WebGPU/location; stable ClientRects, voice subset and custom fonts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
