# Shopee Stock Notification & Discord Alert 🛍️⚡

An automated stock tracker for Shopee Indonesia designed to monitor hard-to-get items (like **DEFECT SALE | NUDETHELABEL** at `https://id.shp.ee/M7J73Lp5`) and send instant Discord notifications whenever stock goes up by **+1 or more**.

---

## 🌟 Key Features

1. **One-Time Login & Cookie Persistence**:
   - Shopee blocks guest traffic with anti-bot verification.
   - Run `npm run login` (or click the button in the Web Dashboard). Chrome opens, you log in once (QR code or credentials), and your session cookies are saved to `data/cookies.json` and `data/cookie-header.txt`.
   - All subsequent checks query Shopee in **milliseconds** via direct API or persistent browser profile!

2. **Accurate SKU / Variation Tracking**:
   - Monitors both **Total Stock** and **Each Individual Variation** (Size, Color, Model).
   - If ANY model or total count restocks (`current_stock > previous_stock`), an alert is triggered immediately.

3. **Discord Notification with Direct Ping**:
   - Sends a rich Discord embed with product image, restocked quantity (`+X`), breakdown of which size/color restocked, current price, and a direct buy link.
   - Supports pinging a specific Discord User ID (`<@USER_ID>`) so they get an instant push notification on their phone the moment the item restocks.

4. **Modern Web Management Dashboard**:
   - Live status indicator (Active / Paused), next check countdown, and instant "Check Now" button.
   - Real-time stock display with variation inventory badges.
   - Discord webhook test button.
   - Restock event timeline history & live console logs.

---

## 🚀 Quick Start

### 1. Start the Web Dashboard
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

### 2. Log In to Shopee Once (Save Session)
Shopee requires an authenticated session to view product stock and prices.

- **Option A (Easiest)**: Click **"Open Chrome to Log In"** on the dashboard, or run:
  ```bash
  npm run login
  ```
  Scan the QR code with your Shopee phone app. Once logged in, the script automatically saves your session.
- **Option B**: If you already have your Shopee cookies, you can click "Paste Cookie String Manually" on the dashboard and paste your `Cookie` header.

---

### 3. Configure Discord Alert
1. In your Discord server, open **Channel Settings** &gt; **Integrations** &gt; **Webhooks** &gt; **New Webhook**.
2. Copy the Webhook URL and paste it into the Dashboard settings.
3. *(Optional)* To ping a specific user:
   - Enable Developer Mode in Discord (`User Settings > Advanced > Developer Mode`).
   - Right-click the user's Discord profile and select **Copy User ID**.
   - Paste the ID into the **Discord User ID to Ping** field.
4. Click **"🔔 Test Alert"** to verify that the message and embed arrive in Discord!

---

### 4. How the Restock Trigger Works
- The background daemon checks the listing every **60 seconds** (configurable down to 15s).
- On the first check, it establishes a baseline.
- On each subsequent check, if `current_stock >= previous_stock + 1`, or if any individual variation increases in stock:
  - An instant high-priority alert is sent to Discord.
  - The restock event is logged to the dashboard's Restock History timeline.

---

## 🛠️ CLI Commands

| Command | Description |
|---|---|
| `npm start` | Starts the Express server and begins background monitoring |
| `npm run login` | Launches Chrome to log into Shopee and save session cookies |
| `npm run check` | Runs an immediate stock check from the terminal |

---

## 📁 Project Structure

```
├── auth/
│   └── login.js          # Interactive Shopee login & cookie extraction
├── data/
│   ├── config.json       # User settings (webhook URL, interval, etc.)
│   ├── cookies.json      # Saved Shopee session cookies
│   └── state.json        # Last known stock state and restock event history
├── public/
│   ├── app.js            # Dashboard interactive frontend logic
│   ├── index.css         # Modern dark mode design system
│   └── index.html        # Dashboard HTML
├── services/
│   ├── discord.js        # Discord webhook formatter & sender
│   ├── shopeeApi.js      # Shopee URL resolver and dual-engine fetcher
│   └── tracker.js        # Core comparison engine & restock detector
├── server.js             # Express API backend server
└── package.json
```
