// Copy with textarea + execCommand first: navigator.clipboard.writeText can resolve
// then be discarded when the popup closes on chrome.tabs.create. The official sample
// uses the same sync path: https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write

function waitForFocus(ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      resolve();
    };
    const onFocus = () => finish();
    const timer = setTimeout(finish, ms);
    window.addEventListener('focus', onFocus, { once: true });
  });
}

function copyWithExecCommand(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand('copy') === true;
  } finally {
    ta.remove();
  }
}

export async function copyText(text) {
  try {
    try { window.focus(); } catch {}
    if (!document.hasFocus()) await waitForFocus(300);
    try {
      if (copyWithExecCommand(text) === true) return true;
    } catch {}
    await navigator.clipboard.writeText(text);
    await new Promise(resolve => setTimeout(resolve, 250));
    return true;
  } catch {
    return false;
  }
}
