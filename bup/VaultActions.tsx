
import React, { useMemo, useState } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

type VerifyResult = {
  key: string;
  ok: boolean;
  expected?: string;
  actual?: string;
  bytes?: number;
  error?: string;
};

type VaultActionsProps = {
  apiBase?: string;
  vaultPath?: string | null;        // e.g., 'demo/efbb80bb83aec619/'
  manifestKey?: string | null;      // e.g., '.../manifest.json'
  tokenMetaKey?: string | null;     // e.g., '.../token-metadata.json'
  title?: string;
};

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

async function sha256(ab: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", ab);
  return toHex(hash);
}

async function presignGet(apiBase: string, key: string): Promise<string> {
  const resp = await fetch(`${apiBase}/presign-get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok || !data?.url) {
    throw new Error(data?.message || "presign-get failed");
  }
  return data.url as string;
}

async function listVault(apiBase: string, prefix: string): Promise<{ key: string; size: number; lastModified?: string }[]> {
  const resp = await fetch(`${apiBase}/vault/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  const data = await resp.json();
  if (!resp.ok || !data?.ok || !Array.isArray(data.objects)) {
    throw new Error(data?.message || "vault/list failed");
  }
  return data.objects;
}

// --- Robust hash extraction helpers ---

function normalizeHex(x?: string | null): string | null {
  if (!x || typeof x !== "string") return null;
  let v = x.trim();
  if (v.startsWith("0x") || v.startsWith("0X")) v = v.slice(2);
  v = v.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  return null;
}

function scoreKeyPath(path: string): number {
  // Heuristic: prefer fields mentioning content/payload/file + sha256/hash
  let score = 0;
  const p = path.toLowerCase();
  if (p.includes("content")) score += 3;
  if (p.includes("payload") || p.includes("file")) score += 2;
  if (p.includes("sha256")) score += 4;
  if (p.includes("hash")) score += 3;
  if (p.includes("extra")) score += 1;
  if (p.includes("attributes")) score += 1;
  return score;
}

function deepFindSha256(obj: any, basePath = ""): { value: string; path: string }[] {
  const hits: { value: string; path: string }[] = [];
  const visit = (node: any, path: string) => {
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        node.forEach((v, i) => visit(v, `${path}[${i}]`));
      } else {
        for (const [k, v] of Object.entries(node)) {
          const p = path ? `${path}.${k}` : k;
          if (typeof v === "string") {
            const norm = normalizeHex(v);
            if (norm) hits.push({ value: norm, path: p });
          } else {
            visit(v, p);
          }
        }
      }
    }
  };
  visit(obj, basePath);
  // sort best-first by key path heuristic
  hits.sort((a, b) => scoreKeyPath(b.path) - scoreKeyPath(a.path));
  return hits;
}

async function fetchJsonViaPresign(apiBase: string, key: string) {
  const url = await presignGet(apiBase, key);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${key}: ${resp.status}`);
  return await resp.json();
}

const VaultActions: React.FC<VaultActionsProps> = ({
  apiBase = "/api",
  vaultPath,
  manifestKey,
  tokenMetaKey,
  title = "Integrity & Retrieval",
}) => {
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const prefix = useMemo(() => {
    if (vaultPath && vaultPath.trim().length > 0) {
      return vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
    }
    if (manifestKey && manifestKey.includes("/")) {
      return manifestKey.replace(/\/manifest\.json$/i, "/");
    }
    if (tokenMetaKey && tokenMetaKey.includes("/")) {
      return tokenMetaKey.replace(/\/token-metadata\.json$/i, "/");
    }
    return "";
  }, [vaultPath, manifestKey, tokenMetaKey]);

  const manifestKeyResolved = useMemo(() => {
    if (manifestKey) return manifestKey;
    if (prefix) return `${prefix}manifest.json`;
    return null;
  }, [prefix, manifestKey]);

  const tokenMetaKeyResolved = useMemo(() => {
    if (tokenMetaKey) return tokenMetaKey;
    if (prefix) return `${prefix}token-metadata.json`;
    return null;
  }, [prefix, tokenMetaKey]);

  const displayVaultId = useMemo(() => {
    if (!prefix) return "unknown";
    const parts = prefix.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }, [prefix]);

  async function fetchExpectedHash(): Promise<string | null> {
    // 1) Try manifest.json
    if (manifestKeyResolved) {
      try {
        const manifest = await fetchJsonViaPresign(apiBase, manifestKeyResolved);
        // Check common explicit fields first
        const explicit =
          normalizeHex(manifest?.contentHash) ||
          normalizeHex(manifest?.asset?.sha256) ||
          normalizeHex(manifest?.asset?.hash) ||
          normalizeHex(manifest?.extra?.contentHash) ||
          normalizeHex(manifest?.extra?.sha256);
        if (explicit) return explicit;

        // Otherwise deep search for any 64-hex string, scoring likely keys
        const hits = deepFindSha256(manifest);
        if (hits.length) return hits[0].value;
      } catch {}
    }

    // 2) Fallback: token-metadata.json
    if (tokenMetaKeyResolved) {
      try {
        const meta = await fetchJsonViaPresign(apiBase, tokenMetaKeyResolved);
        // common NFT metadata places: attributes array; or top-level custom fields
        const fromAttrs = Array.isArray(meta?.attributes)
          ? meta.attributes
              .map((a: any) => normalizeHex(a?.value))
              .find((v: string | null) => v)
          : null;
        const explicit =
          fromAttrs ||
          normalizeHex(meta?.contentHash) ||
          normalizeHex(meta?.sha256) ||
          normalizeHex(meta?.fileHash) ||
          normalizeHex(meta?.extra?.contentHash) ||
          normalizeHex(meta?.extra?.sha256);
        if (explicit) return explicit;

        const hits = deepFindSha256(meta);
        if (hits.length) return hits[0].value;
      } catch {}
    }

    return null;
  }

  async function handleVerify() {
    if (!prefix) {
      setStatus("Vault path not found.");
      return;
    }
    setVerifying(true);
    setStatus("Starting verification…");
    try {
      const [objects, expectedMaybe] = await Promise.all([listVault(apiBase, prefix), fetchExpectedHash()]);
      if (!expectedMaybe) throw new Error("Expected hash not found in manifest or token-metadata");
      const expected = expectedMaybe;

      const targets = objects.filter(
        (o) => !o.key.endsWith(".json") && !o.key.toLowerCase().includes("token-metadata")
      );
      if (targets.length === 0) {
        throw new Error("No vault payload files found to verify.");
      }
      const results: VerifyResult[] = [];
      for (const obj of targets) {
        setStatus(`Hashing ${obj.key}…`);
        const url = await presignGet(apiBase, obj.key);
        const resp = await fetch(url);
        if (!resp.ok) {
          results.push({ key: obj.key, ok: false, expected, error: `HTTP ${resp.status}` });
          continue;
        }
        const ab = await resp.arrayBuffer();
        const actual = (await sha256(ab)).toLowerCase();
        results.push({ key: obj.key, ok: actual === expected, expected, actual, bytes: ab.byteLength });
      }
      setVerifyResults(results);
      const okCount = results.filter((r) => r.ok).length;
      const total = results.length;
      setStatus(okCount === total ? `Verified ${okCount}/${total} file(s). ✅` : `Mismatch on ${total - okCount}/${total} file(s). ⚠️`);
    } catch (err: any) {
      setStatus(err?.message || "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleDownloadZip() {
    if (!prefix) {
      setStatus("Vault path not found.");
      return;
    }
    setDownloading(true);
    setStatus("Preparing vault zip…");
    try {
      const objects = await listVault(apiBase, prefix);
      if (objects.length === 0) {
        throw new Error("No files found under vault path.");
      }
      const zip = new JSZip();
      for (const obj of objects) {
        const relName = obj.key.startsWith(prefix) ? obj.key.substring(prefix.length) : obj.key;
        setStatus(`Adding ${relName}…`);
        const url = await presignGet(apiBase, obj.key);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Fetch failed for ${relName}: ${resp.status}`);
        const blob = await resp.blob();
        zip.file(relName, blob);
      }
      setStatus("Finalizing zip…");
      const content = await zip.generateAsync({ type: "blob" });
      const filename = `fawv-vault-${displayVaultId}.zip`;
      saveAs(content, filename);
      setStatus(`Downloaded ${filename}`);
    } catch (err: any) {
      setStatus(err?.message || "Download failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-white/5 shadow-xl">
      <h2 className="text-xl font-semibold mb-2">{title}</h2>
      <p className="text-sm opacity-80 mb-4">
        Vault: <span className="font-mono">{prefix || "unknown"}</span>
      </p>

      <div className="flex flex-col gap-3">
        <button
          onClick={handleVerify}
          disabled={verifying || downloading}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition disabled:opacity-50 text-left"
          title="Re-hash the vault file(s) and compare against manifest/token metadata hash"
        >
          {verifying ? "Verifying…" : "Verify Integrity"}
        </button>

        <button
          onClick={handleDownloadZip}
          disabled={downloading || verifying}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition disabled:opacity-50 text-left"
          title="Download payload file(s), manifest.json, and token-metadata.json as a single zip"
        >
          {downloading ? "Preparing Zip…" : "Download Vault (.zip)"}
        </button>
      </div>

      {status && <div className="mt-4 text-sm opacity-90">{status}</div>}

      {verifyResults && (
        <div className="mt-4">
          <h3 className="font-medium mb-2">Verification Results</h3>
          <div className="space-y-2">
            {verifyResults.map((r) => (
              <div key={r.key} className={`p-3 rounded-xl border ${r.ok ? "border-emerald-400/30" : "border-amber-400/30"} bg-black/10`}>
                <div className="font-mono text-xs break-all">{r.key}</div>
                {r.error ? (
                  <div className="text-amber-300 text-sm mt-1">Error: {r.error}</div>
                ) : (
                  <div className="text-sm mt-1">
                    <div>Expected: <span className="font-mono">{r.expected}</span></div>
                    <div>Actual:&nbsp;&nbsp;&nbsp; <span className="font-mono">{r.actual}</span></div>
                    <div>Bytes:&nbsp;&nbsp;&nbsp;&nbsp; {r.bytes ?? "?"}</div>
                    <div className={`mt-1 ${r.ok ? "text-emerald-300" : "text-amber-300"}`}>
                      {r.ok ? "Match ✅" : "Mismatch ⚠️"}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VaultActions;
