# xmd Chrome extension

Copies an `https://xmd.imfrank.dev/?url=...` link for the current tab so you can render that page as Markdown.

## Install

Not on the Chrome Web Store.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select this `extension/` folder

Click the toolbar icon on an http(s) page. The popup copies the xmd link and opens it in a new tab.

## Permissions

- `activeTab` — read the current tab URL only when you click the icon
- `clipboardWrite` — put the link on the clipboard

Permissions are unchanged. No `scripting`, host, or `tabs` permissions: the URL is read in the popup after the click, `tabs.create` does not need the `tabs` permission, and the copy runs in the popup.

## Self-host

The link uses `https://xmd.imfrank.dev`. To point at your own origin, change `XMD_BASE` at the top of `popup.js`.
