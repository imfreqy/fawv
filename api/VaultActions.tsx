
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
  /** e.g., 'demo/efbb80bb83aec619/' (with trailing slash preferred) */
  vaultPath?: string | null;
  /** e.g., 'demo/efbb80bb83aec619/manifest.json' */
  manifestKey?: string | null;
  /** e.g., 'demo/efbb80bb83aec619/token-metadata.json' */
  tokenMetaKey?: string | null;
  /** Optional UI override for card title */
  title?: string;
};

/**
 * Utility: hex stringify an ArrayBuffer
 */
function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Compute SHA-256 for an ArrayBuffer in browser using Web Crypto.
 * NOTE: This loads the whole file into memory which is OK for demo-size files.
 */
async function sha256(ab: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", ab);
  return toHex(hash);
}

/**
 * Ask server for presigned GET url.
 */
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

/**
 * Ask server for a list of objects under a vault prefix.
 */
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

  const displayVaultId = useMemo(() => {
    if (!prefix) return "unknown";
    const parts = prefix.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }, [prefix]);

  async function fetchManifestExpectedHash(): Promise<string | null> {
    if (!manifestKeyResolved) return null;
    const url = await presignGet(apiBase, manifestKeyResolved);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Failed to fetch manifest.json");
    const manifest = await resp.json();
    // Try several likely fields
    const candidates = [
      manifest?.contentHash,
      manifest?.asset?.sha256,
      manifest?.asset?.hash,
      manifest?.extra?.contentHash,
      manifest?.extra?.sha256,
    ].filter(Boolean);
    return (candidates?.[0] as string) || null;
  }

  async function handleVerify() {
    if (!prefix) {
      setStatus("Vault path not found.");
      return;
    }
    setVerifying(true);
    setStatus("Starting verification…");
    try {
      const [objects, expected] = await Promise.all([listVault(apiBase, prefix), fetchManifestExpectedHash()]);
      if (!expected) {
        throw new Error("Expected hash not found in manifest.json");
      }
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
        const actual = await sha256(ab);
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
      // Keep relative names (strip the prefix from keys)
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
          title="Re-hash the vault file(s) and compare against manifest.contentHash"
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
