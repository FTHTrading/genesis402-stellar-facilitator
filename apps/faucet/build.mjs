// Bundles the browser script (src/client/main.ts) into public/app.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Returns the bundle text when write is false (used by the S3 bundle test). */
export async function buildClient({ write = true } = {}) {
  const result = await build({
    entryPoints: [`${root}src/client/main.ts`],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    outfile: `${root}public/app.js`,
    write,
    logLevel: write ? "info" : "silent",
  });
  return write ? "" : new TextDecoder().decode(result.outputFiles[0].contents);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildClient();
}
