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
    // main.js.map sits next to main.js so production stack traces point at frontend/src.
    // The source is public on GitHub anyway; the map is only fetched when devtools are open.
    sourcemap: true,
    rolldownOptions: {
      input: 'src/main.tsx',
      output: { entryFileNames: 'main.js' },
    },
  },
});
