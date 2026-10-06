// Canvas / WebGL / audio / font fingerprints across profiles with the same
// hardware fingerprint but different noise seeds (and none):
//  - the same seed must give identical results across launches (stable),
//  - different seeds must differ (profiles can't be linked by these values),
//  - repeated reads within a page must agree (noise not detectable by re-reading).
//
//   node scripts/noise-test.js
const crypto = require('crypto');
const { launchTestProfile } = require('./test-lib');
const { generateFingerprint } = require('../src/main/fingerprints');
const { detectBrowserVersion } = require('../src/main/launcher');
const { Store } = require('../src/main/store');
const os = require('os');
const path = require('path');

// Fonts that are typically installed only by other software on Windows.
const EXTRA_FONTS = [
  'Arial Narrow', 'Book Antiqua', 'Bookman Old Style', 'Century', 'Century Gothic', 'Garamond',
  'Gill Sans MT', 'Haettenschweiler', 'Lucida Bright', 'Lucida Sans', 'Monotype Corsiva',
  'MS Reference Sans Serif', 'Rockwell', 'Tw Cen MT', 'Agency FB', 'Bodoni MT', 'Calisto MT',
  'Copperplate Gothic Bold', 'Elephant', 'Footlight MT Light', 'Perpetua', 'Wide Latin',
];

async function measure(run) {
  const page = await run.context.newPage();
  await page.goto('https://example.com');
  return page.evaluate(async (extraFonts) => {
    const sha = async (data) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');

    // Canvas 2D: the classic text + emoji + gradient fingerprint.
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 240, 0);
    g.addColorStop(0, '#f60'); g.addColorStop(1, '#069');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 240, 60);
    ctx.font = '18px Arial'; ctx.fillStyle = '#fff'; ctx.fillText('Cwm fjordbank 😃 glyphs', 4, 36);
    const dataUrl1 = c.toDataURL();
    const dataUrl2 = c.toDataURL();
    const imageData1 = ctx.getImageData(0, 0, 240, 60).data;
    const imageData2 = ctx.getImageData(0, 0, 240, 60).data;

    // WebGL readPixels of a rendered triangle.
    const gc = document.createElement('canvas');
    gc.width = 64; gc.height = 64;
    const gl = gc.getContext('webgl', { preserveDrawingBuffer: true });
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p; void main(){gl_Position=vec4(p,0,1);}'); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float; void main(){gl_FragColor=vec4(gl_FragCoord.x/64.0,0.4,gl_FragCoord.y/64.0,1);}'); gl.compileShader(fs);
    const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // Audio: the common OfflineAudioContext oscillator + compressor fingerprint.
    const ac = new OfflineAudioContext(1, 5000, 44100);
    const osc = ac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ac.destination); osc.start(0);
    const buffer = await ac.startRendering();
    const samples = buffer.getChannelData(0);
    let audioSum = 0;
    for (let i = 4500; i < 5000; i++) audioSum += Math.abs(samples[i]);

    // Fonts: which of the non-default fonts the page can use.
    const fonts = extraFonts.filter((f) => document.fonts.check(`12px "${f}"`) && (() => {
      const m = (fam) => { const x = document.createElement('canvas').getContext('2d'); x.font = `40px ${fam}`; return x.measureText('mmmmmmmmmmlli10OQ').width; };
      return m(`"${f}", monospace`) !== m('monospace');
    })());

    return {
      canvas: await sha(new TextEncoder().encode(dataUrl1)),
      canvasStable: dataUrl1 === dataUrl2,
      imageData: await sha(imageData1),
      imageDataStable: (await sha(imageData1)) === (await sha(imageData2)),
      webgl: await sha(px),
      audio: audioSum.toFixed(12),
      fonts: fonts.join(', ') || '(none)',
    };
  }, EXTRA_FONTS);
}

(async () => {
  const version = detectBrowserVersion(new Store(path.join(os.tmpdir(), 'bm-noise-settings')).getSettings().browserPath);
  const fingerprint = generateFingerprint({ os: 'windows', engineVersion: version });
  const seedA = crypto.randomBytes(8).toString('hex');
  const seedB = crypto.randomBytes(8).toString('hex');

  const results = {};
  for (const [label, noiseSeed] of [['no noise', null], ['seed A', seedA], ['seed A again', seedA], ['seed B', seedB]]) {
    const run = await launchTestProfile({ noiseSeed, fingerprint });
    results[label] = await measure(run);
    await run.close();
  }
  console.table(results);

  const a = results['seed A'], a2 = results['seed A again'], b = results['seed B'], none = results['no noise'];
  const checks = {
    'canvas differs from real': a.canvas !== none.canvas,
    'canvas differs between profiles': a.canvas !== b.canvas,
    'canvas stable for a profile': a.canvas === a2.canvas,
    'canvas same on re-read': a.canvasStable && a.imageDataStable,
    'webgl differs between profiles': a.webgl !== b.webgl && a.webgl !== none.webgl,
    'webgl stable for a profile': a.webgl === a2.webgl,
    'audio differs between profiles': a.audio !== b.audio && a.audio !== none.audio,
    'audio stable for a profile': a.audio === a2.audio,
    'fonts stable for a profile': a.fonts === a2.fonts,
  };
  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    ok &&= pass;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log(`info  fonts differ between profiles: ${a.fonts !== b.fonts} (depends on which extra fonts this PC has)`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
