import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildClient } from "../build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED = "Testnet only. These tokens have no value.";
const FORBIDDEN = [
  "zero-knowledge",
  "insured",
  "guaranteed",
  "licensed",
  "custody",
  "real money",
  "mainnet",
  "BitGo",
  "TROPTIONS",
  "UNYKORN 7777",
  "first",
  "only",
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** Every piece of text a visitor can read: the page, its styles, the browser script, and server messages. */
function userFacingSources(): Array<{ file: string; text: string }> {
  const files = [
    ...filesUnder(join(root, "public")).filter((f) => /\.(html|css|svg|txt)$/.test(f) || f.endsWith("_headers")),
    ...filesUnder(join(root, "src", "client")),
    join(root, "src", "messages.ts"),
  ];
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

describe("AC5: copy", () => {
  it("the page says plainly: Testnet only. These tokens have no value.", () => {
    const html = readFileSync(join(root, "public", "index.html"), "utf8");
    expect(html).toContain(REQUIRED);
  });

  it("uses none of the forbidden words (the required sentence aside)", () => {
    const hits: string[] = [];
    for (const { file, text } of userFacingSources()) {
      const scrubbed = text.split(REQUIRED).join(" ");
      for (const word of FORBIDDEN) {
        const re = new RegExp(`\\b${word.replace(/[-]/g, "\\-")}\\b`, "i");
        if (re.test(scrubbed)) hits.push(`${file}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("loads fonts from fonts.bunny.net and never from Google Fonts", () => {
    const all = userFacingSources()
      .map((s) => s.text)
      .join("\n");
    expect(all).toContain("fonts.bunny.net");
    expect(all).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});

describe("S3: the static bundle carries no secret", () => {
  it("the built browser bundle and public files contain no Stellar secret key and no secret binding name", async () => {
    const bundle = await buildClient({ write: false });
    const texts = [bundle, ...userFacingSources().map((s) => s.text)];
    for (const t of texts) {
      expect(t).not.toMatch(/\bS[A-Z2-7]{55}\b/);
      expect(t).not.toContain("DISTRIBUTOR_SECRET");
    }
  });

  it("the browser bundle never sends a secret to our API (only an address)", () => {
    const client = readFileSync(join(root, "src", "client", "main.ts"), "utf8");
    // Every call to our API goes through claim(), which posts { address } and nothing else.
    expect(client).toMatch(/JSON\.stringify\(\{ address \}\)/);
    expect(client).not.toMatch(/JSON\.stringify\([^)]*secret/i);
  });
});
