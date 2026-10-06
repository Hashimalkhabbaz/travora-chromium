const $ = (id) => document.getElementById(id);

// The manager offers the host OS so native rendering agrees with the identity.
const OS_LABELS = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

const state = {
  profiles: [],
  palette: ['#1a73e8'],
  busy: new Map(), // profile id -> label of the action in flight
};

// ---------- helpers ----------

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 2500);
}

async function withBusy(id, label, fn) {
  state.busy.set(id, label);
  render();
  try {
    await fn();
  } catch (err) {
    toast(cleanError(err), true);
  } finally {
    state.busy.delete(id);
    render();
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function upsert(profile) {
  const i = state.profiles.findIndex((p) => p.id === profile.id);
  if (i === -1) state.profiles.push(profile);
  else state.profiles[i] = profile;
}

// ---------- rendering ----------

function renderBrowserInfo(browserVersion) {
  $('browserInfo').replaceChildren(
    browserVersion
      ? `Patched Chromium ${browserVersion}`
      : el('span', { className: 'warn', textContent: 'browser not found — set it in Settings' })
  );
}

function render() {
  const body = $('profilesBody');
  $('emptyState').classList.toggle('hidden', state.profiles.length > 0);
  $('profilesTable').classList.toggle('hidden', state.profiles.length === 0);

  body.replaceChildren(
    ...state.profiles.map((p) => {
      const busy = state.busy.get(p.id);
      const s = p.summary;
      return el('tr', {}, [
        el('td', {}, [
          el('div', { className: 'name' }, [
            el('span', { className: 'swatch', style: `background:${p.color}` }),
            p.name,
          ]),
          el('div', { className: 'sub', textContent: s.userAgent, title: s.userAgent }),
        ]),
        el('td', {}, [
          `${s.platform} · ${p.locale === 'auto' ? 'lang auto' : p.locale}`,
        ]),
        el('td', { textContent: s.screen }),
        el('td', { className: 'gpu', textContent: s.gpu, title: s.gpu }),
        el('td', { textContent: `${s.cores}c · ${s.memory ?? '?'}GB` }),
        el('td', {}, proxyCell(p, busy)),
        el('td', {}, el('span', { className: `status ${p.running ? 'running' : ''}`, textContent: p.running ? 'Running' : 'Stopped' })),
        el('td', { className: 'actions' }, [
          busy
            ? el('button', { className: 'btn small', textContent: busy, disabled: true })
            : p.running
              ? el('button', { className: 'btn small', textContent: 'Stop', onclick: () => stopProfile(p) })
              : el('button', { className: 'btn small primary', textContent: 'Launch', onclick: () => launchProfile(p) }),
          el('button', { className: 'btn small ghost', textContent: 'Edit', disabled: Boolean(busy) || p.running, title: p.running ? 'Stop the browser before editing' : 'Edit fingerprint and profile settings', onclick: () => openDialog(p) }),
          el('button', { className: 'btn small ghost', textContent: 'New FP', title: 'Generate a base fingerprint and noise seed; keep explicit editor choices', disabled: busy || p.running, onclick: () => regenerate(p) }),
          el('button', { className: 'btn small ghost danger', textContent: 'Delete', disabled: busy, onclick: () => removeProfile(p) }),
        ]),
      ]);
    })
  );
}

function proxyCell(p, busy) {
  if (!p.proxy) return el('span', { className: 'muted', textContent: 'direct' });
  const geo = p.proxyGeo;
  return [
    el('div', { className: 'proxy-host', textContent: p.proxyHost }),
    el('div', { className: 'sub' }, [
      geo
        ? `${geo.city}, ${geo.countryCode} · ${geo.timezone}`
        : el('span', { className: 'warn', textContent: 'not checked' }),
      ' ',
      el('button', {
        className: 'link',
        textContent: 'check',
        disabled: Boolean(busy),
        onclick: () => checkProxy(p),
      }),
    ]),
  ];
}

// ---------- actions ----------

function launchProfile(p) {
  return withBusy(p.id, 'Starting…', () => window.api.launchProfile(p.id));
}

function checkProxy(p) {
  return withBusy(p.id, 'Checking…', async () => {
    const updated = await window.api.checkProxy(p.id);
    upsert(updated);
    const geo = updated.proxyGeo;
    toast(`Proxy OK: ${geo.ip} · ${geo.city}, ${geo.country} · ${geo.timezone}`);
  });
}

function stopProfile(p) {
  return withBusy(p.id, 'Stopping…', () => window.api.stopProfile(p.id));
}

function regenerate(p) {
  if (!confirm(`Generate a new fingerprint and noise seed for "${p.name}"?\nCookies, storage and explicit editor choices are kept.`)) return;
  return withBusy(p.id, 'Generating…', async () => {
    upsert(await window.api.regenerateProfile(p.id));
    toast('New fingerprint generated');
  });
}

function removeProfile(p) {
  if (!confirm(`Delete "${p.name}"?\nThis removes its cookies, storage and fingerprint permanently.`)) return;
  return withBusy(p.id, 'Deleting…', async () => {
    await window.api.deleteProfile(p.id);
    state.profiles = state.profiles.filter((x) => x.id !== p.id);
  });
}

// ---------- profile dialog ----------

let editorGeneration = 0;
let editorHardware;
let editorReady = false;

function rendererPresets() {
  const choices = [...GPU_PRESETS];
  if (editorHardware) choices.unshift([editorHardware.webgl.vendor, editorHardware.webgl.renderer]);
  const renderers = [...new Set(choices.filter(([vendor]) => vendor === $('pfVendor').value).map(([, renderer]) => renderer))];
  $('pfGpuPreset').replaceChildren(el('option', { value: '', textContent: 'Enter a renderer' }), ...renderers.map(renderer => el('option', { value: renderer, textContent: renderer })));
  $('pfGpuPreset').value = renderers.includes($('pfRenderer').value) ? $('pfRenderer').value : '';
}

function updateEditorVisibility() {
  const panel = (id, visible) => { $(id).classList.toggle('hidden', !visible); $(id).querySelectorAll('input, select, textarea, button').forEach(node => { node.disabled = !visible; }); };
  panel('gpuCustom', $('pfWebglMode').value === 'custom');
  panel('webgpuCustom', $('pfWebgpuMode').value === 'custom');
  panel('screenCustom', $('pfScreenMode').value === 'custom');
  panel('locationCustom', $('pfLocationMode').value === 'custom');
  const input = (id, visible) => { $(id).classList.toggle('hidden', !visible); $(id).disabled = !visible; };
  input('pfLocale', $('pfLanguageMode').value === 'custom');
  input('pfVendor', $('pfVendorPreset').value === 'other');
  // The custom text is still retained when a preset is selected.
  input('pfTimezone', $('pfTimezoneMode').value === 'custom');
  input('pfDisplayLanguage', $('pfDisplayLanguageMode').value === 'custom');
  input('pfFonts', $('pfFontsMode').value === 'custom');
  $('pfCores').disabled = $('pfCpuMode').value === 'real';
  $('pfMemory').disabled = $('pfMemoryMode').value === 'real';
  $('pfLocationPermission').disabled = $('pfLocationMode').value === 'block';
  $('pfRenderer').required = $('pfWebglMode').value === 'custom';
  $('pfLocale').required = $('pfLanguageMode').value === 'custom';
  $('pfTimezone').required = $('pfTimezoneMode').value === 'custom';
  $('pfDisplayLanguage').required = $('pfDisplayLanguageMode').value === 'custom';
  $('pfFonts').required = $('pfFontsMode').value === 'custom';
  if ($('pfWebglMode').value === 'custom' && $('pfWebgpuMode').value === 'real') {
    $('gpuWarning').textContent = 'Custom WebGL with Real WebGPU can report different GPU vendors. Choose WebGPU metadata separately. Features, limits and rendering still come from this machine.';
  } else {
    $('gpuWarning').textContent = 'Custom metadata changes reported GPU names. Graphics features, limits and rendering still come from this machine.';
  }
}

function fillEditor(s, hardware) {
  editorHardware = hardware;
  const values = {
    pfWebglMode: s.webgl.mode, pfVendor: s.webgl.vendor, pfRenderer: s.webgl.renderer,
    pfWebgpuMode: s.webgpu.mode, pfWgpuVendor: s.webgpu.vendor, pfWgpuArch: s.webgpu.architecture, pfWgpuDevice: s.webgpu.device, pfWgpuDescription: s.webgpu.description,
    pfCpuMode: s.cpu.mode, pfCores: s.cpu.value, pfMemoryMode: s.memory.mode, pfMemory: s.memory.value,
    pfScreenMode: s.screen.mode, pfWidth: s.screen.width, pfHeight: s.screen.height, pfAvailWidth: s.screen.availWidth, pfAvailHeight: s.screen.availHeight,
    pfTimezoneMode: s.timezone.mode, pfTimezone: s.timezone.value, pfLocationMode: s.location.mode,
    pfLatitude: s.location.lat, pfLongitude: s.location.lon, pfAccuracy: s.location.accuracy, pfLocationPermission: s.location.permission,
    pfDisplayLanguageMode: s.displayLanguage.mode, pfDisplayLanguage: s.displayLanguage.value,
    pfFontsMode: s.fonts.mode, pfFonts: s.fonts.allowed.join(', '), pfWebrtc: s.webrtc, pfDnt: s.doNotTrack, pfAcceleration: s.acceleration,
  };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  for (const [id, key] of [['pfCanvasNoise', 'canvas'], ['pfGlNoise', 'webgl'], ['pfAudioNoise', 'audio'], ['pfRectsNoise', 'clientRects'], ['pfSpeechNoise', 'speechVoices']]) $(id).checked = s.noise[key];
  const vendors = [...$('pfVendorPreset').options].map(o => o.value);
  $('pfVendorPreset').value = vendors.includes(s.webgl.vendor) ? s.webgl.vendor : 'other';
  $('pfScreenPreset').value = [...$('pfScreenPreset').options].some(o => o.value === `${s.screen.width}x${s.screen.height}`) ? `${s.screen.width}x${s.screen.height}` : '';
  $('realGpu').textContent = `Physical GPU: ${hardware.webgl.vendor} · ${hardware.webgl.renderer}`;
  $('realHardware').textContent = `Real: ${hardware.hardwareConcurrency} CPU threads, ${hardware.deviceMemory} GB reported RAM, ${hardware.screen.width} x ${hardware.screen.height} display, ${hardware.devicePixelRatio} pixel ratio, ${hardware.screen.colorDepth}-bit color. Pixel ratio and color depth follow the display.`;
  rendererPresets();
  updateEditorVisibility();
}

function collectSettings() {
  const value = id => $(id).value;
  const number = id => Number(value(id));
  return {
    webgl: { mode: value('pfWebglMode'), vendor: value('pfVendor'), renderer: value('pfRenderer') },
    webgpu: { mode: value('pfWebgpuMode'), vendor: value('pfWgpuVendor'), architecture: value('pfWgpuArch'), device: value('pfWgpuDevice'), description: value('pfWgpuDescription') },
    cpu: { mode: value('pfCpuMode'), value: number('pfCores') }, memory: { mode: value('pfMemoryMode'), value: number('pfMemory') },
    screen: { mode: value('pfScreenMode'), width: number('pfWidth'), height: number('pfHeight'), availWidth: number('pfAvailWidth'), availHeight: number('pfAvailHeight') },
    timezone: { mode: value('pfTimezoneMode'), value: value('pfTimezone') },
    location: { mode: value('pfLocationMode'), lat: number('pfLatitude'), lon: number('pfLongitude'), accuracy: number('pfAccuracy'), permission: value('pfLocationPermission') },
    noise: { canvas: $('pfCanvasNoise').checked, webgl: $('pfGlNoise').checked, audio: $('pfAudioNoise').checked, clientRects: $('pfRectsNoise').checked, speechVoices: $('pfSpeechNoise').checked },
    fonts: { mode: value('pfFontsMode'), allowed: value('pfFonts').split(/[,\n]/).map(font => font.trim()).filter(Boolean) },
    webrtc: value('pfWebrtc'), displayLanguage: { mode: value('pfDisplayLanguageMode'), value: value('pfDisplayLanguage') }, doNotTrack: value('pfDnt'), acceleration: value('pfAcceleration'),
  };
}

async function openDialog(profile = null) {
  const generation = ++editorGeneration;
  editorReady = false;
  $('fingerprintEditor').disabled = true;
  $('editorLoading').textContent = 'Loading fingerprint settings...';
  $('editorLoading').classList.remove('hidden');
  $('dialogSubmit').disabled = true;
  const form = $('profileForm');
  form.reset();
  form.elements.id.value = profile?.id || '';
  form.elements.name.value = profile?.name || `Profile ${state.profiles.length + 1}`;
  form.elements.proxy.value = profile?.proxy || '';
  const locale = profile?.locale || 'auto';
  $('pfLanguageMode').value = ['auto', 'real'].includes(locale) ? locale : 'custom';
  form.elements.locale.value = ['auto', 'real'].includes(locale) ? 'en-US' : locale;
  form.elements.color.value = profile?.color || state.palette[state.profiles.length % state.palette.length];
  $('dialogTitle').textContent = profile ? 'Edit profile' : 'New profile';
  $('dialogSubmit').textContent = profile ? 'Save' : 'Create';
  document.querySelectorAll('.create-only').forEach((n) => n.classList.toggle('hidden', !!profile));
  $('profileDialog').showModal();
  try {
    const { settings, hardware } = await window.api.editData(profile?.id);
    if (generation !== editorGeneration || !$('profileDialog').open) return;
    fillEditor(settings, hardware);
    editorReady = true;
    $('fingerprintEditor').disabled = false;
    $('dialogSubmit').disabled = false;
    $('editorLoading').classList.add('hidden');
  } catch (err) {
    if (generation !== editorGeneration) return;
    $('editorLoading').textContent = cleanError(err);
  }
}

$('dialogCancel').onclick = () => { editorGeneration++; $('profileDialog').close('cancel'); };
$('profileDialog').addEventListener('cancel', () => { editorGeneration++; });
$('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!editorReady || $('dialogSubmit').disabled) return;
  const form = $('profileForm');
  const data = {
    id: form.elements.id.value,
    name: form.elements.name.value.trim(),
    os: form.elements.os.value,
    locale: $('pfLanguageMode').value === 'custom' ? form.elements.locale.value.trim() : $('pfLanguageMode').value,
    proxy: form.elements.proxy.value.trim(),
    color: form.elements.color.value,
    fingerprintSettings: collectSettings(),
  };
  $('dialogSubmit').disabled = true;
  try {
    upsert(data.id ? await window.api.updateProfile(data) : await window.api.createProfile(data));
    render();
    $('profileDialog').close('save');
    toast('Profile choices saved');
  } catch (err) {
    toast(cleanError(err), true);
  } finally {
    $('dialogSubmit').disabled = false;
  }
});

for (const id of ['pfWebglMode', 'pfWebgpuMode', 'pfScreenMode', 'pfCpuMode', 'pfMemoryMode', 'pfLanguageMode', 'pfTimezoneMode', 'pfLocationMode', 'pfDisplayLanguageMode', 'pfFontsMode']) $(id).onchange = updateEditorVisibility;
$('pfVendorPreset').onchange = () => {
  if ($('pfVendorPreset').value !== 'other') $('pfVendor').value = $('pfVendorPreset').value;
  $('pfRenderer').value = '';
  rendererPresets();
  // A vendor selection is enough to populate a matching renderer. Loading a
  // saved profile still keeps its exact renderer, and Other stays editable.
  if ($('pfVendorPreset').value !== 'other' && $('pfGpuPreset').options.length > 1) {
    $('pfGpuPreset').selectedIndex = 1;
    $('pfRenderer').value = $('pfGpuPreset').value;
  }
  updateEditorVisibility();
};
$('pfVendor').oninput = rendererPresets;
$('pfGpuPreset').onchange = () => { if ($('pfGpuPreset').value) $('pfRenderer').value = $('pfGpuPreset').value; };
$('pfRenderer').oninput = () => { $('pfGpuPreset').value = ''; };
function useResolution(resolution) {
  if (!resolution) return;
  const [width, height] = resolution.split('x').map(Number);
  const reserved = editorHardware ? editorHardware.screen.height - editorHardware.screen.availHeight : 48;
  $('pfWidth').value = $('pfAvailWidth').value = width;
  $('pfHeight').value = height; $('pfAvailHeight').value = Math.max(320, height - reserved);
}
$('pfScreenPreset').onchange = () => useResolution($('pfScreenPreset').value);
$('randomScreen').onclick = () => {
  const presets = [...$('pfScreenPreset').options].map(o => o.value).filter(Boolean);
  $('pfScreenPreset').value = presets[crypto.getRandomValues(new Uint32Array(1))[0] % presets.length];
  useResolution($('pfScreenPreset').value);
};
for (const id of ['pfWidth', 'pfHeight', 'pfAvailWidth', 'pfAvailHeight']) $(id).oninput = () => { $('pfScreenPreset').value = ''; };

// ---------- settings ----------

$('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden');

$('browseBtn').onclick = async () => {
  const file = await window.api.browseExecutable();
  if (file) $('browserPath').value = file;
};

$('saveSettingsBtn').onclick = async () => {
  try {
    const { browserVersion } = await window.api.saveSettings({
      browserPath: $('browserPath').value,
    });
    renderBrowserInfo(browserVersion);
    toast('Settings saved');
  } catch (err) {
    toast(cleanError(err), true);
  }
};

$('newProfileBtn').onclick = () => openDialog();

// ---------- boot ----------

window.api.onStatus(({ id, running }) => {
  const p = state.profiles.find((x) => x.id === id);
  if (p) {
    p.running = running;
    render();
  }
});

window.api.onError(({ message }) => toast(message, true));

(async () => {
  const { settings, browserVersion, osOptions, palette, profiles } = await window.api.init();
  state.profiles = profiles;
  state.palette = palette;

  $('pfOs').replaceChildren(
    ...osOptions.map((os) => el('option', { value: os, textContent: OS_LABELS[os] || os, selected: os === 'windows' }))
  );
  $('browserPath').value = settings.browserPath;
  renderBrowserInfo(browserVersion);
  if (!browserVersion) $('settingsPanel').classList.remove('hidden');
  render();
})();
