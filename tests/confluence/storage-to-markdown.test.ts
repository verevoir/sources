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
});
