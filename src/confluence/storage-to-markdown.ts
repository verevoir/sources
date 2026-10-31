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
// index.ts guards so carefully — so every conversion boundary is treated as
// untrusted rather than passed through verbatim:
//   - a link's `href` is decoded (entities, including numeric references),
//     stripped of control characters and whitespace, and THEN allow-listed
//     to http:, https:, mailto: and a link that is clearly relative /
//     same-document (never a protocol-relative `//host/...`); anything else
//     (javascript:, data:, a control-character- or entity-obfuscated
//     scheme, ...) renders as plain label text, never a clickable
//     destination. A destination containing a character that would break
//     the `(...)` syntax (a space, paren or literal angle bracket) is
//     percent-encoded rather than angle-bracket-wrapped — CommonMark's own
//     `<...>`-delimited destination syntax forbids an unescaped `<`/`>`
//     INSIDE it, so wrapping would not escape a destination that itself
//     contains one.
//   - every other piece of rendered TEXT (headings, paragraphs, list items,
//     table cells, link labels) has CommonMark's own link/image/code
//     metacharacters (`\`, `` ` ``, `[`, `]`, `(`, `)`, `!`) escaped, so
//     page content cannot forge its own markdown link — through a label,
//     or through plain prose that was never inside a real `<a>` tag at all.
//     An anchor with no rendered label (e.g. a self-closing `<a href=.../>`)
//     falls back to the href itself as the label; that fallback is escaped
//     too, so an href crafted to look like `x](z)[click](javascript:...)`
//     cannot forge a second link merely by omitting its own label text.
//     A code span or fenced block's own content stays literal by design
//     (guarded instead by fence sizing, below), since escaping inside code
//     would corrupt it.
//   - a fenced code block's own fence (the `code` macro, and a bare `pre`)
//     is sized longer than the longest run of backticks already present in
//     the body, and a macro's `language` parameter is stripped to
//     `[A-Za-z0-9_+-]` — so neither the body nor the language can break out
//     of its own fence into the surrounding Markdown.
//   - the renderer's own recursion (nested lists, nested inline tags) is
//     depth-capped, and the whole input is length-capped — both degrade to
//     a safe placeholder rather than overflowing the call stack or doing
//     unbounded work on a pathological body.

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

/** Hard cap on the XHTML body this converter will attempt to render. Past
 * it, the body is truncated and a note appended — a bounded, safe result
 * rather than unbounded work on an oversized page. This is independent of
 * (and in addition to) the response-size cap on the HTTP layer in
 * index.ts's confCall, which bounds what gets buffered off the wire before
 * it ever reaches this function. */
const MAX_XHTML_LENGTH = 2_000_000;

/** Hard cap on recursive descent through the parsed tree (nested lists,
 * nested inline tags, ...). Real Confluence content never nests anywhere
 * near this deep; a page body crafted to nest past it degrades to a
 * placeholder instead of risking a stack overflow. */
const MAX_RENDER_DEPTH = 200;

function tooDeep(depth: number): boolean {
  return depth > MAX_RENDER_DEPTH;
}

const DEPTH_PLACEHOLDER = '[content too deeply nested]';

/** Tokenizes `xhtml` and parses it into a synthetic root element's children.
 * CDATA sections (macro bodies, typically) are captured as literal text,
 * never scanned for tags. Comments are dropped. An unmatched closing tag is
 * ignored rather than throwing — storage format from a real page is assumed
 * well-formed, and a converter should degrade, not crash, on the rest. This
 * is an explicit stack (not recursive), so an adversarially deep or wide
 * input cannot overflow the parser itself — only the RENDERER below, which
 * is depth-capped separately. */
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

/** Converts an integer code point to a character, refusing anything
 * `String.fromCodePoint` itself would throw a `RangeError` on (negative,
 * non-finite, or past U+10FFFF) — an attacker-supplied numeric entity like
 * `&#99999999;` must degrade to nothing, not crash the converter. */
function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Decodes the named XML entities storage format actually uses, plus
 * decimal (`&#NN;`) and hex (`&#xNN;`) numeric character references — the
 * generic form an attacker can use to spell any of the named ones (or a
 * URL scheme) without the literal characters appearing anywhere in the
 * source text. `&amp;` is decoded LAST so `&amp;lt;` degrades to the
 * literal text `&lt;`, not `<`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** CommonMark characters that could forge markdown structure out of
 * ordinary text: link/image syntax (`[`, `]`, `(`, `)`, `!`), a code span
 * or fence (`` ` ``), or an escape sequence itself (`\`). A plain
 * character-membership check rather than a regex character class, so
 * there is no bracket-escaping subtlety to get wrong. */
const MARKDOWN_ESCAPE_CHARS = '\\`[]()!';

/** Escapes `MARKDOWN_ESCAPE_CHARS` out of rendered TEXT (headings,
 * paragraphs, list items, table cells, link labels) so page content cannot
 * forge its own markdown link or emphasis — through a label, or through
 * plain prose that was never inside a real `<a>` tag at all. Never applied
 * to a code span's or fenced block's own content (stays literal by
 * design), nor to a link's `href` destination (a URL, not prose). */
function escapeMarkdown(s: string): string {
  let out = '';
  for (const ch of s) out += MARKDOWN_ESCAPE_CHARS.includes(ch) ? `\\${ch}` : ch;
  return out;
}

/** Concatenates every descendant text node, decoding entities except in a
 * CDATA-sourced node (`raw: true`), which stays byte-for-byte literal. Used
 * for `pre`, inline `<code>` (ordinary entity-escaped text, kept literal —
 * never markdown-escaped) and a macro's plain-text body (always CDATA in
 * real storage format, so unaffected by the decode). Depth-capped like
 * every other recursive descent in this module. */
function textContent(n: Node, depth: number): string {
  if (!isEl(n)) return n.raw ? n.text : decodeEntities(n.text);
  if (tooDeep(depth)) return '';
  return n.children.map((c) => textContent(c, depth + 1)).join('');
}

/** Decodes entities in a raw attribute value, then strips ASCII control
 * characters and whitespace — so neither an entity-encoded scheme
 * (`&#106;avascript:`) nor a control-character-obfuscated one
 * (`java\tscript:`) survives to reach the scheme check below. */
function normalizeHref(raw: string): string {
  return decodeEntities(raw).replace(/[\s\x00-\x1f\x7f]/g, '');
}

function firstIndexOfAny(s: string, chars: string[]): number {
  let min = -1;
  for (const c of chars) {
    const i = s.indexOf(c);
    if (i !== -1 && (min === -1 || i < min)) min = i;
  }
  return min;
}

/** True only for: an explicit `http:`/`https:`/`mailto:` scheme
 * (case-insensitive); or a link that is clearly relative/same-document —
 * starting with `/` (but NOT `//`, a protocol-relative absolute URL that
 * silently inherits whatever scheme the current page loaded over), `#`,
 * `./` or `../`, or containing no `:` before its first `/`, `?` or `#` (so
 * a query string's own `:` — `page?x=1:2` — is never mistaken for a scheme
 * separator). Everything else — `javascript:`, `data:`, `vbscript:`,
 * `tel:`, ... — is rejected. `href` MUST already be normalised
 * (`normalizeHref`) before this is called; it does not decode or strip
 * anything itself. */
function isSafeHref(href: string): boolean {
  if (!href) return false;
  const lower = href.toLowerCase();
  if (lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('mailto:')) {
    return true;
  }
  if (href.startsWith('//')) return false; // protocol-relative — not "relative"
  if (
    href.startsWith('/') ||
    href.startsWith('#') ||
    href.startsWith('./') ||
    href.startsWith('../')
  ) {
    return true;
  }
  const colonIdx = href.indexOf(':');
  if (colonIdx === -1) return true;
  const specialIdx = firstIndexOfAny(href, ['/', '?', '#']);
  return specialIdx !== -1 && colonIdx > specialIdx;
}

/** Percent-encodes the characters in a link destination that would
 * otherwise prematurely close CommonMark's `(...)` destination syntax —
 * space, `(`, `)`, `<`, `>`. Percent-encoding, not angle-bracket wrapping:
 * CommonMark's own `<...>`-delimited destination syntax forbids an
 * unescaped `<` or `>` INSIDE it, so wrapping a destination that itself
 * contains a literal `<`/`>` (reachable here via entity decoding, which
 * runs before this) does not escape it — it produces an invalid,
 * ambiguous destination that a real CommonMark parser mis-splits into an
 * autolink plus leaked literal text. Percent-encoding has no such caveat:
 * it is always valid inside a URL, and none of these characters is ever
 * meaningful there. */
const HREF_PERCENT_ENCODE: Record<string, string> = {
  ' ': '%20',
  '(': '%28',
  ')': '%29',
  '<': '%3C',
  '>': '%3E',
};

function formatHref(href: string): string {
  let out = '';
  for (const ch of href) out += HREF_PERCENT_ENCODE[ch] ?? ch;
  return out;
}

function renderInline(nodes: Node[], depth: number): string {
  if (tooDeep(depth)) return DEPTH_PLACEHOLDER;
  return nodes.map((n) => renderInlineNode(n, depth)).join('');
}

function renderInlineNode(n: Node, depth: number): string {
  if (!isEl(n)) return escapeMarkdown(decodeEntities(n.text));
  switch (n.tag) {
    case 'br':
      return '\n';
    case 'a': {
      const href = normalizeHref(n.attrs.href ?? '');
      // renderInline already escapes every leaf text node it descends into
      // (renderInlineNode's default/text branch calls escapeMarkdown), so
      // the label is single-escaped here, not re-escaped — wrapping it in
      // a second escapeMarkdown would double every backslash it just added.
      const label = renderInline(n.children, depth + 1).trim();
      // An anchor with no rendered text (e.g. a self-closing <a href=.../>)
      // falls back to the href itself as the label. That fallback is NOT
      // exempt from escaping: href has only passed normalizeHref (entity
      // decode + control-char strip) and isSafeHref's scheme-prefix check,
      // neither of which inspects the rest of the string — without this,
      // an href like 'https://good.example/x](z)[click](javascript:...)'
      // would inject raw, unescaped markdown-link syntax as label text.
      if (href && isSafeHref(href)) {
        return `[${label || escapeMarkdown(href)}](${formatHref(href)})`;
      }
      return label;
    }
    case 'strong':
    case 'b':
      return `**${renderInline(n.children, depth + 1)}**`;
    case 'em':
    case 'i':
      return `*${renderInline(n.children, depth + 1)}*`;
    case 'code':
      return `\`${textContent(n, depth + 1)}\``;
    case 'ac:structured-macro':
      return macroPlaceholder(n);
    default:
      return renderInline(n.children, depth + 1);
  }
}

function renderList(n: ElNode, kind: 'ul' | 'ol', indent: number, depth: number): string {
  if (tooDeep(depth)) return DEPTH_PLACEHOLDER;
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
    const text = renderInline(inlineChildren, depth + 1).trim();
    lines.push(`${'  '.repeat(indent)}${marker} ${text}`);
    for (const nested of nestedLists) {
      lines.push(renderList(nested, nested.tag as 'ul' | 'ol', indent + 1, depth + 1));
    }
  }
  return lines.join('\n');
}

function renderTable(n: ElNode, depth: number): string {
  if (tooDeep(depth)) return DEPTH_PLACEHOLDER;
  const tbody = n.children.find((c): c is ElNode => isEl(c) && c.tag === 'tbody');
  const host = tbody ?? n;
  const rows = host.children.filter((c): c is ElNode => isEl(c) && c.tag === 'tr');
  if (rows.length === 0) return '';
  const cellsOf = (row: ElNode): ElNode[] =>
    row.children.filter((c): c is ElNode => isEl(c) && (c.tag === 'td' || c.tag === 'th'));
  const renderCell = (c: ElNode): string => {
    const text = renderInline(c.children, depth + 1).trim();
    return text.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
  };
  const renderRow = (cells: ElNode[]): string => `| ${cells.map(renderCell).join(' | ')} |`;
  const header = cellsOf(rows[0]);
  const lines = [renderRow(header), `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(renderRow(cellsOf(row)));
  return `${lines.join('\n')}\n`;
}

/** `ac:name` is itself an attacker-controlled attribute value — decoded the
 * same way `href` is, before it ever reaches the placeholder or the
 * `=== 'code'` comparison. */
function macroName(n: ElNode): string {
  return decodeEntities(n.attrs['ac:name'] ?? 'unknown');
}

function macroPlaceholder(n: ElNode): string {
  return `[macro: ${escapeMarkdown(macroName(n))}]`;
}

function macroParam(n: ElNode, name: string, depth: number): string | undefined {
  for (const c of n.children) {
    if (isEl(c) && c.tag === 'ac:parameter' && c.attrs['ac:name'] === name) {
      return renderInline(c.children, depth + 1).trim();
    }
  }
  return undefined;
}

function macroPlainTextBody(n: ElNode, depth: number): string | undefined {
  for (const c of n.children) {
    if (isEl(c) && c.tag === 'ac:plain-text-body') return textContent(c, depth + 1);
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

function renderMacroBlock(n: ElNode, depth: number): string {
  if (macroName(n) === 'code') {
    const lang = sanitizeLang(macroParam(n, 'language', depth) ?? '');
    const body = (macroPlainTextBody(n, depth) ?? '').replace(/\n+$/, '');
    const fence = fenceFor(body);
    return `${fence}${lang}\n${body}\n${fence}\n\n`;
  }
  return `${macroPlaceholder(n)}\n\n`;
}

function renderBlocks(nodes: Node[], depth: number): string {
  if (tooDeep(depth)) return `${DEPTH_PLACEHOLDER}\n\n`;
  return nodes.map((n) => renderBlock(n, depth)).join('');
}

function renderBlock(n: Node, depth: number): string {
  if (!isEl(n)) {
    const t = escapeMarkdown(decodeEntities(n.text)).trim();
    return t ? `${t}\n\n` : '';
  }
  switch (n.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(n.tag[1]))} ${renderInline(n.children, depth + 1).trim()}\n\n`;
    case 'p': {
      const text = renderInline(n.children, depth + 1).trim();
      return text ? `${text}\n\n` : '';
    }
    case 'ul':
    case 'ol':
      return `${renderList(n, n.tag, 0, depth + 1)}\n\n`;
    case 'table':
      return `${renderTable(n, depth + 1)}\n`;
    case 'pre': {
      const body = textContent(n, depth + 1).trim();
      const fence = fenceFor(body);
      return `${fence}\n${body}\n${fence}\n\n`;
    }
    case 'hr':
      return '---\n\n';
    case 'ac:structured-macro':
      return renderMacroBlock(n, depth);
    default:
      return renderBlocks(n.children, depth + 1);
  }
}

/** Converts a Confluence storage-format XHTML body to Markdown. Empty input
 * converts to an empty string; everything else ends with exactly one
 * trailing newline, and runs of 3+ blank lines collapse to one. An input
 * past `MAX_XHTML_LENGTH` is truncated with a note appended rather than
 * rendered in full. */
export function storageToMarkdown(xhtml: string): string {
  if (!xhtml) return '';
  const input =
    xhtml.length > MAX_XHTML_LENGTH
      ? `${xhtml.slice(0, MAX_XHTML_LENGTH)}<p>[page body truncated: exceeded ${MAX_XHTML_LENGTH} characters]</p>`
      : xhtml;
  const rendered = renderBlocks(parse(input), 0)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return rendered ? `${rendered}\n` : '';
}
