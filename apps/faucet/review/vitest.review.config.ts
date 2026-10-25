import { defineConfig } from "vitest/config";

// Phase 4 review suite. Run: npx vitest run --config review/vitest.review.config.ts
export default defineConfig({
  test: {
    include: ["review/**/*.review.test.ts"],
    testTimeout: 180_000,
  },
});
