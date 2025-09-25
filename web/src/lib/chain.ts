import { ethers } from "ethers";
import abiJson from "@/abi/FAWVMinter721.json";
import { FAWV_VAULT_ADDR } from "@/lib/addresses";

export const FAWV_VAULT_ABI = abiJson.abi;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7"; // 11155111

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet (MetaMask/Rabby) found");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const chainId = await provider.send("eth_chainId", []);
  if (chainId !== SEPOLIA_CHAIN_ID_HEX) {
    // try switch, then add if needed
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: SEPOLIA_CHAIN_ID_HEX }]);
    } catch (e: any) {
      if (e?.code === 4902) {
        await provider.send("wallet_addEthereumChain", [{
          chainId: SEPOLIA_CHAIN_ID_HEX,
          chainName: "Sepolia",
          nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://eth-sepolia.g.alchemy.com/v2/PLACEHOLDER"],
          blockExplorerUrls: ["https://sepolia.etherscan.io/"]
        }]);
      } else {
        throw e;
      }
    }
  }
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress() };
}

export function getVaultContract(signerOrProvider: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(FAWV_VAULT_ADDR, FAWV_VAULT_ABI, signerOrProvider);
}
