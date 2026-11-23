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

  test('prevents nested tag reconstruction bypasses in Node and browser runtimes', () => {
    const nested = '<scr<script>ipt>alert(1)</scr</script>ipt>';
    const clean = sanitizeMarkdownHtml(nested);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');

    const rendered = renderMarkdownToHtml(nested);
    expect(rendered).not.toContain('<script');
    expect(rendered).not.toContain('alert(1)');
  });

  test('neutralizes slash-delimited and whitespace-separated event handlers and dangerous tags', () => {
    const payloads = [
      '<img/src=x/onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(2)>',
    ];

    for (const payload of payloads) {
      const clean = sanitizeMarkdownHtml(payload);
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('onload');
      expect(clean).not.toContain('<svg');
      expect(clean).not.toContain('<math');

      const rendered = renderMarkdownToHtml(payload);
      expect(rendered).not.toContain('onerror');
      expect(rendered).not.toContain('onload');
      expect(rendered).not.toContain('<svg');
      expect(rendered).not.toContain('<math');
    }
  });

  test('neutralizes HTML-entity and control-character obfuscated javascript: URLs', () => {
    const obfuscated = [
      '<a href="&#106;avascript:alert(1)">x1</a>',
      '<a href="&#x6a;avascript:alert(1)">x2</a>',
      '<a href="java&#x09;script:alert(1)">x3</a>',
      '<a href="jav&#x00;ascript:alert(1)">x4</a>',
      '[entity](&#106;avascript:alert(1))',
      '[hex](&#x6A;avascript:alert(1))',
    ];

    for (const item of obfuscated) {
      const rendered = renderMarkdownToHtml(item);
      expect(rendered).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
      expect(rendered).toContain('href="#"');
    }
  });

  test('escapes raw HTML in Markdown link text to prevent inline XSS', () => {
    const rawLinkText = '[<img/src=x/onerror=alert(1)>](https://example.com)';
    const rendered = renderMarkdownToHtml(rawLinkText);
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toMatch(/<[^>]+onerror/i);
    expect(rendered).toContain('&lt;img/src=x/onerror=alert(1)&gt;');
  });

  test('frontend/package.json contains dompurify in dependencies and source imports DOMPurify', () => {
    const pkgPath = require('path').resolve(__dirname, '../frontend/package.json');
    const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies.dompurify).toBeDefined();

    const rendererSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../frontend/src/utils/markdownRenderer.ts'),
      'utf8'
    );
    expect(rendererSource).toMatch(/import\s+(?:\*\s+as\s+DOMPurify|DOMPurify)\s+from\s+['"]dompurify['"]/);
    expect(rendererSource).toContain('DOMPurify');
  });
});
