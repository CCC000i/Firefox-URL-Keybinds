const DEFAULTS = { bg: "#000", active: "#E0E0E0", cleared: "#555" };
const CSS_VARS = { bg: "--bg", active: "--fg", cleared: "--dim" };
const $ = (id) => document.getElementById(id);
const rows = $("rows"), msg = $("msg"), optionsKey = $("optionsKey");
const settingsBox = $("settings"), settingsBtn = $("settingsBtn");
const extrasBox = $("extras"), extrasBtn = $("extrasBtn");
const hexInputs = [...settingsBox.querySelectorAll("input")];

let model = [];                       // rows, incl. blank just-added ones (not persisted)
let settings = { ...DEFAULTS };
let extras = { optionsKey: "" };

// Serialize storage writes (blur-triggered "change" vs. button clicks)
let q = Promise.resolve();
const run = (f) => (q = q.then(f).catch(e => { msg.textContent = e.message; }));
const persist = () => saveRows(model);

// ---- Rows ----
function build() {
  const tpl = $("row").content.firstElementChild;
  const frag = document.createDocumentFragment();
  model.forEach((r, i) => {
    const tr = tpl.cloneNode(true);
    tr.dataset.i = i;
    const f = (c) => tr.querySelector("." + c);
    f("url").value = r.u;
    f("key").value = r.k;
    f("note").value = r.c;
    f("pos").value = i + 1;
    f("pos").max = model.length;
    refresh(tr);
    frag.appendChild(tr);
  });
  rows.replaceChildren(frag);
}

// Row is "empty" (cleared color) when URL, shortcut and note are all blank
const refresh = (tr) =>
  tr.classList.toggle("empty", ![".url", ".key", ".note"].some(c => tr.querySelector(c).value.trim()));

// Move a row to index `to`, rebuild, refocus the same control
const go = (item, to, sel) => run(async () => {
  const from = model.indexOf(item);
  to = Math.max(0, Math.min(model.length - 1, to));
  if (from < 0) return;
  if (from === to) { rows.children[from].querySelector(".pos").value = from + 1; return; }
  model.splice(to, 0, ...model.splice(from, 1));
  build();
  rows.children[to].querySelector(sel).focus();
  await persist();
});

// Record a combo pressed in a shortcut box. Only Ctrl/Alt/Meta combos and F-keys are
// captured, so plain typing still works.
function capture(e, el) {
  if (!e.code || e.code === "Unidentified" || MODIFIER_CODES.has(e.code)) return;
  if (!(e.ctrlKey || e.altKey || e.metaKey || /^F\d{1,2}$/.test(e.code))) return;
  e.preventDefault();
  el.value = formatCombo(comboFromEvent(e));
  const tr = el.closest("tr");
  if (tr) refresh(tr);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Normalized shortcut, or null (with a message) if invalid or taken. `item` is the row being
// edited, or null for the options-page shortcut.
function checkKey(v, item) {
  const fail = (t) => { msg.textContent = t; return null; };
  const c = parseCombo(v);
  if (!c) return fail(`Unrecognized shortcut "${v}".`);
  const k = formatCombo(c);
  const dup = model.findIndex(r => r !== item && r.k === k);
  if (dup >= 0) return fail(`${k} is already used by row ${dup + 1}.`);
  if (item && k === extras.optionsKey) return fail(`${k} is already used by "Open options page" in Extras.`);
  return k;
}

// Pause the privileged listener only while a shortcut box has focus, so keys can be recorded
const pause = (on) => browser.urlShortcuts?.setPaused(on).catch(() => {});
document.addEventListener("focusin",  (e) => { if (e.target.classList.contains("key")) pause(true); });
document.addEventListener("focusout", (e) => { if (e.target.classList.contains("key")) pause(false); });
addEventListener("pagehide", () => pause(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(false); });

rows.addEventListener("input", (e) => refresh(e.target.closest("tr")));

rows.addEventListener("change", (e) => {
  const el = e.target, tr = el.closest("tr"), item = model[+tr.dataset.i];
  if (!item) return;
  if (el.classList.contains("url")) run(() => { item.u = el.value.trim(); return persist(); });
  else if (el.classList.contains("note")) run(() => { item.c = el.value.trim(); return persist(); });
  else if (el.classList.contains("key")) run(async () => {
    msg.textContent = "";
    const v = el.value.trim();
    const k = v ? checkKey(v, item) : "";
    el.value = k ?? item.k;
    refresh(tr);
    if (k === null || k === item.k) return;
    item.k = k;
    await persist();
  });
});

rows.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const i = +b.closest("tr").dataset.i, item = model[i];
  if (!item) return;
  if (b.classList.contains("up")) go(item, i - 1, ".up");
  else if (b.classList.contains("dn")) go(item, i + 1, ".dn");
  else if (b.classList.contains("rm")) run(async () => {
    const at = model.indexOf(item);
    if (at < 0) return;
    model.splice(at, 1);
    build();
    await persist();
    const next = rows.children[Math.min(at, model.length - 1)];
    (next ? next.querySelector(".rm") : $("add")).focus();
  });
});

rows.addEventListener("keydown", (e) => {
  const el = e.target;
  if (el.classList.contains("key")) return capture(e, el);
  if (e.key !== "Enter" || !el.classList.contains("pos")) return;
  e.preventDefault();
  const i = +el.closest("tr").dataset.i, to = parseInt(el.value, 10);
  if (!to) el.value = i + 1; else go(model[i], to - 1, ".pos");
});

$("add").addEventListener("click", () => run(async () => {
  model.push({ u: "", k: "", c: "" });
  build();
  rows.lastElementChild.querySelector(".url").focus();
}));

// ---- Settings ----
function normalizeHex(s) {
  s = String(s || "").trim();
  if (s && s[0] !== "#") s = "#" + s;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : null;
}
const mergeSettings = (raw = {}, base = DEFAULTS) =>
  Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, normalizeHex(raw[k]) || base[k]]));

async function loadSettings() {
  return mergeSettings((await browser.storage.local.get("settings")).settings);
}

function applySettings(s) {
  settings = s;
  for (const [k, v] of Object.entries(CSS_VARS)) document.documentElement.style.setProperty(v, s[k]);
  for (const inp of hexInputs) {
    inp.value = s[inp.dataset.key];
    inp.nextElementSibling.style.background = s[inp.dataset.key];
  }
}

async function updateSettings(s) {
  applySettings(s);
  await browser.storage.local.set({ settings: s });
  await syncSet({ settings: s });
}

for (const inp of hexInputs) {
  inp.addEventListener("input", () => {
    const v = normalizeHex(inp.value);
    if (v) inp.nextElementSibling.style.background = v;
  });
  inp.addEventListener("change", () => run(async () => {
    msg.textContent = "";
    const v = normalizeHex(inp.value);
    if (!v) {
      msg.textContent = "Invalid color. Use hex like #000 or #E0E0E0.";
      applySettings(settings);
      return;
    }
    await updateSettings({ ...settings, [inp.dataset.key]: v });
  }));
}

$("restore-colors").addEventListener("click", () => run(() => {
  msg.textContent = "";
  return updateSettings({ ...DEFAULTS });
}));

// Collapsible panels: toggle the box and flip the arrow
function togglePanel(btn, box) {
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", open);
  btn.querySelector("span").innerHTML = open ? "▴" : "▸";
}
settingsBtn.addEventListener("click", () => togglePanel(settingsBtn, settingsBox));
extrasBtn.addEventListener("click", () => togglePanel(extrasBtn, extrasBox));

// ---- Extras ----
extrasBox.addEventListener("keydown", (e) => { if (e.target === optionsKey) capture(e, optionsKey); });

// The privileged listener resolves the options page URL itself, so this survives UUID changes
optionsKey.addEventListener("change", () => run(async () => {
  msg.textContent = "";
  const v = optionsKey.value.trim();
  const k = v ? checkKey(v, null) : "";
  optionsKey.value = k ?? extras.optionsKey;
  if (k === null || k === extras.optionsKey) return;
  extras = { optionsKey: k };
  await saveExtras(extras);
}));

// ---- Backup ----
$("export").addEventListener("click", () => {
  const data = { version: 2, rows: model.map(tidy).filter(r => !isBlank(r)), settings, extras };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "url-shortcuts-backup.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  run(async () => {
    msg.textContent = "";
    try {
      const d = JSON.parse(await file.text());
      const raw = Array.isArray(d.rows) ? d.rows : [];
      const lost = raw.filter(r => r?.k && !tidy(r).k).length;
      model = raw.map(tidy).filter(r => !isBlank(r));
      await saveRows(model);
      if (d.settings) await updateSettings(mergeSettings(d.settings, settings));
      if (d.extras) {
        extras = tidyExtras(d.extras);
        await saveExtras(extras);
        optionsKey.value = extras.optionsKey;
      }
      build();
      if (lost) msg.textContent = `${lost} shortcut(s) in the backup could not be read and were skipped.`;
    } catch (err) {
      msg.textContent = `Import failed: ${err.message}`;
    }
  });
});

// ---- Misc ----
// about: links open through the privileged API; copy the URL if it isn't loaded
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.about");
  if (!a) return;
  e.preventDefault();
  const url = a.getAttribute("href");
  if (browser.urlShortcuts) browser.urlShortcuts.openUrl(url).catch(console.error);
  else navigator.clipboard.writeText(url).then(() => { msg.textContent = `API not loaded. Copied ${url}, paste it into the address bar.`; });
});

// Warn if the privileged listener isn't running
async function checkListener() {
  if (!browser.urlShortcuts) {
    msg.textContent = "The privileged shortcut API is not loaded, so shortcuts will not work. " +
      "Set extensions.experiments.enabled to true in about:config, then reload the extension.";
    return;
  }
  const { windows } = await browser.urlShortcuts.getStatus();
  if (!windows) msg.textContent = "The shortcut listener is not attached to any browser window.";
}

(async () => {
  await restore();
  applySettings(await loadSettings());
  model = await loadRows();
  extras = await loadExtras();
  optionsKey.value = extras.optionsKey;
  build();
  await checkListener();
})();