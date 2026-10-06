// End-to-end check without the UI: launch one throwaway profile in the patched
// Chromium and compare what websites see with what the profile claims.
//
//   node scripts/smoke-test.js [proxy] [--os=windows|macos|linux]
const { launchTestProfile, report } = require('./test-lib');

const args = process.argv.slice(2);
const proxy = args.find((a) => !a.startsWith('--')) || '';
const fpOs = (args.find((a) => a.startsWith('--os=')) || '--os=windows').slice(5);

// Minutes to add to local time to get UTC (Date#getTimezoneOffset semantics) for an IANA zone.
function tzOffsetMinutes(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((date.getTime() - asUtc) / 60000);
}

(async () => {
  const run = await launchTestProfile({ proxy, os: fpOs });
  const { profile, config, version, context } = run;
  const fp = profile.fingerprint.fingerprint;
  const nav = fp.navigator;
  const native = config.nativeConfig;
  const geo = profile.proxyGeo;
  console.log(`browser ${version}  os: ${fpOs}  proxy: ${geo ? `${geo.ip} ${geo.city}, ${geo.country}` : 'none'}\n`);

  const page = await context.newPage();
  await page.goto('https://httpbin.org/headers', { timeout: 30000 });
  const headers = JSON.parse(await page.innerText('pre')).headers;

  await page.goto('https://example.com');
  if (native.geo) await context.grantPermissions(['geolocation'], { origin: 'https://example.com' });
  const seen = await page.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const hints = await navigator.userAgentData.getHighEntropyValues(['uaFullVersion', 'platformVersion']);
    const worker = await new Promise((resolve) => {
      const src = `postMessage({cores: navigator.hardwareConcurrency, platform: navigator.platform,
        ua: navigator.userAgent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        languages: navigator.languages.join(',')})`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
    });
    const position = await new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => resolve({ error: e.code }),
        { timeout: 10000 }
      )
    );
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      brands: navigator.userAgentData.brands.map((b) => `${b.brand} ${b.version}`).join(', '),
      uaFullVersion: hints.uaFullVersion,
      chPlatform: navigator.userAgentData.platform,
      webdriver: navigator.webdriver,
      languages: navigator.languages.join(','),
      intlLocale: Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0],
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      screen: `${screen.width}x${screen.height}`,
      availScreen: `${screen.availWidth}x${screen.availHeight}`,
      cssDeviceWidth: matchMedia(`(device-width: ${screen.width}px)`).matches,
      gpuVendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
      gpu: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
      workerCores: worker.cores,
      workerPlatform: worker.platform,
      workerUa: worker.ua,
      workerLanguages: worker.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workerTimezone: worker.tz,
      tzOffset: new Date().getTimezoneOffset(),
      geolocation: position,
    };
  });
  seen['header user-agent'] = headers['User-Agent'];
  seen['header sec-ch-ua'] = headers['Sec-Ch-Ua'];
  seen['header sec-ch-ua-platform'] = headers['Sec-Ch-Ua-Platform'];
  seen['header accept-language starts with'] = (headers['Accept-Language'] || '').split(',')[0];

  const expected = {
    userAgent: nav.userAgent,
    platform: nav.platform,
    brands: nav.userAgentData.brands.map((b) => `${b.brand} ${b.version}`).join(', '),
    uaFullVersion: version,
    chPlatform: nav.userAgentData.platform,
    webdriver: false,
    languages: config.languages.join(','),
    // Chrome resolves --lang to one of its UI locales (it-IT -> it), and Intl follows it.
    intlLocale: config.language.split('-')[0],
    cores: nav.hardwareConcurrency,
    memory: native.deviceMemory,
    screen: `${fp.screen.width}x${fp.screen.height}`,
    availScreen: `${fp.screen.availWidth}x${fp.screen.availHeight}`,
    cssDeviceWidth: true,
    gpuVendor: fp.videoCard.vendor,
    gpu: fp.videoCard.renderer,
    workerCores: nav.hardwareConcurrency,
    workerPlatform: nav.platform,
    workerUa: nav.userAgent,
    workerLanguages: config.languages.join(','),
    ...(native.timezone && {
      timezone: native.timezone,
      workerTimezone: native.timezone,
      tzOffset: tzOffsetMinutes(native.timezone),
    }),
    ...(native.geo && { geolocation: native.geo }),
    'header user-agent': nav.userAgent,
    'header sec-ch-ua': profile.fingerprint.headers['sec-ch-ua'],
    'header sec-ch-ua-platform': `"${nav.userAgentData.platform}"`,
    'header accept-language starts with': config.language,
  };
  const ok = report(expected, seen);
  console.log(`info  Accept-Language: ${headers['Accept-Language']}`);

  if (proxy) {
    await page.goto('https://api.ipify.org?format=json');
    console.log(`info  public IP: ${JSON.parse(await page.innerText('body')).ip}`);
  }

  await run.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
