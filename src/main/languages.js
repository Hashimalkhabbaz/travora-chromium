/**
 * Browser languages for a profile. With language "auto", they follow the
 * proxy's country the way a typical local Chrome user's would: the local
 * language first, then English (e.g. Italy -> it-IT, it, en-US, en).
 */

// ISO 3166 country code -> most common browser locale in that country.
const COUNTRY_LOCALES = {
  AE: 'ar-AE', AR: 'es-AR', AT: 'de-AT', AU: 'en-AU', BE: 'nl-BE', BG: 'bg-BG', BH: 'ar-BH',
  BR: 'pt-BR', CA: 'en-CA', CH: 'de-CH', CL: 'es-CL', CN: 'zh-CN', CO: 'es-CO', CY: 'el-CY',
  CZ: 'cs-CZ', DE: 'de-DE', DK: 'da-DK', DZ: 'ar-DZ', EE: 'et-EE', EG: 'ar-EG', ES: 'es-ES',
  FI: 'fi-FI', FR: 'fr-FR', GB: 'en-GB', GR: 'el-GR', HK: 'zh-HK', HR: 'hr-HR', HU: 'hu-HU',
  ID: 'id-ID', IE: 'en-IE', IL: 'he-IL', IN: 'en-IN', IQ: 'ar-IQ', IR: 'fa-IR', IS: 'is-IS',
  IT: 'it-IT', JO: 'ar-JO', JP: 'ja-JP', KR: 'ko-KR', KW: 'ar-KW', KZ: 'ru-KZ', LB: 'ar-LB',
  LT: 'lt-LT', LU: 'fr-LU', LV: 'lv-LV', MA: 'ar-MA', MX: 'es-MX', MY: 'ms-MY', NG: 'en-NG',
  NL: 'nl-NL', NO: 'nb-NO', NZ: 'en-NZ', OM: 'ar-OM', PE: 'es-PE', PH: 'en-PH', PK: 'en-PK',
  PL: 'pl-PL', PT: 'pt-PT', QA: 'ar-QA', RO: 'ro-RO', RS: 'sr-RS', RU: 'ru-RU', SA: 'ar-SA',
  SE: 'sv-SE', SG: 'en-SG', SI: 'sl-SI', SK: 'sk-SK', TH: 'th-TH', TN: 'ar-TN', TR: 'tr-TR',
  TW: 'zh-TW', UA: 'uk-UA', US: 'en-US', VN: 'vi-VN', ZA: 'en-ZA',
};

/**
 * @param language   'auto' or a locale such as 'it-IT'
 * @param countryCode country of the proxy exit (auto mode), or null
 * @param fallback   locale to use in auto mode without a proxy (the system's)
 * @returns {{ primary: string, list: string[] }}  --lang value and Accept-Language list
 */
function resolveLanguages(language, countryCode, fallback = 'en-US') {
  const primary =
    language && language !== 'auto' ? language : COUNTRY_LOCALES[countryCode] || (countryCode ? 'en-US' : fallback);
  const base = primary.split('-')[0];
  const list = [primary, base];
  if (base !== 'en') list.push('en-US', 'en');
  return { primary, list: [...new Set(list)] };
}

module.exports = { resolveLanguages, COUNTRY_LOCALES };
