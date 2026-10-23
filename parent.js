"use strict";

/* global ExtensionAPI, Services */

// Privileged half of the extension. Listens for keydown in the capture phase on every
// browser window's chrome document. Chrome sees keys before any page does, so this
// works on websites, about:newtab, other about: pages, view-source:, the PDF viewer,
// and while the URL bar has focus.

// Treated as a URL scheme: "about:config", "https://x", "mailto:a@b".
// "localhost:3000" and "example.com:80" are not (a digit follows the colon).
const SCHEME = /^[a-z][a-z0-9+.-]*:(\/\/|[^\d\/]|$)/i;

const keyOf = (ctrl, alt, shift, meta, code) =>
  (ctrl ? "C" : "") + (alt ? "A" : "") + (shift ? "S" : "") + (meta ? "M" : "") + "|" + code;

this.urlShortcuts = class extends ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.map = new Map();       // combo key -> url
    this.paused = false;        // true while a shortcut box on the options page has focus
    this.windows = new Set();
    this.inited = false;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.observer = {
      observe: (subject, topic) => {
        if (topic === "domwindowopened") this.watch(subject);
      },
    };
  }

  onStartup() { this.init(); }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    try { Services.ww.unregisterNotification(this.observer); } catch (e) {}
    for (const win of this.windows) {
      try { win.removeEventListener("keydown", this.onKeyDown, true); } catch (e) {}
    }
    this.windows.clear();
    this.map.clear();
    this.paused = false;
    this.inited = false;
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }

  init() {
    if (this.inited) return;
    this.inited = true;
    for (const win of Services.wm.getEnumerator("navigator:browser")) this.watch(win);
    Services.ww.registerNotification(this.observer);
  }

  watch(win) {
    const attach = () => {
      if (this.windows.has(win)) return;
      if (win.document.documentElement.getAttribute("windowtype") !== "navigator:browser") return;
      win.addEventListener("keydown", this.onKeyDown, true);
      win.addEventListener("unload", () => this.windows.delete(win), { once: true });
      this.windows.add(win);
    };
    if (win.document.readyState === "complete") attach();
    else win.addEventListener("load", attach, { once: true });
  }

  setBindings(list) {
    const map = new Map();
    for (const b of list || []) {
      if (!b || !b.code || !(b.url || b.action)) continue;
      const k = keyOf(b.ctrl, b.alt, b.shift, b.meta, b.code);
      if (!map.has(k)) map.set(k, b.action ? { action: b.action } : { url: b.url });
    }
    this.map = map;
  }

  onKeyDown(e) {
    if (!this.map.size || e.isComposing || !e.code) return;
    const hit = this.map.get(keyOf(e.ctrlKey, e.altKey, e.shiftKey, e.metaKey, e.code));
    if (!hit) return;
    const win = e.currentTarget;
    if (this.paused) {
      // The options page reports a focused shortcut box. Only honor that while the options
      // page is the selected tab, so a missed blur can never disable shortcuts elsewhere.
      try {
        const spec = win.gBrowser.selectedBrowser.currentURI.spec;
        if (spec.startsWith(this.extension.getURL("options.html"))) return;
      } catch (err) {}
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (hit.action === "options") this.openOptions(win);
    else if (hit.url) this.open(win, hit.url);
  }

  // Open this extension's options page. The URL is resolved here at runtime, so it stays
  // correct when the moz-extension UUID changes. An already-open options tab is reused.
  openOptions(win) {
    const base = this.extension.getURL("options.html");
    try {
      for (const tab of win.gBrowser.tabs) {
        if (tab.linkedBrowser.currentURI.spec.split(/[?#]/)[0] === base) {
          win.gBrowser.selectedTab = tab;
          return;
        }
      }
    } catch (err) {}
    this.open(win, base);
  }

  open(win, raw) {
    let url = raw.trim();
    if (!SCHEME.test(url)) url = "https://" + url;
    if (/^javascript:/i.test(url)) return;
    try {
      win.openTrustedLinkIn(url, "tab", { inBackground: false });
    } catch (err) {
      try {
        const tab = win.gBrowser.addTab(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        win.gBrowser.selectedTab = tab;
      } catch (err2) {
        Services.console.logStringMessage("URL Shortcuts: could not open " + url + ": " + err2);
      }
    }
  }

  getAPI() {
    this.init();
    return {
      urlShortcuts: {
        setBindings: async (list) => { this.setBindings(list); },
        setPaused: async (paused) => { this.paused = !!paused; },
        openUrl: async (url) => {
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (win) this.open(win, url);
        },
        getStatus: async () => ({ windows: this.windows.size, bindings: this.map.size }),
      },
    };
  }
};
