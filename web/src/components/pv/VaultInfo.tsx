import React from "react";

type Tokenish = string | number | null | undefined;

type DataShape = {
  tokenId?: Tokenish;
  txHash?: string | null;
  tokenURI?: string | null;
  contractAddress?: string | null;
};

type ManifestShape = {
  token?: {
    tokenId?: Tokenish;
    txHash?: string | null;
    tokenURI?: string | null;
  };
  contractAddress?: string | null;
};

type Props = {
  data?: DataShape;
  manifest?: ManifestShape;
  explorerBase?: string;   // optional override; defaults to env
  className?: string;
};

const short = (a?: string | null) => (a ? `${a.slice(0, 10)}…${a.slice(-6)}` : "—");

export default function VaultInfo({ data, manifest, explorerBase, className }: Props) {
  const tokenId: Tokenish =
    data?.tokenId ?? manifest?.token?.tokenId ?? null;

  const txHash: string | null =
    (data?.txHash ?? manifest?.token?.txHash) ?? null;

  const tokenURI: string | null =
    (data?.tokenURI ?? manifest?.token?.tokenURI) ?? null;

  const contractAddress: string | null =
    (data?.contractAddress ?? manifest?.contractAddress ?? process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? null) as string | null;

  // Prefer prop override, else env
  const base = (explorerBase || process.env.NEXT_PUBLIC_EXPLORER_BASE || "").trim();

  const txLink   = txHash && base ? `${base}/tx/${txHash}` : null;
  const addrLink = contractAddress && base ? `${base}/address/${contractAddress}` : null;

  return (
    <div className={["space-y-1 text-sm", className].filter(Boolean).join(" ")}>
      <div><strong>Token ID:</strong> {tokenId ?? "—"}</div>
      <div><strong>Contract:</strong>{" "}
        {contractAddress
          ? (addrLink
              ? <a href={addrLink} target="_blank" rel="noreferrer">{short(contractAddress)}</a>
              : short(contractAddress))
          : "—"}
      </div>
      <div><strong>Tx:</strong>{" "}
        {txHash
          ? (txLink
              ? <a href={txLink} target="_blank" rel="noreferrer">{short(txHash)}</a>
              : short(txHash))
          : "—"}
      </div>
      <div><strong>tokenURI:</strong>{" "}
        {tokenURI
          ? <a href={tokenURI} target="_blank" rel="noreferrer">open</a>
          : "—"}
      </div>
    </div>
  );
}
