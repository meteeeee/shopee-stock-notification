const fs = require('fs');
const path = require('path');
const { getShopeeProduct, resolveShopeeUrl } = require('./shopeeApi');
const { sendDiscordNotification } = require('./discord');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  targetUrl: 'https://shopee.co.id/product/580295413/26906593873',
  checkIntervalSeconds: 60,
  discordWebhookUrl: '',
  discordUserId: '', // Discord User ID for ping/mention
  autoStart: true,
  alertOnInitialStock: false // If true and initial stock > 0, alert on startup
};

class StockTracker {
  constructor() {
    this.config = this.loadConfig();
    this.state = this.loadState();
    this.timer = null;
    this.runId = 0;
    this.isRunning = false;
    this.isChecking = false;
    this.consecutiveErrors = 0;
    this.checksSinceBreather = 0;
    this.nextBreatherAt = 12 + Math.floor(Math.random() * 6);
    this.logs = [];
  }

  isValidProductRecord(prod) {
    if (!prod || typeof prod !== 'object') return false;
    if (/^Shopee Indonesia(?:\s*\||$)/i.test(prod.name || '')) return false;
    if (
      Array.isArray(prod.models) &&
      prod.models.some(m => /lompat ke konten|bahasa indonesia|^english$/i.test(m.name || ''))
    ) {
      return false;
    }
    return true;
  }

  log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, message: msg, type, time: Date.now() };
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${msg}`);
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
  }

  loadConfig() {
    let conf = { ...DEFAULT_CONFIG };
    // Defaults from environment variables if present (useful on initial cloud deployment)
    if (process.env.DISCORD_WEBHOOK_URL) conf.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (process.env.DISCORD_USER_ID) conf.discordUserId = process.env.DISCORD_USER_ID;
    if (process.env.TARGET_URL || process.env.SHOPEE_TARGET_URL) conf.targetUrl = process.env.TARGET_URL || process.env.SHOPEE_TARGET_URL;
    if (process.env.CHECK_INTERVAL_SECONDS) conf.checkIntervalSeconds = Number(process.env.CHECK_INTERVAL_SECONDS);

    // Overridden by saved config from the Web UI if customized
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        conf = { ...conf, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
      }
    } catch (e) {
      console.error('Error loading config:', e.message);
    }
    return conf;
  }

  saveConfig(newConfig) {
    const oldInterval = this.config.checkIntervalSeconds;
    this.config = { ...this.config, ...newConfig };
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    this.log('Settings updated.');

    // If interval was changed while running, reschedule cleanly without spawning a duplicate loop
    if (this.isRunning && newConfig.checkIntervalSeconds && newConfig.checkIntervalSeconds !== oldInterval) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (!this.isChecking) {
        this.runId += 1;
        this.scheduleNext(this.runId);
      }
    }
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (parsed && parsed.lastProduct && !this.isValidProductRecord(parsed.lastProduct)) {
          parsed.lastProduct = null;
        }
        return parsed;
      }
    } catch (e) {
      console.error('Error loading state:', e.message);
    }
    return {
      lastChecked: null,
      lastProduct: null,
      totalRestockEvents: 0,
      history: []
    };
  }

  saveState() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  async checkNow() {
    if (this.isChecking) {
      this.log('Check already in progress, skipping duplicate tick.', 'warn');
      return;
    }

    this.isChecking = true;
    this.log(`Checking Shopee item stock for: ${this.config.targetUrl}...`);

    try {
      const product = await getShopeeProduct(this.config.targetUrl);
      const currentStock = product.totalStock;
      const rawPrevProduct = this.state.lastProduct;
      const hasValidPrev =
        rawPrevProduct &&
        this.isValidProductRecord(rawPrevProduct) &&
        (!rawPrevProduct.itemId || !product.itemId || String(rawPrevProduct.itemId) === String(product.itemId));
      const prevProduct = hasValidPrev ? rawPrevProduct : null;

      this.log(`Product: "${product.name}" | Current Total Stock: ${currentStock} | Price: ${product.priceFormatted}`);

      // Log variation stock breakdown
      if (product.models && product.models.length > 0) {
        const modelsSummary = product.models.map(m => `${m.name}: ${m.stock}`).join(' | ');
        this.log(`Variations: [ ${modelsSummary} ]`);
      }

      if (rawPrevProduct && !hasValidPrev) {
        this.log(`Replaced stale/non-matching baseline with clean baseline (${currentStock} items in stock).`);
      } else if (prevProduct) {
        const prevStock = prevProduct.totalStock || 0;
        const totalDiff = currentStock - prevStock;

        // Check variation-level restocks
        const restockedModels = [];
        if (product.models) {
          for (const model of product.models) {
            const prevModel = (prevProduct.models || []).find(m => m.id === model.id || m.name === model.name);
            const prevModelStock = prevModel ? prevModel.stock : 0;
            const modelDiff = model.stock - prevModelStock;
            if (modelDiff > 0) {
              restockedModels.push({
                name: model.name,
                diff: modelDiff,
                newStock: model.stock
              });
            }
          }
        }

        const isRestocked = totalDiff >= 1 || restockedModels.length > 0;

        if (isRestocked) {
          const effectiveDiff = totalDiff > 0 ? totalDiff : restockedModels.reduce((acc, m) => acc + m.diff, 0);
          this.log(`🚨 RESTOCK DETECTED! Stock went up by +${effectiveDiff}! (Was: ${prevStock}, Now: ${currentStock})`, 'alert');

          // Send Discord notification
          if (this.config.discordWebhookUrl) {
            await sendDiscordNotification({
              webhookUrl: this.config.discordWebhookUrl,
              userId: this.config.discordUserId,
              productName: product.name,
              productUrl: product.url,
              imageUrl: product.imageUrl,
              totalStock: currentStock,
              previousStock: prevStock,
              diff: effectiveDiff,
              restockedModels,
              priceFormatted: product.priceFormatted
            });
          } else {
            this.log('⚠️ No Discord webhook configured. Restock event logged locally only.', 'warn');
          }

          // Add to history
          this.state.totalRestockEvents = (this.state.totalRestockEvents || 0) + 1;
          this.state.history.unshift({
            timestamp: new Date().toISOString(),
            productName: product.name,
            previousStock: prevStock,
            currentStock,
            diff: effectiveDiff,
            restockedModels
          });
          if (this.state.history.length > 50) this.state.history.pop();
        } else if (totalDiff < 0) {
          this.log(`Stock decreased: ${prevStock} -> ${currentStock} (-${Math.abs(totalDiff)} items purchased)`);
        } else {
          this.log(`Stock unchanged (${currentStock} available).`);
        }
      } else {
        // Initial run
        this.log(`Initial baseline recorded: ${currentStock} items in stock.`);
        if (this.config.alertOnInitialStock && currentStock > 0 && this.config.discordWebhookUrl) {
          this.log('Alert on initial stock is enabled. Sending notification for available stock...');
          await sendDiscordNotification({
            webhookUrl: this.config.discordWebhookUrl,
            userId: this.config.discordUserId,
            productName: product.name,
            productUrl: product.url,
            imageUrl: product.imageUrl,
            totalStock: currentStock,
            previousStock: 0,
            diff: currentStock,
            restockedModels: product.models || [],
            priceFormatted: product.priceFormatted
          });
        }
      }

      this.consecutiveErrors = 0;
      this.state.lastChecked = new Date().toISOString();
      this.state.lastProduct = product;
      this.saveState();
      return { success: true, product };
    } catch (err) {
      this.consecutiveErrors += 1;
      this.log(`Error checking stock: ${err.message}`, 'error');
      // If triggered by memory guard, immediately close any lingering Chromium instance to free memory
      if (err.isMemoryGuard) {
        try {
          const { closeWarmBrowser } = require('./shopeeApi');
          await closeWarmBrowser();
        } catch (e) {}
      }
      return { success: false, error: err.message };
    } finally {
      this.isChecking = false;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.runId += 1;
    const currentRunId = this.runId;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log(`Stock Tracker started. Base interval: ~${this.config.checkIntervalSeconds}s (humanized).`);

    // Run first check immediately, then schedule natural human wait after it finishes
    (async () => {
      await this.checkNow();
      if (this.isRunning && this.runId === currentRunId) {
        this.scheduleNext(currentRunId);
      }
    })();
  }

  resetCooldownAndCheckNow() {
    this.consecutiveErrors = 0;
    if (!this.isRunning) return;

    this.runId += 1;
    const currentRunId = this.runId;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.isChecking) {
      (async () => {
        await this.checkNow();
        if (this.isRunning && this.runId === currentRunId) {
          this.scheduleNext(currentRunId);
        }
      })();
    } else {
      // An older unauthenticated check was mid-flight and is closing; run fresh check right after
      this.nextCheckTime = Date.now() + 2500;
      this.timer = setTimeout(async () => {
        if (!this.isRunning || this.runId !== currentRunId) return;
        await this.checkNow();
        if (this.isRunning && this.runId === currentRunId) {
          this.scheduleNext(currentRunId);
        }
      }, 2500);
    }
  }

  scheduleNext(runId = this.runId) {
    if (!this.isRunning || runId !== this.runId) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    let intervalMs;
    if (this.consecutiveErrors > 0) {
      // Automatic anti-bot cooldown so a soft flag never escalates into a hard IP ban
      if (this.consecutiveErrors === 1) {
        intervalMs = Math.round(150000 + Math.random() * 45000); // ~2.5 - 3.25 min
      } else if (this.consecutiveErrors === 2) {
        intervalMs = Math.round(270000 + Math.random() * 60000); // ~4.5 - 5.5 min
      } else {
        intervalMs = Math.round(420000 + Math.random() * 60000); // ~7 - 8 min
      }
      this.nextCheckTime = Date.now() + intervalMs;
      const cooldownSec = (intervalMs / 1000).toFixed(1);
      this.log(`Safety cooldown active (attempt #${this.consecutiveErrors}): pausing ${cooldownSec}s before resuming fast checks...`, 'warn');
    } else {
      const baseMs = Math.max(25, this.config.checkIntervalSeconds || 60) * 1000;
      // Bell-shaped asymmetric human jitter (-15% to +32%)
      const r = (Math.random() + Math.random()) / 2;
      const factor = 0.85 + r * 0.47;
      intervalMs = Math.max(20000, Math.round(baseMs * factor));

      // Occasional natural human distraction breather every 12-17 checks (+22s to +45s)
      this.checksSinceBreather += 1;
      let breatherNote = '';
      if (this.checksSinceBreather >= this.nextBreatherAt) {
        const breatherMs = Math.round(22000 + Math.random() * 23000);
        intervalMs += breatherMs;
        this.checksSinceBreather = 0;
        this.nextBreatherAt = 12 + Math.floor(Math.random() * 6);
        breatherNote = ' [natural human breather]';
      }

      this.nextCheckTime = Date.now() + intervalMs;
      const displaySec = (intervalMs / 1000).toFixed(2);
      this.log(`Next check scheduled in ${displaySec}s (humanized delay)${breatherNote}...`);
    }

    this.timer = setTimeout(async () => {
      if (!this.isRunning || runId !== this.runId) return;
      await this.checkNow();
      if (this.isRunning && runId === this.runId) {
        this.scheduleNext(runId);
      }
    }, intervalMs);
  }

  stop() {
    this.isRunning = false;
    this.runId += 1;
    this.nextCheckTime = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('Stock Tracker stopped.');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      isChecking: this.isChecking,
      config: this.config,
      lastChecked: this.state.lastChecked,
      nextCheckTime: this.nextCheckTime,
      lastProduct: this.state.lastProduct,
      totalRestockEvents: this.state.totalRestockEvents || 0,
      history: this.state.history || [],
      logs: this.logs.slice(0, 50)
    };
  }
}

// Singleton tracker instance
const tracker = new StockTracker();

module.exports = { tracker, StockTracker };
