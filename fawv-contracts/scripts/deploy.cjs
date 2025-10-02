const { ethers } = require("hardhat");

async function main() {
  console.log("ethers injected?", !!ethers);
  const Factory = await ethers.getContractFactory("FAWVMinter721");
  const c = await Factory.deploy();
  await c.waitForDeployment();
  console.log("Deployed at:", await c.getAddress());
}
main().catch((e) => { console.error(e); process.exit(1); });
