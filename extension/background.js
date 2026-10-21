chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'copied') {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
  } else if (msg?.type === 'error') {
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
  }
});
