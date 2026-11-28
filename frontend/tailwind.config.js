/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        canvas: 'var(--bg-canvas)',
        sidebar: 'var(--bg-sidebar)',
        surface: 'var(--bg-surface)',
        'surface-sub': 'var(--bg-surface-sub)',
        input: 'var(--bg-input)',
        elevated: 'var(--bg-elevated)',
        terminal: 'var(--bg-terminal)',
        control: 'var(--bg-control)',
        'control-hover': 'var(--bg-control-hover)',
        accent: 'var(--accent-primary)',
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}
