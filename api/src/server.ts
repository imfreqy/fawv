import "dotenv/config";
import express from "express";
import cors from "cors";
import uploadRouter from "./routes/upload";

const app = express();

app.use(
  cors({
    origin: ["https://fawvv.com", "http://fawvv.com", "http://localhost:5173"],
  })
);
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_, res) => res.json({ ok: true }));

// Mount routes: this makes the URL /api/upload/start
app.use("/api", uploadRouter);

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`API listening on ${port}`);
});

