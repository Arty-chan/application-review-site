// Site-wide behavior, loaded from base.njk. Lives in a static file (not inline
// <script> or onclick/onsubmit attributes) because helmet's Content-Security-Policy
// only allows scripts from 'self' and blocks inline handlers outright.

// <form data-confirm="Are you sure?"> asks before submitting.
document.addEventListener('submit', function (event) {
  var message = event.target.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});

// <select data-autosubmit> applies its form as soon as it's changed (e.g. the
// search results' sort order), with no button to press.
document.addEventListener('change', function (event) {
  if (event.target.matches('select[data-autosubmit]')) event.target.form.requestSubmit();
});

// ---------- The collapsible region/country picker (regionTreePicker in _macros.njk) ----------

// The countries a region's "select all" button covers: every checkbox in its
// picker whose region path starts with the button's (see regionPicker in
// _macros.njk) — the region's own countries and those of all its sub-regions.
function regionBoxes(button) {
  var region = button.getAttribute('data-select-region').split(',');
  var boxes = button.closest('details.region-tree').querySelectorAll('input[data-region-path]');
  return Array.prototype.filter.call(boxes, function (cb) {
    var own = cb.getAttribute('data-region-path').split(',');
    return region.every(function (seg, i) { return own[i] === seg; });
  });
}

function allTicked(boxes) {
  return boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });
}

// Brings a picker up to date with which boxes are ticked: the heading shows how
// many (so a collapsed picker still shows what's selected), and each region's
// button reads "deselect all" once every country it covers is ticked.
function refreshPicker(picker) {
  var count = picker.querySelectorAll('input[type=checkbox]:checked').length;
  picker.querySelector('[data-selected-count]').textContent = count ? '(' + count + ' selected)' : '';
  picker.querySelectorAll('[data-select-region]').forEach(function (button) {
    button.textContent = allTicked(regionBoxes(button)) ? 'deselect all' : 'select all';
  });
}
document.querySelectorAll('details.region-tree').forEach(refreshPicker);

document.addEventListener('change', function (event) {
  var picker = event.target.closest('details.region-tree');
  if (picker) refreshPicker(picker);
});

// A region's button ticks all of its countries — or, if they're all ticked
// already, unticks them. Only the boxes change: nothing is applied until the
// form is submitted.
document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-select-region]');
  if (!button) return;
  var boxes = regionBoxes(button);
  var tick = !allTicked(boxes);
  boxes.forEach(function (cb) { cb.checked = tick; });
  // Setting .checked from script doesn't fire 'change', so refresh here.
  refreshPicker(button.closest('details.region-tree'));
});

// The picker also stays open or closed as you left it when the page reloads —
// applying search filters, or a form shown again with an error — so only
// clicking its heading opens or closes it. Remembered per tab (sessionStorage),
// so a new visit starts collapsed. Storage can be unavailable (e.g. blocked by
// privacy settings); then it just starts collapsed each time.
document.querySelectorAll('details.region-tree').forEach(function (picker) {
  var key = 'region-tree-open:' + picker.getAttribute('data-field');
  try {
    if (sessionStorage.getItem(key) === 'true') picker.open = true;
  } catch (e) { /* storage unavailable */ }
  picker.addEventListener('toggle', function () {
    try {
      sessionStorage.setItem(key, String(picker.open));
    } catch (e) { /* storage unavailable */ }
  });
});
