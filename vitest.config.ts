import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { GATEWAY_SECRET: "test-secret" },
        // Miniflare's local send_email binding validates the message (From:
        // header must equal the envelope sender) and rejects recipients that
        // are not listed here, which stands in for unverified addresses.
        email: { send_email: [{ name: "EMAIL", allowed_destination_addresses: ["author@example.com"] }] },
      },
    }),
  ],
  test: {
    restoreMocks: true,
  },
});
