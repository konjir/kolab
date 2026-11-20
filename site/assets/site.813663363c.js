// konjir.com's only script: the static stand-in for the artifact's component logic (D81), the
// Kolab page's demo of a mark (the second block below), and the header's menu (the third).
// build.mjs places it, hashed, as the first child of the page's .kj root, so it runs
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
        var on = e.currentTarget.parentElement.querySelector('[data-theme-choice][aria-checked="true"]');
        if (on) on.focus();
      });
    }
  });
})();

// A page's demo, bound by data- attributes, since the CSP allows no inline script or handler.
// [data-demo="<state>"] holds it, written in that state; each [data-demo-when="<state> …"] in it
// shows only in those states; each [data-demo-go="<state>"] button moves to that state. The page
// hides everything that needs this script (its buttons), so it reads whole without it.
// A move shows the new state, and its live region says what happened; focus goes to the first
// button the new state shows, so a keyboard carries on where it was. The box keeps the height of
// its tallest state, so the page doesn't jump on a move.
(function () {
  'use strict';
  function visible(el, box) {
    for (var n = el; n && n !== box; n = n.parentElement) if (n.hidden) return false;
    return true;
  }
  function start(box) {
    var parts = box.querySelectorAll('[data-demo-when]');
    var buttons = box.querySelectorAll('[data-demo-go]');
    function show(state, focus) {
      for (var i = 0; i < parts.length; i++) {
        parts[i].hidden = (' ' + parts[i].getAttribute('data-demo-when') + ' ').indexOf(' ' + state + ' ') < 0;
      }
      if (!focus) return;
      for (var j = 0; j < buttons.length; j++) {
        if (visible(buttons[j], box)) { buttons[j].focus(); return; }
      }
    }
    var states = [box.getAttribute('data-demo')];
    var current = states[0];
    for (var k = 0; k < buttons.length; k++) {
      var to = buttons[k].getAttribute('data-demo-go');
      if (states.indexOf(to) < 0) states.push(to);
      buttons[k].addEventListener('click', function (e) {
        current = e.currentTarget.getAttribute('data-demo-go');
        show(current, true);
      });
    }
    // Every state is laid out in turn, in one task, so nothing paints or is announced but the last.
    function hold() {
      box.style.minHeight = '';
      var tallest = 0;
      for (var m = 0; m < states.length; m++) {
        show(states[m], false);
        tallest = Math.max(tallest, box.getBoundingClientRect().height);
      }
      show(current, false);
      box.style.minHeight = Math.ceil(tallest) + 'px';
    }
    hold();
    return hold;
  }
  document.addEventListener('DOMContentLoaded', function () {
    var boxes = document.querySelectorAll('[data-demo]');
    var holds = [];
    for (var i = 0; i < boxes.length; i++) holds.push(start(boxes[i]));
    var pending = false;
    function again() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        for (var j = 0; j < holds.length; j++) holds[j]();
      });
    }
    // Measured again once the fonts are in, since they change how the text wraps, and on a resize.
    window.addEventListener('resize', again);
    window.addEventListener('load', again);
    try { document.fonts.ready.then(again); } catch (e) { /* no font loading API */ }
  });
})();

// The header's menu (chrome.mjs): a <details>, so it opens and closes, and says whether it is open,
// with no script. The stylesheet decides when the screen is narrow, and says so in the menu's
// --menu property: on a wide screen its summary is hidden and its links sit in the header's row,
// so this keeps it open, as it looks; on a narrow one it starts closed, beneath its summary, the
// menu button, and this closes it on Escape (focus back on the button), a click outside it, focus
// leaving it, or a link in it followed (an in-page link would leave it open over the page).
// Crossing between the two opens or closes it; a resize within one leaves it as it is.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var menus = document.querySelectorAll('details[data-menu]');
    if (!menus.length) return;
    var modes = [];
    function narrow(menu) {
      return window.getComputedStyle(menu).getPropertyValue('--menu').trim() === 'narrow';
    }
    function fit() {
      for (var i = 0; i < menus.length; i++) {
        var n = narrow(menus[i]);
        if (n !== modes[i]) {
          modes[i] = n;
          menus[i].open = !n;
        }
      }
    }
    function close(menu, focus) {
      if (!menu.open || !narrow(menu)) return;
      menu.open = false;
      if (focus) menu.querySelector('summary').focus();
    }
    fit();
    var pending = false;
    window.addEventListener('resize', function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        fit();
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      for (var i = 0; i < menus.length; i++) {
        if (menus[i].open && narrow(menus[i])) {
          close(menus[i], menus[i].contains(document.activeElement));
          e.preventDefault();
        }
      }
    });
    document.addEventListener('click', function (e) {
      for (var i = 0; i < menus.length; i++) {
        if (!menus[i].contains(e.target)) close(menus[i], false);
        else if (e.target.closest && e.target.closest('.menu-panel a')) close(menus[i], false);
      }
    });
    for (var j = 0; j < menus.length; j++) {
      menus[j].addEventListener('focusout', function (e) {
        var menu = e.currentTarget;
        if (e.relatedTarget && !menu.contains(e.relatedTarget)) close(menu, false);
      });
    }
  });
})();
