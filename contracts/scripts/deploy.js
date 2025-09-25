import hre from "hardhat";

async function main() {
  const { ethers } = hre; // ensures we use the plugin’s ethers
  const Factory = await ethers.getContractFactory("FAWVMinter721"); // or your contract name
  const c = await Factory.deploy();
  await c.deployed();
  console.log("Deployed at:", c.address);
}

main().catch((err) => { console.error(err); process.exit(1); });
