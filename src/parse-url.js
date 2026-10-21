export const validId = id => typeof id === 'string' && /^\d{1,25}$/.test(id);
export function parseUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Expected an X post URL or numeric id');
  const value = input.trim();
  if (validId(value)) return { id: value, user: null };
  let url;
  try { url = new URL(value.startsWith('/') ? `https://x.com${value}` : /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new Error('Invalid X post URL'); }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['x.com', 'twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com'].includes(host) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Unsupported X post URL');
  const match = url.pathname.match(/^\/(?:([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)|i\/web\/status\/(\d+))(?:\/(?:photo|video)\/\d+)?\/?$/);
  if (!match || !validId(match[2] || match[3])) throw new Error('Expected /user/status/id in X post URL');
  return { id: match[2] || match[3], user: match[1] || null };
}
