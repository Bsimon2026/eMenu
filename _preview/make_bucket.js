const fs = require("fs");
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SECRET_KEY;

(async () => {
  const h = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json" };

  const list = await (await fetch(U + "/storage/v1/bucket", { headers: h })).json();
  console.log("existing buckets:", Array.isArray(list) ? list.map((b) => b.name || b.id) : list);

  const has = Array.isArray(list) && list.some((b) => (b.name || b.id) === "menu-media");
  if (!has) {
    const r = await fetch(U + "/storage/v1/bucket", {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        id: "menu-media",
        name: "menu-media",
        public: true,
        file_size_limit: 3145728,
        allowed_mime_types: ["image/png", "image/jpeg", "image/webp"]
      })
    });
    console.log("create bucket:", r.status, (await r.text()).slice(0, 200));
  }

  const after = await (await fetch(U + "/storage/v1/bucket", { headers: h })).json();
  console.log("buckets now:", after.map((b) => b.name + " public=" + b.public + " limit=" + b.file_size_limit));
})();
