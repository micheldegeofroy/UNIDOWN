/**
 * VRBO scraper using Puppeteer with stealth
 * Uses browser automation to extract property data
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const {
  downloadImage,
  extractJsonLd,
  createProgress,
  ensureDir,
  getExtensionFromContentType,
  saveMetadata,
  saveDebugHtml
} = require('./utils');

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Reusable browser instance with launch lock to prevent race conditions
let browserInstance = null;
let currentProxyConfig = null;
let browserLaunchPromise = null;
let browserUseCount = 0;
const MAX_BROWSER_USES = 10; // Recycle browser after this many scrapes to prevent memory leaks

// Tor configuration
const TOR_SOCKS_PORT = 9050;

/**
 * Check if Tor is running
 */
async function checkTorRunning() {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(TOR_SOCKS_PORT, '127.0.0.1');
  });
}

// Tor enabled state (set by server)
let torEnabledSetting = false;

function setTorEnabled(enabled) {
  console.log('VRBO scraper: Tor enabled set to', enabled);
  torEnabledSetting = enabled;
}

/**
 * Get or create browser instance (with race condition protection)
 */
async function getBrowser() {
  // Check if we need to recreate browser due to proxy change
  const torRunning = torEnabledSetting && await checkTorRunning();
  console.log('VRBO browser: Tor enabled =', torEnabledSetting, ', Tor running =', torRunning);
  const proxyArg = torRunning ? `--proxy-server=socks5://127.0.0.1:${TOR_SOCKS_PORT}` : null;

  // Check if we should recycle the browser due to use count
  if (browserInstance && browserInstance.isConnected() && currentProxyConfig === proxyArg) {
    if (browserUseCount >= MAX_BROWSER_USES) {
      console.log('Recycling VRBO browser instance after', browserUseCount, 'uses');
      await closeBrowser();
    } else {
      return browserInstance;
    }
  }

  // If a launch is already in progress, wait for it
  if (browserLaunchPromise) {
    await browserLaunchPromise;
    if (browserInstance && browserInstance.isConnected() && currentProxyConfig === proxyArg) {
      return browserInstance;
    }
  }

  // Close existing browser if proxy config changed
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  if (proxyArg) {
    args.push(proxyArg);
    console.log('Launching VRBO browser with Tor proxy...');
  } else {
    console.log('Launching VRBO browser without proxy...');
  }

  currentProxyConfig = proxyArg;

  // Launch with lock to prevent race conditions
  browserLaunchPromise = puppeteer.launch({
    headless: 'new',
    args,
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    browserInstance = await browserLaunchPromise;
    browserUseCount = 0;
  } finally {
    browserLaunchPromise = null;
  }

  return browserInstance;
}

/**
 * Close browser instance
 */
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (err) {
      console.warn('Error closing VRBO browser:', err.message);
    }
    browserInstance = null;
    browserUseCount = 0;
  }
}

/**
 * Safely close a page
 */
async function safeClosePage(page) {
  if (page) {
    try {
      await page.close();
    } catch (err) {
      console.warn('Error closing page:', err.message);
    }
  }
}

/**
 * Extract property ID from VRBO URL
 */
function extractPropertyId(url) {
  // URL format: /8789569ha or /unit/12345
  const match = url.match(/vrbo\.com\/(\d+[a-z]*)/i);
  if (match) {
    return match[1];
  }
  // Try alternate format
  const altMatch = url.match(/\/unit\/(\d+)/i);
  if (altMatch) {
    return altMatch[1];
  }
  // Fallback: use hash of URL
  return Buffer.from(url).toString('base64').substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Extract images from HTML
 */
function extractImages(html) {
  const images = new Set();

  // Look for VRBO/Expedia image URLs - expanded patterns
  const imgPatterns = [
    /https:\/\/[^"'\s]+\.muscache\.com\/[^"'\s]+/gi,
    /https:\/\/[^"'\s]+images\.vrbo\.com\/[^"'\s]+/gi,
    /https:\/\/[^"'\s]+images\.trvl-media\.com\/[^"'\s]+/gi,
    /https:\/\/[^"'\s]+mediaim\.expedia\.com\/[^"'\s]+/gi,
    /https:\/\/[^"'\s]+\.expedia[^"'\s]+\.(jpg|jpeg|png|webp)[^"'\s]*/gi,
    /https:\/\/[^"'\s]+lodgingprofile[^"'\s]+\.(jpg|jpeg|png|webp)/gi,
    /https:\/\/[^"'\s]+exp\.cdn[^"'\s]+\.(jpg|jpeg|png|webp)/gi,
    /https:\/\/[^"'\s]+a\.travel-assets\.com\/[^"'\s]+/gi
  ];

  for (const pattern of imgPatterns) {
    const matches = html.match(pattern) || [];
    for (let imgUrl of matches) {
      // Clean up URL - remove trailing characters
      imgUrl = imgUrl.replace(/["'\]>\\),;].*$/, '');
      imgUrl = imgUrl.replace(/&amp;/g, '&');

      // Skip small thumbnails and icons
      if (imgUrl.includes('_t.') ||
          imgUrl.includes('_s.') ||
          imgUrl.includes('50x50') ||
          imgUrl.includes('70x70') ||
          imgUrl.includes('100x100') ||
          imgUrl.includes('favicon') ||
          imgUrl.includes('icon') ||
          imgUrl.includes('logo')) {
        continue;
      }

      // Try to upgrade to larger size
      imgUrl = imgUrl.replace(/_[a-z]\./, '_z.');
      imgUrl = imgUrl.replace(/\?.*$/, '');  // Remove query params for deduplication

      if (imgUrl.length > 20) {  // Skip very short URLs
        images.add(imgUrl);
      }
    }
  }

  // Also look for data-src attributes (lazy loaded images)
  const dataSrcMatches = html.match(/data-src=["']([^"']+)["']/gi) || [];
  for (const match of dataSrcMatches) {
    const urlMatch = match.match(/data-src=["']([^"']+)["']/i);
    if (urlMatch && urlMatch[1].startsWith('http') &&
        (urlMatch[1].includes('.jpg') || urlMatch[1].includes('.jpeg') ||
         urlMatch[1].includes('.png') || urlMatch[1].includes('.webp'))) {
      images.add(urlMatch[1].replace(/\?.*$/, ''));
    }
  }

  // Look for srcset with high-res images
  const srcsetMatches = html.match(/srcset=["']([^"']+)["']/gi) || [];
  for (const match of srcsetMatches) {
    const srcsetContent = match.match(/srcset=["']([^"']+)["']/i);
    if (srcsetContent) {
      const srcsetParts = srcsetContent[1].split(',');
      for (const part of srcsetParts) {
        const urlMatch = part.trim().match(/^(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          let url = urlMatch[1].replace(/\?.*$/, '');
          if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.webp')) {
            images.add(url);
          }
        }
      }
    }
  }

  // Look for background-image URLs
  const bgMatches = html.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/gi) || [];
  for (const match of bgMatches) {
    const urlMatch = match.match(/url\(['"]?([^'")\s]+)['"]?\)/i);
    if (urlMatch && urlMatch[1].startsWith('http')) {
      images.add(urlMatch[1].replace(/\?.*$/, ''));
    }
  }

  // Look for img src directly
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const match of imgSrcMatches) {
    const urlMatch = match.match(/src=["']([^"']+)["']/i);
    if (urlMatch && urlMatch[1].startsWith('http') &&
        (urlMatch[1].includes('expedia') || urlMatch[1].includes('vrbo') ||
         urlMatch[1].includes('trvl-media') || urlMatch[1].includes('travel-assets'))) {
      images.add(urlMatch[1].replace(/\?.*$/, ''));
    }
  }

  const result = Array.from(images).filter(url =>
    (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.webp')) &&
    !url.includes('favicon') && !url.includes('icon') && !url.includes('logo') && !url.includes('sprite')
  );

  console.log('Extracted', result.length, 'unique image URLs');
  return result;
}

/**
 * Extract property details from HTML
 */
function extractPropertyDetails(html) {
  const data = {
    title: '',
    description: '',
    propertyType: '',
    amenities: [],
    location: {},
    images: [],
    bedrooms: null,
    beds: null,
    bathrooms: null,
    guests: null
  };

  // Extract title
  const titlePatterns = [
    /<h1[^>]*>([^<]+)</i,
    /<meta\s+property="og:title"\s+content="([^"]+)"/i,
    /"name":\s*"([^"]+)"/,
    /<title>([^<|]+)/i
  ];

  for (const pattern of titlePatterns) {
    const match = html.match(pattern);
    if (match) {
      data.title = match[1].trim().replace(/\s*[-–|,].*$/, '').trim();
      if (data.title && data.title.length > 5) break;
    }
  }

  // Extract description
  const descPatterns = [
    /<meta\s+property="og:description"\s+content="([^"]+)"/i,
    /<meta\s+name="description"\s+content="([^"]+)"/i,
    /property-description[^>]*>([\s\S]*?)<\/div>/i,
    /"description":\s*"([^"]+)"/
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match) {
      data.description = match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (data.description && data.description.length > 50) break;
    }
  }

  // Extract property type - be more specific to avoid matching JS code
  const typePatterns = [
    /<span[^>]*data-stid="[^"]*property-type[^"]*"[^>]*>([^<]+)</i,
    /property-type[^>]*>([^<]{2,50})</i,
    /<span[^>]*>(Entire\s+\w+|House|Apartment|Condo|Villa|Cabin|Cottage|Townhouse)<\/span>/i,
    /"@type"\s*:\s*"(House|Apartment|VacationRental|LodgingBusiness)"/i
  ];

  for (const pattern of typePatterns) {
    const match = html.match(pattern);
    if (match) {
      const propType = match[1].trim();
      // Validate it looks like a property type (not JS code)
      if (propType && propType.length < 50 && !/[{}()\[\];=]/.test(propType)) {
        data.propertyType = propType;
        break;
      }
    }
  }

  // Extract amenities
  const amenityKeywords = [
    'WiFi', 'Wi-Fi', 'Wireless Internet', 'Internet',
    'Pool', 'Swimming pool', 'Private pool', 'Shared pool',
    'Air conditioning', 'A/C', 'AC', 'Central air',
    'Kitchen', 'Full kitchen', 'Kitchenette',
    'Washer', 'Dryer', 'Washing machine', 'Laundry',
    'Parking', 'Free parking', 'Garage',
    'Patio', 'Deck', 'Balcony', 'Terrace', 'Garden',
    'BBQ', 'Grill', 'Barbecue',
    'Fireplace', 'Fire pit',
    'Hot tub', 'Jacuzzi', 'Spa',
    'TV', 'Cable TV', 'Satellite TV', 'Smart TV',
    'Heating', 'Central heating',
    'Dishwasher', 'Microwave', 'Oven', 'Stove',
    'Coffee maker', 'Coffee machine',
    'Ocean view', 'Sea view', 'Beach view', 'Mountain view', 'Lake view',
    'Beach access', 'Waterfront', 'Beachfront',
    'Pet friendly', 'Pets allowed',
    'Gym', 'Fitness', 'Exercise',
    'Wheelchair accessible', 'Elevator'
  ];

  for (const amenity of amenityKeywords) {
    const pattern = new RegExp(`[>\\s,]${amenity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[<\\s,]`, 'i');
    if (pattern.test(html)) {
      data.amenities.push(amenity);
    }
  }

  // Deduplicate amenities
  data.amenities = [...new Set(data.amenities)].slice(0, 30);

  // Extract room details - use specific patterns from visible page content
  // VRBO uses patterns like ">2 guests<" ">1 bedroom<" ">1 bathroom<"

  // Bedrooms - look for visible text patterns
  const bedroomsPatterns = [
    />(\d{1,2})\s*bedrooms?\s*</i,     // ">1 bedroom<" or ">3 bedrooms<"
    />(\d{1,2})\s*BR\s*</i,             // ">2 BR<"
    /(\d{1,2})\s*bedrooms?[,\s]/i       // "2 bedrooms," in text
  ];
  for (const pattern of bedroomsPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 30) {
        data.bedrooms = num;
        break;
      }
    }
  }

  // Beds - distinct from bedrooms
  const bedsPatterns = [
    />(\d{1,2})\s*beds?\s*</i,          // ">2 beds<"
    /(\d{1,2})\s*beds?[,\s]/i           // "4 beds," in text
  ];
  for (const pattern of bedsPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 30) {
        data.beds = num;
        break;
      }
    }
  }

  // Bathrooms
  const bathroomsPatterns = [
    />(\d{1,2})\s*bathrooms?\s*</i,     // ">1 bathroom<"
    />(\d{1,2})\s*baths?\s*</i,         // ">2 baths<"
    />(\d{1,2})\s*BA\s*</i,             // ">1 BA<"
    /(\d{1,2})\s*bathrooms?[,\s]/i      // "2 bathrooms," in text
  ];
  for (const pattern of bathroomsPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 20) {
        data.bathrooms = num;
        break;
      }
    }
  }

  // Guests/sleeps
  const guestsPatterns = [
    />(\d{1,2})\s*guests?\s*</i,        // ">2 guests<"
    /[Ss]leeps\s*(\d{1,2})/,            // "Sleeps 4" or "sleeps 4"
    /[Aa]ccommodates\s*(\d{1,2})/       // "Accommodates 6"
  ];
  for (const pattern of guestsPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 50) {
        data.guests = num;
        break;
      }
    }
  }

  // Extract images
  data.images = extractImages(html);

  return data;
}

/**
 * Main scraping function for VRBO
 */
async function scrapeVrboApi(url, onProgress = null) {
  const progress = createProgress(onProgress);

  progress('Scraping VRBO: ' + url);

  // Ensure URL is properly formatted
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  const propertyId = extractPropertyId(url);
  progress('Property ID: ' + propertyId);

  // Get browser and create page
  const browser = await getBrowser();
  let page = await browser.newPage();

  try {
    // Set viewport with realistic dimensions
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: true,
      isMobile: false
    });

    // Override navigator properties for better stealth
    await page.evaluateOnNewDocument(() => {
      // Override webdriver detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Add language
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });

      // Add plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // Chrome runtime
      window.chrome = {
        runtime: {}
      };
    });

    // Set extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    });

    // Navigate to page with retry logic
    progress('Navigating to page...');
    let navigationSuccess = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!navigationSuccess && attempts < maxAttempts) {
      attempts++;
      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        navigationSuccess = true;
      } catch (navError) {
        progress(`Navigation attempt ${attempts} failed: ${navError.message}`);
        if (attempts >= maxAttempts) throw navError;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Check for bot challenge and wait for it to resolve
    progress('Checking for bot challenge...');
    let challengeAttempts = 0;
    const maxChallengeWait = 5;

    while (challengeAttempts < maxChallengeWait) {
      const pageTitle = await page.title();
      const pageContent = await page.content();

      if (pageTitle.includes('Bot or Not') || pageContent.includes('Press & Hold') || pageContent.includes('human verification')) {
        progress(`Bot challenge detected (attempt ${challengeAttempts + 1}/${maxChallengeWait}), waiting...`);

        // Try to find and interact with Press & Hold button
        try {
          const holdButton = await page.$('#px-captcha, [id*="captcha"], button[class*="hold"], [aria-label*="hold"]');
          if (holdButton) {
            progress('Found hold button, attempting to interact...');
            const box = await holdButton.boundingBox();
            if (box) {
              // Move mouse to button with human-like curve
              const startX = 100 + Math.random() * 200;
              const startY = 100 + Math.random() * 200;
              await page.mouse.move(startX, startY);
              await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 + Math.floor(Math.random() * 15) });
              await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 400));
              // Press and hold for longer with slight random variation
              await page.mouse.down();
              const holdTime = 8000 + Math.random() * 4000; // 8-12 seconds
              progress(`Holding for ${Math.round(holdTime/1000)}s...`);
              await new Promise(resolve => setTimeout(resolve, holdTime));
              await page.mouse.up();
              await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
            }
          }
        } catch (e) {
          progress('Could not interact with challenge button');
        }

        // Wait and check again
        await new Promise(resolve => setTimeout(resolve, 3000));
        challengeAttempts++;
      } else {
        progress('No bot challenge detected, proceeding...');
        break;
      }
    }

    // Final check - if still on bot challenge page, retry with fresh browser
    const finalTitle = await page.title();
    progress('Final title check: ' + finalTitle);
    if (finalTitle.includes('Bot or Not') || finalTitle.includes('Access Denied') || finalTitle.includes('Blocked')) {
      progress('Access blocked, closing browser and retrying with fresh instance...');
      await page.close();

      // Close browser and clear instance
      if (browserInstance) {
        await browserInstance.close().catch(() => {});
        browserInstance = null;
        currentProxyConfig = null;
      }

      // Wait before retry
      progress('Waiting 5 seconds before retry...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Try once more with fresh browser
      const retryBrowser = await getBrowser();
      const retryPage = await retryBrowser.newPage();

      await retryPage.setViewport({ width: 1920, height: 1080 });
      await retryPage.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      });

      await retryPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const retryTitle = await retryPage.title();
      progress('Retry title check: ' + retryTitle);

      if (retryTitle.includes('Bot or Not') || retryTitle.includes('Access Denied') || retryTitle.includes('Blocked')) {
        await retryPage.close();
        throw new Error('VRBO access blocked after retry. Your IP may be temporarily blocked. Try again in a few minutes.');
      }

      // Use retry page for the rest of the scrape
      page = retryPage;
    }

    // Wait for page to stabilize
    progress('Waiting for page to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Simulate human-like mouse movements
    progress('Simulating human behavior...');
    for (let i = 0; i < 3; i++) {
      const x = 200 + Math.random() * 1200;
      const y = 150 + Math.random() * 400;
      await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) });
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 500));
    }

    // Random delay like a human reading
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

    // Try to dismiss cookie consent if present
    try {
      const cookieButton = await page.$('[id*="cookie"] button, [class*="cookie"] button, button[id*="accept"], [data-testid*="accept"]');
      if (cookieButton) {
        await cookieButton.click();
        progress('Dismissed cookie consent');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      // Ignore cookie consent errors
    }

    // Try to open the photo gallery to load all images
    progress('Looking for photo gallery...');
    try {
      // Look for gallery trigger buttons/links
      const gallerySelectors = [
        '[data-stid="open-gallery-button"]',
        'button[aria-label*="photo"]',
        'button[aria-label*="image"]',
        'button[aria-label*="gallery"]',
        '[class*="gallery"] button',
        '[class*="photo"] button',
        'a[href*="gallery"]',
        '[data-testid*="gallery"]',
        '[data-testid*="photo"]',
        'figure button',
        '.uitk-gallery button'
      ];

      let galleryOpened = false;
      for (const selector of gallerySelectors) {
        const galleryBtn = await page.$(selector);
        if (galleryBtn) {
          progress('Found gallery button: ' + selector);
          // Move mouse naturally to button
          const box = await galleryBtn.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 15 });
            await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 400));
            await galleryBtn.click();
            galleryOpened = true;
            progress('Clicked gallery button');
            await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
            break;
          }
        }
      }

      // If gallery opened, scroll through it to load all images and collect URLs
      let galleryImageUrls = [];
      if (galleryOpened) {
        progress('Scrolling through gallery...');
        // Wait for gallery to fully load
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Collect images during scroll - use a Set to deduplicate
        const collectedUrls = new Set();

        // Helper function to collect current visible images
        const collectCurrentImages = async () => {
          const urls = await page.evaluate(() => {
            const found = [];
            document.querySelectorAll('img[src]').forEach(img => {
              const src = img.src;
              if (src && src.startsWith('http') &&
                  (src.includes('vrbo') || src.includes('expedia') || src.includes('travel-assets') ||
                   src.includes('trvl-media') || src.includes('lodging') || src.includes('mediaim'))) {
                if (!src.includes('icon') && !src.includes('logo') && !src.includes('flag') &&
                    !src.includes('sprite') && !src.includes('favicon') && !src.includes('50x50')) {
                  found.push(src.split('?')[0]);
                }
              }
            });
            return found;
          });
          urls.forEach(url => collectedUrls.add(url));
        };

        // Collect initial images
        await collectCurrentImages();

        // Try to find and click "next" button multiple times, or scroll
        // Add timeout protection: max 30 seconds or 50 iterations, whichever comes first
        const galleryStartTime = Date.now();
        const GALLERY_TIMEOUT_MS = 30000;
        const MAX_ITERATIONS = 50;
        let lastImageCount = 0;
        let noNewImagesCount = 0;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          // Timeout check
          if (Date.now() - galleryStartTime > GALLERY_TIMEOUT_MS) {
            progress('Gallery timeout reached, stopping collection');
            break;
          }

          const nextBtn = await page.$('button[aria-label*="next"], button[aria-label*="Next"], [class*="next"], [data-testid*="next"], button[data-icon="icon-arrow-right"]');
          if (nextBtn) {
            await nextBtn.click();
            await new Promise(resolve => setTimeout(resolve, 350 + Math.random() * 200));
          } else {
            // Try keyboard navigation
            await page.keyboard.press('ArrowRight');
            await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 150));
          }

          // Collect images after every navigation
          await collectCurrentImages();

          // Check if we're still finding new images
          if (collectedUrls.size === lastImageCount) {
            noNewImagesCount++;
            if (noNewImagesCount >= 5) {
              progress('No new images found, stopping gallery collection');
              break;
            }
          } else {
            noNewImagesCount = 0;
            lastImageCount = collectedUrls.size;
          }
        }

        // Extra wait and final collection
        await new Promise(resolve => setTimeout(resolve, 500));
        await collectCurrentImages();

        galleryImageUrls = Array.from(collectedUrls);
        progress('Collected ' + galleryImageUrls.length + ' images from gallery');

        // Close gallery by pressing Escape
        await page.keyboard.press('Escape');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Store gallery URLs for later merging
      page._galleryImageUrls = galleryImageUrls;
    } catch (e) {
      progress('Gallery interaction error: ' + e.message);
      page._galleryImageUrls = [];
    }

    // Scroll page to load lazy content with human-like behavior
    progress('Scrolling page to load content...');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300 + Math.floor(Math.random() * 200);
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 150 + Math.floor(Math.random() * 100));
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 8000);
      });
    });

    // Wait for images to load
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

    // Get page content
    const html = await page.content();
    progress('Page fetched, extracting data...');

    // Get gallery URLs that were collected earlier
    const galleryUrls = page._galleryImageUrls || [];

    // Save HTML for debugging
    const debugDir = path.join(__dirname, '..', 'debug');
    saveDebugHtml(debugDir, 'vrbo-page.html', html);

    // Close page
    await page.close();

    // Extract JSON-LD data
    const jsonLdData = extractJsonLd(html);
    console.log('Found JSON-LD entries:', jsonLdData.length);

    // Extract property details from HTML
    const propertyDetails = extractPropertyDetails(html);
    console.log('Property title:', propertyDetails.title);
    console.log('Images found:', propertyDetails.images.length);

    // Merge data
    const data = {
      title: propertyDetails.title,
      description: propertyDetails.description,
      propertyType: propertyDetails.propertyType,
      amenities: propertyDetails.amenities,
      location: propertyDetails.location,
      images: propertyDetails.images,
      bedrooms: propertyDetails.bedrooms,
      beds: propertyDetails.beds,
      bathrooms: propertyDetails.bathrooms,
      guests: propertyDetails.guests
    };

    // Extract from JSON-LD if available
    for (const jsonLd of jsonLdData) {
      if (jsonLd['@type'] === 'House' || jsonLd['@type'] === 'Apartment' ||
          jsonLd['@type'] === 'VacationRental' || jsonLd['@type'] === 'LodgingBusiness') {
        data.title = data.title || jsonLd.name;
        data.description = data.description || jsonLd.description;
        data.propertyType = data.propertyType || jsonLd['@type'];
        if (jsonLd.address) {
          data.location.address = data.location.address || jsonLd.address.streetAddress;
          data.location.city = jsonLd.address.addressLocality;
          data.location.country = jsonLd.address.addressCountry;
        }
        if (jsonLd.geo) {
          data.location.lat = jsonLd.geo.latitude;
          data.location.lng = jsonLd.geo.longitude;
        }
        if (jsonLd.image) {
          const images = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
          data.images = [...new Set([...images, ...data.images])];
        }
        // Extract room details from JSON-LD
        if (!data.bedrooms && jsonLd.numberOfRooms) {
          data.bedrooms = parseInt(jsonLd.numberOfRooms);
        }
        if (!data.beds && jsonLd.numberOfBeds) {
          data.beds = parseInt(jsonLd.numberOfBeds);
        }
        if (!data.bathrooms && jsonLd.numberOfBathroomsTotal) {
          data.bathrooms = parseInt(jsonLd.numberOfBathroomsTotal);
        }
        if (!data.guests && jsonLd.occupancy) {
          data.guests = jsonLd.occupancy.maxValue || parseInt(jsonLd.occupancy);
        }
      }
    }

    // Merge gallery URLs with extracted images
    if (galleryUrls && galleryUrls.length > 0) {
      console.log('Merging', galleryUrls.length, 'gallery URLs with', data.images.length, 'HTML images');
      // Filter gallery URLs to valid image extensions
      const validGalleryUrls = galleryUrls.filter(url =>
        url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.webp')
      );
      data.images = [...new Set([...data.images, ...validGalleryUrls])];
      console.log('Total unique images after merge:', data.images.length);
    }

    console.log('Final data:', {
      title: data.title,
      description: data.description?.substring(0, 100) + '...',
      amenities: data.amenities.length,
      images: data.images.length,
      location: data.location
    });

    // Create download directory
    const downloadsDir = path.join(__dirname, '..', 'downloads');
    const folderId = `vrbo_${propertyId}`;
    const downloadDir = path.join(downloadsDir, folderId);
    const imagesDir = path.join(downloadDir, 'images');
    ensureDir(imagesDir);

    // Download images
    const downloadedImages = [];
    progress(`Found ${data.images.length} images to download`);

    for (let i = 0; i < data.images.length; i++) {
      try {
        const imgUrl = data.images[i];
        progress(`Downloading image ${i + 1}/${data.images.length}...`);
        const imgResponse = await downloadImage(imgUrl);

        if (imgResponse.status === 200 && imgResponse.buffer.length > 1000) {
          const ext = getExtensionFromContentType(imgResponse.contentType);
          const imgName = `image_${i + 1}.${ext}`;
          const imgPath = path.join(imagesDir, imgName);
          fs.writeFileSync(imgPath, imgResponse.buffer);
          downloadedImages.push({
            original: imgUrl,
            local: `/downloads/${folderId}/images/${imgName}`
          });
        }
      } catch (imgError) {
        console.log(`Failed to download image ${i + 1}:`, imgError.message);
      }
    }

    // Save metadata
    const metadata = {
      id: folderId,
      folder: folderId,
      platform: 'vrbo',
      title: data.title || 'Untitled',
      description: data.description || '',
      images: downloadedImages,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      propertyType: data.propertyType || '',
      amenities: data.amenities || [],
      location: {
        address: data.location?.address || '',
        city: data.location?.city || '',
        country: data.location?.country || '',
        lat: data.location?.lat || null,
        lng: data.location?.lng || null
      },
      bedrooms: data.bedrooms,
      beds: data.beds,
      bathrooms: data.bathrooms,
      guests: data.guests
    };

    saveMetadata(downloadDir, metadata);

    // Increment browser use count on successful scrape
    browserUseCount++;

    return {
      success: true,
      platform: 'vrbo',
      data: metadata
    };

  } catch (error) {
    await safeClosePage(page);
    throw error;
  }
}

module.exports = {
  scrapeVrboApi,
  extractPropertyId,
  closeBrowser,
  setTorEnabled
};
