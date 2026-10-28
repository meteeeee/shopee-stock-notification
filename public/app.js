// Frontend controller for Shopee Stock Tracker Dashboard

const state = {
  isRunning: false,
  isChecking: false,
  config: {},
  product: null,
  history: [],
  logs: [],
  hasCookies: false
};

// Elements
const trackerStatusBadge = document.getElementById('tracker-status-badge');
const btnToggleTracker = document.getElementById('btn-toggle-tracker');
const btnCheckNow = document.getElementById('btn-check-now');

const productName = document.getElementById('product-name');
const productLink = document.getElementById('product-link');
const stockCount = document.getElementById('stock-count');
const stockStatusPill = document.getElementById('stock-status-pill');
const productPrice = document.getElementById('product-price');
const lastCheckedTime = document.getElementById('last-checked-time');
const nextCheckTime = document.getElementById('next-check-time');
const restockCounter = document.getElementById('restock-counter');
const variationCountBadge = document.getElementById('variation-count-badge');
const variationsContainer = document.getElementById('variations-container');

const authStatusBadge = document.getElementById('auth-status-badge');
const btnLaunchLogin = document.getElementById('btn-launch-login');
const btnToggleManualCookie = document.getElementById('btn-toggle-manual-cookie');
const manualCookieBox = document.getElementById('manual-cookie-box');
const inputCookieString = document.getElementById('input-cookie-string');
const btnSaveManualCookie = document.getElementById('btn-save-manual-cookie');

const formDiscordConfig = document.getElementById('form-discord-config');
const discordWebhookUrl = document.getElementById('discord-webhook-url');
const discordUserId = document.getElementById('discord-user-id');
const checkInterval = document.getElementById('check-interval');
const targetProductUrl = document.getElementById('target-product-url');
const btnTestDiscord = document.getElementById('btn-test-discord');
const discordTestResult = document.getElementById('discord-test-result');

const historyTableBody = document.getElementById('history-table-body');
const historyCount = document.getElementById('history-count');
const logsContainer = document.getElementById('logs-container');

let configInitialized = false;

// Fetch status from server
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    
    state.isRunning = data.isRunning;
    state.isChecking = data.isChecking;
    state.config = data.config || {};
    state.product = data.lastProduct;
    state.history = data.history || [];
    state.logs = data.logs || [];
    state.hasCookies = data.hasCookies;
    state.memory = data.memory || null;
    state.lastChecked = data.lastChecked;
    state.nextCheckTime = data.nextCheckTime;
    state.totalRestockEvents = data.totalRestockEvents || 0;

    render();
  } catch (err) {
    console.error('Error fetching tracker status:', err);
  }
}

// Render UI based on state
function render() {
  // 0. Live Memory Meter
  if (state.memory) {
    const mem = state.memory;
    const usageText = document.getElementById('memory-usage-text');
    const percentBadge = document.getElementById('memory-percent-badge');
    const barFill = document.getElementById('memory-bar-fill');

    if (usageText) {
      usageText.textContent = `${mem.containerMb} MB`;
      const containerEl = document.getElementById('memory-meter-container');
      if (containerEl) {
        containerEl.title = `Process RAM: ${mem.containerMb} MB | Total (with Linux cache): ${mem.totalCgroupMb || mem.containerMb} MB / 512 MB`;
      }
    }
    if (percentBadge) {
      percentBadge.textContent = `${mem.percent}%`;
      percentBadge.className = mem.percent >= 80 ? 'badge badge-warning' : (mem.percent >= 65 ? 'badge badge-warning' : 'badge badge-success');
    }
    if (barFill) {
      barFill.style.width = `${mem.percent}%`;
      barFill.style.background = mem.percent >= 80 ? '#ef4444' : (mem.percent >= 65 ? '#f59e0b' : '#10b981');
    }
  }

  // 1. Tracker toggle button & badge
  if (state.isRunning) {
    trackerStatusBadge.className = 'status-badge active';
    trackerStatusBadge.querySelector('.status-text').textContent = 'Tracking Active';
    btnToggleTracker.textContent = 'Pause Monitoring';
    btnToggleTracker.className = 'btn btn-secondary';
  } else {
    trackerStatusBadge.className = 'status-badge paused';
    trackerStatusBadge.querySelector('.status-text').textContent = 'Tracker Paused';
    btnToggleTracker.textContent = 'Start Monitoring';
    btnToggleTracker.className = 'btn btn-primary';
  }

  // Check now loading animation
  if (state.isChecking) {
    btnCheckNow.classList.add('loading');
    btnCheckNow.disabled = true;
  } else {
    btnCheckNow.classList.remove('loading');
    btnCheckNow.disabled = false;
  }

  // 2. Auth badge
  if (state.hasCookies) {
    authStatusBadge.className = 'badge badge-success';
    authStatusBadge.textContent = 'Session Active (Logged In)';
  } else {
    authStatusBadge.className = 'badge badge-warning';
    authStatusBadge.textContent = 'Not Logged In';
  }

  // 3. Product info
  if (state.product) {
    productName.textContent = state.product.name;
    productLink.href = state.product.url;
    stockCount.textContent = state.product.totalStock;
    productPrice.textContent = state.product.priceFormatted || '--';

    if (state.product.totalStock > 0) {
      stockCount.classList.remove('zero');
      stockStatusPill.className = 'stock-pill pill-in';
      stockStatusPill.textContent = 'In Stock';
    } else {
      stockCount.classList.add('zero');
      stockStatusPill.className = 'stock-pill pill-out';
      stockStatusPill.textContent = 'Out of Stock';
    }

    // Variations
    const models = state.product.models || [];
    variationCountBadge.textContent = `${models.length} variations`;

    if (models.length > 0) {
      variationsContainer.innerHTML = models.map(m => `
        <div class="variation-pill ${m.stock > 0 ? 'in-stock' : ''}">
          <span class="var-name" title="${m.name}">${m.name}</span>
          <span class="var-stock ${m.stock > 0 ? 'positive' : 'zero'}">${m.stock} left</span>
        </div>
      `).join('');
    } else {
      variationsContainer.innerHTML = '<div class="empty-state">No individual size/variation models found for this item.</div>';
    }
  } else {
    productName.textContent = state.config.targetUrl ? 'Waiting for first scan...' : 'No item configured';
    stockCount.textContent = '0';
    stockCount.classList.add('zero');
    stockStatusPill.className = 'stock-pill pill-out';
    stockStatusPill.textContent = 'Pending Scan';
    productPrice.textContent = '--';
  }

  // Last checked
  if (state.lastChecked) {
    const d = new Date(state.lastChecked);
    lastCheckedTime.textContent = d.toLocaleTimeString();
  } else {
    lastCheckedTime.textContent = 'Never';
  }

  // Next check with random human jitter
  if (state.nextCheckTime && state.isRunning) {
    const remainingSec = Math.max(0, (state.nextCheckTime - Date.now()) / 1000);
    nextCheckTime.textContent = `~${remainingSec.toFixed(1)}s`;
  } else {
    nextCheckTime.textContent = state.isRunning ? 'Soon...' : 'Paused';
  }

  restockCounter.textContent = state.totalRestockEvents;

  // 4. Form inputs (populate once)
  if (!configInitialized && state.config) {
    discordWebhookUrl.value = state.config.discordWebhookUrl || '';
    discordUserId.value = state.config.discordUserId || '';
    checkInterval.value = state.config.checkIntervalSeconds || 60;
    targetProductUrl.value = state.config.targetUrl || 'https://shopee.co.id/product/580295413/26906593873';
    configInitialized = true;
  }

  // 5. Restock History
  historyCount.textContent = state.history.length;
  if (state.history.length > 0) {
    historyTableBody.innerHTML = state.history.map(h => {
      const time = new Date(h.timestamp).toLocaleTimeString();
      const modelsStr = (h.restockedModels && h.restockedModels.length > 0)
        ? h.restockedModels.map(m => `${m.name} (+${m.diff})`).join(', ')
        : 'All variations';

      return `
        <tr>
          <td><strong>${time}</strong></td>
          <td>${h.previousStock} &rarr; <strong>${h.currentStock}</strong></td>
          <td><span class="var-stock positive">+${h.diff}</span></td>
          <td style="color: #94a3b8;">${modelsStr}</td>
        </tr>
      `;
    }).join('');
  } else {
    historyTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-cell">No restock events recorded yet. When the item restocks by +1, it appears here!</td>
      </tr>
    `;
  }

  // 6. Logs
  if (state.logs && state.logs.length > 0) {
    logsContainer.innerHTML = state.logs.map(log => `
      <div class="terminal-line ${log.type || 'info'}">
        [${log.timestamp}] ${escapeHtml(log.message)}
      </div>
    `).join('');
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

// Event Listeners

// Toggle Tracker
btnToggleTracker.addEventListener('click', async () => {
  const endpoint = state.isRunning ? '/api/tracker/stop' : '/api/tracker/start';
  await fetch(endpoint, { method: 'POST' });
  fetchStatus();
});

// Check Now
btnCheckNow.addEventListener('click', async () => {
  btnCheckNow.classList.add('loading');
  try {
    await fetch('/api/tracker/check-now', { method: 'POST' });
    fetchStatus();
  } catch (e) {
    console.error(e);
  }
});

// Launch Login Window
btnLaunchLogin.addEventListener('click', async () => {
  btnLaunchLogin.disabled = true;
  btnLaunchLogin.innerHTML = 'Opening Chrome... (Log in in Chrome window)';
  try {
    const res = await fetch('/api/auth/login-window', { method: 'POST' });
    const json = await res.json();
    alert(json.message);
  } catch (e) {
    alert('Error launching login: ' + e.message);
  } finally {
    setTimeout(() => {
      btnLaunchLogin.disabled = false;
      btnLaunchLogin.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
          <polyline points="10 17 15 12 10 7"></polyline>
          <line x1="15" y1="12" x2="3" y2="12"></line>
        </svg>
        Open Chrome to Log In (1-Click)
      `;
    }, 4000);
  }
});

// Toggle Manual Cookie Box
btnToggleManualCookie.addEventListener('click', () => {
  manualCookieBox.classList.toggle('hidden');
});

// Save Manual Cookie
btnSaveManualCookie.addEventListener('click', async () => {
  const cookies = inputCookieString.value.trim();
  if (!cookies) return alert('Please enter cookie string');

  try {
    const res = await fetch('/api/auth/save-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies })
    });
    const json = await res.json();
    if (json.success) {
      alert('Cookies saved successfully!');
      manualCookieBox.classList.add('hidden');
      fetchStatus();
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    alert('Failed to save cookies: ' + e.message);
  }
});

// Save Discord Config
formDiscordConfig.addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {
    discordWebhookUrl: discordWebhookUrl.value.trim(),
    discordUserId: discordUserId.value.trim(),
    checkIntervalSeconds: Number(checkInterval.value),
    targetUrl: targetProductUrl.value.trim()
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const json = await res.json();
    if (json.success) {
      showNotice('Settings saved successfully!', 'success');
      fetchStatus();
    }
  } catch (e) {
    showNotice('Failed to save settings: ' + e.message, 'error');
  }
});

// Test Discord Webhook
btnTestDiscord.addEventListener('click', async () => {
  const url = discordWebhookUrl.value.trim();
  if (!url) {
    alert('Please enter a Discord Webhook URL first.');
    return;
  }

  btnTestDiscord.disabled = true;
  btnTestDiscord.textContent = 'Sending...';

  try {
    const res = await fetch('/api/discord/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl: url,
        userId: discordUserId.value.trim()
      })
    });
    const json = await res.json();
    if (json.success) {
      showNotice('✅ Test notification sent to Discord! Check your channel.', 'success');
    } else {
      showNotice('❌ Failed to send Discord test: ' + (json.error || json.reason), 'error');
    }
  } catch (e) {
    showNotice('❌ Error sending test: ' + e.message, 'error');
  } finally {
    btnTestDiscord.disabled = false;
    btnTestDiscord.textContent = '🔔 Test Alert';
  }
});

function showNotice(msg, type) {
  discordTestResult.textContent = msg;
  discordTestResult.className = `alert-box alert-${type}`;
  discordTestResult.classList.remove('hidden');
  setTimeout(() => {
    discordTestResult.classList.add('hidden');
  }, 6000);
}

// Initial polling loop
fetchStatus();
setInterval(fetchStatus, 3000);
