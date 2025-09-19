import React, { useMemo, useRef, useState } from "react";
import Logo from "./components/brand/Logo";
// ---- API base (dev uses Vite proxy if empty) ----
const API_BASE = import.meta.env.VITE_API_BASE || "";

// FAWV Landing + Demo (merged, regenerated)
// Single-file App.tsx to drop into Vite + React + Tailwind.
// • Blue→Teal→Emerald theme
// • Header uses <Logo/> component and full text “For All We Value”
// • Full Vault Builder demo flow
// • Folder-aware uploads; manifest; USD endowment with ETH conversion
// • Final Vault view shows manifest and endowment (USD + ETH) with locked rate

// ---------------------- Types & Utilities ----------------------

type Product = "Permanence" | "Permanence+" | "Heirloom";

type EscrowYears = 3 | 5 | 10;

type VaultVisibility = "PUBLIC" | "PRIVATE";

// ---- Types returned by /api/upload/start ----
type PresignItem = {
  relPath: string;
  objectKey: string;
  s3Uri: string;
  uploadUrl: string;
  contentType: string;
};
type PresignResponse = { sessionId: string; items: PresignItem[] };



interface DemoFile {
  file: File;
  fullPath: string; // preserves folder structure when available
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 2)} ${sizes[i]}`;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

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
  fileList: DemoFile[]
): Promise<PresignResponse> {
  const payload = {
    sessionId,
    files: fileList.map((f) => ({
      relPath: f.fullPath,
      size: f.file.size,
      contentType: f.file.type || "application/octet-stream",
    })),
  };
  const res = await fetch(`${API_BASE}/api/upload/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`presign failed: ${res.status}`);
  return res.json();
}
// Simple demo hash: concatenates file bytes in sorted path order.
// NOTE: For very large folders this will be slow; fine for demo.
async function hashFilesSHA256(list: DemoFile[]): Promise<string> {
  const sorted = [...list].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  const blobs: BlobPart[] = [];
  for (const item of sorted) {
    // include path to make the hash path-aware
    blobs.push(item.fullPath, "\n");
    blobs.push(await item.file.arrayBuffer());
  }
  const ab = await new Blob(blobs).arrayBuffer();
  return sha256Hex(ab);
}


// ---------------------- Mock Pricing ----------------------
// Demo rates; adjust freely. Per-GB (rounded up) + tokenization fee.
const PRICING = {
  tokenizationPerGB: 0.1, // applies to all products
  permanence: {
    storagePerGB: 0.6,
    annualEAS: 20.0, // shown as required for Permanence
  },
  permanencePlus: {
    storagePerGBBase: 0.5, // base per GB
    perYearAdderPerGB: 0.2, // additional per-GB cost per escrow year (3/5/10)
  },
  heirloom: {
    storagePerGB: 1.2, // 100-year guarantee, no EAS required
  },
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
      gb,
      tokenization,
      storage,
      subtotal: tokenization + storage,
      notes: `Requires annual Evidence of Active Stewardship (EAS) — $${PRICING.permanence.annualEAS.toFixed(
        2
      )}/yr`,
    };
  }
  if (product === "Permanence+") {
    const years = escrowYears ?? 3;
    const perGB =
      PRICING.permanencePlus.storagePerGBBase +
      years * PRICING.permanencePlus.perYearAdderPerGB;
    const storage = gb * perGB;
    return {
      gb,
      tokenization,
      storage,
      subtotal: tokenization + storage,
      notes: `${years}-year escrow window with grace; annual EAS still required.`,
    };
  }
  // Heirloom
  const storage = gb * PRICING.heirloom.storagePerGB;
  return {
    gb,
    tokenization,
    storage,
    subtotal: tokenization + storage,
    notes: `100-year guarantee. No annual EAS required.`,
  };
}

// ---------------------- Folder Drop Helpers ----------------------
// Supports: drag a folder OR select with <input webkitdirectory />
// For drag-drop, we descend directory entries using the DataTransferItem API.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ---------------------- UI ----------------------

export default function App() {
  // top-level mode: landing vs demo flow
  const [mode, setMode] = useState<"landing" | "demo">("landing");

  // flow state
  const [started, setStarted] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [escrowYears, setEscrowYears] = useState<EscrowYears>(3);
  const [files, setFiles] = useState<DemoFile[]>([]);
  const [sessionId] = useState(() => randomHex(8));
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadedItems, setUploadedItems] = useState<PresignItem[] | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [acceptedPrice, setAcceptedPrice] = useState(false);
  const [manifest, setManifest] = useState("");
  const [visibility, setVisibility] = useState<VaultVisibility | null>(null);
  // Endowment in USD (demo)
  const [endowmentUsd, setEndowmentUsd] = useState<string>("");
  const [endowmentError, setEndowmentError] = useState<string | null>(null);
  const [demoEthPrice, setDemoEthPrice] = useState<number>(3200); // USD per ETH (demo)
  const [lockedEndowment, setLockedEndowment] = useState<null | { usd: number; eth: number; usdPerEth: number }>(null);

  // S3 uploader (calls /api/upload/start then PUTs each file)

async function uploadToS3(source: DemoFile[] = files) {
  if (!source.length) return;
  setUploading(true);
  setUploadPct(0);
  try {
    const plan = await getPresignedPlan(sessionId, source);
    let done = 0;

    for (const item of plan.items) {
      const match = source.find((x) => x.fullPath === item.relPath);
      if (!match) continue;

      // IMPORTANT: your presigned URL includes x-amz-server-side-encryption,
      // so we must send the same header (AES256) on the PUT.
      const resp = await fetch(item.uploadUrl, {
        method: "PUT",
        body: match.file,
      });

      // ⬇️ NEW: log S3's error XML so we can see the exact reason if it fails
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error("S3 PUT failed", {
          path: item.relPath,
          status: resp.status,
          statusText: resp.statusText,
          body: text,
        });
        throw new Error(`upload failed: ${item.relPath}`);
      }

      done++;
      setUploadPct(Math.round((done / plan.items.length) * 100));
    }

    setUploadedItems(plan.items);
    console.log("S3 uploaded", {
      sessionId,
      count: plan.items.length,
      first: plan.items[0]?.objectKey,
    });
  } catch (e) {
    console.error("S3 upload error", e);
    alert("Upload failed. Check console.");
    setUploadedItems(null);
  } finally {
    setUploading(false);
  }
}

  // NEW: locked archive hash (computed once after pricing)
const [archiveHash, setArchiveHash] = useState<string>("");

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

  // token data (post-mint)
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

  // drag/drop handlers
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer?.items) {
      const picked = await fromDataTransfer(e.dataTransfer.items);
      if (picked.length) setFiles(picked);
      // NEW: auto upload
      uploadToS3(picked);
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
    setManifest("");
    setVisibility(null);
    setStep("selectProduct");
    setEscrowYears(3);
    setShowTokenModal(false);
    setTokenData(null);
    setEndowmentUsd("");
    setEndowmentError(null);
    setLockedEndowment(null);
    setStarted(true); // stay in demo mode for another build
  };

  const proceedAfterPricing = async () => {
  // require accepted pricing and a vault name
  if (!acceptedPrice || !vaultName.trim()) return;

  // validate optional endowment USD if provided and lock conversion at this moment
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

  // NEW: compute archive hash once pricing is accepted
  const hash = files.length ? await hashFilesSHA256(files) : "";
  setArchiveHash(hash);

  setStep("manifest");
};


  const startMint = async () => {
    if (!visibility || !manifest.trim()) return;
    setStep("minting");

    // simulate archive + mint
    await sleep(1200);

    // create a tiny on-the-fly SVG image to embed into tokenURI (data URL)
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

    const tokenId = `0x${randomHex(32)}`;
    const contract = `0x${randomHex(20)}`; // mock contract address
    const owner = `0x${randomHex(20)}`; // mock owner address

    const tokenMeta = {
  name: `${vaultName} — FAWV Vault`,
  description:
    "Demo ERC-721 style token representing a FAWV Vault (mock, non-transferable in demo).",
  image: imageDataUrl,
  attributes: [
    { trait_type: "Product", value: product },
    { trait_type: "Escrow Years", value: product === "Permanence+" ? escrowYears : undefined },
    { trait_type: "Total Files", value: files.length },
    { trait_type: "Total Size", value: formatBytes(totalBytes) },
    { trait_type: "Visibility", value: visibility },
    { trait_type: "Archive Hash (SHA-256)", value: archiveHash || "(none)" },
    { trait_type: "Endowment (USD)", value: lockedEndowment ? Number(lockedEndowment.usd.toFixed(2)) : undefined },
    { trait_type: "Endowment (ETH at time)", value: lockedEndowment ? Number(lockedEndowment.eth.toFixed(6)) : undefined },
    { trait_type: "Endowment Rate (USD/ETH)", value: lockedEndowment ? Number(lockedEndowment.usdPerEth.toFixed(2)) : undefined },
  ].filter((a) => a.value !== undefined),
};


    const tokenUriJson = JSON.stringify(tokenMeta, null, 2);

    setTokenData({
      contract,
      tokenId,
      owner,
      name: tokenMeta.name,
      imageDataUrl,
      tokenUriJson,
    });

    await sleep(800);
    setStep("vault");
    setShowTokenModal(true);
  };

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
          // DEMO FLOW
          <section className="grid gap-6">
            {/* Stepper or Welcome */}
            {!started ? (
              <section className="grid gap-6 md:grid-cols-2 items-center">
                <div className="p-6 rounded-2xl border border-white/10 bg-white/5 shadow-xl">
                  <h1 className="text-3xl font-bold mb-3">Welcome back.</h1>
                  <p className="text-zinc-300 mb-4">
                    We’ll skip account creation and assume you’re logged in. This demo walks through selecting a
                    product, uploading a folder of files, pricing, writing a Vault Manifest, and a mock token mint.
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
                    <li>• Drag an entire <span className="font-semibold">folder</span> into the uploader.</li>
                    <li>• Name your Vault — this becomes the archive and token name.</li>
                    <li>• Review demo pricing and accept before continuing.</li>
                    <li>• Write your <span className="font-semibold">Vault Manifest</span> and choose Public or Private.</li>
                    <li>• Watch a mock mint and see your ERC‑721‑style token.</li>
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
                      description="Adds a 3/5/10‑year escrow grace period before market release if EAS lapses."
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
                      description="100‑year guarantee; no annual EAS required. Ideal for legacy archives."
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
                      <h2 className="text-xl font-semibold mb-2">Upload your files (folder‑aware)</h2>
                      <p className="text-sm text-zinc-400 mb-3">
                        Drag a <span className="font-semibold">folder</span> here or click to pick. We’ll preserve your directory structure where provided.
                      </p>

                      <div
                        onDragOver={onDragOver}
                        onDragLeave={onDragLeave}
                        onDrop={onDrop}
                        onClick={() => inputRef.current?.click()}
                        className={`border-2 border-dashed rounded-2xl p-8 cursor-pointer transition ${dragActive ? "border-cyan-400 bg-white/5" : "border-white/10 bg-white/5"}`}
                      >
                        <div className="text-center">
                          <div className="text-2xl">📁</div>
                          <div className="mt-2 font-medium">Drop folder or files</div>
                          <div className="text-xs text-zinc-400 mt-1">Or click to browse — folder selection supported</div>
                        </div>
                        <input
                          ref={inputRef}
                          type="file"
                          multiple
                          // @ts-expect-error non‑standard but widely supported in Chromium/WebKit
                          webkitdirectory="true"
                          // @ts-expect-error non‑standard
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
                          <span className="font-semibold">Permanence:</span> storage with annual <span className="font-semibold">EAS/Attestation</span> required to keep the Vault in good standing and out of market circulation.
                        </p>
                      )}
                      {product === "Permanence+" && (
                        <p className="mt-6 text-sm text-zinc-300">
                          <span className="font-semibold">Permanence+ Escrow:</span> choose a {escrowYears}-year window that delays market release if EAS lapses, allowing reinstatement.
                        </p>
                      )}
                      {product === "Heirloom" && (
                        <p className="mt-6 text-sm text-zinc-300">
                          <span className="font-semibold">Heirloom (100‑year guarantee):</span> designed for legacy assets; no annual EAS required.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Pricing & Acceptance */}
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
                            <td className="py-2 text-right">${PRICING.tokenizationPerGB.toFixed(2)} × {price.gb} = ${price.tokenization.toFixed(2)}</td>
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
                                <div className="font-medium">${n.toFixed(2)} · {eth.toFixed(6)} ETH</div>
                              </div>
                              <div className="text-xs text-zinc-400 mt-1">Rate: ${demoEthPrice.toFixed(2)} / ETH · Finalized on Continue</div>
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
                        <p className="mt-2 text-xs text-zinc-400">
                          Endowing your Vault asset is optional. It is FAWV’s mechanism for asserting that the Vault’s provenance rests both in its intrinsic digital value and in the cryptographic currency value you attach to the Vault. The USD amount you enter is captured now and converted to <span className="font-semibold">ETH</span> (ether — the native cryptocurrency of the Ethereum network) using the demo rate above.
                        </p>
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
                        A living record of what’s in your Vault. It could be a simple file listing and descriptions, an excerpt of a patent filing, or a plain‑language narrative of why this Vault matters. If made <span className="font-semibold">Public</span>, it is discoverable by researchers and investors on FAWV search. If kept <span className="font-semibold">Private</span>, it stays hidden while EAS/Attestations remain timely — but becomes public if the Vault is ever orphaned/unclaimed.
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
                        value={manifest}
                        onChange={(e) => setManifest(e.target.value)}
                        rows={14}
                        placeholder={`Example

- 2001–2012 family photos (JPEG/RAW)
- Patent: Photonic Memory Cell — excerpt of claims 1–5
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

                      <div className="mt-6 flex gap-2">
                        <button
                          disabled={!manifest.trim() || !visibility}
                          onClick={startMint}
                          className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold disabled:opacity-50"
                        >
                          Submit & Mint (Demo)
                        </button>
                        <button onClick={() => setStep("pricing")} className="px-3 py-2 rounded-2xl border border-white/10">Back</button>
                      </div>
                    </div>

                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5">
                      <h3 className="font-semibold mb-2">Preview</h3>
                      <div className="text-xs text-zinc-400 mb-2">Vault: {vaultName || "(unnamed)"}</div>
                      <div className="rounded-2xl border border-white/10 bg-black/30 p-4 whitespace-pre-wrap break-words text-sm min-h-[8rem] max-w-full">{manifest || "(Your manifest will render here.)"}</div>
                    </div>
                  </div>
                )}

                {/* Minting Spinner */}
                {step === "minting" && (
                  <div className="p-10 rounded-2xl border border-white/10 bg-white/5 text-center">
                    <div className="mx-auto h-14 w-14 rounded-full border-4 border-white/20 border-t-cyan-400 animate-spin" />
                    <div className="mt-4 text-xl font-semibold">Tokenizing & Minting your FAWV Vault…</div>
                    <div className="mt-1 text-sm text-zinc-400">In a real mint, your selected files would be archived and the Vault token issued.</div>
                  </div>
                )}

                {/* Vault Screen */}
                {step === "vault" && (
                  <div className="grid md:grid-cols-2 gap-6 items-start">
                    <div className="p-6 rounded-2xl border border-white/10 bg-white/5 min-w-0">

                      <h2 className="text-xl font-semibold mb-2">Your Demo Vault</h2>
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

  {/* NEW: Archive Hash row */}
  <tr>
    <td className="py-2 text-zinc-400">Archive Hash</td>
    <td className="py-2 text-right font-mono text-xs break-all">{archiveHash || "—"}</td>
  </tr>

  <tr>
    <td className="py-2 text-zinc-400">Visibility</td>
    <td className="py-2 text-right">{visibility}</td>
  </tr>
  <tr>
    <td className="py-2 text-zinc-400">Endowment</td>
    <td className="py-2 text-right">
      {lockedEndowment
        ? `$${lockedEndowment.usd.toFixed(2)} · ${lockedEndowment.eth.toFixed(6)} ETH`
        : "None"}
    </td>
  </tr>
  <tr>
    <td className="py-2 text-zinc-400">Endowment Rate</td>
    <td className="py-2 text-right">
      {lockedEndowment ? `$${lockedEndowment.usdPerEth.toFixed(2)} / ETH` : "—"}
    </td>
  </tr>
  <tr>
    <td className="py-2 text-zinc-400">Status</td>
    <td className="py-2 text-right">Minted (demo)</td>
  </tr>
</tbody>

                      </table>

                      <div className="mt-6 flex gap-2">
                        <button onClick={() => setShowTokenModal(true)} className="px-4 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold">View FAWV Vault Token</button>
                        <button onClick={resetFlow} className="px-3 py-2 rounded-2xl border border-white/10">Build Another Vault</button>
                      </div>
                    </div>

                    {/* Right Column: Manifest + Archive Contents */}
                    <div className="space-y-6">
                      <div className="p-6 rounded-2xl border border-white/10 bg-white/5 min-w-0">
                        <h3 className="font-semibold mb-2">Vault Manifest</h3>
                        <div className="text-xs text-zinc-400 mb-2">Visibility: {visibility}</div>
                        <div className="rounded-2xl border border-white/10 bg-black/30 p-4 whitespace-pre-wrap break-words text-sm min-h-[8rem] max-w-full">{manifest || "(No manifest provided)"}</div>

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

      <footer className="mx-auto max-w-6xl px-4 py-10 text-xs text-zinc-500">Demo pricing and flows are illustrative. No blockchain calls are made.</footer>

      {/* Token Modal */}
      {showTokenModal && tokenData && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-950 overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="font-semibold">FAWV Vault Token (ERC‑721 style, demo)</div>
              <button onClick={() => setShowTokenModal(false)} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">✕</button>
            </div>
            <div className="p-4 grid md:grid-cols-2 gap-4 items-start">
              <img src={tokenData.imageDataUrl} alt="token" className="rounded-2xl w-full border border-white/10" />
              <div className="text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{tokenData.name}</div>
                  <button onClick={() => copy(tokenData.tokenId)} className="text-xs px-2 py-1 rounded-lg border border-white/10 hover:border-cyan-400">Copy Token ID</button>
                </div>
                <table className="w-full text-xs mt-2">
                  <tbody>
                    <tr>
                      <td className="py-1 text-zinc-400">Contract</td>
                      <td className="py-1 text-right font-mono">{tokenData.contract}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Token ID</td>
                      <td className="py-1 text-right font-mono break-all">{tokenData.tokenId}</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-zinc-400">Owner</td>
                      <td className="py-1 text-right font-mono">{tokenData.owner}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="mt-4">
                  <div className="text-xs text-zinc-400 mb-1">tokenURI (demo JSON)</div>
                  <pre className="rounded-2xl border border-white/10 bg-black/30 p-3 text-xs whitespace-pre-wrap max-h-48 overflow-auto">{tokenData.tokenUriJson}</pre>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-white/10 flex items-center justify-end gap-2">
              <button onClick={() => copy(`${tokenData.contract}:${tokenData.tokenId}`)} className="px-3 py-2 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold">Copy Vault Token</button>
              <button onClick={() => setShowTokenModal(false)} className="px-3 py-2 rounded-2xl border border-white/10">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Landing({ onCTAClick }: { onCTAClick: () => void }) {
  return (
    <section className="space-y-12">
      <div className="grid md:grid-cols-2 gap-8 items-center">
        <div className="p-2">
          <h1 className="text-4xl md:text-5xl font-bold leading-tight">For All We Value</h1>
          <p className="mt-4 text-zinc-300 text-lg">
            FAWV is a digital trust platform for preserving and passing forward your most valuable data —
            with programmable permanence, escrow grace, and 100‑year heirloom options.
          </p>
          <div className="mt-6 flex gap-3">
            <button onClick={onCTAClick} className="px-5 py-3 rounded-2xl bg-cyan-500 text-black font-semibold hover:bg-cyan-400">Build a Vault</button>
            <a href="#how-it-works" className="px-5 py-3 rounded-2xl border border-white/10 hover:border-cyan-400">How it works</a>
          </div>
        </div>
        <div className="p-6 rounded-3xl border border-white/10 bg-white/5">
          <ul className="space-y-3 text-sm text-zinc-300">
            <li>• Permanence — annual EAS keeps Vaults in good standing</li>
            <li>• Permanence+ — 3/5/10‑year escrow grace to avoid immediate market release</li>
            <li>• Heirloom — 100‑year guarantee, no annual EAS required</li>
            <li>• Public/Private Manifest — searchable discovery or private until orphaned</li>
            <li>• Folder‑aware uploads — preserve directory structure</li>
          </ul>
        </div>
      </div>

      <div id="how-it-works" className="grid md:grid-cols-3 gap-4">
        {["Choose product", "Upload folder", "Name & Price", "Write manifest", "Mint token", "View Vault"].map((t, i) => (
          <div key={t} className="p-5 rounded-2xl border border-white/10 bg-white/5">
            <div className="text-2xl">{i + 1}.</div>
            <div className="mt-2 font-semibold">{t}</div>
            <div className="text-sm text-zinc-400 mt-1">Guided, demo‑only flow — no blockchain calls.</div>
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
