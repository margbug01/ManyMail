import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

// No index.html here: the page is web/templates/index.html, rendered by Go, which loads
// /static/app/main.js. The file name stays fixed because Go appends ?v=<content hash>.
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '../web/static/app',
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: 'src/main.tsx',
      output: { entryFileNames: 'main.js' },
    },
  },
});
