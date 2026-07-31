require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const db = require("./db");
const { apiLimiter } = require("./middleware/rateLimit");
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const transactionRoutes = require("./routes/transactions");
const balanceRoutes = require("./routes/balances");
const attachmentRoutes = require("./routes/attachments");
const exportRoutes = require("./routes/exportData");
const statementRoutes = require("./routes/statements");

const app = express();

// Render serves this behind a proxy, so the client address arrives in
// X-Forwarded-For. Trust exactly one hop: without this req.ip is the proxy for
// every request (so one abusive client would rate-limit everybody), and
// trusting all hops would let a client spoof its IP and bypass the limits.
app.set("trust proxy", 1);

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

// Declared before the rate limiter so Render's health checks are never throttled.
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api", apiLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/balances", balanceRoutes);
app.use("/api/attachments", attachmentRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/statements", statementRoutes);

// In production the client is built into client/dist and served by this
// same service, so the app runs as a single Render Web Service.
const clientDistPath = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get(/^\/(?!api).*/, (req, res) => {
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

let server;

// Serving requests before the database is connected would return confusing
// errors, so connect first and fail loudly if it is unreachable.
db.connect()
  .then(() => {
    server = app.listen(PORT, () => console.log(`Net Worth Ledger API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Could not connect to MongoDB:", err.message);
    process.exit(1);
  });

// Render sends SIGTERM on every deploy/restart. Without a handler, in-flight
// requests are cut mid-response and the Atlas connection pool is abandoned
// to time out on its own rather than closed. server.close() stops accepting
// new connections but lets in-flight ones finish before its callback fires;
// only then is the DB connection closed and the process exited cleanly. The
// timeout below is a safety net in case a connection never finishes (e.g. a
// stuck keep-alive) -- it forces an exit instead of hanging the deploy
// forever, and is unref()'d so it never itself keeps the process alive.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out; forcing exit.");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  const finish = () => db.close().finally(() => process.exit(0));
  if (server) server.close(finish);
  else finish();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
