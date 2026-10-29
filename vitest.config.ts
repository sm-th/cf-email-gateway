/// <reference types="vitest/importMeta" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:email": new URL("./test/cloudflare-email.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
  },
});
