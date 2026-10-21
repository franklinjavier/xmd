export const XMD_BASE = 'https://xmd.imfrank.dev';

export function xmdLink(url, base = XMD_BASE) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch { return null; }
  return `${String(base).replace(/\/$/, '')}/?url=${encodeURIComponent(url.trim())}`;
}
