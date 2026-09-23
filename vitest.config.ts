import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Unit tests drive the handshake with fake frames — never load real pages.
    environmentOptions: {
      happyDOM: { settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } },
    },
    include: ['test/**/*.test.ts'],
  },
});
