/**
 * Pure, dependency-free GFM Markdown rendering and XSS sanitization utility.
 * Designed to execute cleanly in both Browser and Node (Jest) test environments.
 */

export function isMarkdownExtension(ext?: string | null): boolean {
  if (!ext) return false;
  const clean = ext.trim().toLowerCase().replace(/^\./, '');
  return clean === 'md' || clean === 'markdown';
}

export function isPdfExtension(ext?: string | null): boolean {
  if (!ext) return false;
  const clean = ext.trim().toLowerCase().replace(/^\./, '');
  return clean === 'pdf';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(?:javascript|vbscript|data):/i.test(trimmed)) {
    return '#';
  }
  return trimmed;
}

/**
 * Strips dangerous HTML tags (<script>, <iframe>, <object>, <embed>, <style>, <form>),
 * inline event handlers (onclick, onerror, etc.), and unsafe URL protocols (javascript:, vbscript:, data:).
 */
export function sanitizeMarkdownHtml(html: string): string {
  let clean = html;

  // 1. Strip dangerous tags and their contents
  const dangerousTags = ['script', 'style', 'iframe', 'object', 'embed', 'form'];
  for (const tag of dangerousTags) {
    const blockRegex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    clean = clean.replace(blockRegex, '');
    const selfClosingRegex = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    clean = clean.replace(selfClosingRegex, '');
  }
  // Strip any remaining unclosed or closing tags
  clean = clean.replace(/<\/?(?:script|style|iframe|object|embed|form)\b[^>]*>/gi, '');

  // 2. Strip inline event attributes like onerror, onclick, onload, etc.
  clean = clean.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Neutralize dangerous protocols in href or src attributes
  clean = clean.replace(/(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, attr, val) => {
    const unquoted = val.replace(/^["']|["']$/g, '').trim();
    if (/^(?:javascript|vbscript|data):/i.test(unquoted)) {
      return `${attr}="#"`;
    }
    return match;
  });

  // 4. Remove empty paragraphs left behind by tag removals
  clean = clean.replace(/<p[^>]*>\s*<\/p>/gi, '');

  return clean;
}

function splitTableRow(row: string): string[] {
  let content = row.trim();
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  return content.split('|').map(c => c.trim());
}

/**
 * Render inline markdown features:
 * inline code, images, links, bold, italic, strikethrough.
 */
function renderInline(str: string): string {
  const inlineCodes: string[] = [];
  const links: string[] = [];
  const images: string[] = [];

  // 1. Protect inline code blocks (use unique tokens without underscores or asterisks)
  let text = str.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(
      `<code class="px-1.5 py-0.5 mx-0.5 rounded text-xs font-mono bg-[var(--bg-surface-sub)] text-amber-300 border border-[var(--border-subtle)]">${escapeHtml(code)}</code>`
    );
    return `@@INLINECODE${idx}@@`;
  });

  // 2. Protect images: ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const idx = images.length;
    const safeUrl = sanitizeUrl(url);
    images.push(`<img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(alt)}" class="max-w-full h-auto rounded my-2" />`);
    return `@@IMAGE${idx}@@`;
  });

  // 3. Protect links: [text](url) -> target="_blank" rel="noopener noreferrer"
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    const idx = links.length;
    const safeUrl = sanitizeUrl(url);
    links.push(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">${linkText}</a>`);
    return `@@LINK${idx}@@`;
  });

  // 4. Bold & Italic & Strikethrough
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 5. Restore links, images, and inline code
  text = text.replace(/@@LINK(\d+)@@/g, (_, idx) => links[Number(idx)] || '');
  text = text.replace(/@@IMAGE(\d+)@@/g, (_, idx) => images[Number(idx)] || '');
  text = text.replace(/@@INLINECODE(\d+)@@/g, (_, idx) => inlineCodes[Number(idx)] || '');

  return text;
}

export interface RenderMarkdownOptions {
  copyCode?: string;
}

/**
 * Converts GFM Markdown to sanitized semantic HTML with syntax-highlighted containers,
 * tables, task lists, blockquotes, and code copy delegation attributes.
 */
export function renderMarkdownToHtml(
  markdown: string,
  options?: RenderMarkdownOptions
): string {
  if (!markdown) return '';

  const codeBlocks: string[] = [];

  // 1. Extract fenced code blocks
  const codeBlockRegex = /(?:```|~~~)([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)(?:```|~~~)/g;
  const withBlocksExtracted = markdown.replace(codeBlockRegex, (_, lang, rawCode) => {
    const idx = codeBlocks.length;
    const cleanCode = rawCode.endsWith('\n') ? rawCode.slice(0, -1) : rawCode;
    const language = (lang || 'text').trim();
    const copyLabel = escapeHtml(options?.copyCode || 'Copy code');
    const encoded = encodeURIComponent(cleanCode);
    const escapedCode = escapeHtml(cleanCode);

    const blockHtml =
      `<div class="markdown-code-block rounded-lg overflow-hidden my-3 border border-[var(--border-subtle)] bg-[var(--bg-surface-sub)]">` +
      `<div class="flex items-center justify-between px-3 py-1.5 bg-black/20 text-xs font-mono text-slate-400 border-b border-[var(--border-subtle)]">` +
      `<span class="font-medium text-slate-300 uppercase">${escapeHtml(language)}</span>` +
      `<button type="button" class="markdown-copy-btn flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors" data-copy-code="${encoded}">` +
      `<span>${copyLabel}</span>` +
      `</button>` +
      `</div>` +
      `<pre class="p-3 overflow-x-auto text-xs font-mono text-slate-200"><code>${escapedCode}</code></pre>` +
      `</div>`;

    codeBlocks.push(blockHtml);
    return `\n\n%%CODE_BLOCK_${idx}%%\n\n`;
  });

  const lines = withBlocksExtracted.split(/\r?\n/);
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) {
      i++;
      continue;
    }

    // Code block placeholder
    const blockMatch = line.match(/^%%CODE_BLOCK_(\d+)%%$/);
    if (blockMatch) {
      output.push(codeBlocks[Number(blockMatch[1])] || '');
      i++;
      continue;
    }

    // ATX Headings: # - ######
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = renderInline(headingMatch[2]);
      const headingClasses: Record<number, string> = {
        1: 'text-2xl font-bold text-slate-100 my-4 border-b border-[var(--border-subtle)] pb-2',
        2: 'text-xl font-semibold text-slate-200 my-3 border-b border-[var(--border-subtle)] pb-1.5',
        3: 'text-lg font-semibold text-slate-200 my-2.5',
        4: 'text-base font-semibold text-slate-300 my-2',
        5: 'text-sm font-semibold text-slate-300 my-1.5',
        6: 'text-xs font-semibold text-slate-400 my-1 uppercase tracking-wide',
      };
      output.push(`<h${level} class="${headingClasses[level]}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal Rule: ---, ***, ___
    if (/^(?:---|---|\*\*\*|___)\s*$/.test(line)) {
      output.push('<hr class="my-4 border-[var(--border-subtle)]" />');
      i++;
      continue;
    }

    // Blockquote: >
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const quoteHtml = quoteLines.map(ql => renderInline(ql)).join('<br />');
      output.push(
        `<blockquote class="border-l-4 border-indigo-500 pl-4 py-1.5 my-3 text-slate-400 italic bg-slate-800/20 rounded-r">${quoteHtml}</blockquote>`
      );
      continue;
    }

    // GFM Table: line contains '|' and next line is a separator row
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].trim().includes('|')) {
      const sepLine = lines[i + 1].trim();
      const sepParts = splitTableRow(sepLine);
      const isSep = sepParts.length > 0 && sepParts.every(part => /^:?-+:?$/.test(part.trim()));

      if (isSep) {
        const headerParts = splitTableRow(line);
        const alignments = sepParts.map(part => {
          const t = part.trim();
          if (t.startsWith(':') && t.endsWith(':')) return 'center';
          if (t.endsWith(':')) return 'right';
          return 'left';
        });

        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length) {
          const tableLine = lines[i].trim();
          if (!tableLine || !tableLine.includes('|')) break;
          bodyRows.push(splitTableRow(tableLine));
          i++;
        }

        const alignClass = (align: string) => {
          if (align === 'center') return 'text-center';
          if (align === 'right') return 'text-right';
          return 'text-left';
        };

        const thead =
          `<thead class="bg-[var(--bg-surface-sub)] text-slate-300 font-semibold border-b border-[var(--border-subtle)]">` +
          `<tr>` +
          headerParts
            .map(
              (h, idx) =>
                `<th class="px-3 py-2 border-r border-[var(--border-subtle)] last:border-r-0 ${alignClass(
                  alignments[idx] || 'left'
                )}">${renderInline(h)}</th>`
            )
            .join('') +
          `</tr></thead>`;

        const tbody =
          `<tbody class="divide-y divide-[var(--border-subtle)]">` +
          bodyRows
            .map(
              row =>
                `<tr class="hover:bg-white/5">` +
                row
                  .map(
                    (cell, idx) =>
                      `<td class="px-3 py-2 border-r border-[var(--border-subtle)] last:border-r-0 ${alignClass(
                        alignments[idx] || 'left'
                      )}">${renderInline(cell)}</td>`
                  )
                  .join('') +
                `</tr>`
            )
            .join('') +
          `</tbody>`;

        output.push(
          `<div class="overflow-x-auto my-3 rounded-lg border border-[var(--border-subtle)]">` +
            `<table class="w-full text-left text-xs border-collapse">${thead}${tbody}</table>` +
            `</div>`
        );
        continue;
      }
    }

    // Task List or Regular List
    const taskMatch = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    const unorderedMatch = line.match(/^[-*+]\s+(.*)$/);
    const orderedMatch = line.match(/^(\d+)\.\s+(.*)$/);

    if (taskMatch || unorderedMatch || orderedMatch) {
      const isTask = Boolean(taskMatch);
      const isOrdered = Boolean(orderedMatch);
      const listItems: string[] = [];

      while (i < lines.length) {
        const itemLine = lines[i].trim();
        const curTask = itemLine.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
        const curUnordered = itemLine.match(/^[-*+]\s+(.*)$/);
        const curOrdered = itemLine.match(/^(\d+)\.\s+(.*)$/);

        if (curTask) {
          const checked = curTask[1].toLowerCase() === 'x';
          const text = renderInline(curTask[2]);
          listItems.push(
            `<li class="flex items-center space-x-2 my-1"><input type="checkbox" ${
              checked ? 'checked ' : ''
            }disabled class="rounded border-slate-600 text-indigo-600 focus:ring-0 cursor-default" /><span>${text}</span></li>`
          );
          i++;
        } else if (curUnordered && !isOrdered) {
          const text = renderInline(curUnordered[1]);
          listItems.push(`<li class="my-0.5">${text}</li>`);
          i++;
        } else if (curOrdered && isOrdered) {
          const text = renderInline(curOrdered[2]);
          listItems.push(`<li class="my-0.5">${text}</li>`);
          i++;
        } else {
          break;
        }
      }

      if (isTask) {
        output.push(`<ul class="list-none my-2 space-y-1 text-slate-300 text-xs sm:text-sm">${listItems.join('')}</ul>`);
      } else if (isOrdered) {
        output.push(`<ol class="list-decimal list-inside my-2 space-y-1 text-slate-300 text-xs sm:text-sm">${listItems.join('')}</ol>`);
      } else {
        output.push(`<ul class="list-disc list-inside my-2 space-y-1 text-slate-300 text-xs sm:text-sm">${listItems.join('')}</ul>`);
      }
      continue;
    }

    // Paragraph or generic text
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (!cur) break;
      // Stop if next line is a special block
      if (
        cur.startsWith('#') ||
        cur.startsWith('>') ||
        cur.startsWith('---') ||
        cur.match(/^[-*+]\s+/) ||
        cur.match(/^\d+\.\s+/) ||
        cur.match(/^%%CODE_BLOCK_\d+%%$/) ||
        (cur.includes('|') && i + 1 < lines.length && lines[i + 1].trim().includes('|'))
      ) {
        break;
      }
      paragraphLines.push(renderInline(cur));
      i++;
    }

    if (paragraphLines.length > 0) {
      output.push(`<p class="my-2 leading-relaxed text-slate-300 text-xs sm:text-sm">${paragraphLines.join(' ')}</p>`);
    }
  }

  const rawHtml = output.join('\n');
  return sanitizeMarkdownHtml(rawHtml);
}
