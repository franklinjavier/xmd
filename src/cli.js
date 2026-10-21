import { render, modes } from './modes.js';
import { parseUrl } from './parse-url.js';
import { NotFoundError, NetworkError } from './fetch.js';
import { renderPage, normalizeTargetUrl, BlockedTargetError, UnsupportedTypeError } from './page.js';
import { sanitizeTerminal } from './sanitize-terminal.js';
export const help = 'Usage: xmd <x-post-url|id|any-url> [--mode post|thread|ancestors|replies] [--raw]\nOptions: -m, --mode MODE; --raw (keep terminal escapes); -h, --help';
export async function main(args = process.argv.slice(2)) {
  let validated = false;
  const onWriteError = error => { console.error(sanitizeTerminal(`xmd: ${error.message}`)); process.exitCode = 1; };
  process.stdout.on('error', onWriteError);
  try {
    let mode = 'post';
    let input;
    let raw = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-h' || arg === '--help') { console.log(help); return; }
      if (arg === '--raw') { raw = true; continue; }
      if (arg === '-m' || arg === '--mode') { if (!args[i+1] || args[i+1].startsWith('-')) throw new Error('Missing mode value'); mode = args[++i]; continue; }
      if (arg.startsWith('--mode=')) { mode = arg.slice(7); continue; }
      if (arg.startsWith('-') || input !== undefined) throw new Error(help);
      input = arg;
    }
    if (!modes.includes(mode)) throw new Error('Invalid mode; choose post, thread, ancestors, or replies');
    let markdown;
    let isPost = false;
    let parseError;
    try { parseUrl(input); isPost = true; } catch (error) { parseError = error; }
    if (isPost) {
      validated = true;
      markdown = await render(input, mode);
    } else if (typeof input === 'string' && input.trim()) {
      markdown = await renderPage(normalizeTargetUrl(input).href);
    } else {
      throw parseError || new Error(help);
    }
    const out = raw ? markdown : sanitizeTerminal(markdown);
    await new Promise((resolve, reject) => process.stdout.write(out, error => error ? reject(error) : resolve()));
  } catch (error) {
    console.error(sanitizeTerminal(`xmd: ${error.message}`));
    process.exitCode = error instanceof UnsupportedTypeError ? 5 : error instanceof NotFoundError ? 3 : error instanceof NetworkError ? 4 : error instanceof BlockedTargetError || !validated ? 2 : 1;
  }
}
