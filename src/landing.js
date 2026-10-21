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
h2 {
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
