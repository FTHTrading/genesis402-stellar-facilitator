// Browser side of the Genesis402 testnet faucet.
// The "Make me a test wallet" keypair is created here and its secret never leaves this tab:
// our API receives an address, Horizon receives a signed change_trust, nothing else.
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";

interface Info {
  asset: { code: string; issuer: string; sac: string };
  distributor: string;
  claimAmount: string;
  xlm: { amount: string; sac: string };
  usdc: { sac: string; faucetUrl: string };
  horizonUrl: string;
  networkPassphrase: string;
  explorerTxBase: string;
  g402tReady: boolean;
}

interface ApiResult {
  status: number;
  body: {
    ok?: boolean;
    error?: string;
    message?: string;
    hash?: string | null;
    explorer?: string | null;
    amount?: string;
    fix?: { assetCode: string; assetIssuer: string; account: string };
  };
}

const EXPLORER_ACCOUNT = "https://stellar.expert/explorer/testnet/account/";
let info: Info | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Array<Node | string>) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) node.append(kid);
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  return el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });
}

async function claim(token: "xlm" | "g402t", address: string): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/claim/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const body = (await res.json().catch(() => ({ message: `Server answered HTTP ${res.status}.` }))) as ApiResult["body"];
    return { status: res.status, body };
  } catch {
    return { status: 0, body: { error: "network", message: "Could not reach the faucet. Check your connection and try again." } };
  }
}

/* ---------- theme ---------- */
function setupTheme(): void {
  const btn = $<HTMLButtonElement>("#theme-toggle");
  const root = document.documentElement;
  const current = () =>
    (root.dataset.theme as "light" | "dark" | undefined) ??
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const paint = () => {
    const t = current();
    btn.setAttribute("aria-pressed", String(t === "dark"));
    btn.textContent = t === "dark" ? "Light theme" : "Dark theme";
  };
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("g402-theme", next);
    } catch {
      /* storage blocked: theme still switches for this visit */
    }
    paint();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  paint();
}

/* ---------- copy buttons ---------- */
async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select and copy";
  }
  setTimeout(() => (button.textContent = label), 1600);
}

function copyRow(label: string, value: string, opts: { secret?: boolean } = {}): HTMLElement {
  const code = el("code", { className: "mono value", textContent: value });
  const copy = el("button", { type: "button", className: "btn-ghost", textContent: "Copy" });
  copy.addEventListener("click", () => void copyText(value, copy));
  const row = el("div", { className: opts.secret ? "kv kv-secret" : "kv" }, el("span", { className: "kv-label", textContent: label }), code, copy);
  return row;
}

/* ---------- messages that stay until closed ---------- */
function showError(box: HTMLElement, message: string, extra?: Node): void {
  box.replaceChildren();
  const close = el("button", { type: "button", className: "alert-close", textContent: "Close" });
  close.setAttribute("aria-label", "Close this message");
  close.addEventListener("click", () => {
    box.replaceChildren();
    box.hidden = true;
  });
  const body = el("div", { className: "alert-body" }, el("p", { className: "alert-msg", textContent: message }));
  if (extra) body.append(extra);
  box.append(el("div", { className: "alert alert-bad" }, body, close));
  box.setAttribute("role", "alert");
  box.hidden = false;
}

function showSuccess(box: HTMLElement, message: string, txUrl?: string | null): void {
  box.replaceChildren();
  const p = el("p", { className: "alert-msg", textContent: message });
  const body = el("div", { className: "alert-body" }, p);
  if (txUrl) body.append(el("p", {}, link(txUrl, "View the transaction on stellar.expert")));
  box.append(el("div", { className: "alert alert-ok" }, body));
  box.setAttribute("role", "status");
  box.hidden = false;
}

function trustlineFix(fix: { assetCode: string; assetIssuer: string }): HTMLElement {
  return el(
    "div",
    { className: "fix" },
    el("p", { className: "fix-title", textContent: "How to fix it" }),
    el(
      "ol",
      {},
      el("li", { textContent: "In your wallet, add a trustline (change_trust) for this asset:" }),
    ),
    copyRow("Asset code", fix.assetCode),
    copyRow("Issuer", fix.assetIssuer),
    el("p", { className: "muted", textContent: "Then press Obtain again. Or use Make me a test wallet above, which adds the trustline for you." }),
  );
}

/* ---------- token cards ---------- */
function setupCard(token: "xlm" | "g402t"): void {
  const form = $<HTMLFormElement>(`#form-${token}`);
  const input = $<HTMLInputElement>("input[name=address]", form);
  const button = $<HTMLButtonElement>("button[type=submit]", form);
  const out = $(`#out-${token}`);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const address = input.value.trim();
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Sending...";
    out.hidden = true;
    const r = await claim(token, address);
    button.disabled = false;
    button.textContent = label;
    if (r.body.ok) {
      const what = token === "xlm" ? `${Number(r.body.amount ?? 10000).toLocaleString("en-US")} test XLM` : `${Number(r.body.amount ?? 1000).toLocaleString("en-US")} G402T`;
      showSuccess(out, `Sent ${what} to ${address.slice(0, 6)}...${address.slice(-6)}.`, r.body.explorer);
      return;
    }
    const message = r.body.message ?? `The faucet answered HTTP ${r.status}.`;
    const extra = r.body.error === "no_trustline" && r.body.fix ? trustlineFix(r.body.fix) : r.body.explorer ? el("p", {}, link(r.body.explorer, "Transaction on stellar.expert")) : undefined;
    showError(out, message, extra);
  });
}

/* ---------- details under each card ---------- */
function fillDetails(i: Info): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-field]")) {
    const key = node.dataset.field ?? "";
    const value: Record<string, string> = {
      "g402t.code": i.asset.code,
      "g402t.issuer": i.asset.issuer,
      "g402t.sac": i.asset.sac,
      "g402t.distributor": i.distributor,
      "xlm.sac": i.xlm.sac,
      "usdc.sac": i.usdc.sac,
    };
    if (key in value) {
      node.textContent = value[key]!;
      node.title = value[key]!;
    }
  }
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-account-link]")) {
    const key = a.dataset.accountLink ?? "";
    const id = key === "issuer" ? i.asset.issuer : key === "distributor" ? i.distributor : "";
    if (id) a.href = `${EXPLORER_ACCOUNT}${id}`;
  }
  if (!i.g402tReady) {
    showError($("#out-g402t"), "The G402T faucet is not set up on this server yet. Test XLM still works.");
  }
}

/* ---------- Make me a test wallet ---------- */
const STEPS = ["keys", "xlm", "account", "trust", "g402t"] as const;
type Step = (typeof STEPS)[number];

function mark(step: Step, state: "doing" | "done" | "failed", note?: string): void {
  const li = $(`#step-${step}`);
  li.dataset.state = state;
  const n = $(".step-note", li);
  n.textContent = note ?? (state === "doing" ? "working..." : state === "done" ? "done" : "stopped");
}

async function waitForAccount(horizon: string, id: string): Promise<{ sequence: string }> {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${horizon}/accounts/${id}`).catch(() => null);
    if (res?.ok) return (await res.json()) as { sequence: string };
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("The new account did not appear on testnet in time. Try again in a minute.");
}

async function addTrustline(i: Info, kp: Keypair, sequence: string): Promise<string> {
  const tx = new TransactionBuilder(new Account(kp.publicKey(), sequence), {
    fee: "1000",
    networkPassphrase: i.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(i.asset.code, i.asset.issuer) }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  // Straight to Horizon: the signed transaction contains a signature, never the secret.
  const res = await fetch(`${i.horizonUrl}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { hash?: string; extras?: { result_codes?: unknown } };
  if (!res.ok || !body.hash) {
    throw new Error(`Horizon refused the trustline (${JSON.stringify(body.extras?.result_codes ?? res.status)}). Try again in a minute.`);
  }
  return body.hash;
}

const DONE_LABEL = "Done — make another tomorrow";

function txList(txs: Array<[string, string]>): HTMLElement {
  return el("ul", { className: "tx-list" }, ...txs.map(([label, url]) => el("li", {}, link(url, label))));
}

/**
 * The generated wallet: address, secret and the testnet warning. Shown after a full run, and also
 * when a later step fails after Friendbot funded the account, so the funded wallet is never lost.
 */
function walletCard(kp: Keypair, txs: Array<[string, string]>, complete: boolean): Node[] {
  const nodes: Node[] = [
    el("h3", { textContent: complete ? "Your test wallet" : "Your test wallet (not finished)" }),
    copyRow("Address", kp.publicKey()),
    copyRow("Secret key", kp.secret(), { secret: true }),
    el(
      "p",
      { className: "warn" },
      el("strong", { textContent: "Testnet only. These tokens have no value." }),
      " This secret key was made in your browser and never sent to us. Do not reuse it for anything else. Anyone who sees it controls this test wallet.",
    ),
  ];
  if (!complete) {
    nodes.push(
      el("p", {
        textContent:
          "This wallet already has test XLM. Save the secret key now. To finish, add the G402T trustline in a wallet app, then paste the address into the Get 1,000 G402T card.",
      }),
    );
  }
  nodes.push(el("p", {}, link(`${EXPLORER_ACCOUNT}${kp.publicKey()}`, "Open the wallet on stellar.expert")));
  if (txs.length) nodes.push(txList(txs));
  return nodes;
}

function setupWallet(): void {
  const btn = $<HTMLButtonElement>("#wallet-btn");
  const steps = $("#wallet-steps");
  const result = $("#wallet-result");
  const errorBox = $("#wallet-error");

  btn.addEventListener("click", async () => {
    if (!info) return;
    const i = info;
    btn.disabled = true;
    btn.textContent = "Working...";
    errorBox.hidden = true;
    result.hidden = true;
    result.replaceChildren();
    steps.hidden = false;
    for (const s of STEPS) {
      const li = $(`#step-${s}`);
      li.dataset.state = "todo";
      $(".step-note", li).textContent = "";
    }
    let current: Step = "keys";
    const txs: Array<[string, string]> = [];
    let kp: Keypair | null = null;
    let funded = false;
    let finished = false;
    try {
      mark("keys", "doing");
      kp = Keypair.random();
      mark("keys", "done", `${kp.publicKey().slice(0, 6)}...${kp.publicKey().slice(-6)}`);

      current = "xlm";
      mark("xlm", "doing");
      const x = await claim("xlm", kp.publicKey());
      if (!x.body.ok) throw new Error(x.body.message ?? "Friendbot did not fund the account.");
      funded = true;
      if (x.body.explorer) txs.push(["Test XLM", x.body.explorer]);
      mark("xlm", "done", "10,000 test XLM");

      current = "account";
      mark("account", "doing");
      const acct = await waitForAccount(i.horizonUrl, kp.publicKey());
      mark("account", "done");

      current = "trust";
      mark("trust", "doing");
      const trustHash = await addTrustline(i, kp, acct.sequence);
      txs.push(["G402T trustline", `${i.explorerTxBase}${trustHash}`]);
      mark("trust", "done", "signed in this browser");

      current = "g402t";
      mark("g402t", "doing");
      const g = await claim("g402t", kp.publicKey());
      if (!g.body.ok) throw new Error(g.body.message ?? "The G402T payment did not go through.");
      if (g.body.explorer) txs.push(["1,000 G402T", g.body.explorer]);
      mark("g402t", "done", "1,000 G402T");

      result.append(...walletCard(kp, txs, true));
      result.hidden = false;
      finished = true;
    } catch (err) {
      mark(current, "failed");
      if (funded && kp) {
        // Friendbot already funded this keypair: show it, or the funded wallet is lost with the tab.
        result.append(...walletCard(kp, txs, false));
        result.hidden = false;
        showError(errorBox, (err as Error).message);
      } else {
        showError(errorBox, (err as Error).message, txs.length ? txList(txs) : undefined);
      }
    } finally {
      if (finished || funded) {
        // Test XLM is one claim per network per day, so another run today would stop at step 2.
        btn.disabled = true;
        btn.textContent = DONE_LABEL;
      } else {
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    }
  });
}

async function boot(): Promise<void> {
  setupTheme();
  setupCard("xlm");
  setupCard("g402t");
  setupWallet();
  try {
    const res = await fetch("/api/info");
    info = (await res.json()) as Info;
    fillDetails(info);
    $<HTMLButtonElement>("#wallet-btn").disabled = !info.g402tReady;
  } catch {
    showError($("#wallet-error"), "Could not load faucet details. Reload the page to try again.");
  }
}

void boot();
