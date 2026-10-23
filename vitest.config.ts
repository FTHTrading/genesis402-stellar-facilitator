import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import workspace packages from source so no build step is needed first.
    alias: {
      "@genesis402/stellar-facilitator": `${root}packages/facilitator/src/index.ts`,
      "@genesis402/stellar-seller-sdk": `${root}packages/seller-sdk/src/index.ts`,
      "@genesis402/stellar-discovery": `${root}packages/discovery/src/index.ts`,
      "@genesis402/example-reference-seller": `${root}examples/reference-seller/src/index.ts`,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
