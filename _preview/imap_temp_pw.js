/** Read the newest "temporary password" email and pull the password out. */
const tls = require("tls");
const fs = require("fs");

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const USER = (process.env.SMTP_USER || "").trim();
const PASS = (process.env.SMTP_PASS || "").trim();

let phase = 0, buf = "", out = [];
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
  const tag = "a" + phase;
  if (!buf.split("\r\n").some((l) => l.startsWith(tag + " "))) return;
  const chunk = buf; buf = "";

  if (phase === 1) { send("a2 SELECT INBOX"); phase = 2; return; }
  if (phase === 2) { send('a3 SEARCH SUBJECT "temporary password"'); phase = 3; return; }
  if (phase === 3) {
    const m = /\* SEARCH ([0-9 ]*)/.exec(chunk);
    const ids = (m && m[1].trim()) ? m[1].trim().split(/\s+/) : [];
    if (!ids.length) { console.log("no matching email"); process.exit(1); }
    send("a4 FETCH " + ids[ids.length - 1] + " BODY.PEEK[TEXT]");
    phase = 4;
    return;
  }
  if (phase === 4) {
    /* the body arrives as an IMAP literal: "{1234}" then exactly that many bytes */
    const lit = /\{(\d+)\}\r?\n/.exec(chunk);
    let text = "";
    if (lit) {
      const size = Number(lit[1]);
      const start = lit.index + lit[0].length;
      const raw = chunk.slice(start, start + size);
      try { text = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8"); } catch (e) { text = raw; }
    } else {
      text = chunk;
    }
    const pw = /([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})/.exec(text);
    console.log(pw ? "PASSWORD:" + pw[1] : "no password found in body");
    if (!pw) console.log("body sample:", text.slice(0, 240));
    send("a5 LOGOUT"); phase = 5;
    setTimeout(() => process.exit(0), 300);
  }
});
