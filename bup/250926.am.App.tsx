import React, { useMemo, useRef, useState } from "react";
import Logo from "./components/brand/Logo";
import { mintOrRecord, etherscanTxUrl, shortAddr } from "@/lib/vault-actions";

// ---------------------- API & Wallet Helpers ----------------------
const api = (p: string) => `/api${p.startsWith("/") ? p : `/${p}`}`;

async function getToAddress(): Promise<string> {
  const eth = (window as any).ethereum;
  if (eth?.request) {
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    if (addr) return addr;
  }
  return "0x7165F61F2cAc70354bAD8Df2EbEa7992B4F35Fa2"; // demo fallback
}

async function ensureSepolia() {
  const eth = (window as any).ethereum;
  if (!eth?.request) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }], // 11155111
    });
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0xaa36a7",
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "SEP", decimals: 18 },
          rpcUrls: ["https://eth-sepolia.public.blastapi.io"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"]
        }]
      });
    }
  }
}

// ---------------------- Types & Utilities ----------------------
type Product = "Permanence" | "Permanence+" | "Heirloom";
type EscrowYears = 3 | 5 | 10;
type VaultVisibility = "PUBLIC" | "PRIVATE";

type PresignItem = {
  relPath: string;
  objectKey?: string;
  key?: string;
  s3Uri?: string;
  uploadUrl: string;
  contentType?: string;
  sse?: string;
  sha256?: string;
  hash?: string;
};
type PresignResponse = { sessionId: string; items: PresignItem[] };

type MintResult = {
  ok?: boolean;
  txHash?: string;
  tokenId?: string;
  tokenURI?: string;
  contract?: string;
  contractAddress?: string;
  manifestKey?: string;   // server may return these
  manifestRef?: string;
} | null;

function MintStatus({
  step,
  mintResult,
}: {
  step: "idle" | "uploading" | "done" | "error";
  mintResult: MintResult;
}) {
  if (step === "uploading") return <div className="mt-2 text-sm">Uploading & mintingâ€¦</div>;
  if (step !== "done" || !mintResult) return null;
  return (
    <section className="mt-3 space-y-1 text-sm">
      <div className="font-semibold">Minted!</div>
      {mintResult.txHash && <div>txHash: <span className="font-mono break-all">{mintResult.txHash}</span></div>}
      {mintResult.tokenId && <div>tokenId: <span className="font-mono break-all">{mintResult.tokenId}</span></div>}
      {mintResult.tokenURI && (
        <div className="truncate" title={mintResult.tokenURI}>
          tokenURI: {mintResult.tokenURI}
        </div>
      )}
    </section>
  );
}

interface DemoFile {
  file: File;
  fullPath: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 2)} ${sizes[i]}`;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
function randomHex(bytes = 20) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- Call your API to get presigned URLs ----
async function getPresignedPlan(
  sessionId: string,
  fileList: DemoFile[],
  manifestText: string
): Promise<PresignResponse> {
  const payload = {
    sessionId,
    meta: { extra: { manifestText } }, // keep it simple: include text for the server
    files: fileList.map((f) => ({
      relPath: f.fullPath,
      name: f.file.name,
      size: f.file.size,
      contentType: f.file.type || "application/octet-stream",
    })),
  };

  const res = await fetch(api("/upload/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`presign failed: ${res.status} ${msg}`);
  }
  const body = await res.json();
  return (body?.items ? body : body?.plan ? body.plan : body) as PresignResponse;
}

// Simple archive hash (path-aware). Fine for demo.
async function hashFilesSHA256(list: DemoFile[]): Promise<string> {
  const sorted = [...list].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  const blobs: BlobPart[] = [];
  for (const item of sorted) {
    blobs.push(item.fullPath, "\n");
    blobs.push(await item.file.arrayBuffer());
  }
  const ab = await new Blob(blobs).arrayBuffer();
  return sha256Hex(ab);
}

// ---------------------- Demo Pricing ----------------------
const PRICING = {
  tokenizationPerGB: 0.1,
  permanence: { storagePerGB: 0.6, annualEAS: 20.0 },
  permanencePlus: { storagePerGBBase: 0.5, perYearAdderPerGB: 0.2 },
  heirloom: { storagePerGB: 1.2 },
};
function ceilGB(bytes: number) {
  return Math.max(1, Math.ceil(bytes / 1024 ** 3));
}
function calculatePrice(
  product: Product,
  totalBytes: number,
  escrowYears?: EscrowYears
) {
  const gb = ceilGB(totalBytes);
  const tokenization = gb * PRICING.tokenizationPerGB;
  if (product === "Permanence") {
    const storage = gb * PRICING.permanence.storagePerGB;
    return {
      gb, tokenization, storage,
      subtotal: tokenization + storage,
      notes: `Requires annual Evidence of Active Stewardship (EAS) â€” $${PRICING.permanence.annualEAS.toFixed(2)}/yr`,
    };
  }
  if (product === "Permanence+") {
    const years = escrowYears ?? 3;
    const perGB = PRICING.permanencePlus.storagePerGBBase + years * PRICING.permanencePlus.perYearAdderPerGB;
    const storage = gb * perGB;
    return {
      gb, tokenization, storage,
      subtotal: tokenization + storage,
      notes: `${years}-year escrow window with grace; annual EAS still required.`,
    };
  }
  const storage = gb * PRICING.heirloom.storagePerGB;
  return {
    gb, tokenization, storage,
    subtotal: tokenization + storage,
    notes: `100-year guarantee. No annual EAS required.`,
  };
}

// ---------------------- Folder Drop Helpers ----------------------
async function traverseEntry(entry: any, pathPrefix = ""): Promise<DemoFile[]> {
  return new Promise((resolve) => {
    if (!entry) return resolve([]);
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((f) => {
        resolve([{ file: f, fullPath: pathPrefix + f.name }]);
      });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const all: Promise<DemoFile[]>[] = [];
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            const out = await Promise.all(all);
            resolve(out.flat());
            return;
          }
          for (const e of entries) {
            all.push(traverseEntry(e, pathPrefix + entry.name + "/"));
          }
          readBatch();
        });
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}
async function fromDataTransfer(items: DataTransferItemList): Promise<DemoFile[]> {
  const results: DemoFile[] = [];
  const tasks: Promise<DemoFile[]>[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // @ts-expect-error non-standard API
    const entry = (it as any).webkitGetAsEntry?.();
    if (entry) {
      tasks.push(traverseEntry(entry));
    } else {
      const f = it.getAsFile();
      if (f) results.push({ file: f, fullPath: f.name });
    }
  }
  const nested = await Promise.all(tasks);
  return results.concat(nested.flat());
}
function fromInputFileList(files: FileList): DemoFile[] {
  const arr: DemoFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // @ts-expect-error vendor property
    const rel = (f as any).webkitRelativePath || f.name;
    arr.push({ file: f, fullPath: rel });
  }
  return arr;
}

// ---------------------- App ----------------------
export default function App() {
  const [mode, setMode] = useState<"landing" | "demo">("landing");

  const [started, setStarted] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [escrowYears, setEscrowYears] = useState<EscrowYears>(3);
  const [files, setFiles] = useState<DemoFile[]>([]);
  const [sessionId] = useState(() => randomHex(8));
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [acceptedPrice, setAcceptedPrice] = useState(false);
  const [visibility, setVisibility] = useState<VaultVisibility | null>(null);
  const [endowmentUsd, setEndowmentUsd] = useState<string>("");
  const [endowmentError, setEndowmentError] = useState<string | null>(null);
  const [demoEthPrice, setDemoEthPrice] = useState<number>(3200);
  const [lockedEndowment, setLockedEndowment] = useState<null | { usd: number; eth: number; usdPerEth: number }>(null);
  const [manifestText, setManifestText] = useState<string>("");
  const [mintResult, setMintResult] = useState<MintResult>(null);
  const [flowStatus, setFlowStatus] = useState<"idle" | "uploading" | "error">("idle");
  const inFlightRef = useRef(false);

  // locked archive hash
  const [archiveHash, setArchiveHash] = useState<string>("");

  // S3 paths we capture (first uploaded key + manifest info from API or client)
  const [vaultStorage, setVaultStorage] = useState<{
    archiveKey?: string;     // first uploaded item key
    manifestKey?: string;    // e.g. 'vaults/abc123/manifest.json'
    manifestRef?: string;    // e.g. 's3://bucket/vaults/abc123/manifest.json' or https URL
  } | null>(null);

  const [step, setStep] = useState<
    | "selectProduct"
    | "upload"
    | "pricing"
    | "manifest"
    | "minting"
    | "vault"
  >("selectProduct");

  const inputRef = useRef<HTMLInputElement | null>(null);
  const totalBytes = useMemo(() => files.reduce((s, f) => s + f.file.size, 0), [files]);
  const price = useMemo(() => {
    if (!product) return null;
    return calculatePrice(product, totalBytes, escrowYears);
  }, [product, totalBytes, escrowYears]);

  // Drag/drop handlers (prevent browser navigation)
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer?.items) {
      const picked = await fromDataTransfer(e.dataTransfer.items);
      if (picked.length) setFiles(picked);
    }
  };
  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length) {
      const picked = fromInputFileList(e.target.files);
      setFiles(picked);
    }
  };

  const resetFlow = () => {
    setProduct(null);
    setFiles([]);
    setVaultName("");
    setAcceptedPrice(false);
    setVisibility(null);
    setStep("selectProduct");
    setEscrowYears(3);
    setEndowmentUsd("");
    setEndowmentError(null);
    setLockedEndowment(null);
    setArchiveHash("");
    setManifestText("");
    setMintResult(null);
    setVaultStorage(null);
    setFlowStatus("idle");
    setStarted(true);
  };

  const proceedAfterPricing = async () => {
    if (!acceptedPrice || !vaultName.trim()) return;

    const trimmed = (endowmentUsd ?? "").toString().trim();
    if (trimmed !== "") {
      const num = parseFloat(trimmed);
      if (Number.isNaN(num) || num < 0) {
        setEndowmentError("Please enter a valid non-negative USD amount for Endowment, or leave blank.");
        return;
      } else {
        const usdPerEth = demoEthPrice && demoEthPrice > 0 ? demoEthPrice : 1;
        const usd = num;
        const eth = usd / usdPerEth;
        setLockedEndowment({ usd, eth, usdPerEth });
      }
    } else {
      setLockedEndowment(null);
    }
    setEndowmentError(null);

    const hash = files.length ? await hashFilesSHA256(files) : "";
    setArchiveHash(hash);

    setStep("manifest");
  };

  // ---------------------- S3 + Mint ----------------------
  function normalizePlan(plan: any, source: DemoFile[]): PresignItem[] {
    if (!plan) return [];
    if (Array.isArray(plan.items)) return plan.items as PresignItem[];
    if (plan.item && plan.item.uploadUrl) return [plan.item];
    if (plan.uploadUrl && (plan.objectKey || plan.key || plan.relPath)) {
      return [{
        uploadUrl: plan.uploadUrl,
        relPath: plan.relPath ?? source?.[0]?.fullPath ?? source?.[0]?.file?.name ?? "file",
        objectKey: plan.objectKey,
        key: plan.key,
        contentType: plan.contentType,
        sse: plan.sse,
        sha256: plan.sha256,
        hash: plan.hash,
      }];
    }
    if (Array.isArray(plan.urls)) {
      return plan.urls.map((u: string, i: number) => ({
        uploadUrl: u,
        relPath:
          plan.relPaths?.[i] ??
          source?.[i]?.fullPath ??
          source?.[i]?.file?.name ??
          `file-${i}`,
        objectKey: plan.keys?.[i],
        key: plan.keys?.[i],
        contentType: plan.contentTypes?.[i],
        sse: plan.sse,
      }));
    }
    if (Array.isArray(plan.entries)) {
      return plan.entries
        .filter((e: any) => e?.uploadUrl)
        .map((e: any) => ({
          uploadUrl: e.uploadUrl,
          relPath: e.relPath ?? e.name ?? "file",
          objectKey: e.objectKey,
          key: e.key,
          contentType: e.contentType,
          sse: e.sse,
          sha256: e.sha256,
          hash: e.hash,
        }));
    }
    return [];
  }

  async function finalizeAndMint(s3Key: string, manifestKey?: string) {
    await ensureSepolia();
    const to = await getToAddress();

    const res = await fetch(api("/hash-and-mint"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        s3Key,                // first content key (archive seed)
        to,
        vaultName,
        product,
        escrowYears,
        visibility,
        archiveHash,
        manifestText, // keep it simple: send text again
        endowment: lockedEndowment ? { usd: lockedEndowment.usd, eth: lockedEndowment.eth, usdPerEth: lockedEndowment.usdPerEth } : null,
        manifestKeyClient: manifestKey || null, // let server know which key we used for manifest.json
        sessionId,
      }),
    });
    if (!res.ok) throw new Error(`hash-and-mint failed: ${res.status} ${await res.text()}`);
    return res.json(); // { ok, txHash, tokenId, tokenURI, contract?, contractAddress?, manifestKey?, manifestRef? ... }
  }

  async function forcePatchManifest(manifestKey?: string | null, manifestRef?: string | null) {
    // Final safety: ask the server to rewrite manifest.json with our extra.manifestText
    if (!manifestKey && !manifestRef) return;
    try {
      const res = await fetch(api("/manifest/force-extra"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          manifestKey: manifestKey || null,
          manifestRef: manifestRef || null,
          extra: { manifestText }
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn("force-extra failed:", res.status, t);
      }
    } catch (e) {
      console.warn("force-extra error:", e);
    }
  }


  // Build the manifest JSON file contents (includes manifestText in extra)
  function buildManifestJsonFile(source: DemoFile[]): File {
    const manifestObj = {
      name: vaultName || "",
      product: product || "",
      escrowYears: product === "Permanence+" ? escrowYears : undefined,
      visibility: visibility || "",
      archiveHash: archiveHash || "",
      endowment: lockedEndowment
        ? {
            usd: Number(lockedEndowment.usd.toFixed(2)),
            eth: Number(lockedEndowment.eth.toFixed(6)),
            usdPerEth: Number(lockedEndowment.usdPerEth.toFixed(2)),
          }
        : null,
      files: source.map((f) => ({ path: f.fullPath, size: f.file.size })),
      extra: {
        manifestText: manifestText ?? "", // <-- simple & explicit
      },
      createdAt: new Date().toISOString(),
      sessionId,
    };
    const json = JSON.stringify(manifestObj, null, 2) + "\n";
    return new File([json], "manifest.json", { type: "application/json" });
  }

  async function uploadToS3(_selected: DemoFile[] = files): Promise<MintResult> {
  const sel = Array.isArray(_selected) && _selected.length ? _selected : files;
  if (!sel?.length) throw new Error("No files selected.");

  // 1) Ask server for presigned URLs
  const filesPayload = sel.map((f: any) => ({
    name: f.file?.name || f.name,
    relPath: f.fullPath || f.relPath || f.file?.name || f.name,
    contentType: f.file?.type || f.type || "application/octet-stream",
    sha256: f.sha256 || null,
  }));

  const startRes = await fetch(api("/upload/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, files: filesPayload }),
  });
  if (!startRes.ok) throw new Error(`upload/start failed: ${startRes.status} ${await startRes.text()}`);
  const startJson = await startRes.json();
  if (!startJson?.ok || !Array.isArray(startJson.items) || startJson.items.length === 0) {
    throw new Error(`upload/start returned no items`);
  }
  const uploadBucket: string | undefined = startJson.bucket;
  const items: Array<{ objectKey: string; uploadUrl: string; contentType?: string; sse?: string; }> = startJson.items;

  // 2) PUT each file with matching headers
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const match: any = sel[i];
    const fileBlob: Blob = match.file || match;

    const putRes = await fetch(item.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": item.contentType || "application/octet-stream",
        ...(item.sse ? { "x-amz-server-side-encryption": item.sse } : {}),
      } as any,
      body: fileBlob,
    });
    console.log(`${i+1} PUT`, item.objectKey, putRes.status);
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`S3 PUT failed (${putRes.status}) for ${item.objectKey}: ${text}`);
    }
  }

  // 3) Verify the primary object via manifestRef (avoids bucket/env drift)
  const primary = items[0];
  const manifestRef = uploadBucket ? `s3://${uploadBucket}/${primary.objectKey}` : undefined;
  const vRes = await fetch(api("/verify-upload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifestRef ? { manifestRef } : { key: primary.objectKey, bucket: uploadBucket }),
  });
  const vJson = await vRes.json().catch(() => ({}));
  if (!(vJson?.ok && vJson?.exists)) {
    throw new Error(`Upload verify failed: ${primary.objectKey} not found`);
  }

  // 4) Mint (server will also write manifest.json with manifestText)
  const minted = await finalizeAndMint(primary.objectKey);

  // 5) Best-effort: patch manifest.extra.manifestText to match UI
  try { await forcePatchManifest(minted?.manifestKey ?? null, minted?.manifestRef ?? null); } catch {}

  // 6) Stash S3 paths for the Vault view
  setVaultStorage({
    archiveKey: primary.objectKey,
    manifestKey: minted?.manifestKey ?? undefined,
    manifestRef: minted?.manifestRef ?? undefined,
  });

  return minted;
}

  

  // -------- Token modal preview helpers (auto-open + â€œView Tokenâ€ button) --------
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tokenData, setTokenData] = useState<
    | null
    | {
        contract: string;
        tokenId: string;
        owner: string;
        name: string;
        imageDataUrl: string;
        tokenUriJson: string;
      }
  >(null);

  function buildLocalTokenPreview(): { imageDataUrl: string; tokenUriJson: string; name: string } {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'>
      <rect width='100%' height='100%' fill='black'/>
      <g font-family='monospace' fill='white'>
        <text x='24' y='64' font-size='32'>FAWV Vault Token</text>
        <text x='24' y='120' font-size='20'>${product ?? "Vault"}</text>
        <text x='24' y='160' font-size='16'>${vaultName || "Unnamed Vault"}</text>
        <text x='24' y='200' font-size='16'>Size: ${formatBytes(totalBytes)}</text>
        <text x='24' y='240' font-size='16'>Files: ${files.length}</text>
      </g>
    </svg>`;
    const imageDataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;

    const meta = {
      name: `${vaultName || "Vault"} â€” FAWV Vault`,
      description: "FAWV Vault token (preview).",
      image: imageDataUrl,
      attributes: [
        { trait_type: "Product", value: product || "" },
        { trait_type: "Escrow Years", value: product === "Permanence+" ? escrowYears : undefined },
        { trait_type: "Total Files", value: files.length },
        { trait_type: "Total Size", value: formatBytes(totalBytes) },
        { trait_type: "Visibility", value: visibility || "" },
        { trait_type: "Archive Hash (SHA-256)", value: archiveHash || "(none)" },
        lockedEndowment ? { trait_type: "Endowment (USD)", value: Number(lockedEndowment.usd.toFixed(2)) } : undefined,
        lockedEndowment ? { trait_type: "Endowment (ETH at time)", value: Number(lockedEndowment.eth.toFixed(6)) } : undefined,
        lockedEndowment ? { trait_type: "Endowment Rate (USD/ETH)", value: Number(lockedEndowment.usdPerEth.toFixed(2)) } : undefined,
      ].filter(Boolean) as any[],
    };
    const tokenUriJson = JSON.stringify(meta, null, 2);
    return { imageDataUrl, tokenUriJson, name: meta.name };
  }

  async function openTokenPreviewFromMint(result: MintResult) {
    const owner = await getToAddress();
    const contractAddr =
      result?.contract ||
      result?.contractAddress ||
      "(unknown)";
    const tokenId =
      result?.tokenId ||
      "";

    let name = `${vaultName || "Vault"} â€” FAWV Vault`;
    let imageDataUrl = "";
    let tokenUriJson = "";

    if (result?.tokenURI) {
      try {
        const r = await fetch(result.tokenURI, { mode: "cors" });
        if (r.ok) {
          const j = await r.json();
          name = j?.name || name;
          tokenUriJson = JSON.stringify(j, null, 2);
          if (typeof j?.image === "string" && j.image.startsWith("data:image")) {
            imageDataUrl = j.image;
          } else if (typeof j?.image_data === "string") {
            imageDataUrl = `data:image/svg+xml;base64,${btoa(j.image_data)}`;
          }
        }
      } catch {
        // fall back
      }
    }

    if (!imageDataUrl || !tokenUriJson) {
      const fallback = buildLocalTokenPreview();
      imageDataUrl = imageDataUrl || fallback.imageDataUrl;
      tokenUriJson = tokenUriJson || fallback.tokenUriJson;
      name = fallback.name;
    }

    setTokenData({
      contract: contractAddr,
      tokenId: tokenId || "(unavailable)",
      owner,
      name,
      imageDataUrl,
      tokenUriJson,
    });
    setShowTokenModal(true);
  }

  const handleSubmitMint = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      if (!visibility) throw new Error("Please choose a Visibility (Public or Private) before submitting.");
      if (!manifestText.trim()) throw new Error("Please enter some Manifest text before submitting.");

      setFlowStatus("uploading");
      setStep("minting");

      const result = await uploadToS3(files);
      setMintResult(result);

      // Auto-open token modal with preview
      await openTokenPreviewFromMint(result);

      setFlowStatus("idle");
      setStep("vault");
    } catch (err) {
      console.error("Submit & Mint failed:", err);
      setFlowStatus("error");
      alert((err as Error).message);
      setStep("manifest");
    } finally {
      inFlightRef.current = false;
    }
  };

  // Helpers to show S3 path & folder nicely
  const pickManifestKey = () =>
    mintResult?.manifestKey ||
    vaultStorage?.manifestKey ||
    "";

  const pickManifestRef = () =>
    mintResult?.manifestRef ||
    vaultStorage?.manifestRef ||
    "";

  const pickArchiveKey = () =>
    vaultStorage?.archiveKey || "";

  const dirname = (key: string) => {
    if (!key) return "";
    const parts = key.split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  };

  const vaultFolderPath =
    dirname(pickManifestKey()) ||
    (pickManifestRef().startsWith("s3://") ? dirname(pickManifestRef().replace(/^s3:\/\/[^/]+\//, "")) : "") ||
    dirname(pickArchiveKey());

  // ---------------------- Render ----------------------
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-950 via-teal-950 to-emerald-950 text-zinc-100">
      <header className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-black/40 bg-black/60 border-b border-white/10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9" />
            <div className="leading-tight">
              <div className="font-semibold text-xl tracking-tight">For All We Value</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-zinc-300">
            <button onClick={() => setMode("landing")} className={`px-3 py-1 rounded-lg border ${mode === "landing" ? "border-cyan-400 text-cyan-300" : "border-white/10"}`}>Home</button>
            <button onClick={() => { setMode("demo"); setStarted(true); }} className={`px-3 py-1 rounded-lg border ${mode === "demo" ? "border-cyan-400 text-cyan-300" : "border-white/10"}`}>Build a Vault</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {mode === "landing" ? (
          <Landing onCTAClick={() => { setMode("demo"); setStarted(true); }} />
        ) : (
          <section className="grid gap-6">
            {!started ? (
              <section className="grid gap-6 md:grid-cols-2 items-center">
                <div className="p-6 rounded-2xl border border-white/10 bg-white/5 shadow-xl">
                  <h1 className="text-3xl font-bold mb-3">Welcome back.</h1>
                  <p className="text-zinc-300 mb-4">
                    This demo walks through selecting a product, uploading a folder of files,
                    pricing, writing a Vault Manifest, and minting on Sepolia via the API.
                  </p>
                  <button
                    onClick={() => setStarted(true)}
                    className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold transition"
                  >
                    Start Vault Build
                  </button>
                </div>
                <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                  <ul className="space-y-2 text-sm text-zinc-300">
                    <li>â€¢ Drag an entire <span className="font-semibold">folder</span> into the uploader.</li>
                    <li>â€¢ Name your Vault â€” this becomes the archive and token name.</li>
                    <li>â€¢ Review demo pricing and accept before continuing.</li>
                    <li>â€¢ Write your <span className="font-semibold">Vault Manifest</span> and choose Public or Private.</li>
                    <li>â€¢ Submit & Mint â€” uploads to S3, writes manifest.json (with your manifest text), mints on Sepolia.</li>
                  </ul>
                </div>
              </section>
            ) : (
              <>
                <ol className="flex flex-wrap gap-2 text-xs text-zinc-400 mb-2">
                  {["Select", "Upload", "Pricing", "Manifest", "Mint", "Vault"].map((label, i) => {
                    const active =
                      (step === "selectProduct" && i === 0) ||
                      (step === "upload" && i === 1) ||
                      (step === "pricing" && i === 2) ||
                      (step === "manifest" && i === 3) ||
                      (step === "minting" && i === 4) ||
                      (step === "vault" && i === 5);
                    return (
                      <li key={label} className={`px-3 py-1 rounded-full border ${active ? "border-cyan-400 text-cyan-300" : "border-white/10"}`}>
                        {label}
                      </li>
                    );
                  })}
                </ol>

                {/* Product selection */}
                {step === "selectProduct" && (
                  <div className="grid md:grid-cols-3 gap-4">
                    <ProductCard
                      title="Permanence"
                      description="Always-on storage with required annual EAS (attestation)."
                      footNote={`Requires annual EAS $${PRICING.permanence.annualEAS.toFixed(2)}/yr.`}
                      active={product === "Permanence"}
                      onPick={() => {
                        setProduct("Permanence");
                        setStep("upload");
                      }}
                    />
                    <ProductCard
                      title="Permanence+"
                      description="Adds a 3/5/10-year escrow grace period before market release if EAS lapses."
                      active={product === "Permanence+"}
                      onPick={() => {
                        setProduct("Permanence+");
                        setStep("upload");
                      }}
                    >
                      {product === "Permanence+" && (
                        <div className="mt-3">
                          <label className="block text-xs text-zinc-400 mb-1">Choose escrow duration</label>
                          <div className="flex gap-2">
                            {[3, 5, 10].map((y) => (
                              <button
                                key={y}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEscrowYears(y as EscrowYears);
                                }}
                                className={`px-3 py-1 rounded-lg border ${escrowYears === y ? "border-cyan-400 text-cyan-300" : "border-white/10"}`}
                              >
                                {y} yr
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </ProductCard>
                    <ProductCard
                      title="Heirloom"
                      description="100-year guarantee; no annual EAS required. Ideal for legacy archives."
                      active={product === "Heirloom"}
                      onPick={() => {
                        setProduct("Heirloom");
                        setStep("upload");
                      }}
                    />
                  </div>
                )}

                {/* Upload */}
                {step === "upload" && (
                  <div className="grid md:grid-cols-2 gap-6 items-start">
                    <div>
                      <h2 className="text-xl font-semibold mb-2">Upload your files (folder-aware)</h2>
                      <p className="text-sm text-zinc-400 mb-3">
                        Drag a <span className="font-semibold">folder</span> here or click to pick. Weâ€™ll preserve your directory structure where provided.
                      </p>

                      <div
                        onDragOver={onDragOver}
                        onDragLeave={onDragLeave}
                        onDrop={onDrop}
                        onClick={() => inputRef.current?.click()}
                        className={`border-2 border-dashed rounded-2xl p-8 cursor-pointer transition ${dragActive ? "border-cyan-400 bg-white/5" : "border-white/10 bg-white/5"}`}
                      >
                        <div className="text-center">
                          <div className="text-2xl">ðŸ“</div>
                          <div className="mt-2 font-medium">Drop folder or files</div>
                          <div className="text-xs text-zinc-400 mt-1">Or click to browse â€” folder selection supported</div>
                        </div>
                        <input
                          ref={inputRef}
                          type="file"
                          multiple
                          // @ts-expect-error non-standard but widely supported in Chromium/WebKit
                          webkitdirectory="true"
                          // @ts-expect-error non-standard
                          directory="true"
                          className="hidden"
                          onChange={onFilePick}
                        />
                      </div>

                      {!!files.length && (
                        <div className="mt-4 text-sm text-zinc-300">
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="font-semibold">{files.length}</span> items selected
                            </div>
                            <div className="text-zinc-400">Total size: {formatBytes(totalBytes)}</div>
                          </div>
                          <div className="mt-2 max-h-56 overflow-auto rounded-2xl border border-white/10">
                            <table className="w-full text-xs">
                              <thead className="bg-white/5 sticky top-0">
                                <tr>
                                  <th className="text-left px-3 py-2">Path</th>
                                  <th className="text-right px-3 py-2">Size</th>
                                </tr>
                              </thead>
                              <tbody>
                                {files.slice(0, 200).map((f, idx) => (
                                  <tr key={idx} className="odd:bg-white/0 even:bg-white/5">
                                    <td className="px-3 py-1 truncate max-w-[28rem]" title={f.fullPath}>
                                      {f.fullPath}
                                    </td>
                                    <td className="px-3 py-1 text-right">{formatBytes(f.file.size)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {files.length > 200 && (
                            <div className="text-xs text-zinc-500 mt-1">(showing first 200)</div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                      <h3 className="font-semibold">Name your Vault</h3>
                      <input
                        type="text"
                        value={vaultName}
                        onChange={(e) => setVaultName(e.target.value)}
                        placeholder="e.g., Robinson Family Archive, v1"
                        className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 focus:outline-none focus:border-cyan-400"
                      />
                      <p className="mt-2 text-xs text-zinc-400">This name becomes your archive filename and tokenized Vault name.</p>

                      <div className="mt-6 flex items-center gap-2">
                        <button
                          disabled={!files.length || !vaultName.trim()}
                          onClick={() => setStep("pricing")}
                          className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold disabled:opacity-50"
                        >
                          Continue to Pricing
                        </button>
                        <button onClick={resetFlow} className="text-xs text-zinc-400 hover:text-zinc-200">Reset</button>
                      </div>

                      {product === "Permanence" && (
                        <p className="mt-6 text-sm text-zinc-300">
                          <span className="font-semibold">Permanence:</span> storage with annual <span className="font-semibold">EAS/Attestation</span> required.
                        </p>
                      )}
                      {product === "Permanence+" && (
                        <p className="mt-6 text-sm text-zinc-300">
                          <span className="font-semibold">Permanence+ Escrow:</span> choose a {escrowYears}-year window that delays market release if EAS lapses.
                        </p>
                      )}
                      {product === "Heirloom" && (
                        <p className="mt-6 text-sm text-zinc-300">
                          <span className="font-semibold">Heirloom (100-year guarantee):</span> designed for legacy assets; no annual EAS required.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Pricing */}
                {step === "pricing" && product && price && (
                  <div className="grid md:grid-cols-2 gap-6 items-start">
                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                      <h2 className="text-xl font-semibold mb-4">Pricing Summary (Demo)</h2>
                      <table className="w-full text-sm">
                        <tbody>
                          <tr>
                            <td className="py-2 text-zinc-400">Product</td>
                            <td className="py-2 text-right">{product}{product === "Permanence+" ? ` (${escrowYears}yr)` : ""}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Size (billed GB)</td>
                            <td className="py-2 text-right">{price.gb} GB</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Tokenization (per GB)</td>
                            <td className="py-2 text-right">${PRICING.tokenizationPerGB.toFixed(2)} Ã— {price.gb} = ${price.tokenization.toFixed(2)}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Storage</td>
                            <td className="py-2 text-right">${price.storage.toFixed(2)}</td>
                          </tr>
                          <tr className="border-t border-white/10">
                            <td className="py-2 font-semibold">Subtotal (demo)</td>
                            <td className="py-2 text-right font-semibold">${price.subtotal.toFixed(2)}</td>
                          </tr>
                        </tbody>
                      </table>

                      {/* Endowment card (not included in subtotal) */}
                      {(() => {
                        const n = parseFloat(endowmentUsd as any);
                        if (!isNaN(n) && n >= 0 && demoEthPrice > 0) {
                          const eth = n / demoEthPrice;
                          return (
                            <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-sm">
                              <div className="flex items-center justify-between">
                                <div className="text-zinc-300">Endowment (not included in subtotal)</div>
                                <div className="font-medium">${n.toFixed(2)} Â· {eth.toFixed(6)} ETH</div>
                              </div>
                              <div className="text-xs text-zinc-400 mt-1">Rate: ${demoEthPrice.toFixed(2)} / ETH Â· Finalized on Continue</div>
                            </div>
                          );
                        }
                        return null;
                      })()}

                      <p className="mt-2 text-xs text-zinc-400">{price.notes}</p>

                      <div className="mt-4 flex items-center gap-2">
                        <input id="accept" type="checkbox" checked={acceptedPrice} onChange={(e) => setAcceptedPrice(e.target.checked)} className="h-4 w-4" />
                        <label htmlFor="accept" className="text-sm">I accept the demo pricing. Charge my account on submit.</label>
                      </div>

                      <div className="mt-6">
                        <label className="block text-sm font-medium">Endowment (optional, USD)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={endowmentUsd}
                          onChange={(e) => { setEndowmentUsd(e.target.value); setEndowmentError(null); }}
                          placeholder="e.g., 250.00"
                          className="mt-2 w-full px-3 py-2 rounded-2xl bg-black/40 border border-white/10 focus:outline-none focus:border-cyan-400"
                        />
                        <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
                          <span>Demo ETH price (USD/ETH) captured at endowment:</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={demoEthPrice}
                            onChange={(e) => setDemoEthPrice(parseFloat(e.target.value) || 0)}
                            className="px-2 py-1 rounded-lg bg-black/30 border border-white/10 w-28 focus:outline-none focus:border-cyan-400"
                          />
                        </div>
                        {endowmentError && <div className="mt-2 text-xs text-red-400">{endowmentError}</div>}
                      </div>

                      <div className="mt-6 flex gap-2">
                        <button
                          disabled={!acceptedPrice || !vaultName.trim()}
                          onClick={proceedAfterPricing}
                          className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold disabled:opacity-50"
                        >
                          Continue to Manifest
                        </button>
                        <button onClick={() => setStep("upload")} className="px-3 py-2 rounded-2xl border border-white/10">Back</button>
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                      <h3 className="font-semibold mb-2">What is the Vault Manifest?</h3>
                      <p className="text-sm text-zinc-300">
                        A living record of whatâ€™s in your Vault. It could be a simple file listing and descriptions, an excerpt of a patent filing, or a plain-language narrative of why this Vault matters. If made <span className="font-semibold">Public</span>, it is discoverable by researchers and investors on FAWV search. If kept <span className="font-semibold">Private</span>, it stays hidden while EAS/Attestations remain timely â€” but becomes public if the Vault is ever orphaned/unclaimed.
                      </p>
                    </div>
                  </div>
                )}

                {/* Manifest Entry */}
                {step === "manifest" && (
                  <div className="grid md:grid-cols-2 gap-6 items-start">
                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                      <h2 className="text-xl font-semibold mb-2">Write your Vault Manifest</h2>
                      <p className="text-sm text-zinc-400 mb-3">Use this space to describe contents and significance. Markdown supported in demo preview.</p>
                      <textarea
                        value={manifestText}
                        onChange={(e) => setManifestText(e.target.value)}
                        rows={14}
                        placeholder={`Example

- 2001â€“2012 family photos (JPEG/RAW)
- Patent: Photonic Memory Cell â€” excerpt of claims 1â€“5
- Curated journal entries with context and captions
`}
                        className="w-full px-3 py-2 rounded-2xl bg-black/40 border border-white/10 focus:outline-none focus:border-cyan-400"
                      />

                      <div className="mt-4 text-sm">
                        <div className="mb-2 font-medium">Visibility (required):</div>
                        <div className="flex items-center gap-6">
                          <label className="inline-flex items-center gap-2">
                            <input type="radio" name="vis" checked={visibility === "PUBLIC"} onChange={() => setVisibility("PUBLIC")} />
                            Public (searchable)
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input type="radio" name="vis" checked={visibility === "PRIVATE"} onChange={() => setVisibility("PRIVATE")} />
                            Private (until orphaned)
                          </label>
                        </div>
                      </div>

                      <div className="mt-6 flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            disabled={flowStatus === "uploading" || files.length === 0 || !visibility || !manifestText.trim()}
                            onClick={handleSubmitMint}
                            className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold disabled:opacity-50"
                          >
                            Submit & Mint
                          </button>
                          <MintStatus
                            step={step === "vault" ? "done" : flowStatus === "uploading" ? "uploading" : flowStatus}
                            mintResult={mintResult}
                          />
                        </div>
                        {uploading && (
                          <div className="text-xs text-zinc-400">Uploadingâ€¦ {uploadPct}%</div>
                        )}
                        <button onClick={() => setStep("pricing")} className="self-start px-3 py-2 rounded-2xl border border-white/10">Back</button>
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                      <h3 className="font-semibold mb-2">Preview</h3>
                      <div className="text-xs text-zinc-400 mb-2">Vault: {vaultName || "(unnamed)"} Â· Visibility: {visibility || "â€”"}</div>
                      <div className="rounded-2xl border border-white/10 bg-black/30 p-4 whitespace-pre-wrap break-words text-sm min-h-[8rem] max-w-full">{manifestText || "(Your manifest will render here.)"}</div>
                    </div>
                  </div>
                )}

                {/* Minting Spinner */}
                {step === "minting" && (
                  <div className="p-10 rounded-2xl border border-white/10 bg-white/5 text-center">
                    <div className="mx-auto h-14 w-14 rounded-full border-4 border-white/20 border-t-cyan-400 animate-spin" />
                    <div className="mt-4 text-xl font-semibold">Tokenizing & Minting your FAWV Vaultâ€¦</div>
                    <div className="mt-1 text-sm text-zinc-400">Files are uploaded, <span className="font-semibold">manifest.json</span> (with your text) is written to S3, token minted on Sepolia.</div>
                  </div>
                )}

                {/* Vault Screen */}
                {step === "vault" && (
                  <div className="grid md:grid-cols-2 gap-6 items-start">
                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5 min-w-0">
                      <h2 className="text-xl font-semibold mb-2">Your Vault</h2>
                      <table className="w-full text-sm">
                        <tbody>
                          <tr>
                            <td className="py-2 text-zinc-400">Vault Name</td>
                            <td className="py-2 text-right">{vaultName}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Product</td>
                            <td className="py-2 text-right">
                              {product}
                              {product === "Permanence+" ? ` (${escrowYears}yr)` : ""}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Files</td>
                            <td className="py-2 text-right">{files.length}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Total Size</td>
                            <td className="py-2 text-right">{formatBytes(totalBytes)}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Archive Hash</td>
                            <td className="py-2 text-right font-mono text-xs break-all">{archiveHash || "â€”"}</td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Visibility</td>
                            <td className="py-2 text-right">{visibility}</td>
                          </tr>

                          {/* Vault Path (folder) + Manifest path */}
                          <tr>
                            <td className="py-2 text-zinc-400 align-top">Vault Path (S3 folder)</td>
                            <td className="py-2 text-right font-mono text-xs break-all">
                              {vaultFolderPath || "â€”"}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400 align-top">Manifest Key/Ref</td>
                            <td className="py-2 text-right font-mono text-xs break-all">
                              {pickManifestRef() || pickManifestKey() || "â€”"}
                            </td>
                          </tr>

                          <tr>
                            <td className="py-2 text-zinc-400">Endowment</td>
                            <td className="py-2 text-right">
                              {lockedEndowment
                                ? `$${lockedEndowment.usd.toFixed(2)} Â· ${lockedEndowment.eth.toFixed(6)} ETH`
                                : "None"}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Endowment Rate</td>
                            <td className="py-2 text-right">
                              {lockedEndowment ? `$${lockedEndowment.usdPerEth.toFixed(2)} / ETH` : "â€”"}
                            </td>
                          </tr>
                          <tr>
                            <td className="py-2 text-zinc-400">Mint Result</td>
                            <td className="py-2 text-right">
                              {mintResult?.txHash ? "Success" : "No chain mint"}
                            </td>
                          </tr>
                        </tbody>
                      </table>

                      <div className="mt-4 flex gap-2 justify-end">
                        {(vaultFolderPath || pickManifestRef() || pickManifestKey()) && (
                          <button
                            onClick={() => copy(vaultFolderPath || pickManifestRef() || pickManifestKey())}
                            className="px-3 py-2 rounded-2xl border border-white/10 hover:border-cyan-400 text-sm"
                          >
                            Copy Vault Path
                          </button>
                        )}
                      </div>

                      <div className="mt-6 flex gap-2">
                        <button
                          onClick={() => openTokenPreviewFromMint(mintResult)}
                          className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
                        >
                          View Token
                        </button>
                        <button onClick={resetFlow} className="px-3 py-2 rounded-2xl border border-white/10">Build Another Vault</button>
                      </div>

                      {mintResult?.txHash && (
                        <div className="mt-4 text-sm text-zinc-300 space-y-1">
                          <div>txHash: <span className="font-mono break-all">{mintResult.txHash}</span></div>
                          {mintResult.tokenId && <div>tokenId: <span className="font-mono break-all">{mintResult.tokenId}</span></div>}
                          {mintResult.tokenURI && <div>tokenURI: <span className="font-mono break-all">{mintResult.tokenURI}</span></div>}
                        </div>
                      )}
                    </div>

                    {/* Right Column: Manifest + Archive Contents */}
                    <div className="space-y-6">
                      <div className="p-6 rounded-2xl border border-white/10 bg-white/5 min-w-0">
                        <h3 className="font-semibold mb-2">Vault Manifest</h3>
                        <div className="text-xs text-zinc-400 mb-2">Visibility: {visibility}</div>
                        <div className="rounded-2xl border border-white/10 bg-black/30 p-4 whitespace-pre-wrap break-words text-sm min-h-[8rem] max-w-full">
                          {manifestText || "(No manifest provided)"
                          }
                        </div>
                      </div>

                      <div className="p-6 rounded-2xl border border-white/10 bg-white/5 min-w-0">
                        <h3 className="font-semibold mb-2">Archive Contents (first 200)</h3>
                        <div className="text-xs text-zinc-400 mb-2">Preserving folder paths where available</div>
                        <div className="rounded-2xl border border-white/10 max-h-80 overflow-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-white/5 sticky top-0">
                              <tr>
                                <th className="text-left px-3 py-2">Path</th>
                                <th className="text-right px-3 py-2">Size</th>
                              </tr>
                            </thead>
                            <tbody>
                              {files.slice(0, 200).map((f, idx) => (
                                <tr key={idx} className="odd:bg-white/0 even:bg-white/5">
                                  <td className="px-3 py-1 truncate max-w-[28rem]" title={f.fullPath}>{f.fullPath}</td>
                                  <td className="px-3 py-1 text-right">{formatBytes(f.file.size)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {files.length > 200 && <div className="p-2 text-xs text-zinc-500">(showing first 200)</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-4 py-10 text-xs text-zinc-500">
        Demo pricing and flows are illustrative. Sepolia mint is invoked by the API when configured.
      </footer>

      {/* Token Modal */}
      {showTokenModal && tokenData && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-950 overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="font-semibold">FAWV Vault Token</div>
              <button onClick={() => setShowTokenModal(false)} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">âœ•</button>
            </div>
            <div className="p-4 grid md:grid-cols-2 gap-4 items-start max-h-[70vh] overflow-auto">
              <img src={tokenData.imageDataUrl} alt="token" className="rounded-2xl w-full border border-white/10" />
              <div className="text-sm min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate max-w-[18rem]">{tokenData.name}</div>
                  <button
                    onClick={() => tokenData.tokenId && copy(tokenData.tokenId)}
                    disabled={!tokenData.tokenId || tokenData.tokenId === "(unavailable)"}
                    className={`text-xs px-2 py-1 rounded-lg border ${tokenData.tokenId && tokenData.tokenId !== "(unavailable)" ? "border-white/10 hover:border-cyan-400" : "border-white/10 opacity-50 cursor-not-allowed"}`}
                    title={tokenData.tokenId && tokenData.tokenId !== "(unavailable)" ? "Copy Token ID" : "Token ID not available yet"}
                  >
                    Copy Token ID
                  </button>
                </div>

                <table className="w-full text-xs mt-2">
                  <tbody>
                    <tr>
                      <td className="py-1 text-zinc-400">Contract</td>
                      <td className="py-1 text-right font-mono break-all max-w-[26ch]">{tokenData.contract}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Token ID</td>
                      <td className="py-1 text-right font-mono break-all max-w-[26ch]">{tokenData.tokenId}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Owner</td>
                      <td className="py-1 text-right font-mono break-all max-w-[26ch]">{tokenData.owner}</td>
                    </tr>
                  </tbody>
                </table>

                <div className="mt-4">
                  <div className="text-xs text-zinc-400 mb-1">tokenURI JSON</div>
                  <pre className="rounded-2xl border border-white/10 bg-black/30 p-3 text-xs whitespace-pre-wrap max-h-48 overflow-auto">{tokenData.tokenUriJson}</pre>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-white/10 flex items-center justify-end gap-2">
              <button
                onClick={() => copy(`${tokenData.contract}:${tokenData.tokenId}`)}
                className="px-3 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
              >
                Copy &ldquo;contract:tokenId&rdquo;
              </button>
              <button onClick={() => setShowTokenModal(false)} className="px-3 py-2 rounded-2xl border border-white/10">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------- Landing & ProductCard ----------------------
function Landing({ onCTAClick }: { onCTAClick: () => void }) {
  return (
    <section className="space-y-12">
      <div className="grid md:grid-cols-2 gap-8 items-center">
        <div className="p-2">
          <h1 className="text-4xl md:text-5xl font-bold leading-tight">For All We Value</h1>
          <p className="mt-4 text-zinc-300 text-lg">
            FAWV is a digital trust platform for preserving and passing forward your most valuable data â€”
            with programmable permanence, escrow grace, and 100-year heirloom options.
          </p>
          <div className="mt-6 flex gap-3">
            <button onClick={onCTAClick} className="px-5 py-3 rounded-2xl bg-cyan-500 text-black font-semibold hover:bg-cyan-400">Build a Vault</button>
            <a href="#how-it-works" className="px-5 py-3 rounded-2xl border border-white/10 hover:border-cyan-400">How it works</a>
          </div>
        </div>
        <div className="p-6 rounded-3xl border border-white/10 bg-white/5">
          <ul className="space-y-3 text-sm text-zinc-300">
            <li>â€¢ Permanence â€” annual EAS keeps Vaults in good standing</li>
            <li>â€¢ Permanence+ â€” 3/5/10-year escrow grace to avoid immediate market release</li>
            <li>â€¢ Heirloom â€” 100-year guarantee, no annual EAS required</li>
            <li>â€¢ Public/Private Manifest â€” searchable discovery or private until orphaned</li>
            <li>â€¢ Folder-aware uploads â€” preserve directory structure</li>
          </ul>
        </div>
      </div>

      <div id="how-it-works" className="grid md:grid-cols-3 gap-4">
        {["Choose product", "Upload folder", "Name & Price", "Write manifest", "Submit & Mint", "View Vault"].map((t, i) => (
          <div key={t} className="p-5 rounded-2xl border border-white/10 bg-white/5">
            <div className="text-2xl">{i + 1}.</div>
            <div className="mt-2 font-semibold">{t}</div>
            <div className="text-sm text-zinc-400 mt-1">Guided flow â€” uploads â†’ manifest â†’ Sepolia mint via API.</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProductCard({
  title,
  description,
  footNote,
  active,
  onPick,
  children,
}: {
  title: string;
  description: string;
  footNote?: string;
  active?: boolean;
  onPick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`text-left p-5 rounded-2xl border bg-white/5 hover:bg-white/10 transition relative ${
        active ? "border-cyan-400 ring-2 ring-cyan-400/30" : "border-white/10"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{title}</div>
          <p className="text-sm text-zinc-300 mt-1">{description}</p>
        </div>
        <div className="shrink-0 h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-400 to-emerald-500" />
      </div>
      {footNote && <div className="text-xs text-zinc-400 mt-2">{footNote}</div>}
      {children}
    </button>
  );
}