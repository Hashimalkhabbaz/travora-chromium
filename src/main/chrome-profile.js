const fs = require('fs');
const path = require('path');

/**
 * Writes per-profile settings into Chromium's own settings files before launch:
 *  - display identity (name + color): the name in the profile menu and window
 *    title, a colored avatar, and a browser frame tinted with the color;
 *  - languages (Accept-Language header and navigator.languages);
 *  - WebRTC IP handling: with a proxy, WebRTC must not use direct UDP, or STUN
 *    requests reveal the real IP address to any website.
 *
 * Must run while the browser is NOT running - Chromium rewrites both files from
 * memory on exit. None of these prefs are tamper-protected (MAC-tracked), so
 * editing them from outside is safe. Pref names verified against Chromium 154:
 *   chrome/common/pref_names.h, chrome/browser/profiles/profile_attributes_entry.cc
 */

const PROFILE_DIR = 'Default';
const GENERIC_AVATAR_INDEX = 26; // the plain "person" avatar, tinted by the colors below

const PALETTE = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#007b83', '#c5221f', '#b06000', '#3f51b5', '#00897b'];

/** Default color for a new profile: cycle through the palette. */
function pickColor(existingCount) {
  return PALETTE[existingCount % PALETTE.length];
}

/** "#1a73e8" -> signed 32-bit ARGB int, which is how Chromium stores SkColor prefs. */
function toSkColor(hex) {
  const rgb = parseInt(hex.replace('#', ''), 16);
  return (0xff000000 | rgb) | 0;
}

function isDark(hex) {
  const rgb = parseInt(hex.replace('#', ''), 16);
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

function applyProfileSettings(userDataDir, { name, color, languages, proxied, webrtcPolicy, locationPermission, doNotTrack, acceleration }) {
  const skColor = toSkColor(color);

  updateJson(path.join(userDataDir, PROFILE_DIR, 'Preferences'), (prefs) => {
    prefs.profile = {
      ...prefs.profile,
      name,
      using_default_name: false,
      avatar_index: GENERIC_AVATAR_INDEX,
    };
    prefs.browser = prefs.browser || {};
    prefs.browser.theme = {
      ...prefs.browser.theme,
      user_color2: skColor,
      follows_system_colors: false,
    };
    prefs.extensions = prefs.extensions || {};
    prefs.extensions.theme = { ...prefs.extensions.theme, id: 'user_color_theme_id' };

    if (languages?.length) {
      // Chrome derives accept_languages from selected_languages at startup.
      prefs.intl = {
        ...prefs.intl,
        selected_languages: languages.join(','),
        accept_languages: languages.join(','),
      };
    }
    prefs.webrtc = {
      ...prefs.webrtc,
      ip_handling_policy: webrtcPolicy || (proxied ? 'disable_non_proxied_udp' : 'default'),
    };
    if (locationPermission) {
      prefs.profile.default_content_setting_values = { ...prefs.profile.default_content_setting_values, geolocation: locationPermission };
      // Remove existing per-site grants when the user switches to Ask or Block.
      if (locationPermission !== 1 && prefs.profile.content_settings?.exceptions) delete prefs.profile.content_settings.exceptions.geolocation;
    }
    if (doNotTrack) {
      if (doNotTrack === 'default') delete prefs.enable_do_not_track;
      else prefs.enable_do_not_track = doNotTrack === 'on';
    }
  });

  updateJson(path.join(userDataDir, 'Local State'), (state) => {
    if (acceleration) {
      state.hardware_acceleration_mode = { ...state.hardware_acceleration_mode };
      if (acceleration === 'default') delete state.hardware_acceleration_mode.enabled;
      else state.hardware_acceleration_mode.enabled = acceleration === 'on';
    }
    state.profile = state.profile || {};
    state.profile.info_cache = state.profile.info_cache || {};
    state.profile.info_cache[PROFILE_DIR] = {
      ...state.profile.info_cache[PROFILE_DIR],
      name,
      shortcut_name: name,
      is_using_default_name: false,
      avatar_icon: `chrome://theme/IDR_PROFILE_AVATAR_${GENERIC_AVATAR_INDEX}`,
      is_using_default_avatar: true,
      profile_highlight_color: skColor,
      default_avatar_fill_color: skColor,
      default_avatar_stroke_color: isDark(color) ? -1 /* white */ : toSkColor('#202124'),
    };
  });
}

function updateJson(file, mutate) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  mutate(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { applyProfileSettings, pickColor, PALETTE };
