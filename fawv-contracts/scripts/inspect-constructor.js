// scripts/inspect-constructor.js (ESM)
import fs from "node:fs";
import path from "node:path";

const artifactPath = path.join("artifacts", "contracts", "FAWVVault.sol", "FAWVVault.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const ctor = artifact.abi.find((x) => x.type === "constructor") || { inputs: [] };

if (!ctor.inputs.length) {
  console.log("Constructor has NO inputs.");
} else {
  console.log(
    "Constructor inputs:",
    ctor.inputs.map((i) => `${i.type} ${i.name}`).join(", ")
  );
}
