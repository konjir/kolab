// konjir.com's only script: the static stand-in for the artifact's component logic (D81).
// from-artifact.mjs places it, hashed, as the first child of the page's .kj root, so it runs
// before the rest of the page is parsed and the chosen theme paints first.
//
// The artifact's logic, kept: the theme defaults to dark (Predawn); a stored choice
// (localStorage 'konjir.theme') wins, else the system's preference. The two theme buttons
// form a radio group: click to pick, arrow keys to swap, the checked one is the tab stop.
(function () {
  'use strict';
  var KEY = 'konjir.theme';
  var script = document.currentScript;
  var root = script && script.parentElement;
  if (!root || !root.classList.contains('kj')) root = document.querySelector('.kj');
  if (!root) return;

  function stored() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function preferred() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  var theme = stored();
  if (theme !== 'light' && theme !== 'dark') theme = preferred();

  function choices() {
    return root.querySelectorAll('[data-theme-choice]');
  }
  function render() {
    root.setAttribute('data-theme', theme);
    var buttons = choices();
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme-choice') === theme;
      buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');
      buttons[i].tabIndex = on ? 0 : -1;
    }
  }
  function pick(t) {
    theme = t;
    try { window.localStorage.setItem(KEY, t); } catch (e) { /* storage unavailable */ }
    render();
  }

  render();

  document.addEventListener('DOMContentLoaded', function () {
    render();
    var buttons = choices();
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) {
        pick(e.currentTarget.getAttribute('data-theme-choice'));
      });
      buttons[i].addEventListener('keydown', function (e) {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
        e.preventDefault();
        pick(theme === 'light' ? 'dark' : 'light');
        var on = root.querySelector('[data-theme-choice][aria-checked="true"]');
        if (on) on.focus();
      });
    }

    // The artifact's access form has no destination yet: keep a submit from reloading the page.
    var forms = root.querySelectorAll('form:not([action])');
    for (var j = 0; j < forms.length; j++) {
      forms[j].addEventListener('submit', function (e) { e.preventDefault(); });
    }
  });
})();
