const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { SocksProxyAgent } = require('socks-proxy-agent');
const {
  ProxyManager,
  ProfileManager,
  setupStealthPage,
  getRandomUSTimezone,
} = require('./stealth');

// Initialize plugins
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

// Initialize managers
const proxyManager = new ProxyManager();
const profileManager = new ProfileManager();

// Tor configuration
const TOR_SOCKS_PORT = 9050;

// Check if Tor is enabled from settings
function isTorEnabled() {
  try {
    const settingsPath = path.join(__dirname, '..', 'config', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.torEnabled === true;
    }
  } catch (e) {}
  return false;
}

// Get Tor proxy configuration
function getTorProxy() {
  return {
    host: '127.0.0.1',
    port: TOR_SOCKS_PORT,
    type: 'socks5'
  };
}

// Human-like delays with more variation
const randomDelay = (min, max) => {
  // Add occasional longer "thinking" pauses
  const extraPause = Math.random() < 0.1 ? Math.random() * 2000 : 0;
  return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min + extraPause));
};

// Realistic user agents (updated 2024)
const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
];

// Human-like mouse movement with curves
async function humanMove(page, targetX, targetY) {
  const mouse = page.mouse;
  const steps = Math.floor(Math.random() * 20) + 10;

  // Get current position (approximate)
  const currentPos = await page.evaluate(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2
  }));

  // Create bezier curve control points for natural movement
  const cp1x = currentPos.x + (targetX - currentPos.x) * 0.25 + (Math.random() - 0.5) * 100;
  const cp1y = currentPos.y + (targetY - currentPos.y) * 0.25 + (Math.random() - 0.5) * 100;
  const cp2x = currentPos.x + (targetX - currentPos.x) * 0.75 + (Math.random() - 0.5) * 100;
  const cp2y = currentPos.y + (targetY - currentPos.y) * 0.75 + (Math.random() - 0.5) * 100;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Cubic bezier interpolation
    const x = Math.pow(1 - t, 3) * currentPos.x +
      3 * Math.pow(1 - t, 2) * t * cp1x +
      3 * (1 - t) * Math.pow(t, 2) * cp2x +
      Math.pow(t, 3) * targetX;
    const y = Math.pow(1 - t, 3) * currentPos.y +
      3 * Math.pow(1 - t, 2) * t * cp1y +
      3 * (1 - t) * Math.pow(t, 2) * cp2y +
      Math.pow(t, 3) * targetY;

    await mouse.move(x, y);
    await new Promise(r => setTimeout(r, Math.random() * 20 + 5));
  }
}

// Human-like scrolling with variable speed
async function humanScroll(page, options = {}) {
  const { minScrolls = 2, maxScrolls = 5, direction = 'down' } = options;
  const scrolls = Math.floor(Math.random() * (maxScrolls - minScrolls + 1)) + minScrolls;

  for (let i = 0; i < scrolls; i++) {
    const scrollAmount = Math.floor(Math.random() * 300) + 150;
    const scrollDir = direction === 'down' ? scrollAmount : -scrollAmount;

    // Variable scroll speed
    const duration = Math.floor(Math.random() * 500) + 300;

    await page.evaluate(({ amount, dur }) => {
      const startTime = Date.now();
      const startY = window.scrollY;

      function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
      }

      function step() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / dur, 1);
        const eased = easeOutCubic(progress);
        window.scrollTo(0, startY + amount * eased);
        if (progress < 1) {
          requestAnimationFrame(step);
        }
      }
      step();
    }, { amount: scrollDir, dur: duration });

    await randomDelay(600, 1800);

    // Occasionally pause longer like reading content
    if (Math.random() < 0.3) {
      await randomDelay(1000, 3000);
    }
  }
}

// Simulate reading behavior
async function simulateReading(page, viewport) {
  // Random mouse movements like scanning the page
  const movements = Math.floor(Math.random() * 4) + 2;

  for (let i = 0; i < movements; i++) {
    const x = Math.random() * viewport.width * 0.7 + viewport.width * 0.15;
    const y = Math.random() * viewport.height * 0.5 + viewport.height * 0.2;
    await humanMove(page, x, y);
    await randomDelay(200, 800);
  }
}

// Human-like typing with natural variations
async function humanType(page, text) {
  for (const char of text) {
    // Variable typing speed - some chars faster, some slower
    const baseDelay = Math.random() * 120 + 40;

    // Occasional longer pause (like thinking)
    if (Math.random() < 0.08) {
      await randomDelay(300, 700);
    }

    // Sometimes type faster in bursts
    const burstMode = Math.random() < 0.3;
    const delay = burstMode ? baseDelay * 0.5 : baseDelay;

    await page.keyboard.type(char, { delay });

    // Very occasional typo correction simulation
    if (Math.random() < 0.02 && text.length > 5) {
      await randomDelay(100, 200);
      await page.keyboard.press('Backspace');
      await randomDelay(150, 300);
      await page.keyboard.type(char, { delay: baseDelay });
    }
  }
}

// Random mouse wandering to simulate human behavior
async function wanderMouse(page, viewport) {
  const movements = Math.floor(Math.random() * 3) + 2;

  for (let i = 0; i < movements; i++) {
    const x = Math.random() * viewport.width * 0.6 + viewport.width * 0.2;
    const y = Math.random() * viewport.height * 0.6 + viewport.height * 0.2;
    await humanMove(page, x, y);
    await randomDelay(300, 1000);
  }
}

// Search for property on Airbnb like a human would
async function searchAirbnbProperty(propertyName) {
  console.log(`Searching for property: "${propertyName}"`);

  // Check if Tor is enabled
  const useTor = isTorEnabled();
  let proxy = null;

  if (useTor) {
    proxy = getTorProxy();
    console.log('Using Tor network for this request');
  } else {
    proxy = proxyManager.getRandom();
  }

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const timezoneData = getRandomUSTimezone();

  // Browser arguments
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--start-maximized',
  ];

  if (proxy) {
    if (proxy.type === 'socks5') {
      args.push(`--proxy-server=socks5://${proxy.host}:${proxy.port}`);
      console.log(`Using SOCKS5 proxy: ${proxy.host}:${proxy.port}`);
    } else {
      args.push(...proxyManager.getProxyArgs(proxy));
    }
  }

  const profilePath = profileManager.getProfilePath('airbnb');

  const browser = await puppeteer.launch({
    headless: false,
    args,
    userDataDir: profilePath,
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await browser.newPage();

    // Random viewport
    const baseWidth = [1920, 1536, 1440, 1366, 1280][Math.floor(Math.random() * 5)];
    const baseHeight = [1080, 864, 900, 768, 720][Math.floor(Math.random() * 5)];
    const viewport = {
      width: baseWidth + Math.floor(Math.random() * 20) - 10,
      height: baseHeight + Math.floor(Math.random() * 20) - 10,
    };

    await page.setViewport(viewport);
    await page.setUserAgent(userAgent);

    // Setup stealth
    await setupStealthPage(page, {
      proxy,
      timezone: timezoneData,
      blockBotDetection: false,
    });

    // Set headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': `${timezoneData.languages[0]},${timezoneData.languages.slice(1).join(',')};q=0.9`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    // Debug directory for screenshots
    const debugDir = path.join(__dirname, '..', 'downloads', 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // Step 1: Navigate directly to search results (more reliable than homepage)
    console.log('Step 1: Navigating to Airbnb search...');
    await randomDelay(500, 1500);

    const encodedSearch = encodeURIComponent(propertyName);
    const searchUrl = `https://www.airbnb.com/s/${encodedSearch}/homes`;
    console.log(`Search URL: ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for search results to load
    console.log('Waiting for search results to load...');
    await randomDelay(3000, 5000);

    // Take initial screenshot
    await page.screenshot({ path: path.join(debugDir, `search_step1_${Date.now()}.png`) });

    // Wait for actual content to load (not just skeletons)
    let contentLoaded = false;
    for (let i = 0; i < 8; i++) {
      // Check for actual listing content
      const hasListings = await page.evaluate(() => {
        // Look for listing cards with actual images
        const cards = document.querySelectorAll('[data-testid="card-container"], [itemprop="itemListElement"], a[href*="/rooms/"]');
        const images = document.querySelectorAll('img[src*="muscache.com"], img[src*="airbnb"]');
        return cards.length > 0 && images.length > 0;
      });

      if (hasListings) {
        console.log('Search results loaded successfully');
        contentLoaded = true;
        break;
      }

      console.log(`Waiting for listings... (attempt ${i + 1}/8)`);
      await randomDelay(2000, 3000);

      // Try scrolling to trigger lazy loading
      if (i === 2 || i === 4) {
        await page.mouse.wheel({ deltaY: 500 });
        await randomDelay(1000, 1500);
      }
    }

    if (!contentLoaded) {
      console.log('Warning: Content may not have fully loaded');
    }

    // Step 2: Look around the page like a human
    console.log('Step 2: Browsing search results...');
    await wanderMouse(page, viewport);
    await randomDelay(1500, 3000);

    // Scroll through results
    await humanScroll(page, { minScrolls: 2, maxScrolls: 4 });
    await randomDelay(2000, 3000);

    // Take screenshot after browsing
    await page.screenshot({ path: path.join(debugDir, `search_step2_${Date.now()}.png`) });

    // Step 3: Find and click the property
    console.log(`Step 6: Looking for "${propertyName}" in results...`);

    // Try to find the property by name
    let propertyFound = null;
    try {
      propertyFound = await page.evaluate((searchName) => {
        const searchLower = searchName.toLowerCase();
        const searchWords = searchLower.split(' ').filter(w => w.length > 2);

        // Try various selectors for listing cards
        const selectors = [
          '[data-testid="card-container"]',
          '[itemprop="itemListElement"]',
          'div[aria-labelledby]',
          'a[href*="/rooms/"]',
        ];

        for (const selector of selectors) {
          const cards = document.querySelectorAll(selector);
          for (const card of cards) {
            const text = card.textContent.toLowerCase();
            // Check if most search words are found
            const matchCount = searchWords.filter(word => text.includes(word)).length;
            if (matchCount >= Math.ceil(searchWords.length * 0.6)) {
              // Find clickable link
              const link = card.querySelector('a[href*="/rooms/"]') || card.closest('a[href*="/rooms/"]') || card;
              if (link && link.href) {
                const rect = link.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, href: link.href };
                }
              }
            }
          }
        }
        return null;
      }, propertyName);
    } catch (e) {
      console.log('Error finding property:', e.message);
    }

    // Take screenshot of current state
    await page.screenshot({ path: path.join(debugDir, `search_step6_${Date.now()}.png`) });

    if (propertyFound && propertyFound.href) {
      console.log(`Found property! URL: ${propertyFound.href}`);

      // Store the URL before clicking
      const listingUrl = propertyFound.href;

      // Click on it for natural behavior
      await humanMove(page, propertyFound.x, propertyFound.y);
      await randomDelay(300, 600);
      await page.mouse.click(propertyFound.x, propertyFound.y);
      await randomDelay(2000, 3000);

      await browser.close();

      // Now scrape using the URL
      console.log(`Scraping listing: ${listingUrl}`);
      return await scrapeAirbnb(listingUrl);
    } else {
      console.log('Property not found in search results');
      await page.screenshot({ path: path.join(debugDir, `search_notfound_${Date.now()}.png`) });

      // Get current page URL to help debug
      const currentUrl = page.url();
      console.log(`Current URL: ${currentUrl}`);

      await browser.close();
      throw new Error(`Property "${propertyName}" not found in search results. Try using a direct URL instead.`);
    }

  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function scrapeAirbnb(url) {
  // Check if Tor is enabled
  const useTor = isTorEnabled();
  let proxy = null;

  if (useTor) {
    proxy = getTorProxy();
    console.log('Using Tor network for this request');
  } else {
    // Get regular proxy if available
    proxy = proxyManager.getRandom();
  }

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const timezoneData = getRandomUSTimezone();

  // Browser arguments
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--start-maximized',
  ];

  // Add proxy args
  if (proxy) {
    if (proxy.type === 'socks5') {
      // Tor SOCKS5 proxy
      args.push(`--proxy-server=socks5://${proxy.host}:${proxy.port}`);
      console.log(`Using SOCKS5 proxy: ${proxy.host}:${proxy.port}`);
    } else {
      // Regular HTTP proxy
      args.push(...proxyManager.getProxyArgs(proxy));
      console.log(`Using proxy: ${proxy.host}:${proxy.port}`);
    }
  }

  // Use persistent profile for Airbnb
  const profilePath = profileManager.getProfilePath('airbnb');

  // Try visible mode - headless browsers often get detected
  const browser = await puppeteer.launch({
    headless: false,  // Run visible to avoid detection
    args,
    userDataDir: profilePath,
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await browser.newPage();

    // Random viewport with slight variations
    const baseWidth = [1920, 1536, 1440, 1366, 1280][Math.floor(Math.random() * 5)];
    const baseHeight = [1080, 864, 900, 768, 720][Math.floor(Math.random() * 5)];
    const viewport = {
      width: baseWidth + Math.floor(Math.random() * 20) - 10,
      height: baseHeight + Math.floor(Math.random() * 20) - 10,
    };

    await page.setViewport(viewport);
    await page.setUserAgent(userAgent);

    // Setup stealth measures but DISABLE request blocking temporarily
    const stealthConfig = await setupStealthPage(page, {
      proxy,
      timezone: timezoneData,
      blockBotDetection: false,  // Disable blocking to test if that's the issue
    });

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': `${timezoneData.languages[0]},${timezoneData.languages.slice(1).join(',')};q=0.9`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    });

    console.log('Loading Airbnb listing with enhanced stealth...');
    console.log(`Timezone: ${timezoneData.timezone}, Locale: ${timezoneData.locale}`);

    // Random delay before navigation (like typing URL)
    await randomDelay(800, 2000);

    // Navigate with realistic referrer sometimes
    const referrers = [
      'https://www.google.com/',
      'https://www.airbnb.com/',
      '',
    ];
    const referrer = referrers[Math.floor(Math.random() * referrers.length)];

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000,
      referer: referrer,
    });

    // Wait for initial content to fully load
    console.log('Waiting for page to fully load...');
    await randomDelay(5000, 8000);

    // Try clicking on the skeleton/placeholder area to trigger content loading
    console.log('Clicking on placeholder areas to trigger loading...');
    const clickPoints = [
      { x: 400, y: 400 },  // Main image area
      { x: 700, y: 300 },  // Right side image
      { x: 700, y: 500 },  // Lower right image
    ];

    for (const point of clickPoints) {
      await humanMove(page, point.x, point.y);
      await randomDelay(300, 600);
      await page.mouse.click(point.x, point.y);
      await randomDelay(1000, 2000);
    }

    // Press Escape in case a modal opened
    await page.keyboard.press('Escape');
    await randomDelay(1000, 2000);

    // Aggressively trigger lazy loading by scrolling with more iterations
    console.log('Triggering lazy image loading with aggressive scrolling...');
    for (let i = 0; i < 8; i++) {
      await page.evaluate((i) => {
        window.scrollTo({ top: i * 500, behavior: 'smooth' });
      }, i);
      await randomDelay(1000, 1800);

      // Move mouse while scrolling
      await page.mouse.move(
        300 + Math.random() * 600,
        200 + Math.random() * 400
      );
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await randomDelay(3000, 5000);

    // Move mouse around the image area extensively
    console.log('Moving mouse around image areas...');
    for (let i = 0; i < 5; i++) {
      const x = 200 + Math.random() * 800;
      const y = 150 + Math.random() * 500;
      await humanMove(page, x, y);
      await randomDelay(500, 1500);
    }

    // Wait longer for actual images to load (not just skeleton placeholders)
    console.log('Waiting for images to actually load...');
    let imagesLoaded = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Wait for images with actual URLs (not placeholders)
        await page.waitForFunction(() => {
          const images = document.querySelectorAll('img');
          let loadedCount = 0;
          for (const img of images) {
            const src = img.src || '';
            // Check for real Airbnb property images (not platform assets)
            if (src.includes('muscache.com') &&
                !src.includes('AirbnbPlatformAssets') &&
                !src.includes('UserProfile') &&
                img.complete &&
                img.naturalWidth > 100) {
              loadedCount++;
            }
          }
          return loadedCount >= 1;
        }, { timeout: 10000 });
        console.log('Real property images detected and loaded');
        imagesLoaded = true;
        break;
      } catch (e) {
        console.log(`Attempt ${attempt + 1}: Images not loaded yet, trying interactions...`);

        // Try different interactions to trigger loading
        if (attempt === 0) {
          // Click on main image area
          await page.mouse.click(400, 400);
          await randomDelay(2000, 3000);
          await page.keyboard.press('Escape');
        } else if (attempt === 1) {
          // Scroll and move mouse
          await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'smooth' }));
          await randomDelay(2000, 3000);
          await humanMove(page, 500, 350);
        } else if (attempt === 2) {
          // Click on "Show all photos" button if present
          try {
            const showPhotosBtn = await page.$('button[aria-label*="photo"], button:has-text("Show all photos"), [data-testid="pdp-show-all-photos-button"]');
            if (showPhotosBtn) {
              await showPhotosBtn.click();
              await randomDelay(3000, 5000);
              await page.keyboard.press('Escape');
            }
          } catch (e2) {}
        } else {
          // Final attempt: refresh and wait
          await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await randomDelay(5000, 8000);
        }
      }
    }

    if (!imagesLoaded) {
      console.log('Warning: Could not confirm real images loaded, continuing anyway...');
    }

    // Additional wait for any remaining lazy images
    await randomDelay(4000, 6000);

    // Accept cookies if dialog appears
    try {
      const cookieSelectors = [
        'button[data-testid="accept-btn"]',
        'button[aria-label*="Accept"]',
        'button:has-text("Accept")',
        'button:has-text("OK")',
      ];
      for (const selector of cookieSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          const box = await btn.boundingBox();
          if (box) {
            await humanMove(page, box.x + box.width / 2, box.y + box.height / 2);
            await randomDelay(150, 400);
            await btn.click();
            await randomDelay(1000, 2000);
            break;
          }
        }
      }
    } catch (e) {}

    // Simulate reading the page
    await simulateReading(page, viewport);
    await humanScroll(page, { minScrolls: 2, maxScrolls: 4 });
    await randomDelay(1500, 3500);

    // Wait for images to load
    await page.waitForSelector('img', { timeout: 10000 }).catch(() => {});
    await randomDelay(2000, 4000);

    // Extract listing data
    const listingData = await page.evaluate(() => {
      const data = {
        title: '',
        description: '',
        amenities: [],
        images: [],
        location: '',
        propertyType: '',
        host: '',
        rating: '',
        reviews: ''
      };

      // Get title
      const titleEl = document.querySelector('h1');
      if (titleEl) data.title = titleEl.textContent.trim();

      // Get property type and location
      const subtitleEl = document.querySelector('h1')?.parentElement?.nextElementSibling;
      if (subtitleEl) {
        data.location = subtitleEl.textContent;
      }

      // Get description - multiple strategies
      const descSelectors = [
        '[data-section-id="DESCRIPTION_DEFAULT"] span',
        '[data-section-id="DESCRIPTION"] span',
        'section[aria-label*="description"] span',
        '[data-plugin-in-point-id="DESCRIPTION"] span',
        '[data-section-id="DESCRIPTION_DEFAULT"]',
      ];

      for (const selector of descSelectors) {
        const descEl = document.querySelector(selector);
        if (descEl && descEl.textContent.length > 50) {
          data.description = descEl.textContent.trim();
          break;
        }
      }

      // Get all images
      const images = new Set();

      // From img tags - filter out platform assets
      document.querySelectorAll('img').forEach((img) => {
        const src = img.src || img.getAttribute('data-original-uri') || img.dataset.src;
        if (src && (src.includes('muscache.com') || src.includes('airbnb')) &&
            !src.includes('avatar') &&
            !src.includes('user') &&
            !src.includes('tiny') &&
            !src.includes('icon') &&
            !src.includes('AirbnbPlatformAssets') &&
            !src.includes('UserProfile') &&
            !src.includes('logo') &&
            !src.includes('profile')) {
          const highRes = src.replace(/\?.*$/, '?im_w=1200');
          images.add(highRes);
        }
      });

      // From picture sources
      document.querySelectorAll('picture source').forEach((source) => {
        const srcset = source.srcset;
        if (srcset && srcset.includes('airbnb')) {
          const urls = srcset.split(',').map((s) => s.trim().split(' ')[0]);
          urls.forEach((u) => {
            if (u && !u.includes('avatar') && !u.includes('user') && !u.includes('tiny')) {
              images.add(u.replace(/\?.*$/, '?im_w=1200'));
            }
          });
        }
      });

      // From background images
      document.querySelectorAll('[style*="background-image"]').forEach((el) => {
        const style = el.getAttribute('style');
        const match = style.match(/url\(['"]?(.*?)['"]?\)/);
        if (match && match[1] && match[1].includes('airbnb')) {
          images.add(match[1].replace(/\?.*$/, '?im_w=1200'));
        }
      });

      // From data attributes
      document.querySelectorAll('[data-original-uri]').forEach((el) => {
        const src = el.getAttribute('data-original-uri');
        if (src && (src.includes('muscache.com') || src.includes('airbnb'))) {
          images.add(src.replace(/\?.*$/, '?im_w=1200'));
        }
      });

      data.images = [...images].filter(
        (url) => url && url.startsWith('http') && url.includes('airbnb')
      );

      // Get amenities
      document.querySelectorAll('[data-section-id="AMENITIES_DEFAULT"] div').forEach((el) => {
        const text = el.textContent.trim();
        if (text && text.length < 50 && !text.includes('Show all')) {
          data.amenities.push(text);
        }
      });

      // Get host name
      const hostEl = document.querySelector('[data-section-id="HOST_PROFILE_DEFAULT"] h2');
      if (hostEl) data.host = hostEl.textContent.trim();

      return data;
    });

    // Take a debug screenshot
    const debugDir = path.join(__dirname, '..', 'downloads', 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    await page.screenshot({ path: path.join(debugDir, `airbnb_${Date.now()}.png`), fullPage: false });
    console.log('Debug screenshot saved');

    // Log what images we can see
    const pageImages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).map(img => ({
        src: (img.src || '').substring(0, 100),
        width: img.getBoundingClientRect().width,
        height: img.getBoundingClientRect().height
      })).filter(i => i.width > 100);
    });
    console.log(`Found ${pageImages.length} images on page:`, pageImages.slice(0, 5));

    // Click on the biggest/main picture to open photo gallery
    try {
      console.log('Looking for main photo to click...');

      // Find the largest clickable image on the page
      const mainImage = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img, [role="img"], picture'));
        let biggest = null;
        let maxArea = 0;

        for (const img of images) {
          const rect = img.getBoundingClientRect();
          const area = rect.width * rect.height;
          const src = img.src || img.querySelector?.('img')?.src || '';

          // More flexible matching - any large visible image
          if (area > maxArea &&
              rect.width > 150 &&
              rect.height > 100 &&
              rect.top >= 0 &&
              rect.top < window.innerHeight &&
              rect.left >= 0 &&
              !src.includes('avatar') &&
              !src.includes('icon') &&
              !src.includes('logo') &&
              !src.includes('profile')) {
            maxArea = area;
            biggest = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              width: rect.width,
              height: rect.height,
              src: src.substring(0, 80)
            };
          }
        }
        return biggest;
      });

      if (mainImage) {
        console.log(`Found main image (${mainImage.width}x${mainImage.height}), clicking...`);

        // Move to and click the main image like a human
        await humanMove(page, mainImage.x, mainImage.y);
        await randomDelay(200, 500);
        await page.mouse.click(mainImage.x, mainImage.y);

        // Wait for photo gallery to open/load
        console.log('Waiting for photo gallery to load...');
        await randomDelay(3000, 5000);

        // Check if we're on a new page or a modal opened
        const currentUrl = page.url();
        const isPhotoPage = currentUrl.includes('/photos') || currentUrl.includes('modal=PHOTO');

        if (isPhotoPage) {
          console.log('Photo gallery page opened');
        } else {
          // Check for modal
          const hasModal = await page.$('[role="dialog"], [aria-modal="true"], .photo-modal');
          if (hasModal) {
            console.log('Photo gallery modal opened');
          }
        }

        // Scroll through the photo gallery to load all images
        console.log('Scrolling through photo gallery...');
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => {
            // Try scrolling modal first, then body
            const modal = document.querySelector('[role="dialog"]') ||
                          document.querySelector('[aria-modal="true"]') ||
                          document.querySelector('.photo-modal');
            const scrollTarget = modal || document.documentElement;
            scrollTarget.scrollBy({ top: 600 + Math.random() * 300, behavior: 'smooth' });
          });
          await randomDelay(800, 1800);

          // Occasionally pause like viewing a photo
          if (Math.random() < 0.3) {
            await randomDelay(1500, 3000);
          }
        }

        // Also try scrolling up to catch any images at the top
        await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"]') || document.documentElement;
          modal.scrollTo({ top: 0, behavior: 'smooth' });
        });
        await randomDelay(1000, 2000);

        // Scroll down again slowly
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"]') || document.documentElement;
            modal.scrollBy({ top: 400, behavior: 'smooth' });
          });
          await randomDelay(600, 1200);
        }

        // Collect all images from the photo gallery
        const galleryImages = await page.evaluate(() => {
          const images = new Set();

          // Get all img tags - Airbnb uses muscache.com CDN
          document.querySelectorAll('img').forEach((img) => {
            const src = img.src || img.getAttribute('data-src') || img.dataset.src;
            if (src && (src.includes('muscache.com') || src.includes('airbnb')) &&
                !src.includes('avatar') &&
                !src.includes('tiny') &&
                !src.includes('icon') &&
                !src.includes('logo') &&
                !src.includes('profile') &&
                !src.includes('AirbnbPlatformAssets') &&
                !src.includes('UserProfile')) {
              // Get high resolution version
              const highRes = src.replace(/\?.*$/, '?im_w=1200');
              images.add(highRes);
            }
          });

          // Also check picture sources
          document.querySelectorAll('picture source').forEach((source) => {
            const srcset = source.srcset;
            if (srcset && srcset.includes('airbnb')) {
              const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
              urls.forEach(u => {
                if (u && !u.includes('avatar') && !u.includes('tiny')) {
                  images.add(u.replace(/\?.*$/, '?im_w=1200'));
                }
              });
            }
          });

          // Check for data attributes with image URLs
          document.querySelectorAll('[data-original-uri], [data-src]').forEach((el) => {
            const src = el.getAttribute('data-original-uri') || el.getAttribute('data-src');
            if (src && (src.includes('muscache.com') || src.includes('airbnb')) && !src.includes('avatar')) {
              images.add(src.replace(/\?.*$/, '?im_w=1200'));
            }
          });

          return [...images];
        });

        console.log(`Found ${galleryImages.length} images in photo gallery`);
        listingData.images = [...new Set([...listingData.images, ...galleryImages])];
      } else {
        console.log('Could not find main image to click');
      }
    } catch (e) {
      console.log('Could not open photo gallery:', e.message);
    }

    await browser.close();

    // Create download folder
    const listingId = uuidv4().slice(0, 8);
    const folderName = `airbnb_${listingId}_${Date.now()}`;
    const downloadPath = path.join(__dirname, '..', 'downloads', folderName);
    fs.mkdirSync(downloadPath, { recursive: true });
    fs.mkdirSync(path.join(downloadPath, 'images'), { recursive: true });

    // Download images with human-like timing
    const downloadedImages = [];
    console.log(`Found ${listingData.images.length} images to download`);

    // Configure axios with Tor if enabled
    const axiosConfig = {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': timezoneData.languages.join(','),
        'Referer': 'https://www.airbnb.com/',
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      }
    };

    // Add Tor proxy agent if enabled
    if (useTor) {
      const torAgent = new SocksProxyAgent(`socks5://127.0.0.1:${TOR_SOCKS_PORT}`);
      axiosConfig.httpAgent = torAgent;
      axiosConfig.httpsAgent = torAgent;
      console.log('Downloading images through Tor network');
    }

    for (let i = 0; i < listingData.images.length; i++) {
      const imageUrl = listingData.images[i];
      try {
        // Variable delays between downloads
        await randomDelay(600, 2000);

        // Occasional longer pause
        if (Math.random() < 0.1) {
          await randomDelay(2000, 4000);
        }

        const response = await axios.get(imageUrl, axiosConfig);

        const ext = 'jpg';
        const filename = `image_${i + 1}.${ext}`;
        const filepath = path.join(downloadPath, 'images', filename);
        fs.writeFileSync(filepath, response.data);
        downloadedImages.push({
          original: imageUrl,
          local: `/downloads/${folderName}/images/${filename}`
        });
        console.log(`Downloaded image ${i + 1}/${listingData.images.length}`);
      } catch (err) {
        console.error(`Failed to download image ${i + 1}:`, err.message);
      }
    }

    // Save metadata
    const metadata = {
      id: listingId,
      platform: 'airbnb',
      sourceUrl: url,
      title: listingData.title,
      description: listingData.description,
      location: listingData.location,
      host: listingData.host,
      rating: listingData.rating,
      amenities: [...new Set(listingData.amenities)],
      images: downloadedImages,
      scrapedAt: new Date().toISOString(),
      folder: folderName
    };

    fs.writeFileSync(path.join(downloadPath, 'metadata.json'), JSON.stringify(metadata, null, 2));

    if (listingData.description) {
      fs.writeFileSync(path.join(downloadPath, 'description.txt'), listingData.description);
    }

    return metadata;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = { scrapeAirbnb, searchAirbnbProperty, proxyManager };
