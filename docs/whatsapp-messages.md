# WhatsApp messages, word for word

The six messages a guest receives, in the order they arrive. Five are sent by
`api/marketing.js` and `api/_lib/wa-inbox.js` as free-form text; one is the
`order_confirm` template, whose body lives in **WhatsApp Manager → Message
templates**, not in this repo. Changing a template's wording means editing it
there and waiting for Meta to approve it again — the code only passes the four
parameters.

`{name}` is the guest's first name. A guest who left the name blank gets the
`Hello,` opening instead of `Dear ,` — never a dangling comma. `{restaurant}` is
the restaurant's display name; `{order}` is the item lines (`1 x Half Grilled
Chicken`), and `{total}` is the currency and amount to two decimals.

## 1. The guest messages the number — automatic

Sent by `thankYou()` in `api/_lib/wa-inbox.js` the moment a guest writes to the
restaurant's WhatsApp, before anyone has read it.

> Dear {name}, thank you for choosing us. We have received your order and our
> team is reviewing it now. We will confirm it here in just a moment.

No name on record:

> Hello, thank you for choosing us. We have received your order and our team is
> reviewing it now. We will confirm it here in just a moment.

## 2. Send Order pressed — template `order_confirm`

Body as approved in WhatsApp Manager (paste it there; the code sends the four
variables in this order):

> Dear {{1}}, thank you for your order at {{2}}. Your order is {{3}}, with a
> total of {{4}}. Please tap CONFIRM below so we can proceed and keep you
> updated here.

| Variable | Value |
|---|---|
| `{{1}}` | guest first name, `guest` when the name is blank |
| `{{2}}` | restaurant name |
| `{{3}}` | item lines, newline separated |
| `{{4}}` | total with currency, two decimals — `AED 49.60` |

Quick-reply button: **CONFIRM**. The template is the only way to reach a guest
whose 24-hour window has closed; `Send Order` unlocks two minutes after the
order is placed.

## 3. Accept Order

> Dear {name}, your order has been confirmed and is now being prepared by our
> kitchen team. We will keep you updated at every step. Thank you for your
> patience.

## 4. Ready for Pickup — take away

> Dear {name}, your order is ready for collection. Please visit the counter at
> {restaurant} at your convenience. Thank you for choosing us, and we look
> forward to seeing you.

## 5. Sent for Delivery

> Dear {name}, your order has left our kitchen and is on its way to you. Our
> delivery partner will reach you shortly. Thank you for your patience.

## 6. Enjoy your Meal — dine in

> Dear {name}, we hope you enjoy your meal. Should there be anything we can
> improve or assist you with, please reply here and we will be glad to help.

## Reproving the template after an edit

1. WhatsApp Manager → Account tools → Message templates → `order_confirm`.
2. Replace the body with the text above, keep the four variables in order and
   the CONFIRM quick reply, note the language code (usually `en`).
3. Submit. Approval is usually minutes but can take up to 24 hours; the old
   version keeps sending until the new one is approved.
4. `{{4}}` must stay the last variable — moving it renumbers the call in
   `api/marketing.js` (`sendTemplate(s, to, "order_confirm", [first, place, lines, total])`).
