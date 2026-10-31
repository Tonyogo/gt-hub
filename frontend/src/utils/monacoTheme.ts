export const defineGeminiProxyTheme = (monaco: any) => {
  monaco.editor.defineTheme('gemini-proxy-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: 'fde68a', fontStyle: 'bold' }, // Amber 200
      { token: 'string.value.json', foreground: '34d399' },                // Emerald 400
      { token: 'number', foreground: '60a5fa' },                           // Blue 400
      { token: 'keyword.json', foreground: 'c084fc' },                     // Purple 400
      { token: 'null', foreground: '64748b', fontStyle: 'italic' }         // Slate 500
    ],
    colors: {
      'editor.background': '#090D16',
      'editor.lineHighlightBackground': '#151D2E80',
      'editorLineNumber.foreground': '#475569',
      'editorLineNumber.activeForeground': '#94A3B8'
    }
  });

  monaco.editor.defineTheme('gemini-proxy-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: 'b45309', fontStyle: 'bold' }, // Amber 700
      { token: 'string.value.json', foreground: '059669' },                // Emerald 600
      { token: 'number', foreground: '2563eb' },                           // Blue 600
      { token: 'keyword.json', foreground: '7c3aed' },                     // Purple 600
      { token: 'null', foreground: '94a3b8', fontStyle: 'italic' }         // Slate 400
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.lineHighlightBackground': '#F1F5F9',
      'editorLineNumber.foreground': '#94A3B8',
      'editorLineNumber.activeForeground': '#334155'
    }
  });
};
