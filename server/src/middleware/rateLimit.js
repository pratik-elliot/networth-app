const rateLimit = require("express-rate-limit");

// NOTE: these limits are keyed on the client IP, which only resolves correctly
// because index.js sets "trust proxy". Render terminates TLS at a proxy, so
// without that setting every request would appear to come from the proxy's own
// address and a single abusive client would lock out everyone.

// Sign-in and registration are the brute-force targets. With the emailed
// one-time code disabled, the password is the only credential, so this is the
// main thing standing between an attacker and an account.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Only failed attempts count, so normal repeated logins are never punished.
  skipSuccessfulRequests: true,
  message: { error: "Too many sign-in attempts from this network. Please wait 15 minutes and try again." },
});

// A broad ceiling for the rest of the API to blunt scraping and runaway
// clients. Set high enough that ordinary use never reaches it.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

// Each parse spends one of a limited number of daily upstream requests, so this
// is far tighter than the general API ceiling.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many statement imports. Please wait an hour and try again." },
});

module.exports = { authLimiter, apiLimiter, importLimiter };
