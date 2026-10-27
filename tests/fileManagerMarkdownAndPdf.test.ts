import fs from 'fs';
import path from 'path';

describe('File Manager Markdown & PDF Preview Integration', () => {
  const fileManagerPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalFileManagerView.tsx'
  );
  const mdViewerPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalMarkdownViewer.tsx'
  );
  const pdfModalPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalPdfPreviewModal.tsx'
  );

  test('TerminalMarkdownViewer component exists and wires renderMarkdownToHtml and copy delegation', () => {
    expect(fs.existsSync(mdViewerPath)).toBe(true);
    const mdViewerCode = fs.readFileSync(mdViewerPath, 'utf-8');
    expect(mdViewerCode).toContain('renderMarkdownToHtml');
    expect(mdViewerCode).toContain('data-copy-code');
    expect(mdViewerCode).toContain('navigator.clipboard.writeText');
    expect(mdViewerCode).toContain('dangerouslySetInnerHTML');
  });

  test('TerminalPdfPreviewModal component exists and renders iframe with new-tab, maximize, download, and close actions', () => {
    expect(fs.existsSync(pdfModalPath)).toBe(true);
    const pdfModalCode = fs.readFileSync(pdfModalPath, 'utf-8');
    expect(pdfModalCode).toContain('<iframe');
    expect(pdfModalCode).toContain('window.open(blobUrl');
    expect(pdfModalCode).toContain("t('files.openInNewTab'");
    expect(pdfModalCode).toContain('onDownload(file)');
    expect(pdfModalCode).toContain('Escape');
  });

  test('TerminalFileManagerView routes PDF files to TerminalPdfPreviewModal with application/pdf Blob and revokes object URLs', () => {
    const fmCode = fs.readFileSync(fileManagerPath, 'utf-8');
    expect(fmCode).toContain('isPdfExtension');
    expect(fmCode).toContain('TerminalPdfPreviewModal');
    expect(fmCode).toContain("type: 'application/pdf'");
    expect(fmCode).toContain('URL.createObjectURL');
    expect(fmCode).toContain('URL.revokeObjectURL');
  });

  test('TerminalFileManagerView opens Markdown files in preview mode by default and provides preview/edit toggle', () => {
    const fmCode = fs.readFileSync(fileManagerPath, 'utf-8');
    expect(fmCode).toContain('isMarkdownExtension');
    expect(fmCode).toContain('TerminalMarkdownViewer');
    expect(fmCode).toContain("viewMode: isMarkdown ? 'preview' : 'edit'");
    expect(fmCode).toContain("t('files.previewMode'");
    expect(fmCode).toContain("t('files.editMode'");
  });
});
