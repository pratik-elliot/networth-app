const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "inclusionai/ling-3.0-flash:free";
const REQUEST_TIMEOUT_MS = 120000;
// Keeps a very long statement inside the model's context window.
const MAX_TEXT_CHARS = 120000;

const SYSTEM_PROMPT = [
  "You extract bank transactions from statement text.",
  'Return ONLY a JSON object of the form {"transactions":[{"date":"...","description":"...","type":"credit|debit","amount":"..."}],"closingBalance":{"date":"...","amount":"..."}}.',
  "Copy dates and amounts EXACTLY as they appear in the statement; never reformat, convert or recalculate them.",
  "Use 'credit' for money coming in and 'debit' for money going out.",
  "Ignore opening and closing balance lines, running balance columns, page headers and footers, and summary totals when building the transactions array.",
  "Separately, if the statement states a closing or ending balance, report it as closingBalance with the date it applies to. If there is no clear closing balance, set closingBalance to null.",
  "Ignore page markers of the form '-- 1 of 3 --'.",
  "If there are no transactions, return an empty array.",
].join(" ");

function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

function describeFailure(status, bodyText) {
  if (status === 401 || status === 403) {
    return "OpenRouter rejected the API key. Check that OPENROUTER_API_KEY is set correctly.";
  }
  if (status === 429) {
    return "Too many requests to OpenRouter. The free tier allows a limited number per day — please try again later.";
  }
  if (/data polic|no endpoints|no allowed providers/i.test(bodyText || "")) {
    return (
      "No zero-data-retention provider is available for this model, so your statement was NOT sent. " +
      "Set OPENROUTER_MODEL to a model that has a ZDR provider."
    );
  }
  // Surface whatever the provider actually said. A bare status code sends the
  // reader hunting through logs for a diagnostic that was in the response all
  // along — e.g. "does not support feature: structured-outputs".
  const detail = upstreamMessage(bodyText);
  return detail ? `OpenRouter returned ${status}: ${detail}` : `OpenRouter returned ${status}.`;
}

/* OpenRouter nests the provider's own message inside error.metadata.raw, which
   is itself a JSON string. Dig it out, falling back to the outer message. */
function upstreamMessage(bodyText) {
  if (!bodyText) return "";
  try {
    const body = JSON.parse(bodyText);
    const err = body && body.error;
    if (!err) return "";
    const raw = err.metadata && err.metadata.raw;
    if (typeof raw === "string") {
      try {
        const inner = JSON.parse(raw);
        if (inner && inner.message) return String(inner.message);
      } catch (e) {
        return raw.slice(0, 300);
      }
    }
    return err.message ? String(err.message) : "";
  } catch (e) {
    return String(bodyText).slice(0, 300);
  }
}

/* Some models wrap JSON in a markdown code fence despite being asked not to. */
function parseModelJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function extractTransactions(text, opts = {}) {
  if (!isConfigured()) {
    throw new Error("Statement import is not configured. Set OPENROUTER_API_KEY to enable it.");
  }

  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
        // Never send statement contents to a provider that may retain or train
        // on them. Both keys are schema-validated by OpenRouter, and the
        // request fails rather than silently downgrading if no ZDR endpoint
        // exists — failing closed is the intended behaviour here.
        provider: { zdr: true, data_collection: "deny" },
        // Deliberately NOT sending response_format. The default model
        // (ling-3.0-flash) rejects it outright with "does not support feature:
        // structured-outputs", and requiring it would silently rule out every
        // other model that lacks the feature. The system prompt asks for JSON
        // and parseModelJson tolerates a code-fenced reply, which covers it.
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: String(text || "").slice(0, MAX_TEXT_CHARS) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Reading the statement timed out. Try a shorter statement.");
    }
    throw new Error(`Could not reach OpenRouter: ${(err && err.message) || "unknown error"}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(describeFailure(res.status, bodyText));
  }

  const payload = await res.json();
  const content =
    payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : "";

  let parsed;
  try {
    parsed = parseModelJson(content);
  } catch (err) {
    throw new Error("Could not read this statement — the extraction service returned an unexpected response.");
  }

  const transactions = Array.isArray(parsed && parsed.transactions) ? parsed.transactions : [];
  const cb = parsed && parsed.closingBalance;
  // Kept raw here; normalising happens in the route alongside the transactions
  // so both go through the same date/amount parsing.
  const closingBalance = cb && (cb.date || cb.amount) ? cb : null;
  return { transactions, closingBalance };
}

module.exports = { extractTransactions, isConfigured };
