// @verevoir/sources/confluence — storage-format XHTML -> Markdown
//
// Confluence "storage format" is a constrained, well-formed XHTML dialect:
// ordinary block/inline tags (p, h1-h6, ul/ol/li, table/tr/th/td, a, strong,
// em, code, pre, br, hr) plus Atlassian's own namespaced macro tags
// (`ac:structured-macro`, `ac:parameter`, `ac:plain-text-body`, ...). This is
// a small hand-rolled tokenizer + renderer rather than a dependency, because
// the input is a fixed, documented grammar rather than arbitrary HTML.
//
// Renders headings, (nested) lists, simple tables, links, bold/italic,
// inline code, bare `pre` blocks and the `code` macro as a fenced block. Any
// OTHER macro is dropped with a `[macro: <name>]` placeholder — rendering an
// arbitrary macro's body would need a macro-specific renderer this module
// does not have, and silently inlining raw macro markup would be worse than
// naming what was skipped.
//
// This module's input is attacker-controlled — written by anyone who can
// edit the page, not just the holder of the API token this adapter's own
// index.ts guards so carefully — so two conversion boundaries are treated
// as untrusted rather than passed through verbatim:
//   - a link's `href` is allow-listed to http:, https:, mailto: and any
//     relative / same-document link; anything else (javascript:, data:,
//     ...) renders as plain label text, never a clickable destination.
//   - a fenced code block's own fence (the `code` macro, and a bare `pre`)
//     is sized longer than the longest run of backticks already present in
//     the body, and a macro's `language` parameter is stripped to
//     `[A-Za-z0-9_+-]` — so neither the body nor the language can break out
//     of its own fence into the surrounding Markdown.

interface ElNode {
  kind: 'el';
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface TextNode {
  kind: 'text';
  text: string;
  /** True for text captured from a CDATA section (a macro's plain-text
   * body) — kept byte-for-byte literal. False for ordinary XHTML text,
   * which is entity-escaped and must be decoded before use. */
  raw: boolean;
}
type Node = ElNode | TextNode;

function isEl(n: Node): n is ElNode {
  return n.kind === 'el';
}

const VOID_TAGS = new Set(['br', 'hr']);

/** Tokenizes `xhtml` and parses it into a synthetic root element's children.
 * CDATA sections (macro bodies, typically) are captured as literal text,
 * never scanned for tags. Comments are dropped. An unmatched closing tag is
 * ignored rather than throwing — storage format from a real page is assumed
 * well-formed, and a converter should degrade, not crash, on the rest. */
function parse(xhtml: string): Node[] {
  const root: ElNode = { kind: 'el', tag: '#root', attrs: {}, children: [] };
  const stack: ElNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string, raw: boolean) => {
    if (!text) return;
    stack[stack.length - 1].children.push({ kind: 'text', text, raw });
  };
  while ((m = re.exec(xhtml))) {
    if (m.index > last) pushText(xhtml.slice(last, m.index), false);
    last = re.lastIndex;
    const tok = m[0];
    if (m[1] !== undefined) {
      pushText(m[1], true);
    } else if (tok.startsWith('<!--')) {
      // comment — dropped
    } else if (tok.startsWith('</')) {
      const name = tok.slice(2, -1).trim().toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      const selfClosing = /\/>$/.test(tok);
      const body = tok.slice(1, selfClosing ? -2 : -1).trim();
      const name = (body.match(/^[a-zA-Z][a-zA-Z0-9:_-]*/)?.[0] ?? '').toLowerCase();
      const attrs: Record<string, string> = {};
      const attrRe = /([a-zA-Z_:][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(body))) attrs[am[1].toLowerCase()] = am[2];
      const el: ElNode = { kind: 'el', tag: name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(el);
    }
  }
  if (last < xhtml.length) pushText(xhtml.slice(last), false);
  return root.children;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenates every descendant text node, decoding entities except in a
 * CDATA-sourced node (`raw: true`), which stays byte-for-byte literal. Used
 * for `pre` (ordinary entity-escaped text) and a macro's plain-text body
 * (always CDATA in real storage format, so unaffected by the decode). */
function textContent(n: Node): string {
  if (!isEl(n)) return n.raw ? n.text : decodeEntities(n.text);
  return n.children.map(textContent).join('');
}

/** Schemes a rendered link may point at. Anything else — `javascript:`,
 * `data:`, `vbscript:`, ... — renders as plain label text instead of a
 * clickable destination; a relative or same-document link (no scheme at
 * all) is always allowed. */
const SAFE_LINK_SCHEME_RE = /^(https?|mailto):/i;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isSafeHref(href: string): boolean {
  if (!href) return false;
  if (!URL_SCHEME_RE.test(href)) return true; // relative / same-document — no scheme
  return SAFE_LINK_SCHEME_RE.test(href);
}

function renderInline(nodes: Node[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(n: Node): string {
  if (!isEl(n)) return decodeEntities(n.text);
  switch (n.tag) {
    case 'br':
      return '\n';
    case 'a': {
      const href = n.attrs.href ?? '';
      const label = renderInline(n.children).trim();
      if (href && isSafeHref(href)) return `[${label || href}](${href})`;
      return label;
    }
    case 'strong':
    case 'b':
      return `**${renderInline(n.children)}**`;
    case 'em':
    case 'i':
      return `*${renderInline(n.children)}*`;
    case 'code':
      return `\`${renderInline(n.children)}\``;
    case 'ac:structured-macro':
      return macroPlaceholder(n);
    default:
      return renderInline(n.children);
  }
}

function renderList(n: ElNode, kind: 'ul' | 'ol', depth: number): string {
  const items = n.children.filter((c): c is ElNode => isEl(c) && c.tag === 'li');
  const lines: string[] = [];
  let i = 0;
  for (const li of items) {
    i++;
    const marker = kind === 'ul' ? '-' : `${i}.`;
    const nestedLists = li.children.filter(
      (c): c is ElNode => isEl(c) && (c.tag === 'ul' || c.tag === 'ol')
    );
    const inlineChildren = li.children.filter(
      (c) => !(isEl(c) && (c.tag === 'ul' || c.tag === 'ol'))
    );
    const text = renderInline(inlineChildren).trim();
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
    for (const nested of nestedLists) {
      lines.push(renderList(nested, nested.tag as 'ul' | 'ol', depth + 1));
    }
  }
  return lines.join('\n');
}

function renderTable(n: ElNode): string {
  const tbody = n.children.find((c): c is ElNode => isEl(c) && c.tag === 'tbody');
  const host = tbody ?? n;
  const rows = host.children.filter((c): c is ElNode => isEl(c) && c.tag === 'tr');
  if (rows.length === 0) return '';
  const cellsOf = (row: ElNode): ElNode[] =>
    row.children.filter((c): c is ElNode => isEl(c) && (c.tag === 'td' || c.tag === 'th'));
  const renderCell = (c: ElNode): string => {
    const text = renderInline(c.children).trim();
    return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
  };
  const renderRow = (cells: ElNode[]): string => `| ${cells.map(renderCell).join(' | ')} |`;
  const header = cellsOf(rows[0]);
  const lines = [renderRow(header), `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(renderRow(cellsOf(row)));
  return `${lines.join('\n')}\n`;
}

function macroName(n: ElNode): string {
  return n.attrs['ac:name'] ?? 'unknown';
}

function macroPlaceholder(n: ElNode): string {
  return `[macro: ${macroName(n)}]`;
}

function macroParam(n: ElNode, name: string): string | undefined {
  for (const c of n.children) {
    if (isEl(c) && c.tag === 'ac:parameter' && c.attrs['ac:name'] === name) {
      return renderInline(c.children).trim();
    }
  }
  return undefined;
}

function macroPlainTextBody(n: ElNode): string | undefined {
  for (const c of n.children) {
    if (isEl(c) && c.tag === 'ac:plain-text-body') return textContent(c);
  }
  return undefined;
}

/** A fence of backticks strictly longer than the longest run already in
 * `body` — so the body itself (however many consecutive backticks it
 * contains) can never close the fence early. Never shorter than 3, the
 * conventional minimum. */
function fenceFor(body: string): string {
  const runs = body.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Strips a code-fence `language` tag to a safe, single-line token — no
 * backtick, no newline, nothing that could itself break out of the fence
 * it is about to be spliced onto. */
function sanitizeLang(lang: string): string {
  return lang.replace(/[^A-Za-z0-9_+-]/g, '');
}

function renderMacroBlock(n: ElNode): string {
  if (macroName(n) === 'code') {
    const lang = sanitizeLang(macroParam(n, 'language') ?? '');
    const body = (macroPlainTextBody(n) ?? '').replace(/\n+$/, '');
    const fence = fenceFor(body);
    return `${fence}${lang}\n${body}\n${fence}\n\n`;
  }
  return `${macroPlaceholder(n)}\n\n`;
}

function renderBlocks(nodes: Node[]): string {
  return nodes.map(renderBlock).join('');
}

function renderBlock(n: Node): string {
  if (!isEl(n)) {
    const t = decodeEntities(n.text).trim();
    return t ? `${t}\n\n` : '';
  }
  switch (n.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(n.tag[1]))} ${renderInline(n.children).trim()}\n\n`;
    case 'p': {
      const text = renderInline(n.children).trim();
      return text ? `${text}\n\n` : '';
    }
    case 'ul':
    case 'ol':
      return `${renderList(n, n.tag, 0)}\n\n`;
    case 'table':
      return `${renderTable(n)}\n`;
    case 'pre': {
      const body = textContent(n).trim();
      const fence = fenceFor(body);
      return `${fence}\n${body}\n${fence}\n\n`;
    }
    case 'hr':
      return '---\n\n';
    case 'ac:structured-macro':
      return renderMacroBlock(n);
    default:
      return renderBlocks(n.children);
  }
}

/** Converts a Confluence storage-format XHTML body to Markdown. Empty input
 * converts to an empty string; everything else ends with exactly one
 * trailing newline, and runs of 3+ blank lines collapse to one. */
export function storageToMarkdown(xhtml: string): string {
  if (!xhtml) return '';
  const rendered = renderBlocks(parse(xhtml))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return rendered ? `${rendered}\n` : '';
}
