import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/app/**/*.{ts,tsx}'],
  darkmode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
