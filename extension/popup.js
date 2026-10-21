// clipboardWrite: https://developer.chrome.com/docs/extensions/reference/permissions-list
// Offscreen CLIPBOARD needs the "offscreen" permission and offscreen docs can't be focused; we don't use it:
// https://developer.chrome.com/docs/extensions/reference/api/offscreen
// Official sample copies with a textarea + document.execCommand('copy'):
// https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write
// Prefer execCommand first: writeText can resolve then be lost when tabs.create closes the popup.
// Chrome: navigator.clipboard needs document focus; writeText is the fallback, then wait 250ms:
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard
// tabs.create needs no "tabs" permission (that permission only gates url/pendingUrl/title/favIconUrl in tabs.query):
// https://developer.chrome.com/docs/extensions/reference/api/tabs
import { xmdLink } from './link.js';
import { copyText } from './clipboard.js';

const XMD_BASE = 'https://xmd.imfrank.dev';

const statusEl = document.getElementById('status');
const linkEl = document.getElementById('link');
const noteEl = document.getElementById('note');

async function main() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = undefined;
  }
  const link = xmdLink(tab?.url, XMD_BASE);
  if (!link) {
    statusEl.textContent = 'Open a web page first';
    statusEl.classList.add('err');
    chrome.runtime.sendMessage({ type: 'error' });
    return;
  }
  const copied = await copyText(link);
  linkEl.textContent = link;
  if (copied) {
    statusEl.textContent = 'Copied';
    chrome.runtime.sendMessage({ type: 'copied' });
  } else {
    noteEl.textContent = 'copy failed — select and copy manually';
  }
  try {
    await chrome.tabs.create({ url: link });
  } catch {
    // Keep the popup open with the link if the tab cannot be opened.
  }
}

main();
