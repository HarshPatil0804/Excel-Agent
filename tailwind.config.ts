import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: { 25: '#fcfcfd' },
        primary: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
        success: '#15803d', warning: '#b45309', danger: '#b91c1c',
        chart: { indigo: '#4f46e5', cyan: '#0e7490', green: '#15803d', amber: '#b45309', rose: '#be123c', violet: '#7e22ce' },
      },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
      borderRadius: { card: '12px' },
      boxShadow: { soft: '0 8px 30px rgb(15 23 42 / 0.06)' },
      transitionDuration: { 180: '180ms', 220: '220ms' },
      spacing: { 18: '4.5rem' },
    },
  },
  plugins: [],
} satisfies Config
