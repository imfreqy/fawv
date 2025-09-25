// fawv/api/src/server.ts
import express from "express";
import cors from "cors";
import routes from "../routes.js"; // existing app routes (ESM ok)

// --- Inline: minimal POST /api/manifest/force-extra ---
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));



app.use(express.urlencoded({ extended: true }));

// S3 client
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

// Helpers
function streamToString(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (stream as Readable)
      .on("data", (c) => chunks.push(Buffer.from(c)))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
      .on("error", reject);
  });
}

/**
 * Parses where the manifest lives from either:
 *  - manifestKey (uses env VAULT_BUCKET)
 *  - manifestRef: s3://bucket/key or https://... forms
 */
function parseLocation(opts: { manifestKey?: string | null; manifestRef?: string | null }) {
  const { manifestKey, manifestRef } = opts;

  if (manifestKey) {
    const bucket = process.env.VAULT_BUCKET;
    if (!bucket) throw new Error("VAULT_BUCKET env is required when using manifestKey");
    return { bucket, key: String(manifestKey) };
  }

  if (!manifestRef) throw new Error("manifestKey or manifestRef is required");

  const s = String(manifestRef);
  // s3://bucket/path/to/manifest.json
  if (s.startsWith("s3://")) {
    const [, , bucket, ...rest] = s.split("/");
    return { bucket, key: rest.join("/") };
  }
  // https://s3.<region>.amazonaws.com/<bucket>/<key>
  {
    const m = s.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+)$/);
    if (m) return { bucket: m[1], key: m[2] };
  }
  // https://<bucket>.s3.<region>.amazonaws.com/<key>
  {
    const m = s.match(/^https?:\/\/([^.]+)\.s3\.[^/]+\.amazonaws\.com\/(.+)$/);
    if (m) return { bucket: m[1], key: m[2] };
  }

  // Fallback: treat as key with env bucket
  const bucket = process.env.VAULT_BUCKET;
  if (!bucket) throw new Error("Unable to parse manifestRef; set VAULT_BUCKET or pass manifestKey instead");
  return { bucket, key: s };
}

console.log("[force-extra] route will mount at POST /api/manifest/force-extra");

// IMPORTANT: register this *before* any HTML/static catch-alls
app.post("/api/manifest/force-extra", async (req, res) => {
  try {
    const { manifestKey, manifestRef, extra } = req.body || {};
    const { bucket, key } = parseLocation({ manifestKey, manifestRef });

    let obj: any = {};
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await streamToString(got.Body as any);
      obj = JSON.parse(body || "{}");
    } catch (_e) {
      // If missing or non-JSON, start fresh
      obj = {};
    }

    obj.extra = obj.extra || {};
    obj.extra.manifestText = (extra?.manifestText ?? "").toString();

    const Body = JSON.stringify(obj, null, 2) + "\n";
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body,
      ContentType: "application/json; charset=utf-8",
    }));

    res.json({ ok: true, bucket, key });
  } catch (e: any) {
    console.error("force-extra error:", e);
    return res.status(400).send(e?.message || "force-extra failed");
  }
});

// Sanity: quick ping
app.get("/api/ping", (_req, res) => res.json({ ok: true, route: "/api/ping" }));

// STUB: mount BEFORE app.use("/api", routes)
app.post("/api/manifest/force-extra", (req, res) => {
  console.log("[force-extra] STUB HIT", req.body);
  res.json({ ok: true, stub: true });
});


// Existing routers
app.use("/api", routes);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 4000, () => console.log("API listening"));
