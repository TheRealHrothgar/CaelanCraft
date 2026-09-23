import { defineConfig } from 'vite';

export default defineConfig({
  // `--host` in the npm script exposes the dev server on the LAN so a Windows
  // browser can reach the WSL2 instance even when localhost forwarding is off.
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
