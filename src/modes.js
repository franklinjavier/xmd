import * as api from './fetch.js';
import { NotFoundError } from './fetch.js';
import { parseUrl, validId } from './parse-url.js';
import { formatPost, formatReference, cleanHandle } from './format.js';
export const modes = ['post', 'thread', 'ancestors', 'replies'];
const handle = s => (typeof s.author?.screen_name === 'string' ? s.author.screen_name.trim() : '').toLowerCase();
async function walk(id, fetcher) {
  const posts = [await fetcher.fetchStatus(id)];
  const seen = new Set([String(id)]);
  let note = '';
  for (let hop = 0; hop < 32; hop++) {
    const parent = posts.at(-1).replying_to?.status;
    if (!parent) break;
    if (!validId(parent)) { note = '_(malformed parent id; ancestor walk stopped)_'; break; }
    if (seen.has(parent)) { note = '_(ancestor cycle detected)_'; break; }
    seen.add(String(parent));
    try { posts.push(await fetcher.fetchStatus(parent)); }
    catch (error) { if (!(error instanceof NotFoundError)) throw error; note = `_(parent ${parent} unavailable)_`; break; }
    if (hop === 31 && posts.at(-1).replying_to?.status) note = '_(ancestor limit reached: 32 hops)_';
  }
  return { posts: posts.reverse(), note };
}
async function renderReplies(id, fetcher) {
  const data = await fetcher.fetchConversation(id);
  const linked = data.status && validId(data.status.id) && data.status.id === id ? data.status : await fetcher.fetchStatus(id);
  if (!validId(linked?.id) || linked.id !== id) throw new api.NetworkError('Invalid linked post id');
  const unique = new Map();
  for (const s of Array.isArray(data.replies) ? data.replies : []) {
    if (s && validId(s.id) && s.id !== id && validId(s.replying_to?.status) && !unique.has(s.id)) unique.set(s.id, s);
  }
  const connected = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of unique.values()) if (!connected.has(s.id) && connected.has(s.replying_to.status)) {
      connected.add(s.id);
      changed = true;
    }
  }
  const descendants = [...unique.values()].filter(s => connected.has(s.id)).sort((a,b) => (Number(a.created_timestamp) || 0) - (Number(b.created_timestamp) || 0));
  const posts = [linked, ...descendants];
  const blocks = [`## Replies to @${cleanHandle(linked.author?.screen_name) || 'unknown'}`,
    ...posts.map((s,i) => formatPost(s, `${i+1}/${posts.length}`, { compact: true }))];
  if (!descendants.length) blocks.push('_(no replies returned)_');
  blocks.push('## References', posts.map((s,i) => formatReference(s, i+1)).join('\n'));
  if (data.cursor?.bottom) blocks.push('_(more replies may exist; FxTwitter conversation is not paginated in xmd)_');
  return blocks.join('\n\n') + '\n';
}
export async function render(input, mode = 'post', fetcher = api, { signal } = {}) {
  if (signal) {
    const source = fetcher;
    fetcher = Object.fromEntries(['fetchStatus', 'fetchThread', 'fetchConversation'].filter(k => source[k]).map(k => [k, id => { signal.throwIfAborted(); return source[k](id, signal); }]));
  }
  if (!modes.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const { id } = parseUrl(input);
  if (mode === 'replies') return renderReplies(id, fetcher);
  if (mode === 'post') return formatPost(await fetcher.fetchStatus(id)) + '\n';
  const { posts: chain, note } = await walk(id, fetcher);
  const root = chain[0];
  let posts = chain;
  const intro = [note];
  if (mode === 'thread') {
    if (!handle(root)) throw new api.NetworkError('Root author handle is missing');
    const result = await fetcher.fetchThread(root.id);
    let candidates = result.thread || [];
    if (!candidates.some(s => String(s.id) !== String(root.id) && handle(s) === handle(root)) && fetcher.fetchConversation) {
      const conversation = await fetcher.fetchConversation(root.id);
      candidates = [...candidates, ...(conversation.thread || [])];
    }
    const unique = new Map([[String(root.id), root]]);
    for (const s of [...chain, ...candidates]) if (validId(s.id) && handle(s) && handle(s) === handle(root)) unique.set(String(s.id), s);
    // Only retain self-replies connected to the root, never replies via another author.
    const connected = new Set([String(root.id)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of unique.values()) if (!connected.has(String(s.id)) && connected.has(String(s.replying_to?.status)) && (!s.replying_to?.screen_name || String(s.replying_to.screen_name).toLowerCase() === handle(root))) { connected.add(String(s.id)); changed = true; }
    }
    posts = [...unique.values()].filter(s => connected.has(String(s.id))).sort((a,b) => (Number(a.created_timestamp) || 0) - (Number(b.created_timestamp) || 0));
    intro.push(`## Thread by @${cleanHandle(root.author?.screen_name) || 'unknown'}`);
    const inputPost = chain.at(-1);
    if (handle(inputPost) !== handle(root)) intro.push(`_(input was by @${cleanHandle(inputPost.author?.screen_name) || 'unknown'})_`);
  } else intro.push(`## Reply chain (${posts.length} posts)`);
  return intro.filter(Boolean).join('\n\n') + '\n\n' + posts.map((s,i) => formatPost(s, `${i+1}/${posts.length}`)).join('\n\n---\n\n') + '\n';
}
export const post = (input, fetcher) => render(input, 'post', fetcher);
export const ancestors = (input, fetcher) => render(input, 'ancestors', fetcher);
export const thread = (input, fetcher) => render(input, 'thread', fetcher);
export const replies = (input, fetcher) => render(input, 'replies', fetcher);
