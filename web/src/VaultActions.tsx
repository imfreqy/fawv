
import React, { useMemo, useState } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

type VerifyResult = {
  key: string;
  ok: boolean;
  expected?: string;
  actualClient?: string;
  actualServer?: string;
  bytesClient?: number;
  bytesServer?: number;
  head?: {
    contentLength?: number;
    contentType?: string;
    contentEncoding?: string;
    etag?: string;
    lastModified?: string;
  };
  error?: string;
};

type VaultActionsProps = {
  apiBase?: string;
  vaultPath?: string | null;
  manifestKey?: string | null;
  tokenMetaKey?: string | null;
  title?: string;
  /** If true (default), Verify will auto-write manifest.contentHash when missing and continue. */
  autoFixOnVerify?: boolean;
};

async function callJSON(api: string, path: string, body: any) {
  const resp = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) throw new Error(data?.message || `${path} failed`);
  return data;
}
async function presignGet(apiBase: string, key: string): Promise<string> {
  const { url } = await callJSON(apiBase, "/presign-get", { key });
  return url as string;
}
async function listVault(apiBase: string, prefix: string) {
  const { objects } = await callJSON(apiBase, "/vault/list", { prefix });
  return objects as { key: string; size: number; lastModified?: string }[];
}
async function headObject(apiBase: string, key: string) {
  const d = await callJSON(apiBase, "/vault/head", { key });
  return d as any;
}
async function serverHash(apiBase: string, key: string) {
  const d = await callJSON(apiBase, "/vault/hash", { key });
  return d as any;
}
async function setManifestContentHash(apiBase: string, manifestKey: string, payloadKey: string) {
  const d = await callJSON(apiBase, "/manifest/set-content-hash", { manifestKey, payloadKey, setAssetSha256: true });
  return d as any;
}

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}
async function sha256(ab: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", ab);
  const view = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex.toLowerCase();
}
function normalizeHex(v?: string | null): string | null {
  if (!v || typeof v !== "string") return null;
  let x = v.trim();
  if (x.startsWith("0x") || x.startsWith("0X")) x = x.slice(2);
  x = x.toLowerCase();
  return /^[0-9a-f]{64}$/.test(x) ? x : null;
}

const VaultActions: React.FC<VaultActionsProps> = ({
  apiBase = "/api",
  vaultPath,
  manifestKey,
  tokenMetaKey,
  title = "Integrity & Retrieval",
  autoFixOnVerify = true,
}) => {
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [expectedSource, setExpectedSource] = useState<string | null>(null);
  const [expectedValue, setExpectedValue] = useState<string | null>(null);

  const prefix = useMemo(() => {
    if (vaultPath && vaultPath.trim().length > 0) {
      return vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`
    }
    if (manifestKey && manifestKey.includes("/")) return manifestKey.replace(/\/manifest\.json$/i, "/");
    if (tokenMetaKey && tokenMetaKey.includes("/")) return tokenMetaKey.replace(/\/token-metadata\.json$/i, "/");
    return "";
  }, [vaultPath, manifestKey, tokenMetaKey]);

  const manifestKeyResolved = useMemo(() => manifestKey || (prefix ? `${prefix}manifest.json` : null), [manifestKey, prefix]);

  async function fetchManifestExpected(): Promise<{ expected: string | null; from: string | null }> {
    if (!manifestKeyResolved) return { expected: null, from: null };
    try {
      const url = await presignGet(apiBase, manifestKeyResolved);
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return { expected: null, from: null };
      const m = await r.json();
      const e = normalizeHex(m?.contentHash) || normalizeHex(m?.asset?.sha256) || null;
      if (e) {
        const from = e === normalizeHex(m?.contentHash) ? "manifest.contentHash" : "manifest.asset.sha256";
        return { expected: e, from };
      }
    } catch {}
    return { expected: null, from: null };
  }

  async function findFirstPayloadAndServerHash(): Promise<{ payloadKey: string; sha256Hex: string } | null> {
    if (!prefix) return null;
    const objects = await listVault(apiBase, prefix);
    const candidates = objects.filter(o => !o.key.endsWith(".json")).sort((a,b) => (b.size||0) - (a.size||0));
    if (!candidates.length) return null;
    const payloadKey = candidates[0].key;
    const h = await serverHash(apiBase, payloadKey);
    return { payloadKey, sha256Hex: (h.sha256Hex as string).toLowerCase() };
  }

  async function verifyWithExpected(expected: string) {
    const objects = await listVault(apiBase, prefix);
    const targets = objects.filter(o => !o.key.endsWith(".json") && !o.key.toLowerCase().includes("token-metadata"));
    if (targets.length === 0) throw new Error("No vault payload files found to verify.");

    const results: VerifyResult[] = [];
    for (const obj of targets) {
      setStatus(`Hashing ${obj.key}…`);
      const [head, client] = await Promise.all([headObject(apiBase, obj.key), presignGet(apiBase, obj.key).then(async (u) => {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ab = await r.arrayBuffer();
        return { ab, bytes: ab.byteLength, digest: await sha256(ab) };
      })]);

      let server = null as null | { bytes: number; digest: string };
      if (client.digest !== expected) {
        const h = await serverHash(apiBase, obj.key);
        server = { bytes: h.bytes, digest: (h.sha256Hex as string).toLowerCase() };
      }

      const ok = (server ? server.digest : client.digest) === expected;
      results.push({
        key: obj.key,
        ok,
        expected,
        actualClient: client.digest,
        bytesClient: client.bytes,
        actualServer: server?.digest,
        bytesServer: server?.bytes,
        head: {
          contentLength: head.contentLength,
          contentType: head.contentType,
          contentEncoding: head.contentEncoding,
          etag: head.etag,
          lastModified: head.lastModified,
        },
      });
    }

    setVerifyResults(results);
    const okCount = results.filter(r => r.ok).length;
    const total = results.length;
    setStatus(okCount === total ? `Verified ${okCount}/${total} file(s). ✅` : `Mismatch on ${total - okCount}/${total} file(s). ⚠️`);
  }

  async function handleVerify() {
    if (!prefix) {
      setStatus("Vault path not found.");
      return;
    }
    setVerifying(true);
    setVerifyResults(null);
    setStatus("Starting verification…");
    try {
      // 1) Try manifest for canonical expected
      let { expected, from } = await fetchManifestExpected();

      // 2) If missing and auto-fix enabled, compute server hash & write manifest, then adopt as expected
      if (!expected) {
        const sug = await findFirstPayloadAndServerHash();
        if (!sug) throw new Error("Expected hash not found and no payload available.");
        if (autoFixOnVerify && manifestKeyResolved) {
          setStatus("Writing manifest.contentHash to server hash…");
          try {
            await setManifestContentHash(apiBase, manifestKeyResolved, sug.payloadKey);
            expected = sug.sha256Hex;
            from = "manifest.contentHash (auto)";
          } catch (e: any) {
            // If write fails, still proceed using server hash (won't persist)
            expected = sug.sha256Hex;
            from = "serverHash (not persisted)";
            console.warn("[verify] auto-fix write failed, continuing ephemeral:", e?.message || e);
          }
        } else {
          // No auto-fix; use server hash ephemerally
          expected = sug.sha256Hex;
          from = "serverHash (not persisted)";
        }
      }

      setExpectedSource(from || null);
      setExpectedValue(expected || null);
      if (!expected) throw new Error("Unable to determine expected hash.");

      // 3) Perform verification with expected
      await verifyWithExpected(expected);
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
      if (objects.length === 0) throw new Error("No files found under vault path.");
      const zip = new JSZip();
      for (const obj of objects) {
        const relName = obj.key.startsWith(prefix) ? obj.key.substring(prefix.length) : obj.key;
        setStatus(`Adding ${relName}…`);
        const u = await presignGet(apiBase, obj.key);
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`Fetch failed for ${relName}: ${r.status}`);
        const blob = await r.blob();
        zip.file(relName, blob);
      }
      setStatus("Finalizing zip…");
      const content = await zip.generateAsync({ type: "blob" });
      const filename = `fawv-vault.zip`;
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

      <div className="flex flex-col gap-3">
        <button
          onClick={handleVerify}
          disabled={verifying || downloading}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition disabled:opacity-50 text-left"
          title="Re-hash the vault file(s) and compare to expected hash"
        >
          {verifying ? "Verifying…" : "Verify Integrity"}
        </button>

        <button
          onClick={handleDownloadZip}
          disabled={downloading || verifying}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition disabled:opacity-50 text-left"
          title="Download payload, manifest.json, token-metadata.json as zip"
        >
          {downloading ? "Preparing Zip…" : "Download Vault (.zip)"}
        </button>
      </div>

      {expectedSource && expectedValue && (
        <div className="mt-3 text-xs opacity-90">
          Expected from <span className="font-mono">{expectedSource}</span>:{" "}
          <span className="font-mono">{expectedValue}</span>
        </div>
      )}

      {status && <div className="mt-4 text-sm opacity-90">{status}</div>}

      {verifyResults && (
        <div className="mt-4">
          <h3 className="font-medium mb-2">Verification Results</h3>
          <div className="space-y-2">
            {verifyResults.map((r) => (
              <div key={r.key} className={`p-3 rounded-2xl border ${r.ok ? "border-emerald-400/30" : "border-amber-400/30"} bg-black/10`}>
                <div className="font-mono text-xs break-all">{r.key}</div>

                {r.head && (
                  <div className="text-xs opacity-80 mt-1">
                    HEAD — len: {r.head.contentLength ?? "?"}, type: {r.head.contentType || "?"}, enc: {r.head.contentEncoding || "none"}, etag: {r.head.etag || "?"}
                  </div>
                )}

                {r.error ? (
                  <div className="text-amber-300 text-sm mt-1">Error: {r.error}</div>
                ) : (
                  <div className="text-sm mt-1 space-y-1">
                    <div>Expected:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <span className="font-mono">{r.expected}</span></div>
                    <div>Client hash:&nbsp;&nbsp; <span className="font-mono">{r.actualClient}</span> ({r.bytesClient ?? "?"} bytes)</div>
                    {r.actualServer && (
                      <div>Server hash:&nbsp;&nbsp; <span className="font-mono">{r.actualServer}</span> ({r.bytesServer ?? "?"} bytes)</div>
                    )}
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
