import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase')) return 'firebase';
          if (id.includes('node_modules/react')) return 'react';
          if (id.includes('node_modules/zod')) return 'zod';
        },
      },
    },
  },
});
