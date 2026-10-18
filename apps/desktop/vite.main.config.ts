import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const releaseTrust = process.env.CATBOTS_RELEASE_TRUST_FILE === undefined
  ? {
      teamId: 'CATBOTS_TEAM_ID_REQUIRED',
      publicKey: 'CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED',
      commit: 'CATBOTS_RELEASE_COMMIT_REQUIRED',
    }
  : JSON.parse(readFileSync(process.env.CATBOTS_RELEASE_TRUST_FILE, 'utf8')) as {
      teamId: string; publicKey: string; commit: string;
    };

export default defineConfig({
  define: {
    __CATBOTS_RELEASE_TEAM_ID__: JSON.stringify(releaseTrust.teamId),
    __CATBOTS_RELEASE_PUBLIC_KEY__: JSON.stringify(releaseTrust.publicKey),
    __CATBOTS_RELEASE_COMMIT__: JSON.stringify(releaseTrust.commit),
  },
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'electron', /^node:/],
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
