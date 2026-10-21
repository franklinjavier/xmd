import { createHash } from 'node:crypto';
import { parseUrl, validId } from './parse-url.js';

const MODE_HINTS = {
  post: 'Just this post.',
  thread: "The author's own thread, root first.",
  replies: 'This post, then the replies under it.',
  ancestors: 'The posts it replies to, root first.',
};

// Same X detection as the server: parseUrl runs in the page.
const LANDING_SCRIPT = `
const validId = ${validId};
${parseUrl}
const HINTS = ${JSON.stringify(MODE_HINTS)};
const form = document.getElementById('try');
const input = document.getElementById('try-url');
const modes = document.getElementById('try-modes');
const hint = document.getElementById('try-hint');
function sync() {
  let x = false;
  try { parseUrl(input.value); x = true; } catch {}
  modes.hidden = !x;
  modes.disabled = !x;
  hint.textContent = HINTS[form.elements.mode.value];
}
input.addEventListener('input', sync);
modes.addEventListener('change', sync);
form.addEventListener('submit', () => {
  // post is the default; keep the opened URL short.
  if (form.elements.mode.value === 'post') {
    modes.disabled = true;
    setTimeout(sync);
  }
});
addEventListener('pageshow', sync);
sync();
`;

export const LANDING_SCRIPT_HASH = `sha256-${createHash('sha256').update(LANDING_SCRIPT).digest('base64')}`;

export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xmd: links to clean Markdown</title>
<meta name="description" content="Turn any link (X posts included) into clean Markdown.">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#fdfdfd">
<meta property="og:title" content="xmd: links to clean Markdown">
<meta property="og:description" content="Turn any link (X posts included) into clean Markdown.">
<meta property="og:url" content="https://xmd.imfrank.dev/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="xmd">
<meta property="og:image" content="https://xmd.imfrank.dev/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="xmd: links to clean Markdown">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="xmd: links to clean Markdown">
<meta name="twitter:description" content="Turn any link (X posts included) into clean Markdown.">
<meta name="twitter:image" content="https://xmd.imfrank.dev/og.png">
<style>
:root {
  color-scheme: light;
  --background: oklch(0.995 0 0);
  --foreground: oklch(0.18 0.005 286);
  --muted: oklch(0.955 0.004 286);
  --muted-foreground: oklch(0.55 0.012 286);
  --faint-foreground: oklch(0.7 0.01 286);
  --border: oklch(0.915 0.005 286);
  --input: oklch(0.9 0.005 286);
  --brand: oklch(0.18 0.005 286);
  --brand-foreground: oklch(0.99 0 0);
  --ring: oklch(0.705 0.015 286);
  --radius: 0.625rem;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font: 14px/1.65 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
}
main { width: 100%; max-width: 560px; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
header img { display: block; width: 40px; height: 40px; border-radius: calc(var(--radius) * 1.4); }
h1 { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 500; letter-spacing: -0.02em; }
.lede { margin: 0 0 32px; color: var(--muted-foreground); font-size: 15px; }
h2, .modes legend {
  margin: 24px 0 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 16px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
pre {
  margin: 0;
  background: color-mix(in oklch, var(--muted) 25%, transparent);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 1.4);
  padding: 12px 16px;
  overflow-x: auto;
}
code {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--foreground);
}
footer { margin-top: 32px; font-size: 13px; }
a {
  color: var(--muted-foreground);
  text-decoration: underline;
  text-decoration-color: var(--border);
  text-underline-offset: 3px;
  transition: color 0.2s, text-decoration-color 0.2s;
}
a:hover { color: var(--foreground); text-decoration-color: var(--ring); }
a:focus-visible { outline: 2px solid color-mix(in oklch, var(--ring) 50%, transparent); outline-offset: 2px; border-radius: 4px; }
.try { display: flex; flex-direction: column; gap: 12px; margin-bottom: 8px; }
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 16px;
  border: 1px solid var(--input);
  border-radius: calc(var(--radius) * 1.8);
  background: var(--background);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.field:focus-within { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 25%, transparent); }
.field input {
  flex: 1;
  min-width: 0;
  height: 36px;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
  color: var(--foreground);
  font: inherit;
}
@media (pointer: coarse) { .field input { font-size: 16px; } }
.field input::placeholder { color: var(--faint-foreground); }
.field button {
  flex: none;
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--brand);
  color: var(--brand-foreground);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}
.field button:hover { opacity: 0.85; }
.field button:focus-visible { outline: 2px solid color-mix(in oklch, var(--ring) 50%, transparent); outline-offset: 2px; }
.modes { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.try h2 { margin: 0; }
.modes[hidden] { display: none; }
.modes legend { padding: 0; margin: 4px 0 8px; }
.segmented {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 3px;
  border-radius: 999px;
  background: var(--muted);
}
.segmented label { position: relative; }
.segmented input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.segmented span {
  display: block;
  padding: 4px 8px;
  border-radius: 999px;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground);
  transition: color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.segmented input:checked + span { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px oklch(0.18 0.01 286 / 0.08); }
.segmented input:hover:not(:checked) + span { color: var(--foreground); }
.segmented input:focus-visible + span { outline: 2px solid color-mix(in oklch, var(--ring) 50%, transparent); outline-offset: 1px; }
.hint { margin: 0; font-size: 13px; color: var(--faint-foreground); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
<header>
<img src="/icon-512.png" width="72" height="72" alt="xmd">
<h1>xmd</h1>
</header>
<p class="lede">Turn any link (X posts included) into clean Markdown.</p>
<form class="try" id="try" action="/" method="get" target="_blank" rel="noopener">
<h2><label for="try-url">Try it</label></h2>
<div class="field">
<input id="try-url" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste a link" required>
<button type="submit">Open</button>
</div>
<fieldset class="modes" id="try-modes" hidden disabled>
<legend>X mode</legend>
<div class="segmented">
<label><input type="radio" name="mode" value="post" checked><span>Post</span></label>
<label><input type="radio" name="mode" value="thread"><span>Thread</span></label>
<label><input type="radio" name="mode" value="replies"><span>Replies</span></label>
<label><input type="radio" name="mode" value="ancestors"><span>Ancestors</span></label>
</div>
<p class="hint" id="try-hint"></p>
</fieldset>
</form>
<h2>Web</h2>
<pre><code>https://xmd.imfrank.dev/?url=&lt;link&gt;</code></pre>
<h2>CLI</h2>
<pre><code>bun add -g github:franklinjavier/xmd
xmd &lt;link&gt;</code></pre>
<h2>X modes</h2>
<pre><code>https://xmd.imfrank.dev/?url=&lt;x-link&gt;&amp;mode=thread|replies|ancestors</code></pre>
<h2>Chrome extension</h2>
<pre><code>curl -fsSL https://xmd.imfrank.dev/extension.sh | sh</code></pre>
<footer><a href="https://github.com/franklinjavier/xmd">Source &amp; Chrome extension on GitHub</a></footer>
</main>
<script>${LANDING_SCRIPT}</script>
</body>
</html>
`;
