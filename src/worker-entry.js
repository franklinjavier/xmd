import puppeteer from '@cloudflare/puppeteer';
import { handle } from './worker.js';
import { USER_AGENT } from './version.js';
import { validateTarget, isBlockedHostSync } from './page.js';

export async function browserRender(env, url, { signal, validate } = {}) {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setRequestInterception(true);
    page.on('request', request => {
      Promise.resolve().then(async () => {
        const reqUrl = request.url();
        let parsed;
        try { parsed = new URL(reqUrl); }
        catch { await request.abort(); return; }
        const protocol = parsed.protocol;
        if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'data:' && protocol !== 'blob:') {
          await request.abort();
          return;
        }
        if (protocol === 'http:' || protocol === 'https:') {
          if (isBlockedHostSync(reqUrl)) { await request.abort(); return; }
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            try { await (validate ?? (u => validateTarget(u)))(reqUrl); }
            catch { await request.abort(); return; }
          }
        }
        await request.continue();
      }).catch(() => request.abort().catch(() => {}));
    });
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const rendered = page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 }).then(() => page.content());
    if (!signal) return await rendered;
    return await Promise.race([
      rendered,
      new Promise((_, reject) => {
        const onAbort = () => reject(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        rendered.finally(() => signal.removeEventListener('abort', onAbort));
      }),
    ]);
  } catch (err) {
    console.error('xmd browser error', err?.name, String(err?.message || err).slice(0, 500));
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx, {
      cache: globalThis.caches?.default,
      browserRender: (url, opts) => browserRender(env, url, opts),
    });
  },
};
