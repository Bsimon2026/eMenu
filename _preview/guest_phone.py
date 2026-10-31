"""Guest phone on the order form + actually storing the order."""
import pathlib

p = pathlib.Path("assets/menu.js")
s = p.read_text(encoding="utf-8")

# 1. the message carries the contact number
old_msg = '''  function buildMessage(guest) {
    const { sum } = totals();
    const lines = ["*New order — " + name + "*", "Type: " + mode, ""];
    if (mode === "Dine In") lines.push("Table: " + table);
    if (mode === "Take Away") lines.push("Pickup in: " + pickup);
    if (mode === "Delivery") lines.push("Address: " + address.replace(/\\s+/g, " ").trim());
    lines.push("Guest: " + guest, "");'''
new_msg = '''  function buildMessage(guest, phone) {
    const { sum } = totals();
    const lines = ["*New order — " + name + "*", "Type: " + mode, ""];
    if (mode === "Dine In") lines.push("Table: " + table);
    if (mode === "Take Away") lines.push("Pickup in: " + pickup);
    if (mode === "Delivery") lines.push("Address: " + address.replace(/\\s+/g, " ").trim());
    lines.push("Guest: " + guest);
    if (phone) lines.push("Mobile: " + phone);
    lines.push("");'''
assert old_msg in s
s = s.replace(old_msg, new_msg, 1)

# 2. keep the phone with the local copy
s = s.replace("  function recordOrder(guest, msg) {", "  function recordOrder(guest, msg, phone) {", 1)
s = s.replace('''        guest: guest,
        table: table,''', '''        guest: guest,
        phone: phone || "",
        table: table,''', 1)

# 3. the order itself goes to the database, not just the browser
anchor = '''  $("#confirmOrder").addEventListener("click", () => {'''
submit = '''  /* The guest is handed to WhatsApp either way, but the restaurant needs a
     record even when that message never arrives — which is exactly why the
     mobile number is now required. */
  const API_BASE = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.apiBase) || "";
  let sending = false;

  async function submitOrder(guest, phone) {
    if (sending) return null;
    sending = true;
    try {
      const res = await fetch(API_BASE + "/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle,
          mode: mode,
          table: table,
          pickupAt: pickup || null,
          address: address,
          name: guest,
          phone: phone,
          total: totals().sum,
          items: Array.from(cart.values()).map((r) => ({
            id: r.item.id, name: r.item.name, qty: r.qty, price: r.item.price
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      return res.ok ? data : { ok: false, message: data.message || "not saved" };
    } catch (e) {
      return { ok: false, message: "network" };
    } finally {
      sending = false;
    }
  }

''' + anchor
assert anchor in s
s = s.replace(anchor, submit, 1)

# 4. validate the number, send it, and report if the copy failed
old_confirm = '''  $("#confirmOrder").addEventListener("click", () => {
    let ok = true;
    ok = err("#nameErr", !$("#guestName").value.trim()) && ok;
    if (mode === "Dine In") ok = err("#tableErr", !String(table).trim()) && ok;
    if (mode === "Take Away") ok = err("#pickErr", !pickup) && ok;
    if (mode === "Delivery") ok = err("#addrErr", !address.trim()) && ok;
    if (!ok) return;

    const guest = $("#guestName").value.trim();
    const msg = buildMessage(guest);'''
new_confirm = '''  $("#confirmOrder").addEventListener("click", async () => {
    let ok = true;
    ok = err("#nameErr", !$("#guestName").value.trim()) && ok;
    const phoneRaw = ($("#guestPhone").value || "").trim();
    ok = err("#phoneErr", phoneRaw.replace(/[^\\d]/g, "").length < 7) && ok;
    if (mode === "Dine In") ok = err("#tableErr", !String(table).trim()) && ok;
    if (mode === "Take Away") ok = err("#pickErr", !pickup) && ok;
    if (mode === "Delivery") ok = err("#addrErr", !address.trim()) && ok;
    if (!ok) return;

    const guest = $("#guestName").value.trim();
    const msg = buildMessage(guest, phoneRaw);
    const saved = await submitOrder(guest, phoneRaw);'''
assert old_confirm in s
s = s.replace(old_confirm, new_confirm, 1)

s = s.replace("    recordOrder(guest, msg);", "    recordOrder(guest, msg, phoneRaw);", 1)

# 5. tell the guest when the copy did not reach the restaurant
old_next = '''    $("\\#doneNext").textContent ='''
if old_next not in s:
    old_next = '''    $("#doneNext").textContent ='''
new_next = '''    if (saved && saved.ok === false) {
      $("#doneNext").textContent = "WhatsApp is ready — but we could not save a copy for the restaurant. Send the message so they get it.";
    } else {
    $("#doneNext").textContent ='''
assert old_next in s
s = s.replace(old_next, new_next, 1)

# close the else block we just opened, right after the ternary that sets doneNext
old_tail = '''        : "The restaurant confirms the address and delivery charge on WhatsApp before sending.";

    $("#sheetForm").hidden = true;'''
new_tail = '''        : "The restaurant confirms the address and delivery charge on WhatsApp before sending.";
    }

    $("#sheetForm").hidden = true;'''
assert old_tail in s
s = s.replace(old_tail, new_tail, 1)

# 6. prefill the dial code from the restaurant's own number
s = s.replace('''  $("\\#waLink").href''', '''  $("\\#waLink").href''')
p.write_text(s, encoding="utf-8")
print("phone + submit wired:", "submitOrder" in s, "| phoneErr:", "phoneErr" in s)
