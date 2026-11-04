"""Take the mailbox password from the clipboard, prove it sends mail, and store it
as Vercel production env vars without ever printing the value."""
import json, os, pathlib, subprocess, sys

NODE = r"C:\Program Files\nodejs\node.exe"
VERCEL = r'"C:\Users\Biju Simon\AppData\Roaming\npm\vercel.cmd"'   # .cmd shim needs a shell

clip = subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
                      capture_output=True, text=True, timeout=30).stdout
pw = clip.strip()
if not pw or len(pw) < 6 or "\n" in pw:
    sys.exit("clipboard does not look like a password (len %d, lines %d)" % (len(pw), pw.count(chr(10))))
print("password read: %d characters" % len(pw))

env = {**os.environ, "SMTP_USER": "connect@indubaicity.com", "SMTP_PASS": pw,
       "MAIL_FROM": "connect@indubaicity.com", "SMTP_HOST": "smtp.hostinger.com", "SMTP_PORT": "465"}

# 1. does it actually authenticate and send?
test = subprocess.run([NODE, "-e", """
const mail = require('./api/_lib/mail');
mail.sendMail({ to:['connect@indubaicity.com'], subject:'DigiMenu is connected',
  fromName:'DigiMenu', text:'If you are reading this, order notifications can be sent from this mailbox.\\n\\nNo action needed.' }, 15000)
  .then(r => { console.log(JSON.stringify(r)); });
"""], cwd=r"D:\eMenuBuilder", env=env, capture_output=True, text=True, timeout=90)
print("send test:", (test.stdout or test.stderr).strip()[:200])

sent = '"ok":true' in (test.stdout or "")
if not sent:
    sys.exit("authentication or delivery failed — not storing a credential that does not work")

# 2. keep it for local runs too (.env is gitignored)
envfile = pathlib.Path(r"D:\eMenuBuilder\.env")
lines = [l for l in envfile.read_text(encoding="utf-8").splitlines()
         if not l.startswith(("SMTP_", "MAIL_FROM", "NOTIFY_EMAIL"))]
lines += ["SMTP_HOST=smtp.hostinger.com", "SMTP_PORT=465",
          "SMTP_USER=connect@indubaicity.com", "SMTP_PASS=" + pw,
          "MAIL_FROM=connect@indubaicity.com", "NOTIFY_EMAIL=connect@indubaicity.com"]
envfile.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("added to local .env (gitignored)")

# 3. Vercel production env vars
for name, value in [("SMTP_HOST", "smtp.hostinger.com"), ("SMTP_PORT", "465"),
                    ("SMTP_USER", "connect@indubaicity.com"), ("SMTP_PASS", pw),
                    ("MAIL_FROM", "connect@indubaicity.com"),
                    ("NOTIFY_EMAIL", "connect@indubaicity.com")]:
    r = subprocess.run(VERCEL + " env add " + name + " production", shell=True, input=value, text=True,
                       capture_output=True, timeout=180, cwd=r"D:\eMenuBuilder")
    ok = r.returncode == 0
    msg = ((r.stdout or "") + (r.stderr or "")).strip().replace(pw, "<hidden>")
    print(("  set %-14s" % name), "ok" if ok else ("FAILED " + msg[:110]))
