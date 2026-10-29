/* POST /api/import  { url }
 *
 * One entry point for "bring my menu in from a link". Each platform gets its
 * own adapter because each behaves differently against a server fetch:
 *
 *   talabat   - 200, full menu inside __NEXT_DATA__        -> works today
 *   deliveroo - 403 Cloudflare challenge                    -> needs a browser
 *   noon      - unverified                                  -> probe, then fall back
 *
 * The response always says what happened and what the caller should do next,
 * so the UI never has to guess: { ok, code, fallback, ... }.
 */
const { importTalabat, isTalabatUrl } = require("./_lib/talabat");

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

function readUrl(req) {
  if (req.query && req.query.url) return String(req.query.url);
  if (req.body && typeof req.body === "object" && req.body.url) return String(req.body.url);
  if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed && parsed.url) return String(parsed.url);
    } catch (e) {
      /* not JSON */
    }
  }
  return "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const url = readUrl(req).trim();
  if (!url) {
    res.status(400).json({ ok: false, code: "NO_URL", message: "Send { url }." });
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    res.status(400).json({ ok: false, code: "BAD_URL", message: "That is not a valid link." });
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    res.status(400).json({ ok: false, code: "BAD_URL", message: "Only http and https links." });
    return;
  }

  const host = hostOf(url);

  /* --- Talabat: real import --------------------------------------------- */
  if (isTalabatUrl(url)) {
    const result = await importTalabat(url, { timeout: 15000 });
    if (result.ok) {
      // images are shown for review but flagged: they are Talabat's to serve
      result.imagesNotice =
        "Dish images are linked from Talabat's CDN for review. Ask the restaurant for their own photos before publishing.";
      res.status(200).json(result);
      return;
    }
    res.status(422).json({
      ...result,
      fallback: "photo",
      fallbackMessage:
        "We could not read that page. Upload a photo or PDF of the menu instead, or check the link opens in a browser."
    });
    return;
  }

  /* --- Deliveroo: blocked by a bot challenge ---------------------------- */
  if (/(^|\.)deliveroo\./.test(host)) {
    res.status(501).json({
      ok: false,
      code: "PROTECTED",
      source: "deliveroo",
      message:
        "Deliveroo answers automated requests with a Cloudflare challenge, so a server fetch cannot read the menu.",
      fallback: "photo",
      fallbackMessage: "Ask the restaurant to upload a photo or PDF of their menu."
    });
    return;
  }

  /* --- noon: not yet verified ------------------------------------------- */
  if (/(^|\.)noon\.com$/.test(host)) {
    res.status(501).json({
      ok: false,
      code: "NOT_IMPLEMENTED",
      source: "noon",
      message: "noon Food import is not implemented yet — I have not verified that their menu payload is reachable.",
      fallback: "photo",
      fallbackMessage: "Ask the restaurant to upload a photo or PDF of their menu."
    });
    return;
  }

  /* --- anything else: try the same trick, then bail --------------------- */
  res.status(501).json({
    ok: false,
    code: "UNSUPPORTED_SOURCE",
    source: host,
    message: "We only import Talabat automatically today.",
    fallback: "photo",
    fallbackMessage: "Ask the restaurant to upload a photo or PDF of their menu."
  });
};
