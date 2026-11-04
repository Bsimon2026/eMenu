/**
 * Read the mailbox over IMAP to prove an email actually arrived.
 * Usage: node _preview/imap_check.js "search text"
 */
const tls = require("tls");
const fs = require("fs");

/* read .env the way a dotenv loader would — sourcing it in bash breaks on
   passwords containing @, $ or spaces */
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const USER = (process.env.SMTP_USER || "").trim();
const PASS = (process.env.SMTP_PASS || "").trim().replace(/^"(.*)"$/, "$1");
const TERM = process.argv[2] || "New order";

if (!USER || !PASS) { console.error("SMTP_USER / SMTP_PASS not set"); process.exit(1); }

const sock = tls.connect({ host: process.env.IMAP_HOST || "imap.hostinger.com", port: 993, servername: process.env.IMAP_HOST || "imap.hostinger.com" }, () => {});
sock.setTimeout(20000);
sock.on("error", (e) => { console.log("IMAP error:", e.message); process.exit(1); });
sock.on("timeout", () => { console.log("IMAP timeout"); process.exit(1); });

let phase = 0, buf = "";
const results = [];
const send = (s) => sock.write(s + "\r\n");

sock.on("data", (c) => {
  buf += c.toString("utf8");

  /* the greeting is untagged: wait for "* OK", then log in */
  if (phase === 0) {
    if (/\* OK/.test(buf)) {
      buf = "";
      send('a1 LOGIN "' + USER + '" "' + PASS + '"');
      phase = 1;
    }
    return;
  }

  const lines = buf.split("\r\n");
  /* wait for a tagged completion line — phase n is waiting on tag "an" */
  const tag = "a" + phase;
  const done = lines.some((l) => l.startsWith(tag + " "));
  if (!done) return;

  const chunk = buf;
  buf = "";

  if (phase === 1 && chunk.includes("a1 OK")) {
    send("a2 SELECT INBOX");
    phase = 2;
  } else if (phase === 1) {
    results.push("login failed: " + chunk.trim().split("\r\n").slice(-1)[0].slice(0, 90));
    console.log(results.join("\n"));
    sock.destroy();
    process.exit(0);
  } else if (phase === 2) {
    const m = /\* (\d+) EXISTS/.exec(chunk);
    results.push("INBOX has " + (m ? m[1] : "?") + " messages");
    send('a3 SEARCH SUBJECT "' + TERM + '"');
    phase = 3;
  } else if (phase === 3) {
    const m = /\* SEARCH ([0-9 ]*)/.exec(chunk);
    const ids = (m && m[1].trim()) ? m[1].trim().split(/\s+/) : [];
    results.push("messages matching \"" + TERM + "\": " + ids.length);
    if (!ids.length) { send("a5 LOGOUT"); phase = 5; return; }
    const last = ids[ids.length - 1];
    send("a4 FETCH " + last + " BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE CC)]");
    phase = 4;
  } else if (phase === 4) {
    const head = chunk.replace(/\r/g, "").split("\n").filter((l) => /^(Subject|From|To|Cc|Date):/i.test(l.trim()));
    results.push("latest matching message:");
    head.forEach((h) => results.push("  " + h.trim().slice(0, 120)));
    send("a5 LOGOUT");
    phase = 5;
  } else if (phase === 5) {
    console.log(results.join("\n"));
    sock.destroy();
    process.exit(0);
  }
});
