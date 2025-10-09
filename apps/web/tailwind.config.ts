import { heroui } from '@heroui/react';
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  darkMode: 'class',
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            primary: '#0596aa',
            secondary: '#c89b3c',
            success: '#0f2027',
            warning: '#c8aa6e',
            danger: '#c8282f',
            background: '#010a13',
            foreground: '#f0e6d2',
          },
        },
        dark: {
          colors: {
            primary: '#0596aa',
            secondary: '#c89b3c',
            success: '#0f2027',
            warning: '#c8aa6e',
            danger: '#c8282f',
            background: '#010a13',
            foreground: '#f0e6d2',
          },
        },
      },
    }),
  ],
};

export default config;