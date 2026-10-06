const { FingerprintGenerator } = require('fingerprint-generator');

const generator = new FingerprintGenerator();

const OS_OPTIONS = ['windows', 'macos', 'linux'];

/**
 * Generate a realistic desktop Chrome fingerprint (+ matching HTTP headers).
 * `engineVersion` is the full version of the Chromium binary that will run it
 * (e.g. "154.0.8037.98"); the fingerprint is rewritten to claim that version,
 * because a UA that disagrees with the real engine's features is a giveaway.
 */
function generateFingerprint({ os = 'windows', locale = 'en-US', engineVersion = null } = {}) {
  if (!OS_OPTIONS.includes(os)) throw new Error(`Unsupported OS: ${os}`);

  const result = generator.getFingerprint({
    browsers: [{ name: 'chrome' }],
    operatingSystems: [os],
    devices: ['desktop'],
    locales: [locale],
  });

  if (engineVersion) alignToEngineVersion(result, engineVersion);
  return result;
}

function alignToEngineVersion({ fingerprint, headers }, fullVersion) {
  const major = fullVersion.split('.')[0];
  const reduced = `${major}.0.0.0`; // Chrome's UA string only exposes the major version
  const nav = fingerprint.navigator;

  const fixUa = (ua) => ua && ua.replace(/Chrome\/[\d.]+/, `Chrome/${reduced}`);
  nav.userAgent = fixUa(nav.userAgent);
  nav.appVersion = fixUa(nav.appVersion);
  headers['user-agent'] = fixUa(headers['user-agent']);

  const uad = nav.userAgentData;
  if (uad) {
    // Rebuild the brand lists exactly as Google Chrome of this version would (the generator's data
    // is from older versions and sometimes from Brave/Edge, whose GREASE brand and order differ).
    uad.brands = chromeBrandList(Number(major), major, false);
    uad.fullVersionList = chromeBrandList(Number(major), fullVersion, true);
    uad.uaFullVersion = fullVersion;
    headers['sec-ch-ua'] = uad.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  }
}

/**
 * Port of Chromium's GenerateBrandVersionList / GetGreasedUserAgentBrandVersion /
 * ShuffleBrandList (components/embedder_support/user_agent_utils.cc): the GREASE
 * brand and the brand order are derived from the major version, so they must be
 * recomputed whenever the claimed version changes.
 */
function chromeBrandList(seed, version, fullVersion) {
  const greaseChars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseVersions = ['8', '99', '24'];
  const greaseBrand = `Not${greaseChars[seed % greaseChars.length]}A${greaseChars[(seed + 1) % greaseChars.length]}Brand`;
  const greaseMajor = greaseVersions[seed % greaseVersions.length];

  const list = [
    { brand: greaseBrand, version: fullVersion ? `${greaseMajor}.0.0.0` : greaseMajor },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const order = orders[seed % orders.length];
  const shuffled = [];
  list.forEach((item, i) => (shuffled[order[i]] = item));
  return shuffled;
}

/**
 * The compact config our patched Chromium reads from --fingerprint-data
 * (schema: third_party/blink/public/common/fingerprint/fingerprint_config.h).
 */
function toNativeConfig({ fingerprint }) {
  const nav = fingerprint.navigator;
  const uad = nav.userAgentData || {};
  const s = fingerprint.screen;
  // Chrome 154 reports deviceMemory as a power of two clamped to [2, 32] on desktop.
  const memory = Math.min(32, Math.max(2, 2 ** Math.round(Math.log2(nav.deviceMemory || 8))));
  return {
    ua: nav.userAgent,
    platform: nav.platform,
    ch: {
      platform: uad.platform,
      platformVersion: uad.platformVersion,
      architecture: uad.architecture,
      bitness: uad.bitness,
      model: uad.model || '',
    },
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: memory,
    screen: {
      width: s.width,
      height: s.height,
      availWidth: s.availWidth,
      availHeight: s.availHeight,
      colorDepth: s.colorDepth,
    },
    webgl: { vendor: fingerprint.videoCard?.vendor, renderer: fingerprint.videoCard?.renderer },
  };
}

/** Short human-readable summary used by the UI table. */
function summarize({ fingerprint }) {
  const nav = fingerprint.navigator;
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform || nav.platform,
    screen: `${fingerprint.screen.width}x${fingerprint.screen.height}`,
    gpu: fingerprint.videoCard?.renderer || 'unknown',
    cores: nav.hardwareConcurrency,
    memory: nav.deviceMemory,
    languages: nav.languages,
  };
}

module.exports = { generateFingerprint, alignToEngineVersion, toNativeConfig, summarize, OS_OPTIONS };
