const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function waitForEnterKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question('\n👉 [AFTER LOGGING IN] Press ENTER here in this console to save cookies: ', () => {
      rl.close();
      resolve();
    });
  });
}

async function loginOnce(options = {}) {
  const isHeadless = options.headless ?? false;
  console.log('====================================================');
  console.log('🚀 Launching Chrome to log in to Shopee...');
  console.log('👉 1. In the Chrome window, log in with your Shopee account.');
  console.log('👉 2. Once logged in, press ENTER in this terminal.');
  console.log('====================================================');

  const launchOptions = {
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1200,850'
    ]
  };
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 850 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    // Navigate to Shopee login
    await page.goto('https://shopee.co.id/buyer/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('\n👀 Chrome window is open. Waiting for you to log in...');

    // Race between automatic detection (valid SPC_EC or numeric SPC_U) and user pressing Enter
    const autoDetectPromise = new Promise(async (resolve) => {
      while (true) {
        try {
          const cookies = await page.cookies();
          const hasRealAuth = cookies.some(
            c => (c.name === 'SPC_EC' && c.value.length > 10) ||
                 (c.name === 'SPC_U' && /^\d+$/.test(c.value) && Number(c.value) > 0)
          );
          if (hasRealAuth) {
            console.log('\n⚡ Real authenticated session detected automatically!');
            return resolve(true);
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          break;
        }
      }
    });

    // Wait for auto-detect or manual Enter press
    await Promise.race([
      autoDetectPromise,
      waitForEnterKey()
    ]);

    // Give 1 second for cookies to settle
    await new Promise(r => setTimeout(r, 1000));

    // Capture all cookies
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));

    const cookieHeader = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    fs.writeFileSync(COOKIE_HEADER_FILE, cookieHeader);

    console.log(`\n💾 Saved ${cookies.length} cookies successfully to:`);
    console.log(`   - ${COOKIES_FILE}`);
    console.log(`   - ${COOKIE_HEADER_FILE}`);

    const hasAuth = cookies.some(c => c.name === 'SPC_EC' || (c.name === 'SPC_U' && Number(c.value) > 0));
    if (hasAuth) {
      console.log('🎉 Confirmed: Logged in Shopee account cookies captured!');
    } else {
      console.log('ℹ️ Cookies captured! (If login was not finished, you can run this command again anytime).');
    }

    return true;
  } catch (err) {
    console.error('❌ Error during login:', err.message);
    return false;
  } finally {
    await browser.close();
    console.log('Browser closed.\n');
  }
}

if (require.main === module) {
  loginOnce().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { loginOnce, COOKIES_FILE, COOKIE_HEADER_FILE };
