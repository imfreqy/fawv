import "dotenv/config";
import "@nomicfoundation/hardhat-ethers";
import { task } from "hardhat/config";

/** Quick diagnostic: npx hardhat check-ethers should print true */ 
task("check-ethers", "Verify hre.ethers is available", async (_, hre) => { 
  console.log("hre.ethers?", !!hre.ethers); }); 
  task("show-networks", "Print resolved networks", async (_, hre) => { console.log(hre.config.networks); });
/** @type {import('hardhat/config').HardhatUserConfig} */
export default {
  solidity: "0.8.24",
  networks: {
    sepolia: {
      type: "http", // <-- required if you previously had a wrong type; or remove this line entirely
      url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
      chainId: 11155111,
    },
  },
};
