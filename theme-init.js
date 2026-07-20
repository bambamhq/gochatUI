// Resolves the theme before first paint.
//
// chrome.storage is async, so reading the preference there would paint the
// default (dark) first and then repaint — a visible flash every time the
// window opens. popup.js mirrors the preference into localStorage, which is
// synchronous, purely so this file can read it in <head>.
//
// "system" is resolved to a concrete value here rather than in CSS, so the
// stylesheet only has to carry one light branch instead of duplicating it
// under a prefers-color-scheme query.
(function () {
  var pref = null;
  try {
    pref = localStorage.getItem('oc_theme');
  } catch (e) {
    // Storage can be unavailable in some embedding contexts; fall through to
    // the OS preference rather than failing to render.
  }

  if (pref !== 'light' && pref !== 'dark') {
    pref = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  document.documentElement.setAttribute('data-theme', pref);
})();
