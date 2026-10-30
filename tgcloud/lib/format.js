export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

// Converts the API's cleaned Markdown (paragraphs, **bold**, *italic*, links,
// # headings, > quotes) to Telegram's plain-message HTML. Used only when a rich
// message can't be sent.
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = lines.map((line) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `<b>${inline(heading[1])}</b>`;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return `<blockquote>${inline(quote[1])}</blockquote>`;
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) return `• ${inline(bullet[1])}`;
    return inline(line);
  });
  return out.join('\n').replace(/<\/blockquote>\n<blockquote>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^_]+)__/g, '<b>$1</b>');
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
  return html;
}

// Splits text into pieces of at most `max` characters, preferring paragraph,
// then line, then sentence boundaries, so no piece breaks an HTML tag.
export function chunkText(text, max) {
  const pieces = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('። '));
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return balanceTags(pieces);
}

// Closes tags left open at the end of a piece and reopens them in the next one.
function balanceTags(pieces) {
  let carry = [];
  return pieces.map((piece) => {
    const body = carry.map((tag) => tag.open).join('') + piece;
    const stack = [];
    for (const match of body.matchAll(/<(\/?)(b|i|a|blockquote)(\s[^>]*)?>/g)) {
      if (match[1]) stack.pop();
      else stack.push({ name: match[2], open: match[0] });
    }
    carry = stack;
    return body + [...stack].reverse().map((tag) => `</${tag.name}>`).join('');
  });
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const minutes = Math.round(n / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(n / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
