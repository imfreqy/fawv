import "dotenv/config";
import "@nomicfoundation/hardhat-ethers";

/** @type {import('hardhat/config').HardhatUserConfig} */
export default {
  solidity: "0.8.28",
  networks: {
    sepolia: {
      // DO NOT set "type" incorrectly; omit it or set to "http"
      url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
      chainId: 11155111
    }
  }
};
