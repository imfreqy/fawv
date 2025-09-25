// scripts/deploy-plain.js (ESM)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const artifact = readJSON(path.join(__dirname, "../artifacts/contracts/FAWVMinter721.sol/FAWVMinter721.json"));
  const ctor = artifact.abi.find((x) => x.type === "constructor") || { inputs: [] };

  const argsPath = path.join(__dirname, "FAWVVault.args.json");
  let args = [];
  if (ctor.inputs.length > 0) {
    if (!fs.existsSync(argsPath)) {
      const sig = ctor.inputs.map((i) => `${i.type} ${i.name}`).join(", ");
      throw new Error(
        `Constructor requires ${ctor.inputs.length} args (${sig}). ` +
        `Create ${argsPath} with a JSON array of values.`
      );
    }
    args = readJSON(argsPath);
    if (!Array.isArray(args) || args.length !== ctor.inputs.length) {
      const sig = ctor.inputs.map((i) => `${i.type} ${i.name}`).join(", ");
      throw new Error(
        `Expected ${ctor.inputs.length} constructor args (${sig}), got ${Array.isArray(args) ? args.length : typeof args}.`
      );
    }
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();

  console.log("FAWVVault deployed to:", await contract.getAddress());
}

main().catch((e) => (console.error(e), process.exit(1)));
