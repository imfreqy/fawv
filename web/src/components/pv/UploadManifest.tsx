import React, { useCallback, useMemo, useRef, useState } from "react";
import { createSHA256 } from "hash-wasm";

// ========================= Types =========================

type PermanencePlan = "payOnce" | "payOnceDual" | "subscription";

type Heir = { id: string; label: string };

type Manifest = {
  manifestVersion: string;
  archiveId: string;
  createdAt: string; // ISO
  ownerAddress?: string;
  file: {
    name: string;
    sizeBytes: number;
    sha256: string;
    mime?: string;
  };
  storagePolicy: {
    permanencePlan: PermanencePlan;
    retentionYears: number; // demo placeholder
    redundancy: "single" | "dual";
    encryption: {
      mode: "none" | "passphrase" | "publicKey";
      hint?: string; // Do NOT store secrets; demo-only hint
    };
  };
  heritagePolicy: {
    ttlYears: number; // e.g., 100
    heartbeatMonths: number; // e.g., 12
    heirs: string[]; // emails or addresses (demo)
    custodialStewardship: boolean;
  };
  attestations: {
    heartbeatSchemaUID?: string; // placeholder for EAS schema UID
    heirProofSchemaUID?: string; // placeholder for EAS schema UID
  };
  token: {
    symbolic: boolean; // demo only (not on-chain)
    standard: "ERC721" | "ERC1155" | "Other";
    name: string;
    symbol: string;
    description?: string;
    previewURI?: string;
  };
  economicPreview: {
    estimatedUSD: number; // DEMO — not a quote
    inputs: {
      baseUSDPerGBYear: number;
      years: number;
      redundancyFactor: number;
    };
  };
};

// ========================= Helpers =========================

function classNames(...s: Array<string | false | null | undefined>) {
  return s.filter(Boolean).join(" ");
}

function bytesToHuman(n: number) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(2)} GB`;
  const tb = gb / 1024;
  return `${tb.toFixed(2)} TB`;
}

function sizeGB(n: number) {
  return n / 1024 / 1024 / 1024;
}

function downloadJSON(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Chunked hashing that avoids stream typing issues and large memory spikes
async function sha256Hex(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const hasher = await createSHA256();
  const total = file.size;
  const chunkSize = 8 * 1024 * 1024; // 8 MiB slices
  let offset = 0;

  while (offset < total) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, total));
    const buf = await chunk.arrayBuffer();
    hasher.update(new Uint8Array(buf));
    offset += buf.byteLength;
    onProgress?.(offset, total);
    // Yield to UI so the page stays responsive during large hashes
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  return hasher.digest("hex");
}

// ========================= Component =========================

export default function UploadModule() {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // File & hashing state
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [hashProgress, setHashProgress] = useState<number>(0);

  // Form state
  const [ownerAddress, setOwnerAddress] = useState("");
  const [permanencePlan, setPermanencePlan] = useState<PermanencePlan>("payOnceDual");
  const [encryptionMode, setEncryptionMode] = useState<"none" | "passphrase" | "publicKey">("none");
  const [encryptionHint, setEncryptionHint] = useState("");

  const [ttlYears, setTtlYears] = useState<number>(100);
  const [heartbeatMonths, setHeartbeatMonths] = useState<number>(12);
  const [heirs, setHeirs] = useState<Heir[]>([]);
  const [heirInput, setHeirInput] = useState("");
  const [custodialStewardship, setCustodialStewardship] = useState(true);

  const [symbolic, setSymbolic] = useState(true);
  const [tokenStd, setTokenStd] = useState<"ERC721" | "ERC1155" | "Other">("ERC721");
  const [tokenName, setTokenName] = useState("PermaVault Archive");
  const [tokenSymbol, setTokenSymbol] = useState("PV-ARCH");
  const [tokenDesc, setTokenDesc] = useState(
    "Symbolic token representing an archive block in FAWV (demo)"
  );

  // Derived
  const redundancy = useMemo(
    () => (permanencePlan === "payOnceDual" ? "dual" : "single"),
    [permanencePlan]
  );

  const estimate = useMemo(() => {
    if (!file) return { price: 0, inputs: { baseUSDPerGBYear: 0, years: 0, redundancyFactor: 0 } };
    const gb = Math.max(0.0000001, sizeGB(file.size));
    // DEMO math only — clearly marked as illustrative
    const baseUSDPerGBYear = 0.01;
    const years = 200;
    const redundancyFactor = redundancy === "dual" ? 1.6 : 1.0;
    const price = gb * baseUSDPerGBYear * years * redundancyFactor;
    return { price: Number(price.toFixed(2)), inputs: { baseUSDPerGBYear, years, redundancyFactor } };
  }, [file, redundancy]);

  // ========================= Handlers =========================

  const dragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files?.[0];
    if (f) await pickFile(f);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) await pickFile(f);
  };

  const pickFile = useCallback(async (f: File) => {
    setBusy(true);
    setHashProgress(0);
    setFile(null);
    setFileHash("");
    try {
      const hash = await sha256Hex(f, (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        setHashProgress(Math.max(0, Math.min(100, pct)));
      });
      setFile(f);
      setFileHash(hash);
    } catch (err) {
      console.error(err);
      alert(
        "Failed to hash file. Try a smaller file for the demo, check .wasm MIME type, or switch to server-side hashing."
      );
    } finally {
      setBusy(false);
    }
  }, []);

  function addHeir() {
    const v = heirInput.trim();
    if (!v) return;
    setHeirs((h) => [...h, { id: crypto.randomUUID(), label: v }]);
    setHeirInput("");
  }

  function removeHeir(id: string) {
    setHeirs((h) => h.filter((x) => x.id !== id));
  }

  async function createManifest() {
    if (!file || !fileHash) {
      alert("Choose a file first.");
      return;
    }

    const manifest: Manifest = {
      manifestVersion: "0.1.0",
      archiveId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ownerAddress: ownerAddress || undefined,
      file: {
        name: file.name,
        sizeBytes: file.size,
        sha256: fileHash,
        mime: file.type || undefined,
      },
      storagePolicy: {
        permanencePlan,
        retentionYears: 200,
        redundancy: redundancy as "single" | "dual",
        encryption: { mode: encryptionMode, hint: encryptionHint || undefined },
      },
      heritagePolicy: {
        ttlYears,
        heartbeatMonths,
        heirs: heirs.map((h) => h.label),
        custodialStewardship,
      },
      attestations: {
        heartbeatSchemaUID: "0x-HEARTBEAT-SCHEMA-UID", // replace with real EAS schema
        heirProofSchemaUID: "0x-HEIRPROOF-SCHEMA-UID",
      },
      token: {
        symbolic,
        standard: tokenStd,
        name: tokenName,
        symbol: tokenSymbol,
        description: tokenDesc || undefined,
        previewURI: undefined,
      },
      economicPreview: {
        estimatedUSD: estimate.price,
        inputs: estimate.inputs,
      },
    };

    downloadJSON(`${manifest.archiveId}.manifest.json`, manifest);
  }

  function downloadTokenMetadata() {
    if (!file) {
      alert("Choose a file first.");
      return;
    }
    const meta = {
      name: tokenName,
      symbol: tokenSymbol,
      description: tokenDesc,
      external_url: "https://example.org/permavault/demo",
      image: undefined,
      attributes: [
        { trait_type: "Archive Size", value: file ? bytesToHuman(file.size) : "" },
        { trait_type: "Hash", value: fileHash.substring(0, 16) + "…" },
        { trait_type: "Plan", value: permanencePlan },
        { trait_type: "Heirloom TTL (yrs)", value: ttlYears },
        { trait_type: "Heartbeat (months)", value: heartbeatMonths },
      ],
    } as const;

    downloadJSON(`${tokenSymbol || "PV-ARCH"}.token-metadata.json`, meta);
  }

  function resetAll() {
    setFile(null);
    setFileHash("");
    setOwnerAddress("");
    setPermanencePlan("payOnceDual");
    setEncryptionMode("none");
    setEncryptionHint("");
    setTtlYears(100);
    setHeartbeatMonths(12);
    setHeirs([]);
    setHeirInput("");
    setCustodialStewardship(true);
    setSymbolic(true);
    setTokenStd("ERC721");
    setTokenName("PermaVault Archive");
    setTokenSymbol("PV-ARCH");
    setTokenDesc("Symbolic token representing an archive block in FAWV (demo)");
    setHashProgress(0);
  }

  // ========================= Render =========================

  return (
    <div className="min-h-screen bg-background text-foreground p-6 md:p-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-semibold">FAWV Demo — Upload & Manifest</h1>
          <div className="text-sm opacity-70">v0.2.0</div>
        </header>

        {/* Uploader */}
        <section className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2">
            <div
              onDragOver={dragOver}
              onDrop={onDrop}
              className={classNames(
                "border-2 border-dashed rounded-2xl p-8 transition",
                file ? "border-green-500/50" : "border-foreground/20 hover:border-foreground/40"
              )}
            >
              <div className="flex flex-col items-center justify-center text-center space-y-3">
                <div className="text-lg font-medium">Drag & drop a file here</div>
                <div className="text-sm opacity-70">or</div>
                <button
                  onClick={() => inputRef.current?.click()}
                  className="px-4 py-2 rounded-xl bg-foreground text-background hover:opacity-90 disabled:opacity-60"
                  disabled={busy}
                >
                  {busy ? `Hashing… ${hashProgress}%` : "Choose file"}
                </button>
                <input ref={inputRef} type="file" className="hidden" onChange={onPick} />
                {file && (
                  <div className="mt-4 text-sm">
                    <div className="font-medium">{file.name}</div>
                    <div className="opacity-70">{bytesToHuman(file.size)} · SHA-256: {fileHash.slice(0, 12)}…</div>
                  </div>
                )}
                <p className="text-xs opacity-60 max-w-md">
                  Large archives are hashed in 8 MiB chunks entirely in your browser (demo). For multi-GB+ assets,
                  consider a server-side hash toggle in production.
                </p>
              </div>
            </div>
          </div>

          {/* Owner / Address */}
          <div className="space-y-3">
            <label className="block text-sm font-medium">Owner (wallet or contact)</label>
            <input
              type="text"
              placeholder="0x… or email for demo"
              value={ownerAddress}
              onChange={(e) => setOwnerAddress(e.target.value)}
              className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2 focus:outline-none"
            />
            <div className="text-xs opacity-60">
              No wallet connection is performed in this demo. Input is stored only in the manifest you download.
            </div>
          </div>
        </section>

        {/* Plan & Heritage */}
        <section className="grid md:grid-cols-2 gap-6">
          <div className="rounded-2xl border border-foreground/15 p-5 space-y-4">
            <h2 className="text-lg font-semibold">Permanence Plan</h2>
            <div className="space-y-2">
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  checked={permanencePlan === "payOnce"}
                  onChange={() => setPermanencePlan("payOnce")}
                />
                <span className="text-sm">Pay-once (single-rail)</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  checked={permanencePlan === "payOnceDual"}
                  onChange={() => setPermanencePlan("payOnceDual")}
                />
                <span className="text-sm">Pay-once + Mirror (dual-rail)</span>
              </label>
              <label className="flex items-center gap-3 opacity-60">
                <input
                  type="radio"
                  checked={permanencePlan === "subscription"}
                  onChange={() => setPermanencePlan("subscription")}
                />
                <span className="text-sm">Subscription (placeholder)</span>
              </label>
            </div>

            <div className="space-y-2 pt-3">
              <div className="text-sm font-medium">Encryption</div>
              <select
                value={encryptionMode}
                onChange={(e) => setEncryptionMode(e.target.value as any)}
                className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
              >
                <option value="none">None (demo)</option>
                <option value="passphrase">Client-side passphrase (demo)</option>
                <option value="publicKey">Public key (demo)</option>
              </select>
              {encryptionMode !== "none" && (
                <input
                  type="text"
                  placeholder={
                    encryptionMode === "passphrase"
                      ? "Add a hint (do NOT put the passphrase)"
                      : "Key fingerprint / hint"
                  }
                  value={encryptionHint}
                  onChange={(e) => setEncryptionHint(e.target.value)}
                  className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
                />
              )}
              <div className="text-xs opacity-60">Demo-only fields. Do not store secrets here.</div>
            </div>
          </div>

          <div className="rounded-2xl border border-foreground/15 p-5 space-y-4">
            <h2 className="text-lg font-semibold">Heirloom / Heritage</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium">TTL (years)</label>
                <input
                  type="number"
                  min={1}
                  value={ttlYears}
                  onChange={(e) => setTtlYears(parseInt(e.target.value || "0"))}
                  className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium">Heartbeat (months)</label>
                <input
                  type="number"
                  min={1}
                  value={heartbeatMonths}
                  onChange={(e) => setHeartbeatMonths(parseInt(e.target.value || "0"))}
                  className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">Heirs (emails or addresses)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="alice@example.com or 0x…"
                  value={heirInput}
                  onChange={(e) => setHeirInput(e.target.value)}
                  className="flex-1 rounded-xl border border-foreground/20 bg-background px-3 py-2"
                />
                <button
                  onClick={addHeir}
                  className="px-3 py-2 rounded-xl border border-foreground/20 hover:bg-foreground/5"
                >
                  Add
                </button>
              </div>
              {heirs.length > 0 && (
                <ul className="flex flex-wrap gap-2 pt-2">
                  {heirs.map((h) => (
                    <li
                      key={h.id}
                      className="text-xs bg-foreground/10 rounded-full px-3 py-1 flex items-center gap-2"
                    >
                      {h.label}
                      <button
                        onClick={() => removeHeir(h.id)}
                        className="opacity-60 hover:opacity-100"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <label className="flex items-center gap-3 pt-1">
              <input
                type="checkbox"
                checked={custodialStewardship}
                onChange={(e) => setCustodialStewardship(e.target.checked)}
              />
              <span className="text-sm">Allow custodial stewardship if unclaimed (demo)</span>
            </label>
          </div>
        </section>

        {/* Token */}
        <section className="rounded-2xl border border-foreground/15 p-5 space-y-4">
          <h2 className="text-lg font-semibold">Symbolic Token (Demo)</h2>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={symbolic}
              onChange={(e) => setSymbolic(e.target.checked)}
            />
            <span className="text-sm">Create a symbolic token metadata file (no on-chain mint)</span>
          </label>

          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium">Standard</label>
              <select
                value={tokenStd}
                onChange={(e) => setTokenStd(e.target.value as any)}
                className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
              >
                <option>ERC721</option>
                <option>ERC1155</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium">Name</label>
              <input
                type="text"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Symbol</label>
              <input
                type="text"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                className="w-full rounded-xl border border-foreground/20 bg-background px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Description</label>
            <textarea
              value={tokenDesc}
              onChange={(e) => setTokenDesc(e.target.value)}
              className="w-full rounded-2xl border border-foreground/20 bg-background px-3 py-2"
              rows={3}
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button
              onClick={downloadTokenMetadata}
              className="px-4 py-2 rounded-xl border border-foreground/20 hover:bg-foreground/5"
            >
              Download token-metadata.json
            </button>
          </div>
        </section>

        {/* Preview & Actions */}
        <section className="grid md:grid-cols-2 gap-6">
          <div className="rounded-2xl border border-foreground/15 p-5 space-y-4">
            <h2 className="text-lg font-semibold">Economic Preview (Demo)</h2>
            <div className="text-sm">
              <div>
                <span className="opacity-70">File size:</span> {file ? bytesToHuman(file.size) : "—"}
              </div>
              <div>
                <span className="opacity-70">Plan:</span> {permanencePlan} ({redundancy})
              </div>
              <div>
                <span className="opacity-70">Estimate:</span> ${estimate.price.toLocaleString()}
              </div>
            </div>
            <div className="text-xs opacity-70">
              This is a <b>demonstration-only</b> estimate, using placeholder constants. It is <b>not a quote</b> and not an
              offer.
            </div>
          </div>

          <div className="rounded-2xl border border-foreground/15 p-5 space-y-4">
            <h2 className="text-lg font-semibold">Create Manifest</h2>
            <div className="text-sm opacity-80">
              The manifest captures file hash/size, plan, heritage, and a symbolic token record. No data is uploaded in
              this demo; you will download a JSON file locally.
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={createManifest}
                className="px-4 py-2 rounded-xl bg-foreground text-background hover:opacity-90 disabled:opacity-60"
                disabled={!file || !fileHash}
              >
                Download manifest.json
              </button>
              <button
                onClick={resetAll}
                className="px-4 py-2 rounded-xl border border-foreground/20 hover:bg-foreground/5"
              >
                Reset
              </button>
            </div>
          </div>
        </section>

        {/* Compliance / Notes */}
        <section className="rounded-2xl border border-foreground/15 p-5 space-y-2">
          <h2 className="text-lg font-semibold">Notes</h2>
          <ul className="list-disc pl-5 text-sm space-y-1 opacity-80">
            <li>Client-side hashing only; files are not uploaded in this demo.</li>
            <li>Do not enter secrets. Encryption fields are non-functional placeholders.</li>
            <li>Economic preview is illustrative and may not reflect actual protocol costs.</li>
            <li>Attestation schema UIDs are placeholders for future EAS integration.</li>
          </ul>
        </section>

        <footer className="pt-2 text-xs opacity-60">© {new Date().getFullYear()} FAWV / PermaVault — Demo UI</footer>
      </div>
    </div>
  );
}
