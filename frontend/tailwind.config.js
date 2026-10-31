/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg-canvas)',
        surface: 'var(--bg-surface)',
        'surface-sub': 'var(--bg-surface-sub)',
        elevated: 'var(--bg-elevated)',
        terminal: 'var(--bg-terminal)',
        control: 'var(--bg-control)',
        'control-hover': 'var(--bg-control-hover)',
      },
    },
  },
  plugins: [],
}
