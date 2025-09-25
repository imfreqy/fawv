import hre from "hardhat";

async function main() {
  const { ethers } = hre; // comes from @nomicfoundation/hardhat-ethers
  const Factory = await ethers.getContractFactory("FAWVMinter721"); // or your FAWVVault
  const c = await Factory.deploy();          // add constructor args if needed
  await c.deployed();
  console.log("Deployed at:", c.address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
