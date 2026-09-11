import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig(({ mode }) => ({
  plugins: [solid({ hot: mode !== 'test' })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
