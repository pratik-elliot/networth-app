require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const { uploadDir } = require("./paths");
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const transactionRoutes = require("./routes/transactions");
const balanceRoutes = require("./routes/balances");
const imageRoutes = require("./routes/images");
const exportRoutes = require("./routes/exportData");

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadDir));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/balances", balanceRoutes);
app.use("/api/images", imageRoutes);
app.use("/api/export", exportRoutes);

// In production the client is built into client/dist and served by this
// same service, so the app runs as a single Render Web Service.
const clientDistPath = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get(/^\/(?!api|uploads).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Net Worth Ledger API listening on port ${PORT}`));
