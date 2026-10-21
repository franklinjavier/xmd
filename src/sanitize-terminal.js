// Strip terminal control sequences from untrusted CLI output (OSC/CSI/ESC/C0/C1).
export function sanitizeTerminal(text) {
  let s = String(text ?? '');
  // OSC: ESC ] ... BEL or ST (ESC \)
  s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');
  // CSI: ESC [ parameter/intermediate bytes, final byte 0x40-0x7E
  s = s.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');
  // Other ESC sequences (charset, nF, etc.)
  s = s.replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '');
  s = s.replace(/\x1b./g, '');
  s = s.replace(/\x1b/g, '');
  // C1 controls
  s = s.replace(/[\x80-\x9f]/g, '');
  // C0 except LF/TAB; drop CR and DEL
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return s;
}
