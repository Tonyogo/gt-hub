export const defineGeminiProxyTheme = (monaco: any) => {
  monaco.editor.defineTheme('gemini-proxy-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: 'fde68a', fontStyle: 'bold' }, // Amber 200
      { token: 'string.value.json', foreground: '34d399' },                // Emerald 400
      { token: 'number', foreground: '60a5fa' },                           // Blue 400
      { token: 'keyword.json', foreground: 'c084fc' },                     // Purple 400
      { token: 'null', foreground: '646b7a', fontStyle: 'italic' }         // Muted neutral
    ],
    colors: {
      'editor.background': '#0b0d11',
      'editor.lineHighlightBackground': '#161920',
      'editorLineNumber.foreground': '#646b7a',
      'editorLineNumber.activeForeground': '#a1a8b8'
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
      { token: 'null', foreground: '858d9e', fontStyle: 'italic' }         // Muted neutral
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f8f9fb',
      'editorLineNumber.foreground': '#858d9e',
      'editorLineNumber.activeForeground': '#111318'
    }
  });
};
