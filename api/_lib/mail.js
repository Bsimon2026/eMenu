/**
 * Minimal SMTP sender — no dependencies.
 *
 * Hostinger's mail server takes plain SMTP over implicit TLS on 465, so the whole
 * protocol is: greeting, EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Writing
 * those nine lines of conversation costs less than shipping nodemailer into a
 * serverless function, and there is nothing to keep updated.
 *
 * Deliberately not a general mail library: one message, one recipient list, UTF-8
 * body sent as base64 so no line can begin with a dot and needs stuffing.
 */

const tls = require("tls");

const HOST = process.env.SMTP_HOST || "smtp.hostinger.com";
const PORT = Number(process.env.SMTP_PORT) || 465;
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.MAIL_FROM || USER;

const ready = Boolean(USER && PASS && FROM);

function b64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

/** Base64 in 76-character lines, which is what the spec asks for. */
function body64(text) {
  return (Buffer.from(String(text), "utf8").toString("base64").match(/.{1,76}/g) || []).join("\r\n");
}

function headers(o) {
  const list = [
    "From: " + (o.fromName ? o.fromName + " <" + FROM + ">" : FROM),
    "To: " + [].concat(o.to).join(", "),
    "Subject: " + String(o.subject || "").replace(/[\r\n]+/g, " "),
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + Date.now() + "." + Math.random().toString(36).slice(2) + "@" + FROM.split("@")[1] + ">",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64"
  ];
  if (o.cc && [].concat(o.cc).length) list.splice(2, 0, "Cc: " + [].concat(o.cc).join(", "));
  if (o.replyTo) list.push("Reply-To: " + o.replyTo);
  return list.join("\r\n");
}

/**
 * Send one plain-text message. Resolves { ok, code, detail } and never throws —
 * a failed courtesy email must not turn a stored order into an error page.
 */
function sendMail(o, timeoutMs) {
  if (!ready) return Promise.resolve({ ok: false, code: "NOT_CONFIGURED", detail: "SMTP_USER / SMTP_PASS unset" });

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { socket.destroy(); } catch (e) {} resolve(r); } };

    let buffer = "";
    let step = 0;
    const steps = [
      "EHLO digimenu",
      "AUTH LOGIN",
      b64(USER),
      b64(PASS),
      "MAIL FROM:<" + FROM + ">",
      ...[[].concat(o.to)][0].map((r) => "RCPT TO:<" + r + ">"),
      ...((o.cc && [].concat(o.cc).length) ? [].concat(o.cc).map((r) => "RCPT TO:<" + r + ">") : []),
      "DATA"
    ];

    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {});
    socket.setTimeout(timeoutMs || 9000);
    socket.on("timeout", () => done({ ok: false, code: "TIMEOUT", detail: "no answer from " + HOST }));
    socket.on("error", (e) => done({ ok: false, code: "SOCKET", detail: e.message }));

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      /* a reply is complete when its last line starts with three digits and a space */
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (!/^\d{3} /.test(last)) return;
      buffer = "";
      const code = Number(last.slice(0, 3));

      if (step === 0) {                       /* 220 greeting */
        if (code !== 220) return done({ ok: false, code: "GREETING", detail: last });
        socket.write(steps[step++] + "\r\n");
        return;
      }
      if (code === 235 && step >= 4) {         /* authenticated */
        socket.write(steps[step++] + "\r\n");
        return;
      }
      if (code === 334) {                      /* AUTH LOGIN challenge */
        socket.write(steps[step++] + "\r\n");
        return;
      }
      if (code === 354) {                      /* ready for the body */
        const message = headers(o) + "\r\n\r\n" + body64(o.text || "") + "\r\n.";
        socket.write(message + "\r\n");
        return;
      }
      if (code === 250) {
        if (step < steps.length) {             /* EHLO / MAIL / RCPT accepted */
          socket.write(steps[step++] + "\r\n");
          return;
        }
        socket.write("QUIT\r\n");
        return done({ ok: true, code: 250, detail: "sent" });
      }
      if (code === 221) return done({ ok: true, code: 221, detail: "sent" });
      return done({ ok: false, code: String(code), detail: last });
    });
  });
}

module.exports = { sendMail, ready, from: FROM };
