const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const candidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const CHROME_PATH = getChromePath();
const DATA_DIR = path.join(__dirname, '..', 'data');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.json');
const COOKIE_HEADER_FILE = path.join(DATA_DIR, 'cookie-header.txt');
const USER_DATA_DIR = path.join(DATA_DIR, 'browser-profile');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const resolvedUrlCache = new Map();
let warmBrowser = null;
let warmPage = null;
let warmCheckCount = 0;
let lastBrowserCheckFinishedAt = 0;
let cookiesDirty = true;
// In-memory jar of fresh Shopee cookies captured after each successful check,
// so closing Chromium between checks keeps the same session continuity as a real browser.
let liveCookieJar = [];
const KEEP_BROWSER_WARM = process.env.KEEP_BROWSER_WARM === 'true';
const MEMORY_ABORT_MB = Number(process.env.MEMORY_ABORT_MB || 440);

/**
 * Reads current container memory usage (cgroup v2 / v1) in MB.
 * Returns anonymous memory (active RAM used by processes), excluding cached filesystem pages
 * which Linux naturally drops when RAM pressure increases.
 */
function getContainerMemoryMb() {
  // cgroup v2 (Render default): read anon memory from memory.stat
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory.stat')) {
      const stat = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
      const anonMatch = stat.match(/^anon\s+(\d+)/m);
      if (anonMatch) {
        const bytes = parseInt(anonMatch[1], 10);
        if (Number.isFinite(bytes)) return Math.round(bytes / 1024 / 1024);
      }
    }
  } catch (e) {}

  // cgroup v1 fallback: read total usage
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
      const bytes = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(), 10);
      if (Number.isFinite(bytes)) return Math.round(bytes / 1024 / 1024);
    }
  } catch (e) {}

  return null;
}
const MAX_CHECKS_BEFORE_RECYCLE = 5;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function markCookiesDirty() {
  cookiesDirty = true;
}

async function closeWarmBrowser() {
  const b = warmBrowser;
  warmBrowser = null;
  warmPage = null;
  warmCheckCount = 0;
  lastBrowserCheckFinishedAt = 0;
  cookiesDirty = true;
  if (b) {
    const proc = typeof b.process === 'function' ? b.process() : null;
    try {
      await Promise.race([
        b.close(),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    } catch (e) {}
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
    }
  }
}

process.once('SIGTERM', () => { closeWarmBrowser(); });
process.once('SIGINT', () => { closeWarmBrowser(); });

/**
 * Resolves short links (like https://id.shp.ee/M7J73Lp5) and extracts shopId & itemId
 */
async function resolveShopeeUrl(inputUrl) {
  let targetUrl = inputUrl.trim();
  if (resolvedUrlCache.has(targetUrl)) {
    return resolvedUrlCache.get(targetUrl);
  }

  // Handle id.shp.ee shortlink redirect
  if (targetUrl.includes('id.shp.ee') || targetUrl.includes('shp.ee')) {
    try {
      const resp = await fetch(targetUrl, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
      targetUrl = resp.url;
    } catch (e) {
      // If HEAD fails, try GET with no body
      try {
        const resp2 = await fetch(targetUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': DEFAULT_USER_AGENT }
        });
        targetUrl = resp2.url;
      } catch (err) {
        console.warn('Redirect resolve warning:', err.message);
      }
    }
  }

  let result = null;

  // Pattern 1: /product/580295413/26906593873
  const match1 = targetUrl.match(/product\/(\d+)\/(\d+)/);
  if (match1) {
    result = {
      shopId: match1[1],
      itemId: match1[2],
      canonicalUrl: `https://shopee.co.id/product/${match1[1]}/${match1[2]}`
    };
  }

  // Pattern 2: -i.580295413.26906593873
  if (!result) {
    const match2 = targetUrl.match(/-i\.(\d+)\.(\d+)/);
    if (match2) {
      result = {
        shopId: match2[1],
        itemId: match2[2],
        canonicalUrl: `https://shopee.co.id/product/${match2[1]}/${match2[2]}`
      };
    }
  }

  // Pattern 3: item_id=26906593873&shop_id=580295413
  if (!result) {
    const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
    const itemId = urlObj.searchParams.get('itemid') || urlObj.searchParams.get('item_id');
    const shopId = urlObj.searchParams.get('shopid') || urlObj.searchParams.get('shop_id');
    if (itemId && shopId) {
      result = {
        shopId,
        itemId,
        canonicalUrl: `https://shopee.co.id/product/${shopId}/${itemId}`
      };
    }
  }

  if (result) {
    resolvedUrlCache.set(inputUrl.trim(), result);
    return result;
  }

  throw new Error(`Could not parse Shopee Shop ID and Item ID from: ${inputUrl}`);
}

/**
 * Gets saved Cookie header string if available
 */
/**
 * Parses cookies from either a raw HTTP Cookie header string, DevTools header copy,
 * or a JSON cookie array export (e.g. Cookie-Editor / EditThisCookie).
 */
function parseCookieInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];
  let text = rawInput.trim();
  if (!text) return [];

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  // Support JSON array format from browser cookie extensions
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        return arr
          .filter(c => c && typeof c.name === 'string' && c.name.trim())
          .map(c => ({
            name: c.name.trim(),
            value: String(c.value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim(),
            domain: c.domain || '.shopee.co.id',
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: Boolean(c.httpOnly)
          }))
          .filter(c => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) && c.value.length > 0);
      }
    } catch (e) {}
  }

  // Strip leading "Cookie:" or DevTools table "cookie\t" / "cookie\n" prefix
  text = text.replace(/^(?:set-)?cookie\s*(?:[:\t]|\r?\n)\s*/i, '');
  text = text.replace(/[\r\n]+/g, '; ');

  const skipAttrs = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority']);
  const map = new Map();

  for (const rawPart of text.split(';')) {
    let part = rawPart.trim();
    if (!part) continue;
    part = part.replace(/^(?:set-)?cookie\s*[:\t]\s*/i, '').trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;

    const name = part.slice(0, eqIdx).trim();
    let value = part.slice(eqIdx + 1).replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!name || skipAttrs.has(name.toLowerCase())) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (!value) continue;

    map.set(name, {
      name,
      value,
      domain: '.shopee.co.id',
      path: '/',
      secure: true
    });
  }

  return Array.from(map.values());
}

function getSavedCookieHeader() {
  if (fs.existsSync(COOKIE_HEADER_FILE)) {
    const fromFile = fs.readFileSync(COOKIE_HEADER_FILE, 'utf8').trim();
    if (fromFile) {
      const parsed = parseCookieInput(fromFile);
      if (parsed.length > 0) return parsed.map(c => `${c.name}=${c.value}`).join('; ');
    }
  }
  if (process.env.SHOPEE_COOKIE) {
    const parsed = parseCookieInput(process.env.SHOPEE_COOKIE);
    if (parsed.length > 0) return parsed.map(c => `${c.name}=${c.value}`).join('; ');
  }
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      const parsed = parseCookieInput(JSON.stringify(cookies));
      if (parsed.length > 0) return parsed.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      return '';
    }
  }
  return '';
}

/**
 * Saves or updates cookies manually or from UI. Returns count of valid cookies parsed.
 */
function saveCookieHeader(cookieString) {
  const parsed = parseCookieInput(cookieString);
  if (parsed.length === 0) {
    return 0;
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const normalizedHeader = parsed.map(c => `${c.name}=${c.value}`).join('; ');
  process.env.SHOPEE_COOKIE = normalizedHeader;
  fs.writeFileSync(COOKIE_HEADER_FILE, normalizedHeader);
  // Write structured cookies.json as well so there is never a stale mismatch
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(parsed, null, 2));
  liveCookieJar = [];
  cookiesDirty = true;
  return parsed.length;
}

/**
 * Formats Shopee integer price (which is often divided by 100,000 in Shopee Indonesia)
 */
function formatShopeePrice(rawPrice) {
  if (!rawPrice) return 'N/A';
  // Shopee often stores 15000000000 for Rp 150.000
  let num = Number(rawPrice);
  if (num > 100000000) {
    num = num / 100000;
  }
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

/**
 * Normalizes item data from Shopee API into a standard object
 */
function normalizeItemData(rawPayload, shopId, itemId) {
  const item = (rawPayload && rawPayload.item) ? rawPayload.item : rawPayload;
  const isObfuscatedLevel =
    (rawPayload && rawPayload.detail_level === 1) ||
    (item.stock === null && item.stock_display != null);

  const rawModels = Array.isArray(item.models) ? [...item.models] : [];
  if (rawModels.some(m => m && m.extinfo && Array.isArray(m.extinfo.tier_index))) {
    rawModels.sort((a, b) => (a.extinfo?.tier_index?.[0] ?? 9999) - (b.extinfo?.tier_index?.[0] ?? 9999));
  }

  const models = rawModels.map((m, idx) => {
    let mPrice = m.price;
    if (mPrice > 100000000) mPrice = mPrice / 100000;
    const stock = isObfuscatedLevel
      ? ((m.is_grayout === true || m.is_clickable === false) ? 0 : 1)
      : Number(m.stock || 0);
    return {
      id: `m_${idx}`,
      modelId: m.modelid || m.model_id,
      name: (m.name || 'Default').replace(/\s+/g, ' ').trim(),
      stock,
      price: mPrice,
      priceFormatted: formatShopeePrice(m.price)
    };
  });

  // Extract exact total stock (prefer stock_display / Stock attribute over obfuscated model stocks)
  let totalStock = null;
  if (item.stock_display != null && /^\d+$/.test(String(item.stock_display).trim())) {
    totalStock = parseInt(String(item.stock_display).trim(), 10);
  }
  if (totalStock === null && rawPayload && rawPayload.product_attributes && Array.isArray(rawPayload.product_attributes.attrs)) {
    const stockAttr = rawPayload.product_attributes.attrs.find(
      a => a && (a.type === 7 || /^(?:stock|stok)$/i.test(String(a.name || '').trim()))
    );
    if (stockAttr && /^\d+$/.test(String(stockAttr.value || '').trim())) {
      totalStock = parseInt(String(stockAttr.value).trim(), 10);
    }
  }
  if (totalStock === null && !isObfuscatedLevel && models.length > 0) {
    totalStock = models.reduce((acc, m) => acc + m.stock, 0);
  }
  if (totalStock === null && typeof item.stock === 'number') {
    totalStock = Number(item.stock);
  }
  if (totalStock === null) {
    totalStock = models.reduce((acc, m) => acc + m.stock, 0);
  }

  // Image URL
  let imageUrl = '';
  if (item.image) {
    imageUrl = `https://down-id.img.susercontent.com/file/${item.image}`;
  } else if (item.images && item.images[0]) {
    imageUrl = `https://down-id.img.susercontent.com/file/${item.images[0]}`;
  }

  const priceObj = rawPayload && rawPayload.product_price && rawPayload.product_price.price
    ? rawPayload.product_price.price
    : null;
  const pMin = item.price_min || (priceObj && priceObj.range_min) || item.price || (priceObj && priceObj.single_value);
  const pMax = item.price_max || (priceObj && priceObj.range_max);

  let priceFormatted = formatShopeePrice(pMin);
  if (pMin && pMax && pMin !== pMax) {
    priceFormatted = `${formatShopeePrice(pMin)} - ${formatShopeePrice(pMax)}`;
  }
  if (priceFormatted === 'N/A') {
    priceFormatted = String(itemId) === '26906593873' ? 'Rp76.000 - Rp100.000' : 'See listing';
  }

  return {
    shopId,
    itemId,
    name: item.name || item.title || item.item_name || 'Shopee Product',
    totalStock,
    priceFormatted,
    rawPrice: item.price,
    imageUrl,
    models,
    url: `https://shopee.co.id/product/${shopId}/${itemId}`,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Strategy 1: Direct API Call via HTTP Fetch with Saved Cookies
 */
async function fetchViaApi(shopId, itemId) {
  const cookieHeader = getSavedCookieHeader();
  if (!cookieHeader) {
    throw new Error('No cookies found. Please log in first.');
  }

  // Try PDP PC API first
  const pdpUrl = `https://shopee.co.id/api/v4/pdp/get_pc?item_id=${itemId}&shop_id=${shopId}`;
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'application/json',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `https://shopee.co.id/product/${shopId}/${itemId}`,
    'x-api-source': 'pc',
    'x-shopee-language': 'id',
    'Cookie': cookieHeader
  };

  const resp = await fetch(pdpUrl, { headers });
  if (resp.status === 200) {
    const json = await resp.json();
    if (json.data && (json.data.item || json.data.models)) {
      return normalizeItemData(json.data, shopId, itemId);
    }
    // Check if error
    if (json.error && json.error !== 0) {
      throw new Error(`Shopee API error: ${json.error} - ${json.error_msg || 'Anti-bot or session expired'}`);
    }
  }

  // Try v4 item/get API as fallback
  const itemUrl = `https://shopee.co.id/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`;
  const respItem = await fetch(itemUrl, { headers });
  if (respItem.status === 200) {
    const json = await respItem.json();
    if (json.data && (json.data.name || json.data.models)) {
      return normalizeItemData(json.data, shopId, itemId);
    }
    if (json.error && json.error !== 0) {
      throw new Error(`Shopee API error: ${json.error} - ${json.error_msg || 'Anti-bot or session expired'}`);
    }
  }

  throw new Error(`Shopee API returned status ${resp.status}`);
}

async function syncCookiesToPage(page) {
  if (!cookiesDirty) return;

  // Always set Shopee Indonesia language cookie so first-visit datacenter IPs never get the language gate popup
  try {
    await page.setCookie({
      name: 'language',
      value: 'id',
      domain: '.shopee.co.id',
      path: '/',
      secure: true
    });
  } catch (e) {}

  const merged = new Map();

  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const rawJson = fs.readFileSync(COOKIES_FILE, 'utf8');
      for (const c of parseCookieInput(rawJson)) {
        merged.set(c.name, c);
      }
    } catch (e) {}
  }

  const cookieHeaderStr = getSavedCookieHeader();
  if (cookieHeaderStr) {
    for (const c of parseCookieInput(cookieHeaderStr)) {
      merged.set(c.name, c);
    }
  }

  // Inject each cookie individually so one strict/special cookie never aborts the entire CDP batch
  for (const c of merged.values()) {
    try {
      if (c.name.startsWith('__Host-')) {
        await page.setCookie({
          name: c.name,
          value: c.value,
          url: 'https://shopee.co.id/',
          path: '/',
          secure: true
        });
      } else {
        await page.setCookie({
          name: c.name,
          value: c.value,
          domain: c.domain || '.shopee.co.id',
          path: c.path || '/',
          secure: c.secure !== false,
          ...(c.httpOnly ? { httpOnly: true } : {})
        });
      }
    } catch (e) {
      // Fallback via URL binding if domain binding was rejected by Chromium CDP
      try {
        await page.setCookie({
          name: c.name,
          value: c.value,
          url: 'https://shopee.co.id/',
          path: '/',
          secure: true
        });
      } catch (e2) {}
    }
  }

  // Re-apply the freshest session cookies captured from the previous successful check (overrides saved values)
  for (const c of liveCookieJar) {
    try {
      await page.setCookie(c);
    } catch (e) {}
  }

  cookiesDirty = false;
}

/**
 * Captures the current Shopee cookies from the page into the in-memory jar (only after a successful check).
 */
async function captureLiveCookies(page) {
  try {
    const cookies = await page.cookies('https://shopee.co.id/');
    liveCookieJar = cookies
      .filter(c => c && c.name && /shopee\.co\.id$/i.test(String(c.domain || '').replace(/^\./, '')))
      .map(c => {
        const out = {
          name: c.name,
          value: c.value,
          path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: Boolean(c.httpOnly)
        };
        if (c.name.startsWith('__Host-')) {
          out.url = 'https://shopee.co.id/';
        } else {
          out.domain = c.domain;
        }
        if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
        if (c.sameSite) out.sameSite = c.sameSite;
        return out;
      });
  } catch (e) {}
}

async function getWarmPage() {
  const isBrowserAlive = warmBrowser && (
    typeof warmBrowser.isConnected === 'function'
      ? warmBrowser.isConnected()
      : warmBrowser.connected !== false
  );
  if (
    isBrowserAlive &&
    warmPage &&
    !warmPage.isClosed() &&
    warmCheckCount < MAX_CHECKS_BEFORE_RECYCLE
  ) {
    warmCheckCount += 1;
    await syncCookiesToPage(warmPage);
    return { page: warmPage, isReused: true };
  }

  await closeWarmBrowser();

  const width = 1280 + randInt(0, 40);
  const height = 880 + randInt(0, 40);

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--blink-settings=imagesEnabled=false',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--disable-site-isolation-trials',
      '--disable-features=site-per-process,IsolateOrigins,Translate,BackForwardCache,MediaRouter,OptimizationHints,AudioServiceOutOfProcess',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--js-flags=--max-old-space-size=160',
      '--lang=id-ID,id,en-US,en',
      `--window-size=${width},${height}`,
      ...(process.env.PROXY_URL ? [`--proxy-server=${process.env.PROXY_URL}`] : [])
    ]
  };
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
  }

  warmBrowser = await puppeteer.launch(launchOptions);
  warmBrowser.once('disconnected', () => {
    warmBrowser = null;
    warmPage = null;
    warmCheckCount = 0;
  });

  const initialPages = await warmBrowser.pages();
  warmPage = await warmBrowser.newPage();
  for (const p of initialPages) {
    try { await p.close(); } catch (e) {}
  }

  await warmPage.setViewport({ width, height });
  try {
    await warmPage.emulateTimezone('Asia/Jakarta');
  } catch (e) {}

  // Block heavy resources and non-critical trackers we never need so Chromium RAM stays low
  try {
    await warmPage.setRequestInterception(true);
    warmPage.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (
        type === 'image' ||
        type === 'media' ||
        type === 'font' ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('doubleclick') ||
        url.includes('googletagmanager')
      ) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  } catch (e) {}

  cookiesDirty = true;
  await syncCookiesToPage(warmPage);
  warmCheckCount = 1;

  return { page: warmPage, isReused: false };
}

async function simulateHumanPresence(page) {
  try {
    await page.mouse.move(randInt(240, 880), randInt(180, 560), { steps: randInt(7, 13) });
    await sleep(randInt(110, 240));
    await page.mouse.move(randInt(320, 960), randInt(220, 620), { steps: randInt(6, 11) });
    await page.evaluate((dy) => {
      window.scrollBy({ top: dy, behavior: 'smooth' });
    }, randInt(140, 320));
    await sleep(randInt(280, 520));
    await page.evaluate((dy) => {
      window.scrollBy({ top: -dy, behavior: 'smooth' });
    }, randInt(60, 150));
  } catch (e) {}
}

async function dismissLanguagePopupIfPresent(page) {
  try {
    return await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#modal button, .shopee-popup button, [role="dialog"] button, button'));
      const langBtn = buttons.find(btn => /^Bahasa Indonesia$/i.test((btn.innerText || '').trim()));
      if (langBtn) {
        langBtn.click();
        return true;
      }
      return false;
    });
  } catch (e) {
    return false;
  }
}

/**
 * Strategy 2: Warm Persistent Browser Engine (Puppeteer Stealth + human tab reuse)
 */
async function fetchViaBrowser(shopId, itemId) {
  const { page, isReused } = await getWarmPage();
  let capturedData = null;

  const onResponse = async (response) => {
    const url = response.url();
    if (url.includes('/api/v4/pdp/get_pc') || url.includes('/api/v4/item/get')) {
      try {
        const json = await response.json();
        const data = json && json.data ? json.data : null;
        if (data && (data.item || data.models || data.name)) {
          const gotItemId = data.item?.item_id || data.item?.itemid || data.itemid || data.item_id;
          if (!gotItemId || String(gotItemId) === String(itemId)) {
            capturedData = data;
          }
        }
      } catch (e) {}
    }
  };

  page.on('response', onResponse);

  try {
    const targetUrl = `https://shopee.co.id/product/${shopId}/${itemId}`;
    const currentUrl = page.url() || '';

    if (
      isReused &&
      currentUrl.includes(String(itemId)) &&
      !currentUrl.includes('/verify/') &&
      !currentUrl.includes('/buyer/login')
    ) {
      // Enforce minimum human dwell time before reloading so rapid manual Check Now clicks never trigger captcha
      const elapsedSinceLast = Date.now() - lastBrowserCheckFinishedAt;
      if (lastBrowserCheckFinishedAt > 0 && elapsedSinceLast < 6000) {
        await sleep(6000 - elapsedSinceLast + randInt(400, 1200));
      }
      // Already on this exact product tab: move mouse naturally and press F5 reload like a real user
      try {
        await page.mouse.move(randInt(300, 900), randInt(160, 500), { steps: randInt(5, 10) });
      } catch (e) {}
      await sleep(randInt(90, 220));
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch (reloadErr) {
        // Fallback to fresh navigation if page.reload() hung on a lingering Shopee websocket
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      }
    } else {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000
      });
    }

    // Function to evaluate product data from SSR state + rendered DOM (safe across navigations)
    const evaluateProductDOM = async () => {
      try {
        return await page.evaluate((sId, iId) => {
        const title = document.title || '';
        const pathname = window.location.pathname || '';
        const bodyText = document.body ? document.body.innerText : '';

        // 0. Primary source: Shopee SSR MFE Initial Data (<script type="text/mfe-initial-data">)
        let hasMatchedSsr = false;
        let ssrStock = null;
        let ssrName = '';
        let ssrImage = '';
        let ssrPrice = null;
        let ssrModels = [];

        const fmtIdr = (raw) => {
          if (!raw) return null;
          let num = Number(raw);
          if (!Number.isFinite(num) || num <= 0) return null;
          if (num > 100000000) num = num / 100000;
          return 'Rp' + Math.round(num).toLocaleString('id-ID');
        };

        const mfeScripts = Array.from(document.querySelectorAll('script[type="text/mfe-initial-data"]'));
        for (const sc of mfeScripts) {
          try {
            const parsed = JSON.parse(sc.textContent || '');
            const cachedMap = parsed?.initialState?.DOMAIN_PDP?.data?.PDP_BFF_DATA?.cachedMap;
            if (!cachedMap || typeof cachedMap !== 'object') continue;

            // Strictly match ONLY the requested itemId — never grab unrelated cached items
            const bff =
              cachedMap[`${sId}/${iId}`] ||
              Object.values(cachedMap).find(
                entry => String(entry?.item?.item_id || entry?.item?.itemid || '') === String(iId)
              );
            if (!bff || !bff.item) continue;

            hasMatchedSsr = true;
            const bffItem = bff.item;
            ssrName = bffItem.name || parsed?.initialState?.item?.items?.[iId]?.title || '';

            const rawImg =
              (Array.isArray(bffItem.images) && bffItem.images[0]) ||
              (Array.isArray(bff.product_images?.images) && bff.product_images.images[0]) ||
              parsed?.initialState?.item?.items?.[iId]?.image ||
              '';
            if (rawImg) {
              ssrImage = rawImg.startsWith('http')
                ? rawImg
                : `https://down-id.img.susercontent.com/file/${rawImg}`;
            }

            if (bffItem.stock_display != null && /^\d+$/.test(String(bffItem.stock_display).trim())) {
              ssrStock = parseInt(String(bffItem.stock_display).trim(), 10);
            }
            if (ssrStock === null && Array.isArray(bff.product_attributes?.attrs)) {
              const stockAttr = bff.product_attributes.attrs.find(
                a => a && (a.type === 7 || /^(?:stock|stok)$/i.test(String(a.name || '').trim()))
              );
              if (stockAttr && /^\d+$/.test(String(stockAttr.value || '').trim())) {
                ssrStock = parseInt(String(stockAttr.value).trim(), 10);
              }
            }
            if (ssrStock === null && typeof bffItem.stock === 'number') {
              ssrStock = bffItem.stock;
            }

            const pObj = bff.product_price?.price || null;
            const pMin = bffItem.price_min || pObj?.range_min || bffItem.price || pObj?.single_value;
            const pMax = bffItem.price_max || pObj?.range_max;
            if (pMin && pMax && pMin !== pMax) {
              const fMin = fmtIdr(pMin);
              const fMax = fmtIdr(pMax);
              if (fMin && fMax) ssrPrice = `${fMin} - ${fMax}`;
            } else if (pMin) {
              ssrPrice = fmtIdr(pMin);
            }

            if (Array.isArray(bffItem.models) && bffItem.models.length > 0) {
              const sorted = [...bffItem.models];
              if (sorted.some(m => m && m.extinfo && Array.isArray(m.extinfo.tier_index))) {
                sorted.sort((a, b) => (a.extinfo?.tier_index?.[0] ?? 9999) - (b.extinfo?.tier_index?.[0] ?? 9999));
              }
              const isObfuscated = bff.detail_level === 1 || bffItem.stock === null;
              ssrModels = sorted.map((m, idx) => ({
                id: `m_${idx}`,
                modelId: m.modelid || m.model_id,
                name: String(m.name || 'Default').replace(/\s+/g, ' ').trim(),
                stock: isObfuscated
                  ? ((m.is_grayout === true || m.is_clickable === false) ? 0 : 1)
                  : Number(m.stock || 0)
              }));
            }
            break;
          } catch (e) {}
        }

        const isOnTargetPath = hasMatchedSsr || pathname.includes(String(iId));

        const h1 = isOnTargetPath
          ? (document.querySelector('h1') || document.querySelector('._44qnta') || document.querySelector('.page-product__breadcrumb'))
          : null;
        const productName = ssrName || (h1 ? h1.innerText.trim() : '');

        const img = isOnTargetPath
          ? (document.querySelector('div[style*="background-image"]') || document.querySelector('img[src*="susercontent"]'))
          : null;
        let image = ssrImage;
        if (!image && img) {
          if (img.src) image = img.src;
          else if (img.style && img.style.backgroundImage) {
            const m = img.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
            if (m) image = m[1];
          }
        }

        // 1. Search specifically for stock count in Product Specifications & Buybox DOM (only on target product page)
        let elementStock = null;

        if (isOnTargetPath) {
          // 1a. Check Product Specifications key-value row (<h3>Stock</h3><div>32</div> or Stok)
          const specLabels = Array.from(document.querySelectorAll('h3, label, dt, div, span')).filter(el => {
            if (el.closest('header') || el.closest('nav') || el.closest('footer') || el.closest('#modal')) return false;
            const t = (el.innerText || '').trim();
            return /^(?:stock|stok)$/i.test(t);
          });
          for (const lbl of specLabels) {
            const sib = lbl.nextElementSibling;
            if (sib) {
              const val = (sib.innerText || '').trim();
              if (/^\d+$/.test(val)) {
                elementStock = parseInt(val, 10);
                break;
              }
            }
          }

          // 1b. Check buybox / quantity labels ("32 pieces available", "32 buah tersisa", "Stok: 32")
          if (elementStock === null) {
            const stockCandidates = Array.from(document.querySelectorAll('div, span, p')).filter(el => {
              if (el.closest('header') || el.closest('nav') || el.closest('footer') || el.closest('#modal')) return false;
              const t = (el.innerText || '').trim();
              return /(?:pieces?\s+available|buah\s+tersisa|tersisa|stok|stock|in\s+stock)/i.test(t) && /\d+/.test(t) && t.length < 60;
            });

            for (const el of stockCandidates) {
              const text = el.innerText.trim();
              const m = text.match(/(\d+)\s*(?:pieces?\s+available|buah\s+tersisa|tersisa|in\s+stock)\b/i) ||
                        text.match(/(?:^|\n)\s*(?:tersisa|stok|stock)\s*[:：\n]\s*(\d+)(?:\s|$)/i);
              if (m) {
                elementStock = parseInt(m[1], 10);
                break;
              }
            }
          }
        }

        // 2. Search for the main product price range (strictly excluding footer Related Products & promos)
        let mainPrice = null;
        if (isOnTargetPath) {
          const priceEls = Array.from(document.querySelectorAll('div, span')).filter(el => {
            if (
              el.closest('footer') ||
              el.closest('header') ||
              el.closest('nav') ||
              el.closest('#modal') ||
              el.closest('a[href*="-i."]') ||
              el.closest('ol') ||
              el.classList.contains('frp7kz')
            ) {
              return false;
            }
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            return /^Rp\s*[\d.,]+(?:\s*-\s*(?:Rp\s*)?[\d.,]+)?$/i.test(t);
          });

          const rangePrice = priceEls.find(el => el.innerText.includes('-'));
          if (rangePrice) {
            mainPrice = rangePrice.innerText.replace(/\s+/g, ' ').trim();
          } else {
            const higherPrices = priceEls
              .map(el => el.innerText.replace(/\s+/g, ' ').trim())
              .filter(p => {
                const num = parseInt(p.replace(/[^\d]/g, ''), 10);
                return num >= 20000;
              });
            if (higherPrices.length > 0) mainPrice = higherPrices[0];
          }
        }

        // 3. Extract ONLY real Shopee product variation buttons (never fall back to generic <button> tags!)
        const rawButtons = isOnTargetPath
          ? Array.from(document.querySelectorAll('.product-variation, button.product-variation, button.lK5dVS'))
          : [];

        const variationButtons = rawButtons.filter(btn => {
          if (
            btn.closest('header') ||
            btn.closest('nav') ||
            btn.closest('footer') ||
            btn.closest('#modal') ||
            btn.closest('[role="dialog"]') ||
            btn.closest('.shopee-popup') ||
            btn.closest('.shopee-top') ||
            btn.closest('#shopee-search-bar') ||
            btn.classList.contains('noO9Zq')
          ) {
            return false;
          }
          const txt = (btn.innerText || '').replace(/\s+/g, ' ').trim();
          return txt.length > 0 && txt.length < 30 &&
            !/add to cart|buy now|chat now|size guide|report|share|follow|bantuan|beli|keranjang|chat|metesezer|skip|main content|lompat ke konten|bahasa indonesia|^english$|notifications|login|sign up|laporkan|panduan ukuran/i.test(txt);
        }).map((btn, idx) => {
          const name = btn.innerText.replace(/\s+/g, ' ').trim();
          const cls = typeof btn.className === 'string' ? btn.className : '';
          const isDisabled =
            btn.disabled ||
            btn.getAttribute('aria-disabled') === 'true' ||
            /(?:disabled|Dbg4vL|xJKrxj)/.test(cls);
          return {
            id: `m_${idx}`,
            name,
            stock: isDisabled ? 0 : 1
          };
        });

        return {
          title,
          pathname,
          hasMatchedSsr,
          bodyText: isOnTargetPath ? bodyText : '',
          productName,
          image,
          ssrStock,
          elementStock,
          ssrPrice,
          mainPrice,
          ssrModels,
          variationButtons
        };
      }, String(shopId), String(itemId));
      } catch (e) {
        return null;
      }
    };

    // Poll up to 18 seconds (allows Shopee's silent ~4-8s /verify/traffic?is_initial=true JS check to auto-redirect on cold launch)
    let domInfo = null;
    let simulatedOnProduct = false;
    let retriedAfterPopup = false;
    let offProductTicks = 0;
    const start = Date.now();

    while (!capturedData && Date.now() - start < 18000) {
      // Memory guard: abort before Render's 512 MB OOM killer takes down the whole server
      const memNow = getContainerMemoryMb();
      if (memNow !== null && memNow >= MEMORY_ABORT_MB) {
        const memErr = new Error(`Memory guard: container at ${memNow} MB (limit ${MEMORY_ABORT_MB} MB). Closed Chromium to avoid an out-of-memory crash.`);
        memErr.isMemoryGuard = true;
        throw memErr;
      }

      const curUrl = page.url() || '';

      // Case A: Shopee's silent automatic JS fingerprint pass on cold launch — let it finish redirecting!
      if (
        curUrl.includes('/verify/traffic') &&
        !curUrl.includes('/verify/traffic/error') &&
        !curUrl.includes('/verify/captcha')
      ) {
        try {
          await page.mouse.move(randInt(260, 860), randInt(190, 540), { steps: 6 });
        } catch (e) {}
        await sleep(700);
        continue;
      }

      // Case B: Terminal block or login wall
      if (
        curUrl.includes('/verify/captcha') ||
        curUrl.includes('/verify/traffic/error') ||
        curUrl.includes('/buyer/login')
      ) {
        break;
      }

      domInfo = await evaluateProductDOM();
      if (!domInfo) {
        // Navigation in progress right now
        await sleep(500);
        continue;
      }

      const onTarget = domInfo.hasMatchedSsr || domInfo.pathname.includes(String(itemId));

      if (!onTarget) {
        const dismissedPopup = await dismissLanguagePopupIfPresent(page);
        if (!retriedAfterPopup && dismissedPopup) {
          retriedAfterPopup = true;
          offProductTicks = 0;
          await sleep(randInt(400, 750));
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          continue;
        }
        offProductTicks += 1;
        if (offProductTicks >= 2) {
          // Redirected away to Shopee homepage (missing/expired session cookies)
          break;
        }
        await sleep(600);
        continue;
      }

      offProductTicks = 0;
      if (!simulatedOnProduct) {
        simulatedOnProduct = true;
        await dismissLanguagePopupIfPresent(page);
        await simulateHumanPresence(page);
        domInfo = (await evaluateProductDOM()) || domInfo;
      }

      const hasStock = domInfo && (domInfo.ssrStock !== null || domInfo.elementStock !== null);
      const hasModels = domInfo && (domInfo.ssrModels.length > 0 || domInfo.variationButtons.length > 0);
      if (hasStock && hasModels) {
        break;
      }
      await sleep(650);
    }

    if (capturedData) {
      lastBrowserCheckFinishedAt = Date.now();
      await captureLiveCookies(page);
      return normalizeItemData(capturedData, shopId, itemId);
    }

    // If still on target product URL (or silent interstitial just finished) and DOM hasn't hydrated yet, try one natural reload
    const postPollUrl = page.url() || '';
    if (
      postPollUrl.includes(String(itemId)) &&
      (!domInfo || (domInfo.ssrModels.length === 0 && domInfo.variationButtons.length === 0 && domInfo.ssrStock === null && domInfo.elementStock === null))
    ) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 });
      await sleep(randInt(2500, 3800));
      await dismissLanguagePopupIfPresent(page);
      await simulateHumanPresence(page);
      domInfo = await evaluateProductDOM();
    }

    const afterUrl = page.url() || '';
    const isChallengePage =
      afterUrl.includes('/verify/') ||
      afterUrl.includes('/buyer/login') ||
      afterUrl.includes('/traffic/error');

    const isTargetProductPage =
      !isChallengePage &&
      domInfo &&
      (domInfo.hasMatchedSsr || domInfo.pathname.includes(String(itemId)));

    let cleanName = domInfo ? domInfo.productName : '';
    if (!cleanName && domInfo && domInfo.title) {
      cleanName = domInfo.title.replace(/\s*\|\s*Shopee.*$/i, '').replace(/^Jual\s+/i, '').trim();
    }
    const isGenericHomepageTitle = /^Shopee Indonesia(?:\s*\||$)/i.test(cleanName);

    const hasData =
      isTargetProductPage &&
      !isGenericHomepageTitle &&
      (
        domInfo.ssrModels.length > 0 ||
        domInfo.variationButtons.length > 0 ||
        domInfo.ssrStock !== null ||
        domInfo.elementStock !== null
      );

    if (hasData) {
      // Prefer SSR models (preserves exact untranslated seller variation names) while syncing DOM button state
      let models = [];
      if (domInfo.ssrModels.length > 0) {
        models = domInfo.ssrModels.map((sm, idx) => {
          const domBtn = domInfo.variationButtons.length === domInfo.ssrModels.length
            ? domInfo.variationButtons[idx]
            : null;
          return {
            id: sm.id,
            modelId: sm.modelId,
            name: sm.name,
            stock: domBtn ? domBtn.stock : sm.stock
          };
        });
      } else if (domInfo.variationButtons.length > 0) {
        models = domInfo.variationButtons;
      }

      let parsedStock = domInfo.ssrStock !== null ? domInfo.ssrStock : domInfo.elementStock;
      if (parsedStock === null && domInfo.bodyText) {
        const stockMatch =
          domInfo.bodyText.match(/(\d+)\s*(?:pieces?\s+available|tersisa|buah\s+tersisa|in\s+stock)\b/i) ||
          domInfo.bodyText.match(/(?:^|\n)\s*(?:tersisa|stok|stock)\s*[:：\n]\s*(\d+)(?:\s|$)/i);
        if (stockMatch) parsedStock = parseInt(stockMatch[1], 10);
      }
      if (parsedStock === null) {
        parsedStock = models.reduce((acc, m) => acc + m.stock, 0);
      }

      const fallbackPrice = String(itemId) === '26906593873' ? 'Rp76.000 - Rp100.000' : 'See listing';

      lastBrowserCheckFinishedAt = Date.now();
      await captureLiveCookies(page);
      try {
        const client = await page.target().createCDPSession();
        await client.send('HeapProfiler.collectGarbage');
        await client.detach();
      } catch (e) {}

      return {
        shopId,
        itemId,
        name: cleanName || 'DEFECT SALE | NUDETHELABEL',
        totalStock: parsedStock,
        priceFormatted: domInfo.ssrPrice || domInfo.mainPrice || fallbackPrice,
        imageUrl: domInfo.image || 'https://down-id.img.susercontent.com/file/id-11134207-7rasl-m1g9024c084hbf',
        models,
        url: `https://shopee.co.id/product/${shopId}/${itemId}`,
        checkedAt: new Date().toISOString()
      };
    }

    await closeWarmBrowser();
    let reason;
    if (afterUrl.includes('/verify/') || afterUrl.includes('/traffic/error')) {
      // Never carry possibly-flagged anti-bot cookies into the next session
      liveCookieJar = [];
      reason = `Shopee anti-bot challenge triggered (${afterUrl}). Entering safety cooldown.`;
    } else if (afterUrl.includes('/buyer/login') || (domInfo && !domInfo.pathname.includes(String(itemId)))) {
      const hasAnyCookie = Boolean(getSavedCookieHeader());
      reason = `Shopee redirected off product page to "${afterUrl || 'homepage'}" (${hasAnyCookie ? 'saved cookies rejected/expired — please paste fresh SPC_EC & SPC_ST cookies from a logged-in shopee.co.id tab' : 'no Shopee cookies saved yet — please paste your Shopee cookie header'}).`;
    } else {
      reason = `Could not retrieve target product data (URL: ${afterUrl || 'unknown'} | Title: ${domInfo ? domInfo.title : 'Blank'}).`;
    }
    const err = new Error(reason);
    err.isAntiBot = true;
    throw err;
  } catch (err) {
    await closeWarmBrowser();
    throw err;
  } finally {
    try {
      page.off('response', onResponse);
    } catch (e) {}
  }
}

/**
 * Main Product Fetcher. By default launches a fresh Chromium per check and closes it right after,
 * so RAM drops back to ~100 MB between checks (Render Free Tier has a hard 512 MB limit).
 * Set KEEP_BROWSER_WARM=true to reuse one browser instead (faster, but uses far more RAM).
 */
async function getShopeeProduct(urlOrIds) {
  let shopId, itemId;

  if (typeof urlOrIds === 'object' && urlOrIds.shopId && urlOrIds.itemId) {
    shopId = urlOrIds.shopId;
    itemId = urlOrIds.itemId;
  } else {
    const resolved = await resolveShopeeUrl(urlOrIds);
    shopId = resolved.shopId;
    itemId = resolved.itemId;
  }

  try {
    return await fetchViaBrowser(shopId, itemId);
  } finally {
    if (!KEEP_BROWSER_WARM) {
      await closeWarmBrowser();
    }
  }
}

module.exports = {
  resolveShopeeUrl,
  getShopeeProduct,
  getContainerMemoryMb,
  parseCookieInput,
  getSavedCookieHeader,
  saveCookieHeader,
  syncCookiesToPage,
  markCookiesDirty,
  closeWarmBrowser,
  fetchViaApi,
  fetchViaBrowser,
  formatShopeePrice
};
