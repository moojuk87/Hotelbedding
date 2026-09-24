# Hotel Bedding Web App

A simple ordering page for the Hotel Bedding all-in-one bedding set, meant to
be linked from short-term rental platforms (홈스인코리아, 리브애니웨어,
삼삼엠투, etc.) so guests can order bedding before check-in.

```
hotel-bedding-webapp/
├── index.html          <- the storefront (deploy this with GitHub Pages)
├── images/              <- product photos used by index.html
├── backend/             <- tiny order-create / order-capture server (deploy on Render)
│   ├── server.js
│   ├── package.json
│   └── .env.example
└── README.md
```

## How it works

- **`index.html`** is a static page. It shows the product, lets the guest
  pick a color/quantities, and renders the PayPal buttons. It only ever
  holds your **PayPal Client ID**, which is safe to be public.
- **`backend/`** is a tiny Node server with two routes: create an order,
  and capture (finalize) an order. It holds your **PayPal Secret**, which
  must never appear in the frontend or in GitHub. It also recomputes the
  price server-side, so nobody can tamper with the amount from the browser.

## 1. Deploy the backend on Render

1. Push this whole folder to a new GitHub repository (see step 3 below —
   you can do steps 1 and 3 in either order, but the backend needs to be
   live before the frontend's `API_BASE_URL` will work).
2. Go to [render.com](https://render.com) → **New +** → **Web Service** →
   connect your GitHub repo.
3. When asked for the root directory, enter `backend`.
4. Build command: `npm install`
   Start command: `npm start`
5. Under **Environment**, add these variables (see `backend/.env.example`):
   - `PAYPAL_CLIENT_ID` — your Sandbox Client ID (from the developer you
     asked to generate it)
   - `PAYPAL_CLIENT_SECRET` — your Sandbox Secret (**never share this with
     Claude or anyone else** — paste it directly into this Render field)
   - `PAYPAL_ENV` — `sandbox` for now
   - `ALLOWED_ORIGIN` — your future GitHub Pages URL, e.g.
     `https://your-username.github.io`
6. Deploy. Once it's live, Render gives you a URL like
   `https://hotel-bedding-backend.onrender.com`. Copy it.
7. Check it works by opening `https://<your-render-url>/api/health` in a
   browser — it should show `{"ok":true,"env":"sandbox"}`.

## 2. Wire the frontend to the backend + PayPal

Open `index.html` and edit these two lines near the top of the `<script>`
block:

```js
var PAYPAL_CLIENT_ID = "YOUR_SANDBOX_CLIENT_ID"; // <- paste your Sandbox Client ID
var API_BASE_URL = "https://YOUR-BACKEND.onrender.com"; // <- paste your Render URL (no trailing slash)
```

Also change the admin PIN before going live:

```js
var ADMIN_PIN = "1234"; // <- change this
```

## 3. Push to GitHub and deploy the frontend with GitHub Pages

```bash
cd hotel-bedding-webapp
git init
git add .
git commit -m "Hotel Bedding web app"
git branch -M main
git remote add origin https://github.com/<your-username>/hotel-bedding-webapp.git
git push -u origin main
```

Then on GitHub:

1. Go to your repo → **Settings** → **Pages**.
2. Under **Source**, choose **Deploy from a branch**, branch `main`,
   folder `/ (root)`.
3. Save. After a minute or two your site is live at
   `https://<your-username>.github.io/hotel-bedding-webapp/`.

That URL is what you'll embed as a link on 홈스인코리아, 리브애니웨어,
삼삼엠투, etc.

## 4. Test a full sandbox payment

1. Go to [developer.paypal.com](https://developer.paypal.com) → **Sandbox**
   → **Accounts**. PayPal auto-creates a test buyer account here (fake
   email + fake balance).
2. Open your deployed page (or `index.html` locally), add items, fill in
   the delivery form, and click the PayPal button.
3. In the PayPal sandbox popup, log in with the test buyer account.
4. Approve the payment. You should see "Payment complete" on the page,
   and the order should appear under **Sandbox** → that buyer's activity
   on the PayPal developer dashboard.

## 5. Going live later

1. In PayPal's developer dashboard, switch to the **Live** tab and create
   a Live app to get a **Live Client ID** and **Live Secret**.
2. On Render, update `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and set
   `PAYPAL_ENV=live`.
3. In `index.html`, replace `PAYPAL_CLIENT_ID` with the Live Client ID.
4. Commit and push — GitHub Pages redeploys automatically.

## Known limitation to fix before launch

Delivery details are currently only attached as a short text note on the
PayPal order (visible in the PayPal dashboard). There's no database yet,
so nothing is saved anywhere else. Before real launch, the `TODO` in
`backend/server.js`'s capture route should be wired up to save each paid
order (name, address, check-in date, color, items) somewhere durable —
a spreadsheet, email, or small database — so 도훈님 knows what to ship.
