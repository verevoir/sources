import { describe, it, expect } from 'vitest';
import { storageToMarkdown } from '../../src/confluence/storage-to-markdown.js';

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
});
