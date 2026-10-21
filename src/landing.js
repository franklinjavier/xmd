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
<meta name="theme-color" content="#0a0b0d">
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
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: #0a0b0d;
  color: #e6e8ec;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif;
}
body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
main {
  width: 100%;
  max-width: 640px;
  background: #141518;
  border: 1px solid #23252a;
  border-radius: 16px;
  padding: 32px;
}
header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
header img { display: block; border-radius: 16px; }
h1 { margin: 0; font-size: 1.75rem; font-weight: 650; letter-spacing: -0.02em; }
.lede { margin: 0 0 1.5rem; color: #c5c9d1; }
h2 {
  margin: 1.25rem 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #9aa3ad;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
pre {
  margin: 0;
  background: #0a0b0d;
  border: 1px solid #23252a;
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: #e6e8ec;
}
footer { margin-top: 1.75rem; }
a { color: #2e8cff; }
</style>
</head>
<body>
<main>
<header>
<img src="/icon-512.png" width="72" height="72" alt="xmd">
<h1>xmd</h1>
</header>
<p class="lede">Turn any link (X posts included) into clean Markdown.</p>
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
</body>
</html>
`;
