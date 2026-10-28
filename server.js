const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { tracker } = require('./services/tracker');
const { getShopeeProduct, getSavedCookieHeader, saveCookieHeader, markCookiesDirty, closeWarmBrowser } = require('./services/shopeeApi');
const { sendTestNotification } = require('./services/discord');
const { loginOnce, COOKIES_FILE, COOKIE_HEADER_FILE } = require('./auth/login');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight healthcheck endpoint for UptimeRobot / Render keep-alive
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

function getMemoryStats() {
  let containerUsedBytes = null;
  let anonMb = null;
  let fileMb = null;

  // cgroup v2 (Render default)
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory.stat')) {
      const stat = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
      const anonMatch = stat.match(/^anon\s+(\d+)/m);
      if (anonMatch) anonMb = Math.round(parseInt(anonMatch[1], 10) / 1024 / 1024);
      const fileMatch = stat.match(/^file\s+(\d+)/m);
      if (fileMatch) fileMb = Math.round(parseInt(fileMatch[1], 10) / 1024 / 1024);
    }
    if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
      const val = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
      containerUsedBytes = parseInt(val, 10);
    }
  } catch (e) {}

  // cgroup v1 fallback
  if (containerUsedBytes === null) {
    try {
      if (fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
        const val = fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim();
        containerUsedBytes = parseInt(val, 10);
      }
    } catch (e) {}
  }

  const nodeMem = process.memoryUsage();
  const nodeRssMb = Math.round(nodeMem.rss / 1024 / 1024);
  const totalCgroupMb = containerUsedBytes && !isNaN(containerUsedBytes)
    ? Math.round(containerUsedBytes / 1024 / 1024)
    : nodeRssMb;

  // Render's OOM killer fires on active process anonymous memory under real pressure.
  // anonMb reflects actual app + Chromium process memory, while fileMb is Linux buffer cache.
  const activeProcessMb = (anonMb !== null && !isNaN(anonMb)) ? anonMb : totalCgroupMb;
  const limitMb = 512; // Render Free Tier limit
  const percent = Math.min(100, Math.max(0, Math.round((activeProcessMb / limitMb) * 100)));

  return {
    nodeRssMb,
    containerMb: activeProcessMb,
    totalCgroupMb,
    anonMb: activeProcessMb,
    fileCacheMb: fileMb || 0,
    limitMb,
    percent
  };
}

// 1. Get current tracker status, product info, logs
app.get('/api/status', (req, res) => {
  const status = tracker.getStatus();
  const hasCookies = !!getSavedCookieHeader();
  const memory = getMemoryStats();
  res.json({
    ...status,
    hasCookies,
    memory
  });
});

// 2. Start / Stop Tracker
app.post('/api/tracker/start', (req, res) => {
  tracker.start();
  res.json({ success: true, isRunning: tracker.isRunning });
});

app.post('/api/tracker/stop', (req, res) => {
  tracker.stop();
  res.json({ success: true, isRunning: tracker.isRunning });
});

// 3. Trigger manual check now
app.post('/api/tracker/check-now', async (req, res) => {
  const result = await tracker.checkNow();
  res.json(result);
});

// 4. Update configuration
app.post('/api/config', (req, res) => {
  const { targetUrl, checkIntervalSeconds, discordWebhookUrl, discordUserId, alertOnInitialStock } = req.body;
  tracker.saveConfig({
    ...(targetUrl !== undefined && { targetUrl }),
    ...(checkIntervalSeconds !== undefined && { checkIntervalSeconds: Number(checkIntervalSeconds) }),
    ...(discordWebhookUrl !== undefined && { discordWebhookUrl }),
    ...(discordUserId !== undefined && { discordUserId }),
    ...(alertOnInitialStock !== undefined && { alertOnInitialStock: Boolean(alertOnInitialStock) })
  });
  res.json({ success: true, config: tracker.config });
});

// 5. Test Discord Webhook
app.post('/api/discord/test', async (req, res) => {
  const webhookUrl = req.body.webhookUrl || tracker.config.discordWebhookUrl;
  const userId = req.body.userId || tracker.config.discordUserId;

  if (!webhookUrl) {
    return res.status(400).json({ success: false, error: 'Webhook URL is required' });
  }

  const result = await sendTestNotification(webhookUrl, userId, tracker.state.lastProduct);
  res.json(result);
});

// 6. Launch interactive Shopee login window
let isLoginRunning = false;
app.post('/api/auth/login-window', async (req, res) => {
  if (isLoginRunning) {
    return res.json({ success: false, message: 'Login window is already running!' });
  }

  isLoginRunning = true;
  res.json({ success: true, message: 'Chrome login window launched. Please scan QR or log in.' });

  // Run in background
  try {
    const success = await loginOnce({ headless: false });
    if (success) {
      markCookiesDirty();
      await closeWarmBrowser();
      tracker.resetCooldownAndCheckNow();
    }
    tracker.log(success ? '✅ Shopee login successful! Cookies refreshed.' : '❌ Shopee login was not completed.', success ? 'info' : 'warn');
  } catch (e) {
    tracker.log(`Login error: ${e.message}`, 'error');
  } finally {
    isLoginRunning = false;
  }
});

// 7. Manually save cookie string
app.post('/api/auth/save-cookies', async (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid cookie string provided' });
  }

  const count = saveCookieHeader(cookies);
  if (count === 0) {
    return res.status(400).json({
      success: false,
      error: 'Could not parse any valid cookies. Paste your Cookie header (e.g. SPC_EC=...; SPC_ST=...) or JSON cookie export.'
    });
  }

  await closeWarmBrowser();
  tracker.log(`Shopee cookies manually updated (${count} cookies loaded). Refreshing browser session...`);
  tracker.resetCooldownAndCheckNow();
  res.json({ success: true, count, message: `Cookies saved successfully (${count} cookies loaded)!` });
});

// 8. Clear cookies
app.post('/api/auth/clear-cookies', async (req, res) => {
  try {
    process.env.SHOPEE_COOKIE = '';
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    if (fs.existsSync(COOKIE_HEADER_FILE)) fs.unlinkSync(COOKIE_HEADER_FILE);
    await closeWarmBrowser();
    tracker.log('Shopee cookies cleared.');
    res.json({ success: true, message: 'Cookies cleared successfully.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start Express server and optionally auto-start tracker
app.listen(PORT, () => {
  console.log('==================================================');
  console.log(`✨ Shopee Stock Tracker Dashboard running at:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log('==================================================');

  if (tracker.config.autoStart) {
    // Short boot delay so Render marks the instance healthy before the first Chromium launch
    const bootDelayMs = Number(process.env.BOOT_DELAY_MS || 15000);
    tracker.log(`Server booted. First stock check starts in ${Math.round(bootDelayMs / 1000)}s...`);
    setTimeout(() => tracker.start(), bootDelayMs);
  }
});
