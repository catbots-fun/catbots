import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export function rendererContentSecurityPolicy(development: boolean): string {
  const connectSource = development
    ? "connect-src 'self' http://localhost:* ws://localhost:*"
    : "connect-src 'self'";
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; ${connectSource}`;
}

function contentSecurityPolicyPlugin(development: boolean): Plugin {
  return {
    name: 'catbots-renderer-content-security-policy',
    transformIndexHtml: (html) => html.replace('__CATBOTS_CSP__', rendererContentSecurityPolicy(development)),
  };
}

export default defineConfig(({ command }) => ({
  plugins: [contentSecurityPolicyPlugin(command === 'serve'), react()],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  // Workspace source changes frequently; prebundling these can retain stale exports.
  optimizeDeps: { exclude: ['@catbots/contracts', '@catbots/strategy-runtime', '@catbots/node-kit', ...['trigger', 'data', 'indicator', 'process', 'condition', 'strategy', 'risk', 'action', 'output'].map(name => `@catbots/nodes-${name}`)] },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        wallet: resolve(__dirname, 'src/renderer/wallet.html'),
        web: resolve(__dirname, 'src/renderer/web.html'),
      },
    },
    outDir: resolve(__dirname, '.vite/renderer/main_window'),
  },
}));
