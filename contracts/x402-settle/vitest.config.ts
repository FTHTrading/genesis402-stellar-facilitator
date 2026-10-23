import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Testnet integration test for the x402-settle contract. Separate from the
 * root config so `npm test` stays network-free; run with
 * `T2_TESTNET=1 npx vitest run --config contracts/x402-settle/vitest.config.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@genesis402/stellar-facilitator": `${repoRoot}packages/facilitator/src/index.ts`,
    },
  },
  test: {
    include: ["contracts/x402-settle/test/**/*.test.ts"],
    root: repoRoot,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
