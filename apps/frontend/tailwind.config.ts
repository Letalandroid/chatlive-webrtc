import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(222 47% 6%)',
        foreground: 'hsl(210 40% 98%)',
        card: 'hsl(222 36% 10%)',
        border: 'hsl(217 25% 22%)',
        primary: 'hsl(162 84% 52%)',
        muted: 'hsl(217 18% 40%)',
      },
      boxShadow: {
        glow: '0 0 60px rgba(45, 212, 191, 0.18)',
      },
    },
  },
  plugins: [],
} satisfies Config;
