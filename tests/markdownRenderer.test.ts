import {
  isMarkdownExtension,
  isPdfExtension,
  renderMarkdownToHtml,
  sanitizeMarkdownHtml,
} from '../frontend/src/utils/markdownRenderer';
import { en } from '../frontend/src/i18n/locales/en';
import { zh } from '../frontend/src/i18n/locales/zh';

describe('Markdown Renderer & File Type Helpers', () => {
  test('i18n locales contain markdown and pdf preview keys in both zh and en', () => {
    const requiredKeys = [
      'previewMode',
      'editMode',
      'openInNewTab',
      'emptyMarkdown',
      'copyCode',
      'codeCopied',
      'retry',
      'maximize',
      'restore',
    ] as const;

    for (const key of requiredKeys) {
      expect(zh.files[key]).toBeTruthy();
      expect(en.files[key]).toBeTruthy();
    }
    expect(zh.files.previewMode).toBe('预览');
    expect(zh.files.editMode).toBe('编辑');
    expect(en.files.previewMode).toBe('Preview');
    expect(en.files.editMode).toBe('Edit');
  });

  test('isMarkdownExtension and isPdfExtension identify extensions case-insensitively', () => {
    expect(isMarkdownExtension('md')).toBe(true);
    expect(isMarkdownExtension('MD')).toBe(true);
    expect(isMarkdownExtension('.markdown')).toBe(true);
    expect(isMarkdownExtension('txt')).toBe(false);

    expect(isPdfExtension('pdf')).toBe(true);
    expect(isPdfExtension('PDF')).toBe(true);
    expect(isPdfExtension('.pdf')).toBe(true);
    expect(isPdfExtension('png')).toBe(false);
  });

  test('renders GFM headings, tables, task lists, blockquotes, and external links', () => {
    const md = [
      '# Title 1',
      '## Title 2',
      '',
      '> A quote line',
      '',
      '- [x] Completed task',
      '- [ ] Pending task',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| CPU | 80% |',
      '',
      'Visit [Example](https://example.com) and `inline_code`.',
    ].join('\n');

    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<h1');
    expect(html).toContain('Title 1</h1>');
    expect(html).toContain('<h2');
    expect(html).toContain('<blockquote');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('CPU</td>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code');
    expect(html).toContain('inline_code</code>');
  });

  test('renders fenced code blocks with escaped HTML and URI-encoded data-copy-code attribute', () => {
    const rawCode = 'const a = \'<div class="x">&</div>\';';
    const md = '```ts\n' + rawCode + '\n```';
    const html = renderMarkdownToHtml(md, { copyCode: 'Copy code' });

    expect(html).toContain('ts');
    expect(html).toContain('&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
    expect(html).toContain(`data-copy-code="${encodeURIComponent(rawCode)}"`);
  });

  test('strips XSS vectors: script tags, onerror attributes, and javascript: links', () => {
    const malicious = [
      '# Safe Heading',
      '<script>window.hacked = true;</script>',
      '<img src="x" onerror="alert(1)" />',
      '[Evil Link](javascript:alert(document.cookie))',
      '<a href="JAVASCRIPT:alert(2)" onclick="steal()">Click</a>',
    ].join('\n');

    const html = renderMarkdownToHtml(malicious);
    expect(html).toContain('Safe Heading');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('window.hacked');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('sanitizeMarkdownHtml removes iframe, object, embed, and style tags directly', () => {
    const dirty = '<div><iframe src="https://evil.com"></iframe><style>body{display:none}</style><p>Keep me</p></div>';
    const clean = sanitizeMarkdownHtml(dirty);
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<style');
    expect(clean).toContain('<p>Keep me</p>');
  });
});
