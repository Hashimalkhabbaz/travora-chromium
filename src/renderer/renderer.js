const $ = (id) => document.getElementById(id);

// This PC runs Windows: a macOS/Linux fingerprint can be spotted through fonts,
// emoji, scrollbars and WebGL details, so those are offered with a warning.
const OS_LABELS = {
  windows: 'Windows (recommended)',
  macos: 'macOS (not recommended)',
  linux: 'Linux (not recommended)',
};
const OS_WARNING = 'This PC runs Windows: fonts, emoji, scrollbars and WebGL details can reveal it.';

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
          p.os !== 'windows' ? el('span', { className: 'warn', textContent: ' ⚠', title: OS_WARNING }) : '',
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
          el('button', { className: 'btn small ghost', textContent: 'Edit', disabled: busy, onclick: () => openDialog(p) }),
          el('button', { className: 'btn small ghost', textContent: 'New FP', title: 'Generate a new fingerprint', disabled: busy || p.running, onclick: () => regenerate(p) }),
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
  if (!confirm(`Generate a new fingerprint for "${p.name}"?\nCookies and storage are kept.`)) return;
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

function openDialog(profile = null) {
  const form = $('profileForm');
  form.reset();
  form.elements.id.value = profile?.id || '';
  form.elements.name.value = profile?.name || `Profile ${state.profiles.length + 1}`;
  form.elements.proxy.value = profile?.proxy || '';
  form.elements.locale.value = profile?.locale || 'auto';
  form.elements.color.value = profile?.color || state.palette[state.profiles.length % state.palette.length];
  $('dialogTitle').textContent = profile ? 'Edit profile' : 'New profile';
  $('dialogSubmit').textContent = profile ? 'Save' : 'Create';
  document.querySelectorAll('.create-only').forEach((n) => n.classList.toggle('hidden', !!profile));
  $('profileDialog').showModal();
}

$('profileDialog').addEventListener('close', async () => {
  if ($('profileDialog').returnValue !== 'save') return;
  const form = $('profileForm');
  const data = {
    id: form.elements.id.value,
    name: form.elements.name.value.trim(),
    os: form.elements.os.value,
    locale: form.elements.locale.value.trim(),
    proxy: form.elements.proxy.value.trim(),
    color: form.elements.color.value,
  };
  try {
    upsert(data.id ? await window.api.updateProfile(data) : await window.api.createProfile(data));
    render();
  } catch (err) {
    toast(cleanError(err), true);
  }
});

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
