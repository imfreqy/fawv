// server.js (ESM, merged & fixed)
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import express from "express";
// import cors from "cors"; // <- optional: enable if you call API directly from http://localhost:5173

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 1) Load .env from the api folder BEFORE importing routes
dotenv.config({ path: join(__dirname, ".env") });

// 2) Create app + middleware
const app = express();
app.use(express.json({ limit: "25mb" }));

// OPTIONAL CORS (uncomment if you are NOT using Vite proxy and call 4000 directly from the browser)
/*
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-amz-checksum-crc32", "x-amz-meta-sha256"],
}));
app.options("*", cors());
*/

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// 3) Import router AFTER .env is loaded
const { default: router } = await import("./routes.js");
app.use("/api", router);

// 4) Start server (only once)
const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`FAWV API listening on :${port}`));

// 5) Graceful shutdown
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
