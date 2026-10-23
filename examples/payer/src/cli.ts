import { runTestnetDemo } from "./demo.js";

runTestnetDemo()
  .then((r) => {
    console.log("");
    console.log("DEMO RESULT");
    console.log(`  network      ${r.network}`);
    console.log(`  asset        ${r.asset.code} ${r.asset.contract} [${r.asset.label}]`);
    console.log(`  payer        ${r.payer}`);
    console.log(`  seller       ${r.seller}`);
    console.log(`  facilitator  ${r.facilitator} (fee sponsor only)`);
    console.log(`  tx hash      ${r.txHash}`);
    console.log(`  explorer     ${r.explorerUrl}`);
    console.log(`  discovered   ${r.discovered.length} resource(s)`);
    console.log(`  replay       ${r.replayRefused ? "refused (402)" : "NOT refused"}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("demo failed:", err);
    process.exit(1);
  });
