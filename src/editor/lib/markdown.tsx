// Light markdown for chat replies: paragraphs, lists, headings, fenced code, **bold**, *italic*, `code`, links as text.
// Builds React elements (never HTML strings), so model output can't inject markup.
import { Fragment, type ReactNode } from 'react';

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    if (token.startsWith('**') || token.startsWith('__')) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (token.startsWith('`')) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) out.push(<Fragment key={k}>{token.slice(1, token.indexOf(']'))}</Fragment>);
    else out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'h'; text: string };

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) body.push(lines[i]);
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: 'h', text: heading[1] });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const prev = out.at(-1);
      const item = (bullet ?? numbered)![1];
      if (prev && prev.kind === kind) prev.items.push(item);
      else out.push({ kind, items: [item] });
      continue;
    }
    const prev = out.at(-1);
    // A line right after a list item continues it; after a paragraph line, it continues the paragraph.
    if (prev && (prev.kind === 'ul' || prev.kind === 'ol') && /^\s{2,}\S/.test(line))
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
    else if (prev && prev.kind === 'p' && lines[i - 1]?.trim()) prev.lines.push(line);
    else out.push({ kind: 'p', lines: [line] });
  }
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? 'prose-chat'}>
      {blocks(text).map((block, b) => {
        const k = `b${b}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre key={k}>
                <code>{block.text}</code>
              </pre>
            );
          case 'h':
            return <h3 key={k}>{inline(block.text, k)}</h3>;
          case 'ul':
          case 'ol': {
            const List = block.kind;
            return (
              <List key={k}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item, `${k}-${i}`)}</li>
                ))}
              </List>
            );
          }
          default:
            return (
              <p key={k}>
                {block.lines.map((line, i) => (
                  <Fragment key={i}>
                    {i > 0 && <br />}
                    {inline(line, `${k}-${i}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
