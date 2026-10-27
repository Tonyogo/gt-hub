import React, { useMemo, useCallback } from 'react';
import { FileText, Edit2 } from 'lucide-react';
import { useTranslation } from '../../i18n/LanguageContext';
import { renderMarkdownToHtml } from '../../utils/markdownRenderer';

export interface TerminalMarkdownViewerProps {
  content: string;
  onRequestEdit?: () => void;
}

export const TerminalMarkdownViewer: React.FC<TerminalMarkdownViewerProps> = ({
  content,
  onRequestEdit,
}) => {
  const { t } = useTranslation();

  const isEmpty = !content || !content.trim();

  const html = useMemo(() => {
    if (isEmpty) return '';
    return renderMarkdownToHtml(content, {
      copyCode: t('files.copyCode', '复制代码'),
    });
  }, [content, isEmpty, t]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const btn = (e.target as HTMLElement).closest('[data-copy-code]') as HTMLElement | null;
      if (!btn) return;

      const rawEncoded = btn.getAttribute('data-copy-code');
      if (!rawEncoded) return;

      try {
        const code = decodeURIComponent(rawEncoded);
        navigator.clipboard.writeText(code);
        const span = btn.querySelector('span');
        if (span) {
          const originalText = span.textContent;
          span.textContent = t('files.codeCopied', '已复制');
          setTimeout(() => {
            span.textContent = originalText;
          }, 2000);
        }
      } catch (err) {
        console.error('Failed to copy code block:', err);
      }
    },
    [t]
  );

  if (isEmpty) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center select-none">
        <FileText className="w-12 h-12 text-slate-500 mb-3" />
        <p className="text-xs sm:text-sm max-w-md mb-4 text-slate-400">
          {t('files.emptyMarkdown', '文档内容为空，点击右上角「编辑」开始编写')}
        </p>
        {onRequestEdit && (
          <button
            type="button"
            onClick={onRequestEdit}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
          >
            <Edit2 className="w-3.5 h-3.5" />
            <span>{t('files.editMode', '编辑')}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="terminal-markdown-viewer h-full overflow-y-auto p-4 sm:p-6 select-text text-slate-200"
      onClick={handleContainerClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default TerminalMarkdownViewer;
