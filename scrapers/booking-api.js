/**
 * Booking.com scraper using Puppeteer with stealth
 * Uses browser automation to bypass WAF protection
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
let browserLaunchPromise = null;
let browserUseCount = 0;
const MAX_BROWSER_USES = 10; // Recycle browser after this many scrapes to prevent memory leaks

/**
 * Get or create browser instance (with race condition protection)
 */
async function getBrowser() {
  // If browser exists and is connected, check if we should recycle it
  if (browserInstance && browserInstance.isConnected()) {
    if (browserUseCount >= MAX_BROWSER_USES) {
      console.log('Recycling browser instance after', browserUseCount, 'uses');
      await closeBrowser();
    } else {
      return browserInstance;
    }
  }

  // If a launch is already in progress, wait for it
  if (browserLaunchPromise) {
    await browserLaunchPromise;
    return browserInstance;
  }

  // Start a new launch with lock
  console.log('Launching new browser instance...');
  browserLaunchPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
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
      console.warn('Error closing browser:', err.message);
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
 * Extract property ID from Booking.com URL
 */
function extractPropertyId(url) {
  // URL format: /hotel/es/can-toni-platera.en-gb.html
  const match = url.match(/\/hotel\/[^/]+\/([^.]+)/);
  if (match) {
    return match[1];
  }
  // Fallback: use hash of URL
  return Buffer.from(url).toString('base64').substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Extract data from embedded JavaScript
 */
function extractEmbeddedData(html) {
  const data = {};

  // Look for booking specifics in script tags
  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scriptMatches) {
    // Look for property coordinates
    const coordsMatch = script.match(/b_map_center_latitude['":\s]+(-?[\d.]+)[\s\S]*?b_map_center_longitude['":\s]+(-?[\d.]+)/);
    if (coordsMatch) {
      data.coordinates = {
        lat: parseFloat(coordsMatch[1]),
        lng: parseFloat(coordsMatch[2])
      };
    }

    // Alternative coordinate format
    const latMatch = script.match(/"latitude":\s*(-?[\d.]+)/);
    const lngMatch = script.match(/"longitude":\s*(-?[\d.]+)/);
    if (latMatch && lngMatch && !data.coordinates) {
      data.coordinates = {
        lat: parseFloat(latMatch[1]),
        lng: parseFloat(lngMatch[1])
      };
    }
  }

  return data;
}

/**
 * Extract images from HTML
 */
function extractImages(html) {
  const imageIds = new Set(); // Track unique image IDs to avoid duplicates
  const images = [];
  const imageUrlMap = new Map(); // Store best URL for each image ID

  // Look for all property images from bstatic.com with query params
  const allImgMatches = html.match(/https:\/\/cf\.bstatic\.com\/xdata\/images\/hotel\/[^"'\s)]+/gi) || [];

  for (let imgUrl of allImgMatches) {
    // Clean up URL - remove trailing quotes or brackets
    imgUrl = imgUrl.replace(/["'\]>].*$/, '');

    // Skip non-image URLs
    if (!imgUrl.match(/\.(jpg|jpeg|png|webp)/i)) continue;

    // Filter out small images
    if (imgUrl.includes('square60') ||
        imgUrl.includes('square50') ||
        imgUrl.includes('max50') ||
        imgUrl.includes('max60') ||
        imgUrl.includes('max75') ||
        imgUrl.includes('max100')) {
      continue;
    }

    // Extract image ID (the number before .jpg)
    const idMatch = imgUrl.match(/\/(\d+)\.(jpg|jpeg|png|webp)/i);
    if (idMatch) {
      const imageId = idMatch[1];

      // Prefer larger images (max500 > max300, etc.)
      const currentUrl = imageUrlMap.get(imageId);
      const currentSize = currentUrl ? parseInt((currentUrl.match(/max(\d+)/) || [0, 0])[1]) : 0;
      const newSize = parseInt((imgUrl.match(/max(\d+)/) || [0, 0])[1]);

      if (!currentUrl || newSize > currentSize) {
        imageUrlMap.set(imageId, imgUrl);
      }
    }
  }

  return Array.from(imageUrlMap.values());
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

  // Extract title - multiple patterns
  const titlePatterns = [
    /<h2[^>]*class="[^"]*pp-header__title[^"]*"[^>]*>([^<]+)</i,
    /<h2[^>]*id="hp_hotel_name"[^>]*>\s*([^<\n]+)/i,
    /data-testid="header-title"[^>]*>([^<]+)</i,
    /<meta\s+property="og:title"\s+content="([^"]+)"/i,
    /<title>([^<|]+)/i
  ];

  for (const pattern of titlePatterns) {
    const match = html.match(pattern);
    if (match) {
      data.title = match[1].trim().replace(/\s*[-–|,].*$/, '').trim();
      if (data.title) break;
    }
  }

  // Extract description
  const descPatterns = [
    /<div[^>]*data-testid="property-description"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="property_description_content"[^>]*>([\s\S]*?)<\/div>/i,
    /<meta\s+name="description"\s+content="([^"]+)"/i
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match) {
      data.description = match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (data.description) break;
    }
  }

  // Extract property type
  const typePatterns = [
    /data-testid="property-type-badge"[^>]*>([^<]+)</i,
    /<span[^>]*class="[^"]*bui-badge[^"]*"[^>]*>([^<]+)</i,
    /"accommodationType":"([^"]+)"/i
  ];

  for (const pattern of typePatterns) {
    const match = html.match(pattern);
    if (match) {
      data.propertyType = match[1].trim();
      if (data.propertyType) break;
    }
  }

  // Extract amenities/facilities using text content matching
  const amenityKeywords = [
    'Free WiFi', 'Free parking', 'Private parking', 'Free private parking',
    'Swimming pool', 'Outdoor pool', 'Private pool', 'Indoor pool',
    'Air conditioning', 'Kitchen', 'Kitchenette', 'Washing machine',
    'Garden', 'Terrace', 'Patio', 'Balcony', 'BBQ', 'Fireplace',
    'Private bathroom', 'Bathtub', 'TV', 'Flat-screen TV', 'Cable channels',
    'Heating', 'Dishwasher', 'Microwave', 'Refrigerator', 'Coffee machine',
    'Sea view', 'Mountain view', 'Garden view', 'Pool view', 'City view',
    'Non-smoking', 'Family rooms', 'Pet friendly', 'Pets allowed',
    'Airport shuttle', 'Room service', 'Spa', 'Sauna', 'Fitness',
    'Restaurant', 'Bar', 'Breakfast'
  ];

  const amenityPattern = />([^<]*(?:Free|Private|Pool|WiFi|Kitchen|Air conditioning|Parking|Garden|Terrace|Patio|BBQ|Washing|Fireplace|TV|Balcony|Heating|Dishwasher|Microwave|Refrigerator|Coffee|view|Non-smoking|Pet|Spa|Sauna|Fitness|Restaurant|Bar|Breakfast|Bathtub|bathroom)[^<]*)</gi;
  const matches = [...html.matchAll(amenityPattern)];

  for (const match of matches) {
    const text = match[1].trim();
    if (text.length > 3 && text.length < 60 && !text.includes('{') && !text.includes(':')) {
      data.amenities.push(text);
    }
  }

  // Deduplicate and clean amenities - filter out noise
  const noisePatterns = [
    /spain/i, /deals/i, /review/i, /sign in/i, /overview/i,
    /read all/i, /verified/i, /score/i, /traveller/i, /reservations/i,
    /finally/i, /guest/i, /^view$/i, /awards/i, /spanish/i,
    /real guests/i, /holiday home/i, /^pets$/i
  ];

  data.amenities = [...new Set(data.amenities)]
    .filter(a => {
      // Skip items matching noise patterns
      if (noisePatterns.some(p => p.test(a))) return false;
      // Skip items that are just country/city names or too generic
      if (a.length < 5 && !a.toLowerCase().includes('wifi') && !a.toLowerCase().includes('spa')) return false;
      // Keep shuttle but skip other airport mentions
      if (a.toLowerCase().includes('airport') && !a.toLowerCase().includes('shuttle')) return false;
      return true;
    })
    .slice(0, 25);

  // Extract address
  const addressPatterns = [
    /<span[^>]*data-node_tt_id="location_score_tooltip"[^>]*>([^<]+)</i,
    /class="[^"]*hp_address_subtitle[^"]*"[^>]*>([^<]+)</i,
    /"address":\s*\{[^}]*"streetAddress":\s*"([^"]+)"/i
  ];

  for (const pattern of addressPatterns) {
    const match = html.match(pattern);
    if (match) {
      data.location.address = match[1].trim();
      if (data.location.address) break;
    }
  }

  // Extract room details (bedrooms, beds, bathrooms, guests)
  const bedroomsMatch = html.match(/(\d+)\s*bedroom/i);
  if (bedroomsMatch) data.bedrooms = parseInt(bedroomsMatch[1]);

  const bedsMatch = html.match(/(\d+)\s*bed(?!room)/i);
  if (bedsMatch) data.beds = parseInt(bedsMatch[1]);

  const bathroomsMatch = html.match(/(\d+)\s*bathroom/i);
  if (bathroomsMatch) data.bathrooms = parseInt(bathroomsMatch[1]);

  const guestsMatch = html.match(/(\d+)\s*guest/i);
  if (guestsMatch) data.guests = parseInt(guestsMatch[1]);

  // Extract images
  data.images = extractImages(html);

  return data;
}

/**
 * Main scraping function for Booking.com
 */
async function scrapeBookingApi(url, onProgress = null) {
  const progress = createProgress(onProgress);

  progress('Scraping Booking.com: ' + url);

  // Ensure URL is properly formatted
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  const propertyId = extractPropertyId(url);
  progress('Property ID: ' + propertyId);

  // Get browser and create page
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set extra headers to look more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
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
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
        navigationSuccess = true;
      } catch (navError) {
        console.log(`Navigation attempt ${attempts} failed:`, navError.message);
        if (attempts >= maxAttempts) throw navError;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Wait for page to stabilize (handle potential redirects)
    progress('Waiting for page to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Try to dismiss cookie consent if present
    try {
      const cookieButton = await page.$('[id*="cookie"] button, [class*="cookie"] button, button[id*="accept"], [data-testid*="accept"]');
      if (cookieButton) {
        await cookieButton.click();
        console.log('Dismissed cookie consent');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      // Ignore cookie consent errors
    }

    // Wait for page to be stable - use evaluate instead of networkidle which may not exist
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 });
    } catch (e) {
      console.log('Page ready state timeout, continuing...');
    }

    // Additional wait for any late-loading content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get page content with multiple retry attempts
    let html;
    let contentAttempts = 0;
    const maxContentAttempts = 3;

    while (!html && contentAttempts < maxContentAttempts) {
      contentAttempts++;
      try {
        // Check if we're still on a valid page
        const currentUrl = page.url();
        console.log(`Content attempt ${contentAttempts}, URL: ${currentUrl}`);

        html = await page.content();
      } catch (contentError) {
        console.log(`Content fetch attempt ${contentAttempts} failed:`, contentError.message);
        if (contentAttempts >= maxContentAttempts) {
          // Last resort: close browser and try fresh
          console.log('Closing browser and trying fresh...');
          await page.close().catch(() => {});
          await closeBrowser();

          // Create new browser and page
          const freshBrowser = await getBrowser();
          const freshPage = await freshBrowser.newPage();
          await freshPage.setViewport({ width: 1920, height: 1080 });

          await freshPage.goto(url, { waitUntil: 'load', timeout: 60000 });
          await new Promise(resolve => setTimeout(resolve, 5000));
          html = await freshPage.content();
          await freshPage.close();
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    if (!html) {
      throw new Error('Failed to get page content after multiple attempts');
    }
    console.log('Page fetched, length:', html.length);

    // Save HTML for debugging
    const debugDir = path.join(__dirname, '..', 'debug');
    saveDebugHtml(debugDir, 'booking-page.html', html);

    // Close page
    await page.close();

    // Extract JSON-LD data
    const jsonLdData = extractJsonLd(html);
    console.log('Found JSON-LD entries:', jsonLdData.length);

    // Extract embedded JavaScript data
    const embeddedData = extractEmbeddedData(html);
    console.log('Embedded data keys:', Object.keys(embeddedData));

    // Extract property details from HTML
    const propertyDetails = extractPropertyDetails(html);
    console.log('Property title:', propertyDetails.title);
    console.log('Images found:', propertyDetails.images.length);

    // Merge data from all sources
    const data = {
      title: propertyDetails.title,
      description: propertyDetails.description,
      propertyType: propertyDetails.propertyType,
      amenities: propertyDetails.amenities,
      location: {
        ...propertyDetails.location,
        ...(embeddedData.coordinates || {})
      },
      images: propertyDetails.images,
      bedrooms: propertyDetails.bedrooms,
      beds: propertyDetails.beds,
      bathrooms: propertyDetails.bathrooms,
      guests: propertyDetails.guests
    };

    // Extract from JSON-LD if available
    for (const jsonLd of jsonLdData) {
      if (jsonLd['@type'] === 'Hotel' || jsonLd['@type'] === 'LodgingBusiness' || jsonLd['@type'] === 'VacationRental') {
        data.title = data.title || jsonLd.name;
        data.description = data.description || jsonLd.description;
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
      }
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
    const folderId = `booking_${propertyId}`;
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
          console.log(`Downloaded: ${imgName} (${imgResponse.buffer.length} bytes)`);
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
      platform: 'booking',
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
      platform: 'booking',
      data: metadata
    };

  } catch (error) {
    await safeClosePage(page);
    throw error;
  }
}

module.exports = {
  scrapeBookingApi,
  extractPropertyId,
  closeBrowser
};
