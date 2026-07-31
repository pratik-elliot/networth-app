require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const db = require("./db");
const { uploadDir } = require("./paths");
const { apiLimiter } = require("./middleware/rateLimit");
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const transactionRoutes = require("./routes/transactions");
const balanceRoutes = require("./routes/balances");
const imageRoutes = require("./routes/images");
const exportRoutes = require("./routes/exportData");

const app = express();

// Render serves this behind a proxy, so the client address arrives in
// X-Forwarded-For. Trust exactly one hop: without this req.ip is the proxy for
// every request (so one abusive client would rate-limit everybody), and
// trusting all hops would let a client spoof its IP and bypass the limits.
app.set("trust proxy", 1);

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadDir));

// Declared before the rate limiter so Render's health checks are never throttled.
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api", apiLimiter);

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

// Last line of defence: Node 20 exits on an unhandled rejection by default, so
// a single failed outbound call could otherwise take the whole service down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (service kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, shutting down so the platform can restart cleanly:", err);
  process.exit(1);
});

const PORT = process.env.PORT || 4000;

// Serving requests before the database is connected would return confusing
// errors, so connect first and fail loudly if it is unreachable.
db.connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Net Worth Ledger API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Could not connect to MongoDB:", err.message);
    process.exit(1);
  });
