require("dotenv").config();
const { Wallet } = require("ethers");

const pk = (process.env.DEPLOYER_PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  throw new Error(`DEPLOYER_PRIVATE_KEY invalid. Got length=${pk.length}, startsWith0x=${pk.startsWith("0x")}`);
}
const w = new Wallet(pk);
console.log("Deployer address:", w.address);
