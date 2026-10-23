// Shared by background.js and options.js: shortcut parsing, storage, sync mirror.
// Row: { u: url, k: shortcut (e.g. "Ctrl+Alt+K"), c: note }, kept in storage.local.rows.

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight",
]);

const MOD_NAMES = { ctrl: "ctrl", alt: "alt", shift: "shift", meta: "meta", win: "meta" };

const NAMED_CODES = [
  "Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote",
  "Comma", "Period", "Slash", "IntlBackslash", "ContextMenu", "PrintScreen", "ScrollLock", "Pause",
  "CapsLock", "NumLock", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
  "NumpadDecimal", "NumpadEnter", "MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious",
  "MediaStop", "AudioVolumeUp", "AudioVolumeDown", "AudioVolumeMute",
];
const CODE_BY_NAME = Object.fromEntries(NAMED_CODES.map(n => [n.toLowerCase(), n]));
const CODE_BY_CHAR = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
  "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash",
};

// Key name -> KeyboardEvent.code ("" if unknown). Shortcuts follow physical key position.
function toCode(p) {
  if (/^[a-z]$/i.test(p)) return "Key" + p.toUpperCase();
  if (/^\d$/.test(p)) return "Digit" + p;
  const l = p.toLowerCase();
  if (CODE_BY_NAME[l]) return CODE_BY_NAME[l];
  if (/^f([1-9]|1\d|2[0-4])$/.test(l)) return l.toUpperCase();
  if (/^numpad\d$/.test(l)) return "Numpad" + l.slice(-1);
  return CODE_BY_CHAR[p] || "";
}

// "alt + shift + 1" -> { ctrl, alt, shift, meta, code }, or null. Any modifier subset, one key.
function parseCombo(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  const c = { ctrl: false, alt: false, shift: false, meta: false, code: "" };
  for (const p of s.split("+").map(x => x.trim()).filter(Boolean)) {
    const m = MOD_NAMES[p.toLowerCase()];
    if (m) { c[m] = true; continue; }
    if (c.code) return null;
    c.code = toCode(p);
    if (!c.code) return null;
  }
  return c.code ? c : null;
}

function formatCombo(c) {
  const label = /^(Key[A-Z]|Digit\d)$/.test(c.code) ? c.code.slice(-1) : c.code;
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta", label].filter(Boolean).join("+");
}

const comboFromEvent = (e) =>
  ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code });

// ---- Rows ----
const tidy = (r) => {
  r ||= {};
  const c = parseCombo(r.k);
  return { u: String(r.u || "").trim(), k: c ? formatCombo(c) : "", c: String(r.c || "").trim() };
};
const isBlank = (r) => !r.u && !r.k && !r.c;
const syncSet = (o) => browser.storage.sync.set(o).catch(e => console.warn("sync mirror failed", e));

async function loadRows() {
  const { rows } = await browser.storage.local.get("rows");
  return Array.isArray(rows) ? rows.map(tidy) : [];
}

async function saveRows(rows) {
  const clean = rows.map(tidy).filter(r => !isBlank(r));
  await browser.storage.local.set({ rows: clean });
  await mirrorRows(clean);
}

// Backup copy in storage.sync as r1..rN (stale keys removed)
async function mirrorRows(rows) {
  try {
    const sync = browser.storage.sync;
    const set = Object.fromEntries(rows.map((r, i) => [`r${i + 1}`, r]));
    const stale = Object.keys(await sync.get(null)).filter(k => /^r\d+$/.test(k) && !(k in set));
    if (rows.length) await sync.set(set);
    if (stale.length) await sync.remove(stale);
  } catch (e) { console.warn("sync mirror failed", e); }
}

// Fill settings/extras from sync if missing locally. With no local rows, rebuild them
// from the sync mirror.
async function restore() {
  try {
    const local = browser.storage.local;
    const [cur, remote] = await Promise.all([
      local.get(["settings", "rows", "extras"]),
      browser.storage.sync.get(null),
    ]);
    const back = {};
    for (const k of ["settings", "extras"]) if (!cur[k] && remote[k]) back[k] = remote[k];
    if (Object.keys(back).length) await local.set(back);
    if (cur.rows !== undefined) return false;

    const rows = Object.keys(remote)
      .map(k => /^r(\d+)$/.exec(k))
      .filter(Boolean)
      .sort((a, b) => a[1] - b[1])
      .map(m => tidy(remote[m[0]]))
      .filter(r => !isBlank(r));
    if (!rows.length) return false;
    await local.set({ rows });
    return true;
  } catch (e) { console.warn("restore failed", e); return false; }
}

// ---- Extras ----
// { optionsKey: shortcut that opens the options page }, in storage.local.extras, mirrored to sync.
function tidyExtras(x) {
  const c = parseCombo(x && x.optionsKey);
  return { optionsKey: c ? formatCombo(c) : "" };
}

async function loadExtras() {
  return tidyExtras((await browser.storage.local.get("extras")).extras);
}

async function saveExtras(x) {
  x = tidyExtras(x);
  await browser.storage.local.set({ extras: x });
  await syncSet({ extras: x });
}

// Rows -> bindings for the privileged listener. Needs a URL and a valid shortcut; first duplicate wins.
// The options-page shortcut goes first and is sent as an action.
function buildBindings(rows, extras = {}) {
  const seen = new Set(), out = [];
  const oc = parseCombo(extras.optionsKey);
  if (oc) { seen.add(formatCombo(oc)); out.push({ ...oc, action: "options" }); }
  for (const r of rows) {
    const c = parseCombo(r.k), url = String(r.u || "").trim();
    if (!c || !url) continue;
    const id = formatCombo(c);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...c, url });
  }
  return out;
}

async function applyBindings() {
  if (!browser.urlShortcuts) {
    console.warn("urlShortcuts experiment API is not available");
    return false;
  }
  const { rows, extras } = await browser.storage.local.get(["rows", "extras"]);
  await browser.urlShortcuts.setBindings(buildBindings(Array.isArray(rows) ? rows : [], extras));
  return true;
}
