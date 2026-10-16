import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Large reference videos/zips live in the project root; watching them can crash the
    // dev server on Windows (EBUSY while a file is still being copied).
    watch: { ignored: ['**/*.mp4', '**/*.mov', '**/*.zip', '**/dist/**'] },
  },
});
