import fs from 'node:fs';

/** Read a JSONL file, skipping blank or malformed lines. */
export function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line while the agent is still writing — ignore */
    }
  }
  return out;
}

/** Flatten the many shapes "content" can take into plain text. */
export function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.type === 'image') return '[image]';
    if ('content' in content) return toText(content.content);
    if ('output' in content) return toText(content.output);
  }
  return '';
}

/** Remove harness-injected tags that are noise for a human viewer. */
export function stripHarnessTags(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n… (${text.length - max} more characters)`;
}

/** Rough +/- line count between two strings (good enough for stats). */
export function lineDelta(oldStr = '', newStr = '') {
  const a = oldStr ? oldStr.split('\n') : [];
  const b = newStr ? newStr.split('\n') : [];
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = counts.get(l);
    if (c) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return { added: b.length - common, removed: a.length - common };
}
