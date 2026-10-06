// Measure the selected browser without a fingerprint, on a local page only.
// This avoids inventing a GPU/scale that disagrees with the rendering backend.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const cache = new Map();
const HOST_OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readHardware() {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  const hints = await navigator.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'platformVersion']);
  const adapter = await navigator.gpu?.requestAdapter();
  return {
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    hints,
    devicePixelRatio,
    screen: Object.fromEntries(['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'].map(key => [key, screen[key]])),
    webgl: debug ? { vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) } : null,
    webgpu: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null,
  };
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hardware probe CDP connection timed out')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Hardware probe CDP connection failed')); };
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hardware measurement timed out')), 15000);
      const fail = message => { clearTimeout(timer); reject(new Error(message)); };
      ws.onclose = () => fail('Hardware probe page closed');
      ws.onerror = () => fail('Hardware probe connection failed');
      ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error || msg.result?.exceptionDetails) {
          reject(new Error('Hardware measurement failed: ' + JSON.stringify(msg.error || msg.result.exceptionDetails)));
        } else {
          resolve(msg.result?.result?.value);
        }
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.onclose = null;
    ws.close();
  }
}

async function probe(browserPath) {
  if (!HOST_OS) throw new Error(`Unsupported host OS: ${process.platform}`);
  if (!browserPath || !fs.existsSync(browserPath)) throw new Error(`Browser executable not found: ${browserPath || '(not set)'}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-hardware-'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Browser hardware measurement</title>');
  });
  let child, exited, spawnError;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    child = spawn(browserPath, [
      `--user-data-dir=${tempDir}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--window-position=-32000,-32000', url,
    ], { stdio: 'ignore', windowsHide: true, env: { ...process.env, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' } });
    exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', err => { spawnError = err; resolve(); }); });
    const activePort = path.join(tempDir, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('Hardware probe browser exited before measurement');
      try { port = Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]); } catch {}
      if (port > 0) break;
      await sleep(200);
    }
    if (!port) throw new Error('Hardware probe browser did not expose its debugging port');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const target = tabs.find(tab => tab.type === 'page' && tab.url === url);
    if (!target) throw new Error('Local hardware measurement page is unavailable');
    await sleep(1000); // The HTTP target can exist before its navigation commits.
    const hardware = await evaluate(target.webSocketDebuggerUrl, `(${readHardware})()`);
    if (!hardware?.webgl?.vendor || !hardware.webgl.renderer || !(hardware.devicePixelRatio > 0) || !hardware.hints?.platform) {
      throw new Error('Hardware probe returned incomplete GPU/display measurements: ' + JSON.stringify(hardware));
    }
    return { ...hardware, os: HOST_OS };
  } finally {
    server.close();
    if (child && child.exitCode === null && !spawnError) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGTERM');
      let timer;
      const timedOut = await Promise.race([exited.then(() => false), new Promise(resolve => { timer = setTimeout(() => resolve(true), 10000); })]);
      clearTimeout(timer);
      if (timedOut) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGKILL');
        await exited;
      }
    }
    await sleep(300);
    // tempDir is the absolute directory returned by mkdtemp, never a user path.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function getHostHardware(browserPath, { refresh = false } = {}) {
  if (refresh) cache.delete(browserPath);
  if (!cache.has(browserPath)) {
    const measurement = probe(browserPath).catch(err => { cache.delete(browserPath); throw err; });
    cache.set(browserPath, measurement);
  }
  return cache.get(browserPath);
}

module.exports = { HOST_OS, getHostHardware };
