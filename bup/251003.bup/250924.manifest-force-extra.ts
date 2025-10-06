import express from "express";
import manifestForceExtra from "./routes/manifest-force-extra";

const app = express();
app.use(express.json());

// ...any other routes
app.use("/api", manifestForceExtra);  // <-- matches the client: /api/manifest/force-extra

app.listen(process.env.PORT || 3000);
