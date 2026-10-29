/* Run the Talabat importer from the command line, against a real page.
 *   node tools/try-import.js "https://www.talabat.com/uae/restaurant/..."
 */
const { importTalabat } = require("../api/_lib/talabat");

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node tools/try-import.js "<talabat url>"');
    process.exit(2);
  }

  const t0 = Date.now();
  const out = await importTalabat(url);
  const ms = Date.now() - t0;

  if (!out.ok) {
    console.log("FAILED", out.code, "-", out.message, `(${ms}ms)`);
    process.exit(1);
  }

  console.log(`OK  ${out.restaurant.name || "(unnamed)"} · ${out.restaurant.area || ""}`);
  console.log(`    ${ms}ms · ${out.categories.length} categories · ${out.itemCount} items · ${out.withImages} with images`);
  console.log("");

  for (const cat of out.categories.slice(0, 4)) {
    console.log(`  ${cat.name} (${cat.items.length})`);
    for (const it of cat.items.slice(0, 3)) {
      const price = it.price == null ? "—" : `AED ${it.price}`;
      console.log(`    ${it.name.padEnd(38).slice(0, 38)} ${price.padStart(9)}  ${it.image ? "img" : "no image"}`);
    }
  }
  console.log("");
  console.log("JSON sample (first item):");
  console.log(JSON.stringify(out.categories[0].items[0], null, 2));
})();
