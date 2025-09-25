// ../web/src/lib/vault-actions.ts
import { ethers } from "ethers";
import { connectWallet, getVaultContract } from "@/lib/chain";
import { sha256Hex, toBytes32 } from "@/lib/hash";

/** What the UI gets back after a successful on-chain call */
export type MintResult = {
  owner: string;
  contract: string;
  txHash: string;
  tokenId: string | null;         // null if we couldn't infer it
  manifestUrl: string;
  fileHash: `0x${string}`;        // bytes32 hex (sha256)
  methodUsed: string;             // which contract method was called
  s3VaultPath?: string;           // optional, for your “Your Vault” block
};

/** Nicely shortens 0x addresses for display */
export function shortAddr(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

/** Etherscan helpers */
export function etherscanTxUrl(txHash: string) {
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}
export function etherscanAddressUrl(addr: string) {
  return `https://sepolia.etherscan.io/address/${addr}`;
}

/**
 * Mints/records an uploaded asset on Sepolia.
 * - Connects wallet, ensures Sepolia (handled in connectWallet)
 * - Computes SHA-256 of the original file (bytes32)
 * - Calls the first matching method it finds on your contract:
 *     safeMint(address to, string uri, bytes32 fileHash)
 *     mint(address to, string uri, bytes32 fileHash)
 *     recordAsset(address to, bytes32 fileHash, string uri)
 * - Waits for receipt, tries to parse tokenId from events
 *
 * @param manifestUrl  The URL you want stored as tokenURI/metadata link
 * @param originalFile The exact File object the user uploaded
 * @param s3VaultPath  (optional) e.g., "s3://bucket/vaults/DEV/…"
 */
export async function mintOrRecord(
  manifestUrl: string,
  originalFile: File,
  s3VaultPath?: string
): Promise<MintResult> {
  // 1) Wallet + contract
  const { signer, address: owner } = await connectWallet();
  const contract = getVaultContract(signer);
  const contractAddr = await contract.getAddress();

  // 2) Hash file → bytes32
  const sha = await sha256Hex(originalFile);
  const fileHash32 = toBytes32(sha);

  // 3) Pick a method that exists on this ABI
  const candidates: Array<{
    name: string;
    call: () => Promise<ethers.TransactionResponse>;
  }> = [];

  // Helper to check if function exists without throwing the whole flow
  const hasFn = (sig: string) => {
    try {
      contract.interface.getFunction(sig);
      return true;
    } catch {
      return false;
    }
  };

  if (hasFn("safeMint(address,string,bytes32)")) {
    candidates.push({
      name: "safeMint(address,string,bytes32)",
      call: () => contract.safeMint(owner, manifestUrl, fileHash32),
    });
  }
  if (hasFn("mint(address,string,bytes32)")) {
    candidates.push({
      name: "mint(address,string,bytes32)",
      call: () => contract.mint(owner, manifestUrl, fileHash32),
    });
  }
  if (hasFn("recordAsset(address,bytes32,string)")) {
    candidates.push({
      name: "recordAsset(address,bytes32,string)",
      call: () => contract.recordAsset(owner, fileHash32, manifestUrl),
    });
  }

  if (candidates.length === 0) {
    // Last-ditch: try looser name-only checks that some ABIs expose
    if ((contract as any).safeMint) {
      candidates.push({
        name: "safeMint(?)",
        call: () => (contract as any).safeMint(owner, manifestUrl, fileHash32),
      });
    } else if ((contract as any).mint) {
      candidates.push({
        name: "mint(?)",
        call: () => (contract as any).mint(owner, manifestUrl, fileHash32),
      });
    } else if ((contract as any).recordAsset) {
      candidates.push({
        name: "recordAsset(?)",
        call: () => (contract as any).recordAsset(owner, fileHash32, manifestUrl),
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      "No compatible contract method found. Expected one of: " +
        "safeMint(address,string,bytes32), mint(address,string,bytes32), recordAsset(address,bytes32,string)."
    );
  }

  // 4) Execute first available method
  let methodUsed = "";
  let tx: ethers.TransactionResponse;
  let receipt: ethers.TransactionReceipt;

  for (const c of candidates) {
    try {
      methodUsed = c.name;
      tx = await c.call();
      receipt = await tx.wait();
      break;
    } catch (err) {
      // Try next candidate if this one reverts or mismatches
      if (c === candidates[candidates.length - 1]) throw err;
      continue;
    }
  }

  // At this point we must have tx & receipt
  // @ts-expect-error — guarded above
  const txHash: string = receipt!.hash;

  // 5) Try to parse a tokenId from events (works for ERC721 and many custom Mints)
  let tokenId: string | null = null;
  try {
    for (const log of receipt!.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        // Common cases:
        // - Custom "Minted(address to, uint256 tokenId, string tokenURI, bytes32 hash)"
        // - ERC-721 "Transfer(address from, address to, uint256 tokenId)" with from == 0x0
        if (parsed?.name === "Minted") {
          const id = parsed.args?.tokenId ?? parsed.args?.[1];
          tokenId = id?.toString?.() ?? null;
          if (tokenId) break;
        }
        if (parsed?.name === "Transfer") {
          // Transfer(from, to, tokenId)
          const from = parsed.args?.from ?? parsed.args?.[0];
          const id = parsed.args?.tokenId ?? parsed.args?.[2];
          const zero = "0x0000000000000000000000000000000000000000";
          if ((from?.toLowerCase?.() ?? "") === zero) {
            tokenId = id?.toString?.() ?? null;
            if (tokenId) break;
          }
        }
      } catch {
        // Not a log for this interface — skip
      }
    }
  } catch {
    // swallow — tokenId stays null
  }

  return {
    owner,
    contract: contractAddr,
    txHash,
    tokenId,
    manifestUrl,
    fileHash: fileHash32,
    methodUsed,
    s3VaultPath,
  };
}
