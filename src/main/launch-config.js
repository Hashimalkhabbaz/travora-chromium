const crypto = require('crypto');
const { toNativeConfig } = require('./fingerprints');
const { resolveLanguages } = require('./languages');
const { settingsFor, browserChoices, gpuMetadata, hasNoise } = require('./fingerprint-settings');

/** Random per-profile key for canvas/WebGL/audio noise and the font subset. */
function newNoiseSeed() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Everything the browser needs for one launch of `profile`:
 *  - nativeConfig: the --fingerprint-data payload
 *  - language / languages: --lang and the Accept-Language list
 *
 * With a proxy (and its location from lookupProxyGeo in profile.proxyGeo),
 * timezone, geolocation and - for language "auto" - languages follow the
 * proxy's location. Without one, the real location already matches the real
 * IP, so those stay real and languages default to the system's.
 */
function buildLaunchConfig(profile, { systemLocale = 'en-US' } = {}) {
  const geo = profile.proxy && profile.proxyGeo?.proxy === profile.proxy ? profile.proxyGeo : null;
  const { primary, list } = resolveLanguages(profile.locale, geo?.countryCode, systemLocale);

  const s = settingsFor(profile);
  const choices = browserChoices(profile, systemLocale);
  const nativeConfig = { ...toNativeConfig(profile.fingerprint) };
  if (hasNoise(s) && profile.noiseSeed) nativeConfig.noiseSeed = profile.noiseSeed;
  // Only explicitly edited profiles need the new fields. Seed-only configs
  // keep compatibility with existing builds and their original outputs.
  if (profile.fingerprintSettings) {
    nativeConfig.noise = { ...s.noise, fonts: s.fonts.mode === 'subset' };
    if (s.fonts.mode === 'custom') nativeConfig.fontAllowlist = s.fonts.allowed;
    if (s.webrtc === 'disabled') nativeConfig.webrtcDisabled = true;
    if (s.webgpu.mode === 'disabled') nativeConfig.webgpu = { disabled: true };
    else if (s.webgpu.mode === 'custom') nativeConfig.webgpu = { custom: true, vendor: s.webgpu.vendor, architecture: s.webgpu.architecture, device: s.webgpu.device, description: s.webgpu.description };
    else if (s.webgpu.mode === 'webgl' && s.webgl.mode === 'custom') nativeConfig.webgpu = { custom: true, ...gpuMetadata(s.webgl) };
  }
  if (s.timezone.mode === 'custom') nativeConfig.timezone = s.timezone.value;
  else if (s.timezone.mode === 'proxy' && geo) nativeConfig.timezone = geo.timezone;
  if (s.location.mode === 'custom') nativeConfig.geo = { lat: s.location.lat, lon: s.location.lon, accuracy: s.location.accuracy };
  else if (s.location.mode === 'proxy' && geo) nativeConfig.geo = nearbyPosition(geo, profile.noiseSeed || profile.id);
  return { nativeConfig, language: choices.displayLanguage || primary, languages: list, ...choices };
}

/**
 * A stable position within ~2 km of the proxy's geo-IP location. IP
 * geolocation gives a city centroid, which many real users share; offsetting
 * per profile avoids every profile reporting the exact same coordinates.
 */
function nearbyPosition({ lat, lon }, seed) {
  const bytes = crypto.createHash('sha256').update(`geo:${seed}`).digest();
  const angle = (bytes.readUInt32BE(0) / 2 ** 32) * 2 * Math.PI;
  const distanceKm = 0.3 + (bytes.readUInt32BE(4) / 2 ** 32) * 1.7;
  const accuracy = Math.round(20 + (bytes.readUInt32BE(8) / 2 ** 32) * 80);
  const dLat = (distanceKm / 111.32) * Math.cos(angle);
  const dLon = (distanceKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return { lat: round(lat + dLat), lon: round(lon + dLon), accuracy };
}

module.exports = { buildLaunchConfig, newNoiseSeed };
