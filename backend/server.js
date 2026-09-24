/**
 * Hotel Bedding — minimal PayPal order backend
 *
 * Two endpoints only:
 *   POST /api/orders                -> create a PayPal order from cart items
 *   POST /api/orders/:orderID/capture -> capture (finalize) an approved order
 *
 * Prices are looked up SERVER-SIDE from PRICES below, never trusted from
 * the client. If you change a price in the frontend's admin panel, update
 * PRICES here too so the two stay in sync.
 *
 * Required environment variables (set these on Render, never commit them):
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_ENV            "sandbox" or "live" (defaults to "sandbox")
 *   ALLOWED_ORIGIN         e.g. https://yourname.github.io
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const PAYPAL_API_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// Server-side source of truth for prices (USD). Keep in sync with the
// frontend admin panel if you use it to change displayed prices.
const PRICES = {
  bedding_set: 40,
  body_towel: 7,
  face_towel: 3
};

const ITEM_NAMES = {
  bedding_set: "Hotel Bedding Set (5PCS)",
  body_towel: "Body Towel 70x130cm",
  face_towel: "Face Towel 40x80cm"
};

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET env vars");
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

// Recompute the total from the server-side PRICES table, ignoring any
// amount the client may have sent, so nobody can alter the price by
// editing requests in the browser.
function computeAmount(items) {
  let total = 0;
  const lineItems = [];

  for (const item of items || []) {
    const unitPrice = PRICES[item.id];
    if (unitPrice === undefined) continue;
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));
    if (quantity === 0) continue;

    total += unitPrice * quantity;
    lineItems.push({
      name: ITEM_NAMES[item.id],
      unit_amount: { currency_code: "USD", value: unitPrice.toFixed(2) },
      quantity: String(quantity)
    });
  }

  return { total, lineItems };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: PAYPAL_ENV });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { items, delivery } = req.body || {};
    const { total, lineItems } = computeAmount(items);

    if (total <= 0 || lineItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const accessToken = await getAccessToken();

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: total.toFixed(2),
            breakdown: {
              item_total: { currency_code: "USD", value: total.toFixed(2) }
            }
          },
          items: lineItems,
          // Delivery details are stored as a note for now — wire this up to
          // your own order log / database / email step as needed.
          description: delivery
            ? `Ship to: ${delivery.name}, ${delivery.address} (check-in ${delivery.checkInMonth}/${delivery.checkInDay}/${delivery.checkInYear}) — color: ${delivery.color}`.slice(0, 127)
            : undefined
        }
      ]
    };

    const ppRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderPayload)
    });

    const ppData = await ppRes.json();
    if (!ppRes.ok) {
      console.error("PayPal create order error:", ppData);
      return res.status(502).json({ error: "Could not create PayPal order." });
    }

    res.json({ id: ppData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error creating order." });
  }
});

app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    const { orderID } = req.params;
    const accessToken = await getAccessToken();

    const ppRes = await fetch(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const ppData = await ppRes.json();
    if (!ppRes.ok) {
      console.error("PayPal capture error:", ppData);
      return res.status(502).json({ error: "Could not capture payment." });
    }

    // TODO: once this responds with COMPLETED, this is the place to save
    // the order + delivery details somewhere durable (a database, a sheet,
    // an email to yourself) so 도훈님 knows what to ship.
    res.json({ status: ppData.status, id: ppData.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error capturing order." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hotel Bedding backend listening on port ${PORT} (${PAYPAL_ENV})`);
});
