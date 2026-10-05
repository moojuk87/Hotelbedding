/**
 * Hotel Bedding — minimal PayPal order backend
 *
 * Two endpoints:
 *   POST /api/orders                  -> validate the cart + delivery details and create a PayPal order
 *   POST /api/orders/:orderID/capture -> capture (finalize) the approved order, then record it
 *                                        in the Google Sheet (via the Apps Script web app)
 *
 * Prices are looked up SERVER-SIDE from PRICES below, never trusted from the
 * client. If you change a price in the frontend's admin panel, update PRICES
 * here too so the two stay in sync.
 *
 * Environment variables (set these on Render, never commit them):
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_ENV             "sandbox" or "live" (defaults to "sandbox")
 *   ALLOWED_ORIGIN         e.g. https://moojuk87.github.io
 *   SHEET_WEBHOOK_URL      Apps Script web app URL (ends with /exec)
 *   SHEET_WEBHOOK_TOKEN    same secret token as the Apps Script property
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "20kb" }));

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

const COLORS = ["Blue", "Gray"];
const MAX_QTY_PER_ITEM = 99;

/* ---------- small helpers ---------- */

function cleanText(value, maxLen) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

function qtyOf(items, id) {
  let total = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.id === id) {
      total += Math.max(0, Math.floor(Number(item.quantity) || 0));
    }
  }
  return Math.min(total, MAX_QTY_PER_ITEM);
}

// Builds quantities, the PayPal line items and the total from the server-side price table.
function buildCart(items, color) {
  const qtySet = qtyOf(items, "bedding_set");
  const qtyBody = qtyOf(items, "body_towel");
  const qtyFace = qtyOf(items, "face_towel");

  const lineItems = [];
  let total = 0;

  function add(id, name, quantity) {
    if (quantity <= 0) return;
    total += PRICES[id] * quantity;
    lineItems.push({
      name,
      unit_amount: { currency_code: "USD", value: PRICES[id].toFixed(2) },
      quantity: String(quantity)
    });
  }

  // The color goes into the item name so it shows up in PayPal's own records.
  add("bedding_set", `${ITEM_NAMES.bedding_set} - ${color || "?"}`, qtySet);
  add("body_towel", ITEM_NAMES.body_towel, qtyBody);
  add("face_towel", ITEM_NAMES.face_towel, qtyFace);

  return { qtySet, qtyBody, qtyFace, total, lineItems };
}

function parseDelivery(raw) {
  const d = raw || {};
  const y = Number(d.checkInYear);
  const m = Number(d.checkInMonth);
  const day = Number(d.checkInDay);

  let checkIn = "";
  if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(day) && y >= 2000 && y <= 2100) {
    const dt = new Date(Date.UTC(y, m - 1, day));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day) {
      checkIn = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return {
    name: cleanText(d.name, 100),
    contact: cleanText(d.contact, 150),
    address: cleanText(d.address, 400),
    color: COLORS.includes(d.color) ? d.color : "",
    checkIn
  };
}

/* ---------- remember order details between "create" and "capture" ---------- */

const pendingOrders = new Map();
const PENDING_TTL_MS = 3 * 60 * 60 * 1000;

function rememberOrder(orderID, order) {
  pendingOrders.set(orderID, { order, at: Date.now() });
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [key, value] of pendingOrders) {
    if (value.at < cutoff) pendingOrders.delete(key);
  }
}

/* ---------- PayPal ---------- */

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

/* ---------- Google Sheet (Apps Script web app) ---------- */

async function sendToSheet(order) {
  const url = process.env.SHEET_WEBHOOK_URL;
  const token = process.env.SHEET_WEBHOOK_TOKEN;
  if (!url || !token) {
    throw new Error("SHEET_WEBHOOK_URL / SHEET_WEBHOOK_TOKEN are not set");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...order }),
    redirect: "follow",
    signal: AbortSignal.timeout(20000)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Sheet webhook returned HTTP ${res.status} but not JSON (check the URL ends with /exec and access is "Anyone")`
    );
  }
  if (!res.ok || !data.ok) {
    throw new Error(`Sheet webhook rejected the order: ${data.error || res.status}`);
  }
  return data;
}

// Tries twice (the Apps Script ignores a repeated order ID, so a retry is safe).
// If both attempts fail, the full order is written to the log so it is not lost.
async function recordOrder(order) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await sendToSheet(order);
      console.log(
        `[order] sheet recorded ${order.orderId}${data.duplicate ? " (duplicate, skipped)" : ""} mail=${data.mail || "n/a"}`
      );
      return true;
    } catch (err) {
      console.error(`[order] sheet attempt ${attempt} failed for ${order.orderId}: ${err.message}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  console.error("[order] RECOVERY - record this paid order manually: " + JSON.stringify(order));
  return false;
}

/* ---------- routes ---------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: PAYPAL_ENV,
    sheetConfigured: Boolean(process.env.SHEET_WEBHOOK_URL && process.env.SHEET_WEBHOOK_TOKEN)
  });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { items, delivery } = req.body || {};
    const d = parseDelivery(delivery);

    const problems = [];
    if (!d.name) problems.push("name");
    if (!d.contact) problems.push("contact");
    if (!d.address) problems.push("address");
    if (!d.checkIn) problems.push("check-in date");
    if (!d.color) problems.push("color");
    if (problems.length > 0) {
      return res.status(400).json({ error: "Missing or invalid: " + problems.join(", ") });
    }

    const cart = buildCart(items, d.color);
    if (cart.total <= 0 || cart.lineItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const accessToken = await getAccessToken();

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: cart.total.toFixed(2),
            breakdown: {
              item_total: { currency_code: "USD", value: cart.total.toFixed(2) }
            }
          },
          items: cart.lineItems,
          description: `Hotel Bedding order - ${d.color}`
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

    rememberOrder(ppData.id, {
      color: d.color,
      qtySet: cart.qtySet,
      qtyBody: cart.qtyBody,
      qtyFace: cart.qtyFace,
      name: d.name,
      contact: d.contact,
      address: d.address,
      checkIn: d.checkIn
    });
    console.log(`[order] created ${ppData.id} total=${cart.total.toFixed(2)} color=${d.color}`);

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
      `${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
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

    // Only a COMPLETED capture counts as a paid order.
    if (ppData.status !== "COMPLETED") {
      console.error(`[order] ${orderID} capture finished with status=${ppData.status}`);
      return res.status(502).json({ error: "Payment was not completed." });
    }

    const capture =
      ppData.purchase_units &&
      ppData.purchase_units[0] &&
      ppData.purchase_units[0].payments &&
      ppData.purchase_units[0].payments.captures &&
      ppData.purchase_units[0].payments.captures[0];
    const paidAmount = capture && capture.amount ? capture.amount.value : "";
    console.log(`[order] captured ${orderID} amount=${paidAmount}`);

    // Prefer the details saved when the order was created. If the server restarted
    // in between, fall back to what the browser sent with the capture request.
    const saved = pendingOrders.get(orderID);
    let details;
    if (saved) {
      details = saved.order;
    } else {
      const body = req.body || {};
      const d = parseDelivery(body.delivery);
      const cart = buildCart(body.items, d.color);
      details = {
        color: d.color,
        qtySet: cart.qtySet,
        qtyBody: cart.qtyBody,
        qtyFace: cart.qtyFace,
        name: d.name,
        contact: d.contact,
        address: d.address,
        checkIn: d.checkIn
      };
      console.warn(`[order] ${orderID} details were not in memory; using the browser's copy`);
    }

    const expected =
      details.qtySet * PRICES.bedding_set +
      details.qtyBody * PRICES.body_towel +
      details.qtyFace * PRICES.face_towel;
    if (paidAmount && Number(paidAmount).toFixed(2) !== expected.toFixed(2)) {
      console.warn(`[order] ${orderID} amount mismatch: paid=${paidAmount} expected=${expected.toFixed(2)}`);
    }

    const order = { orderId: orderID, amount: paidAmount, ...details };
    const recorded = await recordOrder(order);
    pendingOrders.delete(orderID);

    // The payment is already captured, so the customer sees success either way.
    res.json({ status: ppData.status, id: ppData.id, recorded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error capturing order." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hotel Bedding backend listening on port ${PORT} (${PAYPAL_ENV})`);
});
