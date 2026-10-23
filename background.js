// Push saved shortcuts to the privileged listener on startup and on change.
restore().then(applyBindings).catch(console.error);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.rows || changes.extras)) applyBindings().catch(console.error);
});
