import { xmdLink } from './link.js';

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
  try {
    await navigator.clipboard.writeText(link);
    statusEl.textContent = 'Copied';
    linkEl.textContent = link;
    chrome.runtime.sendMessage({ type: 'copied' });
    setTimeout(() => window.close(), 900);
  } catch {
    linkEl.textContent = link;
    noteEl.textContent = 'copy failed — select and copy manually';
  }
}

main();
