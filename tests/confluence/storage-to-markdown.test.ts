import { describe, it, expect } from 'vitest';
import { storageToMarkdown, _parseStepsForTest } from '../../src/confluence/storage-to-markdown.js';

describe('storageToMarkdown', () => {
  it('renders headings', () => {
    expect(storageToMarkdown('<h1>Title</h1><h2>Sub</h2>')).toBe('# Title\n\n## Sub\n');
  });

  it('renders an unordered list', () => {
    expect(storageToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two\n');
  });

  it('renders a nested ordered list, indenting the nested level', () => {
    const xhtml = '<ol><li>first<ol><li>nested</li></ol></li><li>second</li></ol>';
    expect(storageToMarkdown(xhtml)).toBe('1. first\n  1. nested\n2. second\n');
  });

  it('renders a simple table as a markdown table', () => {
    const xhtml =
      '<table><tbody><tr><th>Name</th><th>Age</th></tr><tr><td>Ada</td><td>30</td></tr></tbody></table>';
    expect(storageToMarkdown(xhtml)).toBe('| Name | Age |\n| --- | --- |\n| Ada | 30 |\n');
  });

  it('renders a link', () => {
    expect(storageToMarkdown('<p>See <a href="https://example.com">here</a>.</p>')).toBe(
      'See [here](https://example.com).\n'
    );
  });

  it('renders the code macro as a fenced block, keeping its language', () => {
    const xhtml =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>';
    expect(storageToMarkdown(xhtml)).toBe('```js\nconst x = 1;\n```\n');
  });

  it('renders a code macro with no language param and no plain-text-body as an empty fenced block', () => {
    const xhtml = '<ac:structured-macro ac:name="code"></ac:structured-macro>';
    expect(storageToMarkdown(xhtml)).toBe('```\n\n```\n');
  });

  it('renders a bare pre block as a fenced code block', () => {
    expect(storageToMarkdown('<pre>line one\nline two</pre>')).toBe(
      '```\nline one\nline two\n```\n'
    );
  });

  it('drops an unrenderable macro, leaving a placeholder that names it', () => {
    const xhtml =
      '<p>Before</p>' +
      '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>' +
      '<p>After</p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toContain('Before');
    expect(out).toContain('[macro: jira]');
    expect(out).toContain('After');
    expect(out).not.toContain('PROJ-1');
  });

  it('renders bold and italic inline', () => {
    expect(storageToMarkdown('<p><strong>bold</strong> and <em>italic</em></p>')).toBe(
      '**bold** and *italic*\n'
    );
  });

  it('renders <b> and <i> as the same aliases as <strong> and <em>', () => {
    expect(storageToMarkdown('<p><b>bold</b> and <i>italic</i></p>')).toBe(
      '**bold** and *italic*\n'
    );
  });

  it('decodes basic XML entities in text', () => {
    expect(storageToMarkdown('<p>A &amp; B &lt;tag&gt;</p>')).toBe('A & B <tag>\n');
  });

  it('returns an empty string for empty input', () => {
    expect(storageToMarkdown('')).toBe('');
  });

  it('drops an XHTML comment entirely', () => {
    expect(storageToMarkdown('<p>Before</p><!-- a comment --><p>After</p>')).toBe(
      'Before\n\nAfter\n'
    );
  });

  it('ignores an unmatched closing tag rather than throwing', () => {
    expect(storageToMarkdown('<p>Text</li></p>')).toBe('Text\n');
  });

  it('renders a horizontal rule', () => {
    expect(storageToMarkdown('<p>Before</p><hr/><p>After</p>')).toBe('Before\n\n---\n\nAfter\n');
  });

  it('renders a line break inline', () => {
    expect(storageToMarkdown('<p>a<br/>b</p>')).toBe('a\nb\n');
  });

  it('renders a link with no href as plain text', () => {
    expect(storageToMarkdown('<p>See <a>here</a>.</p>')).toBe('See here.\n');
  });

  it('renders a table with no tbody (rows directly under table)', () => {
    const xhtml = '<table><tr><th>A</th></tr><tr><td>1</td></tr></table>';
    expect(storageToMarkdown(xhtml)).toBe('| A |\n| --- |\n| 1 |\n');
  });

  it('renders an empty string for a table with no rows', () => {
    expect(storageToMarkdown('<table></table>')).toBe('');
  });

  it('renders only a safe link scheme (https) as a clickable destination', () => {
    expect(storageToMarkdown('<p><a href="https://example.com">ok</a></p>')).toBe(
      '[ok](https://example.com)\n'
    );
  });

  it('renders a mailto: link as a clickable destination', () => {
    expect(storageToMarkdown('<p><a href="mailto:a@example.com">mail</a></p>')).toBe(
      '[mail](mailto:a@example.com)\n'
    );
  });

  it('renders a relative link as a clickable destination (no scheme to allow-list)', () => {
    expect(storageToMarkdown('<p><a href="/wiki/spaces/ENG/pages/123">rel</a></p>')).toBe(
      '[rel](/wiki/spaces/ENG/pages/123)\n'
    );
  });

  it('renders a javascript: link as plain label text, not a clickable destination', () => {
    expect(storageToMarkdown('<p><a href="javascript:alert(1)">click</a></p>')).toBe('click\n');
  });

  it('renders a data: link as plain label text, not a clickable destination', () => {
    expect(storageToMarkdown('<p><a href="data:text/html;base64,SGVsbG8=">click</a></p>')).toBe(
      'click\n'
    );
  });

  it('decodes XML entities inside a pre block — only a CDATA macro body stays literal', () => {
    expect(storageToMarkdown('<pre>if (a &lt; b) { x = a &amp; b; }</pre>')).toBe(
      '```\nif (a < b) { x = a & b; }\n```\n'
    );
  });

  it('sizes the pre fence longer than the longest backtick run in its body', () => {
    const xhtml = '<pre>````\nbreakout attempt\n````</pre>';
    const out = storageToMarkdown(xhtml);
    expect(out.startsWith('`````\n')).toBe(true);
    expect(out).toContain('breakout attempt');
    expect(out.trim().endsWith('`````')).toBe(true);
  });

  it('sizes the code-macro fence longer than the longest backtick run in its body', () => {
    const xhtml =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[````\nbreakout attempt\n````]]></ac:plain-text-body></ac:structured-macro>';
    const out = storageToMarkdown(xhtml);
    expect(out.startsWith('`````js\n')).toBe(true);
    expect(out).toContain('breakout attempt');
    expect(out.trim().endsWith('`````')).toBe(true);
  });

  it('sanitises a macro language param, stripping any newline or backtick breakout attempt', () => {
    const xhtml =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js\n```evil</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[safe body]]></ac:plain-text-body></ac:structured-macro>';
    const out = storageToMarkdown(xhtml);
    expect(out.split('\n')[0]).toBe('```jsevil');
    expect(out).toContain('safe body');
  });

  it('decodes an entity-escaped href before the scheme check', () => {
    const xhtml = '<p><a href="https://e.co/x?a=1&amp;b=2">here</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[here](https://e.co/x?a=1&b=2)\n');
  });

  it('rejects a tab-obfuscated javascript: scheme', () => {
    const xhtml = '<p><a href="java\tscript:alert(1)">click</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('rejects a numeric-entity-encoded javascript: scheme', () => {
    const encoded = 'javascript:alert(1)'
      .split('')
      .map((c) => `&#${c.codePointAt(0)};`)
      .join('');
    const xhtml = `<p><a href="${encoded}">click</a></p>`;
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('rejects a protocol-relative URL as unsafe', () => {
    const xhtml = '<p><a href="//evil.example/x">click</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('rejects a backslash protocol-relative URL (WHATWG resolves \\\\host/x to https://host/x)', () => {
    const xhtml = '<p><a href="\\\\evil.example/x">click</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('rejects a leading-slash-then-backslash URL (WHATWG resolves /\\host/x the same way)', () => {
    const xhtml = '<p><a href="/\\evil.example/x">click</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('percent-encodes a paren in a link destination rather than wrapping it', () => {
    const xhtml = '<p><a href="https://example.com/a)b">x</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[x](https://example.com/a%29b)\n');
  });

  it('percent-encodes an interior space in a link destination rather than deleting it', () => {
    const xhtml = '<p><a href="https://example.com/a b">x</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[x](https://example.com/a%20b)\n');
  });

  it('percent-encodes a literal angle bracket in a link destination, reachable via entity decoding', () => {
    const xhtml = '<p><a href="https://example.com/a&gt;b">x</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[x](https://example.com/a%3Eb)\n');
  });

  it('treats a single-quoted href as absent (fails safe)', () => {
    const xhtml = "<p><a href='https://example.com'>text</a></p>";
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('text\n');
  });

  it('treats a query-string colon as safe/relative, not a scheme separator', () => {
    const xhtml = '<p><a href="page?x=1:2">rel</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[rel](page?x=1:2)\n');
  });

  it('rejects a scheme whose colon precedes every special character, even with a path after it', () => {
    const xhtml = '<p><a href="javascript:void(0)/x">click</a></p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('click\n');
  });

  it('escapes the href-as-label fallback for an empty-label anchor, closing a markdown-injection path', () => {
    const href = 'https://good.example/x](z)[click](javascript:alert(1))';
    const xhtml = `<p><a href="${href}"/></p>`;
    const out = storageToMarkdown(xhtml);
    const ESCAPE_CHARS = '\\`[]()!';
    const escapedHref = href
      .split('')
      .map((c) => (ESCAPE_CHARS.includes(c) ? `\\${c}` : c))
      .join('');
    const PERCENT_ENCODE: Record<string, string> = {
      ' ': '%20',
      '(': '%28',
      ')': '%29',
      '<': '%3C',
      '>': '%3E',
    };
    const encodedHref = href.replace(/[ ()<>]/g, (c) => PERCENT_ENCODE[c]);
    expect(out).toBe(`[${escapedHref}](${encodedHref})\n`);
  });

  it('escapes markdown syntax forged through a link label', () => {
    const label = 'x](javascript:alert(1)';
    const xhtml = `<p>See <a href="https://safe.example">${label}</a> ok</p>`;
    const ESCAPE_CHARS = '\\`[]()!';
    const escapedLabel = label
      .split('')
      .map((c) => (ESCAPE_CHARS.includes(c) ? `\\${c}` : c))
      .join('');
    const out = storageToMarkdown(xhtml);
    expect(out).toBe(`See [${escapedLabel}](https://safe.example) ok\n`);
  });

  it('escapes markdown syntax forged in plain prose text', () => {
    const text = 'Click [here](javascript:alert(1)) to win';
    const ESCAPE_CHARS = '\\`[]()!';
    const escaped = text
      .split('')
      .map((c) => (ESCAPE_CHARS.includes(c) ? `\\${c}` : c))
      .join('');
    const out = storageToMarkdown(`<p>${text}</p>`);
    expect(out).toBe(`${escaped}\n`);
  });

  it('renders inline code literally, unescaped', () => {
    const xhtml = '<p>Use <code>a[1](b)</code> here</p>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('Use `a[1](b)` here\n');
  });

  it('ignores a malformed/out-of-range numeric entity rather than throwing', () => {
    expect(() => storageToMarkdown('<p>&#99999999;</p>')).not.toThrow();
  });

  it('decodes a decimal numeric entity', () => {
    expect(storageToMarkdown('<p>&#65;</p>')).toBe('A\n');
  });

  it('decodes a hex numeric entity', () => {
    expect(storageToMarkdown('<p>&#x41;</p>')).toBe('A\n');
  });

  it('keeps CDATA literal — never entity-decoded — even outside a code macro, inline', () => {
    // The CDATA `raw` flag means "never decode entities", independent of
    // WHERE the CDATA sits. A page author can put a CDATA section directly
    // in prose, not only inside a macro's plain-text body.
    expect(storageToMarkdown('<p><![CDATA[&lt;x&gt;]]></p>')).toBe('&lt;x&gt;\n');
  });

  it('keeps a block-level CDATA (no wrapping tag) literal too', () => {
    expect(storageToMarkdown('<![CDATA[&lt;y&gt;]]>')).toBe('&lt;y&gt;\n');
  });

  it('passes an unrecognised block tag through to its children (e.g. <div>)', () => {
    expect(storageToMarkdown('<div><p>inside div</p></div>')).toBe('inside div\n');
  });

  it('passes an unrecognised inline tag through to its children (e.g. <span>)', () => {
    expect(storageToMarkdown('<p>a <span>b</span> c</p>')).toBe('a b c\n');
  });

  it('falls back to "unknown" for a macro with no ac:name', () => {
    const xhtml = '<ac:structured-macro></ac:structured-macro>';
    const out = storageToMarkdown(xhtml);
    expect(out).toBe('[macro: unknown]\n');
  });

  it('caps rendering recursion depth, degrading to a placeholder', () => {
    const depth = 1000; // far past the renderer's own depth cap
    const xhtml = '<ul><li>'.repeat(depth) + 'x' + '</li></ul>'.repeat(depth);
    const out = storageToMarkdown(xhtml);
    // The behaviour this test is named for is the PLACEHOLDER appearing,
    // not merely "did not throw" -- at this depth there is no stack-
    // overflow risk either way, so not.toThrow() alone would stay green
    // even if the depth cap were deleted entirely.
    expect(out).toContain('[content too deeply nested]');
  });

  it('decodes &amp; LAST, so a double-encoded entity degrades to its single-encoded form, not the raw character', () => {
    // decodeEntities's own doc comment states this ordering is deliberate:
    // '&amp;lt;' must become the literal text '&lt;', never '<'. A test
    // pins the order so a regression that re-sorted the replace() chain
    // would be caught.
    expect(storageToMarkdown('<p>&amp;lt;</p>')).toBe('&lt;\n');
  });

  it('renders a bare "<" that never forms a tag as literal text (the tokenizer\'s non-tag-opener branch)', () => {
    // '<' immediately followed by a space is not `<[a-zA-Z]` or `</[a-zA-Z]`,
    // so parseCore's own 'not a tag opener' branch emits it as literal text
    // and resumes scanning right after it, rather than treating the whole
    // rest of the paragraph as inside an unclosed tag.
    expect(storageToMarkdown('<p>a < b ></p>')).toBe('a < b >\n');
  });

  it('truncates an oversized page body rather than full render', () => {
    const huge = `<p>${'x'.repeat(2_500_000)}</p>`;
    const out = storageToMarkdown(huge);
    expect(out.length).toBeLessThan(huge.length);
  });
});

describe('storageToMarkdown — the tokenizer scans linearly, not quadratically, on unclosed constructs', () => {
  // Regression for a previously-quadratic tokenizer: a single alternated,
  // lazily-quantified regex cost O(n^2) on repeated UNCLOSED CDATA/comment
  // openers. These tests assert a DETERMINISTIC, timing-free proxy instead
  // of wall-clock time: `_parseStepsForTest` exposes how many iterations of
  // the main scanning loop parseCore needed. Every branch that handles an
  // unclosed construct (CDATA, comment, tag) ends the loop with a single
  // failed `indexOf` scan of the remaining input and a `break` — so the
  // step count stays a small constant REGARDLESS of how large `n` is, which
  // is a strictly stronger, and deterministic, proof of "bounded by k*n"
  // than a wall-clock assertion that a shared or loaded CI runner could
  // push over any fixed millisecond threshold with no code change at all.
  const MAX_STEPS = 5;

  it('needs a small, constant number of scan steps on 200k unclosed comment openers', () => {
    const steps = _parseStepsForTest('<!--'.repeat(200_000));
    expect(steps).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('needs a small, constant number of scan steps on 200k unclosed CDATA openers', () => {
    const steps = _parseStepsForTest('<![CDATA['.repeat(200_000));
    expect(steps).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('needs a small, constant number of scan steps on 200k unclosed tag openers', () => {
    const steps = _parseStepsForTest('<a'.repeat(200_000));
    expect(steps).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('step count does not grow with input length for the same unclosed construct (not quadratic)', () => {
    // A direct linear-vs-quadratic check: double the input and confirm the
    // step count does not grow at all (every unclosed-construct branch
    // breaks after one failed indexOf, so it stays flat) — a quadratic
    // tokenizer that re-scanned from every position would instead show
    // steps scaling with n.
    const small = _parseStepsForTest('<!--'.repeat(50_000));
    const large = _parseStepsForTest('<!--'.repeat(200_000));
    expect(large).toBe(small);
  });
});
