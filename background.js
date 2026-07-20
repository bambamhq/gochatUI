// OpenCode Go Chat — service worker
// Clicking the toolbar icon injects (or toggles) the floating chat window
// on the active tab. Falls back to a standalone popup window on pages
// where content scripts cannot run (chrome://, Web Store, PDF viewer…).

const FLOAT_SCRIPT = 'content/float.js';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [FLOAT_SCRIPT],
    });
  } catch (err) {
    openFallbackWindow();
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'oc-toggle' });
  } catch (err) {
    // Listener not ready yet (race on first injection) — next click works.
  }
});

function openFallbackWindow() {
  try {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 440,
      height: 700,
      focused: true,
    });
  } catch (_) {}
}
