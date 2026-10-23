Firefox Extension for URL Shortcut Keybinds

Shortcuts are handled by a privileged listener on the browser window (parent.js), so they work on every page, including about:newtab, and while the URL bar has focus.

Requires Extension Experiment API: about:config -> set extensions.experiments.enabled = true