/** Print the diagnostic text of the newest bounce in the mailbox. */
const tls = require("tls");
const fs = require("fs");

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2];
}
const USER = (process.env.SMTP_USER || "").trim();
const PASS = (process.env.SMTP_PASS || "").trim();
const NEEDLE = process.argv[2] || "Undelivered";

let phase = 0, buf = "";
const sock = tls.connect({ host: "imap.hostinger.com", port: 993, servername: "imap.hostinger.com" }, () => {});
sock.setTimeout(25000);
sock.on("timeout", () => { console.log("timeout"); process.exit(1); });
sock.on("error", (e) => { console.log("err", e.message); process.exit(1); });
const send = (s) => sock.write(s + "\r\n");

sock.on("data", (c) => {
  buf += c.toString("utf8");
  if (phase === 0) {
    if (/\* OK/.test(buf)) { buf = ""; send('a1 LOGIN "' + USER + '" "' + PASS + '"'); phase = 1; }
    return;
  }
  if (!buf.split("\r\n").some((l) => l.startsWith("a" + phase + " "))) return;
  const chunk = buf; buf = "";

  if (phase === 1) { send("a2 SELECT INBOX"); phase = 2; return; }
  if (phase === 2) { send('a3 SEARCH SUBJECT "' + NEEDLE + '"'); phase = 3; return; }
  if (phase === 3) {
    const m = /\* SEARCH ([0-9 ]*)/.exec(chunk);
    const ids = (m && m[1].trim()) ? m[1].trim().split(/\s+/) : [];
    if (!ids.length) { console.log("no bounce found"); process.exit(0); }
    send("a4 FETCH " + ids[ids.length - 1] + " BODY.PEEK[]");
    phase = 4;
    return;
  }
  if (phase === 4) {
    const lit = /\{(\d+)\}\r?\n/.exec(chunk);
    let raw = chunk;
    if (lit) {
      const size = Number(lit[1]);
      const start = lit.index + lit[0].length;
      raw = chunk.slice(start, start + size);
    }
    /* the useful lines are the SMTP diagnostics */
    const lines = raw.split(/\r?\n/);
    const hits = lines.filter((l) =>
      /^(Diagnostic-Code|Status|Action|Remote-MTA|Reporting-MTA|Final-Recipient):/i.test(l) ||
      /(550|551|552|553|554|450|451|452|421)\b/.test(l) ||
      /does not exist|not exist|rejected|spam|blocked|policy|relay|user unknown/i.test(l)
    );
    console.log("--- headers ---");
    lines.filter((l) => /^(From|To|Subject|Date):/i.test(l)).slice(0, 5).forEach((l) => console.log(l.slice(0, 120)));
    console.log("--- why ---");
    const uniq = [...new Set(hits.map((l) => l.replace(/\s+/g, " ").trim()))].slice(0, 14);
    uniq.forEach((l) => console.log(l.slice(0, 240)));
    send("a5 LOGOUT"); phase = 5;
    setTimeout(() => process.exit(0), 300);
  }
});
