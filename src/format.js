export function fullText(status) {
  return [status?.text, status?.raw_text?.text].filter(v => typeof v === 'string' && v.trim()).sort((a, b) => b.length - a.length)[0] || '';
}
export const cleanName = value => String(value || '').replace(/[\[\]()*_`#<>\\]/g, '').replace(/\s+/g, ' ').trim();
export const cleanHandle = value => String(value || '').replace(/[^A-Za-z0-9_]/g, '');
export function safeUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return value.replace(/[\s()\\<>\x00-\x1f\x7f]/g, c => encodeURIComponent(c).replace(/\(/g, '%28').replace(/\)/g, '%29'));
  } catch { return ''; }
}
function permalink(s) {
  return /^\d{1,25}$/.test(String(s.id)) ? `https://x.com/${cleanHandle(s.author?.screen_name) || 'i'}/status/${s.id}` : '';
}
export function formatPost(s, position = '', { compact = false } = {}) {
  const author = s.author || {};
  const date = new Date(s.created_at || Number(s.created_timestamp) * 1000);
  const stamp = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const blocks = [`### ${position ? position + ' · ' : ''}${cleanName(author.name || author.screen_name) || 'Unknown'} (@${cleanHandle(author.screen_name) || 'unknown'})${stamp && !compact ? ' · ' + stamp : ''}`, fullText(s)];
  const media = s.media || {};
  const items = [...(media.photos || []).map(m => ({ ...m, type: 'photo' })), ...(media.videos || []).map(m => ({ ...m, type: 'video' })), ...(media.all || [])];
  const seen = new Set();
  const links = [];
  for (const m of items) {
    const best = [...(m.formats || [])].filter(f => f.url && (f.container === 'mp4' || f.content_type === 'video/mp4')).sort((a,b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const url = [best?.url, m.url, m.original_url].map(safeUrl).find(Boolean);
    if (url && !seen.has(url)) { seen.add(url); links.push(`- [${m.type === 'photo' ? 'photo' : 'video'}](${url})`); }
  }
  if (links.length) blocks.push(links.join('\n'));
  if (s.quote) {
    const q = s.quote;
    const quoteUrl = safeUrl(q.url) || permalink(q);
    blocks.push(`> **Quote:** ${cleanName(q.author?.name || q.author?.screen_name) || 'Unknown'} (@${cleanHandle(q.author?.screen_name) || 'unknown'}): ${fullText(q).replace(/\n/g, '\n> ')}${quoteUrl ? ` — [link](${quoteUrl})` : ''}`);
  }
  const metrics = formatMetrics(s);
  if (!compact && metrics) blocks.push(`<sub>${metrics}</sub>`);
  if (!compact && permalink(s)) blocks.push(`[permalink](${permalink(s)})`);
  return blocks.filter(Boolean).join('\n\n');
}

function formatMetrics(s) {
  return [['❤️','likes'],['🔁','reposts'],['💬','replies'],['👁','views']].filter(([,k]) => typeof s[k] === 'number' && Number.isFinite(s[k])).map(([icon,k]) => `${icon} ${s[k]}`).join(' · ');
}
export function formatReference(s, number) {
  const url = permalink(s);
  const metrics = formatMetrics(s);
  return `${number}. @${cleanHandle(s.author?.screen_name) || 'unknown'}${url ? ` — <${url}>` : ''}${metrics ? ` · ${metrics}` : ''}`;
}
