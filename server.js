const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const rateLimit = require('express-rate-limit');

// Simple structured logger
const logger = {
  _format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  },
  info(message, meta) { console.log(this._format('INFO', message, meta)); },
  warn(message, meta) { console.warn(this._format('WARN', message, meta)); },
  error(message, meta) { console.error(this._format('ERROR', message, meta)); },
  debug(message, meta) { if (process.env.DEBUG) console.log(this._format('DEBUG', message, meta)); }
};
// Simple in-memory lock for listing operations to prevent race conditions
const listingLocks = new Map();

async function acquireListingLock(listingId, timeout = 30000) {
  const startTime = Date.now();
  while (listingLocks.has(listingId)) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Lock timeout: listing is being modified by another request');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  listingLocks.set(listingId, Date.now());
}

function releaseListingLock(listingId) {
  listingLocks.delete(listingId);
}

// Clean up stale locks periodically (in case of crashes)
setInterval(() => {
  const now = Date.now();
  const STALE_LOCK_MS = 60000; // 1 minute
  for (const [id, timestamp] of listingLocks.entries()) {
    if (now - timestamp > STALE_LOCK_MS) {
      logger.warn('Cleaning up stale lock', { listingId: id });
      listingLocks.delete(id);
    }
  }
}, 30000);

const { scrapeAirbnbApi, searchAirbnbApi } = require('./scrapers/airbnb-api');
const { scrapeAirbnb, searchAirbnbProperty, proxyManager: airbnbProxyManager } = require('./scrapers/airbnb');
const { scrapeBookingApi, closeBrowser: closeBookingBrowser } = require('./scrapers/booking-api');
const { scrapeVrboApi, closeBrowser: closeVrboBrowser, setTorEnabled: setVrboTorEnabled } = require('./scrapers/vrbo-api');
const { ProxyManager } = require('./scrapers/stealth');

const app = express();
const PORT = process.env.PORT || 30002;

// Safe JSON parse helper - returns defaultValue on parse error
function safeJsonParse(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error('JSON parse error:', e.message);
    return defaultValue;
  }
}

// Standardized API response helpers
function sendSuccess(res, data = {}) {
  return res.json({ success: true, ...data });
}

function sendError(res, statusCode, message, details = null) {
  const response = { success: false, error: message };
  if (details) response.details = details;
  return res.status(statusCode).json(response);
}

// Supported platforms for URL validation
const SUPPORTED_PLATFORMS = ['airbnb.com', 'booking.com', 'vrbo.com'];

// Validate and identify platform from URL
function validateListingUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Check protocol
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'URL must use http or https protocol' };
    }
    // Check hostname against supported platforms
    const hostname = url.hostname.toLowerCase();
    for (const platform of SUPPORTED_PLATFORMS) {
      if (hostname === platform || hostname.endsWith('.' + platform)) {
        return { valid: true, platform: platform.split('.')[0], url: url.href };
      }
    }
    return { valid: false, error: 'Please provide a valid Airbnb, Booking.com, or VRBO URL' };
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// Shared proxy manager
const proxyManager = new ProxyManager();

// CORS configuration - allow localhost origins only for security
const allowedOrigins = [
  'http://localhost:30002',
  'http://127.0.0.1:30002',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or same-origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // For development, also allow any localhost port
    if (origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' })); // Explicit limit for large metadata
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// Request logging middleware (for API routes only)
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
});

// Rate limiting - protect API endpoints from abuse
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 60, // 60 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for scraping endpoints (resource intensive)
const scrapeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 10, // 10 scrapes per minute per IP
  message: { error: 'Too many scrape requests, please wait before trying again' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/scrape', scrapeLimiter);

// Ensure directories exist
const downloadsDir = path.join(__dirname, 'downloads');
const configDir = path.join(__dirname, 'config');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// ============================================
// LISTING LOOKUP HELPER (Optimized)
// ============================================

// Find a listing by ID - returns { metadata, folder, metaPath } or null
async function findListingById(id) {
  if (!fs.existsSync(downloadsDir)) return null;

  const folders = await fsPromises.readdir(downloadsDir);

  // Search in parallel for better performance
  const results = await Promise.all(folders.map(async (folder) => {
    const metaPath = path.join(downloadsDir, folder, 'metadata.json');
    try {
      const content = await fsPromises.readFile(metaPath, 'utf8');
      const metadata = safeJsonParse(content, null);
      if (metadata && metadata.id === id) {
        return { metadata, folder, metaPath };
      }
    } catch {
      // File doesn't exist or can't be read
    }
    return null;
  }));

  return results.find(r => r !== null) || null;
}

// ============================================
// SCRAPING PROGRESS (SSE)
// ============================================

let scrapeProgress = { message: '', timestamp: 0 };
let scrapeProgressClients = [];
const MAX_SSE_CLIENTS = 50;

function removeSSEClient(client) {
  scrapeProgressClients = scrapeProgressClients.filter(c => c !== client);
}

function updateScrapeProgress(message) {
  scrapeProgress = { message, timestamp: Date.now() };
  // Send to all connected SSE clients, remove dead ones
  const deadClients = [];
  scrapeProgressClients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(scrapeProgress)}\n\n`);
    } catch (err) {
      deadClients.push(client);
    }
  });
  // Clean up dead clients
  deadClients.forEach(removeSSEClient);
}

app.get('/api/scrape/progress', (req, res) => {
  // Limit max concurrent SSE clients
  if (scrapeProgressClients.length >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Too many SSE connections' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send current progress immediately
  res.write(`data: ${JSON.stringify(scrapeProgress)}\n\n`);

  // Add client to list
  scrapeProgressClients.push(res);

  // Remove client on disconnect or error
  req.on('close', () => removeSSEClient(res));
  res.on('error', () => removeSSEClient(res));
});

// ============================================
// SCRAPING API
// ============================================

app.post('/api/scrape', async (req, res) => {
  const { url, propertyName, useBrowser } = req.body;

  if (!url && !propertyName) {
    return res.status(400).json({ error: 'URL or property name is required' });
  }

  try {
    let result;
    let scrapedUrl = url;

    if (propertyName) {
      // Search by property name
      console.log(`Searching for property: ${propertyName}`);
      updateScrapeProgress(`Searching for "${propertyName}"...`);
      if (useBrowser) {
        // Use browser-based search (slower, may be blocked)
        result = await searchAirbnbProperty(propertyName);
      } else {
        // Use API-based search (faster, more reliable)
        const searchResult = await searchAirbnbApi(propertyName);
        if (searchResult.results && searchResult.results.length > 0) {
          // Scrape the first result
          const firstResult = searchResult.results[0];
          scrapedUrl = firstResult.url;
          updateScrapeProgress(`Found property, scraping Airbnb...`);
          result = await scrapeAirbnbApi(firstResult.url);
        } else {
          throw new Error(`No results found for "${propertyName}"`);
        }
      }
    } else if (url.includes('airbnb.com')) {
      // Direct URL scrape - use API by default
      updateScrapeProgress('Connecting to Airbnb...');
      if (useBrowser) {
        result = await scrapeAirbnb(url);
      } else {
        result = await scrapeAirbnbApi(url);
      }
    } else if (url.includes('booking.com')) {
      // Booking.com scrape - uses Puppeteer with stealth
      updateScrapeProgress('Launching browser for Booking.com...');
      result = await scrapeBookingApi(url, updateScrapeProgress);
    } else if (url.includes('vrbo.com')) {
      // VRBO scrape - uses Puppeteer with stealth
      updateScrapeProgress('Launching browser for VRBO...');
      result = await scrapeVrboApi(url, updateScrapeProgress);
    } else {
      return res.status(400).json({
        error: 'Please provide a valid Airbnb, Booking.com, or VRBO listing URL.'
      });
    }

    // Check for scraper-level errors (like bot protection)
    if (result.success === false && result.error) {
      return res.status(403).json(result);
    }

    // Check if a listing with the same URL already exists
    if (result.success && scrapedUrl) {
      const mergeResult = await mergeWithExistingListing(scrapedUrl, result);
      if (mergeResult.merged) {
        result.merged = true;
        result.addedImages = mergeResult.addedImages;
        result.addedAmenities = mergeResult.addedAmenities;
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Scraping error:', error);
    const isBotProtection = error.message && error.message.includes('bot protection');
    res.status(isBotProtection ? 403 : 500).json({
      error: isBotProtection ? error.message : 'Failed to scrape listing',
      details: error.message
    });
  }
});

// Helper function to merge new scrape with existing listing
async function mergeWithExistingListing(scrapedUrl, newResult) {
  if (!fs.existsSync(downloadsDir)) return { merged: false };

  const folders = fs.readdirSync(downloadsDir);
  let existingListing = null;
  let existingFolder = null;
  let newFolder = null;

  // Normalize URL for comparison (remove trailing slashes, query params)
  const normalizeUrl = (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  };

  const normalizedScrapedUrl = normalizeUrl(scrapedUrl);

  // Find existing listing with same URL and the new listing
  for (const folder of folders) {
    const metaPath = path.join(downloadsDir, folder, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const metadata = safeJsonParse(fs.readFileSync(metaPath, 'utf8'), {});
      const normalizedExistingUrl = normalizeUrl(metadata.sourceUrl || '');

      if (metadata.id === newResult.id) {
        newFolder = folder;
      } else if (normalizedExistingUrl === normalizedScrapedUrl) {
        existingListing = metadata;
        existingFolder = folder;
      }
    }
  }

  // If no existing listing found, nothing to merge
  if (!existingListing || !newFolder) {
    return { merged: false };
  }

  console.log(`Found existing listing for URL, merging new content...`);

  const existingMetaPath = path.join(downloadsDir, existingFolder, 'metadata.json');
  const newMetaPath = path.join(downloadsDir, newFolder, 'metadata.json');
  const newMetadata = safeJsonParse(fs.readFileSync(newMetaPath, 'utf8'), {});

  // Merge images (copy new images to existing folder, avoid duplicates)
  const existingImages = existingListing.images || [];
  const newImages = newMetadata.images || [];
  const existingImageUrls = new Set(existingImages.map(img => img.original || img.local));

  let addedImages = 0;
  const existingImagesDir = path.join(downloadsDir, existingFolder, 'images');

  for (const newImg of newImages) {
    const imgKey = newImg.original || newImg.local;
    if (!existingImageUrls.has(imgKey)) {
      // Copy image file to existing folder
      if (newImg.local) {
        const srcPath = path.join(__dirname, newImg.local);
        if (fs.existsSync(srcPath)) {
          const filename = path.basename(newImg.local);
          const destPath = path.join(existingImagesDir, filename);
          if (!fs.existsSync(destPath)) {
            try {
              fs.copyFileSync(srcPath, destPath);
            } catch (err) {
              logger.warn('Failed to copy image during merge', { src: srcPath, dest: destPath, error: err.message });
              continue;
            }
          }
          existingImages.push({
            local: `/downloads/${existingFolder}/images/${filename}`,
            original: newImg.original
          });
          addedImages++;
        }
      }
    }
  }

  // Merge amenities (add new ones)
  const existingAmenities = new Set(existingListing.amenities || []);
  const newAmenities = newMetadata.amenities || [];
  let addedAmenities = 0;

  for (const amenity of newAmenities) {
    if (!existingAmenities.has(amenity)) {
      existingAmenities.add(amenity);
      addedAmenities++;
    }
  }

  // Merge house rules
  const existingRules = new Set(existingListing.houseRules || []);
  const newRules = newMetadata.houseRules || [];
  for (const rule of newRules) {
    existingRules.add(rule);
  }

  // Update existing listing metadata
  existingListing.images = existingImages;
  existingListing.amenities = Array.from(existingAmenities);
  existingListing.houseRules = Array.from(existingRules);
  existingListing.lastUpdated = new Date().toISOString();

  // Keep newer title/description if current is empty
  if (!existingListing.title && newMetadata.title) {
    existingListing.title = newMetadata.title;
  }
  if (!existingListing.description && newMetadata.description) {
    existingListing.description = newMetadata.description;
  }

  // Save updated metadata
  try {
    fs.writeFileSync(existingMetaPath, JSON.stringify(existingListing, null, 2));
  } catch (err) {
    logger.error('Failed to save merged metadata', { path: existingMetaPath, error: err.message });
    throw new Error('Failed to save merged listing');
  }

  // Delete the new folder (we merged its content)
  try {
    fs.rmSync(path.join(downloadsDir, newFolder), { recursive: true });
  } catch (err) {
    logger.warn('Failed to delete merged source folder', { folder: newFolder, error: err.message });
    // Non-fatal: continue even if cleanup fails
  }

  console.log(`Merged ${addedImages} new images and ${addedAmenities} new amenities`);

  return { merged: true, addedImages, addedAmenities };
}

// ============================================
// SAVED URLS API
// ============================================

const savedUrlsPath = path.join(configDir, 'saved-urls.json');

// Get all saved URLs
app.get('/api/saved-urls', (req, res) => {
  let savedUrls = [];
  if (fs.existsSync(savedUrlsPath)) {
    savedUrls = safeJsonParse(fs.readFileSync(savedUrlsPath, 'utf8'), []);
  }
  res.json(savedUrls);
});

// Add a new saved URL
app.post('/api/saved-urls', (req, res) => {
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  const validation = validateListingUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  let savedUrls = [];
  if (fs.existsSync(savedUrlsPath)) {
    savedUrls = safeJsonParse(fs.readFileSync(savedUrlsPath, 'utf8'), []);
  }

  // Check for duplicates
  const exists = savedUrls.some(item => item.url === url);
  if (exists) {
    return res.status(400).json({ error: 'This URL is already saved' });
  }

  const newEntry = {
    id: Date.now().toString(),
    name: name.trim(),
    url: url.trim(),
    addedAt: new Date().toISOString()
  };

  savedUrls.push(newEntry);
  try {
    fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));
  } catch (err) {
    logger.error('Failed to save URLs', { error: err.message });
    return res.status(500).json({ error: 'Failed to save URL' });
  }

  res.json({ success: true, entry: newEntry });
});

// Delete a saved URL
app.delete('/api/saved-urls/:id', (req, res) => {
  const { id } = req.params;

  if (!fs.existsSync(savedUrlsPath)) {
    return res.status(404).json({ error: 'No saved URLs found' });
  }

  let savedUrls = safeJsonParse(fs.readFileSync(savedUrlsPath, 'utf8'), []);
  const index = savedUrls.findIndex(item => String(item.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'URL not found' });
  }

  savedUrls.splice(index, 1);
  try {
    fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));
  } catch (err) {
    logger.error('Failed to delete saved URL', { error: err.message });
    return res.status(500).json({ error: 'Failed to delete URL' });
  }

  res.json({ success: true });
});

// Update a saved URL (name)
app.patch('/api/saved-urls/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!fs.existsSync(savedUrlsPath)) {
    return res.status(404).json({ error: 'No saved URLs found' });
  }

  let savedUrls = safeJsonParse(fs.readFileSync(savedUrlsPath, 'utf8'), []);
  const index = savedUrls.findIndex(item => String(item.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'URL not found' });
  }

  if (name) {
    savedUrls[index].name = name.trim();
  }

  try {
    fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));
  } catch (err) {
    logger.error('Failed to update saved URL', { error: err.message });
    return res.status(500).json({ error: 'Failed to update URL' });
  }

  res.json({ success: true, entry: savedUrls[index] });
});

// ============================================
// LISTINGS API
// ============================================

app.get('/api/listings', async (req, res) => {
  try {
    if (!fs.existsSync(downloadsDir)) {
      return res.json([]);
    }

    const folders = await fsPromises.readdir(downloadsDir);

    // Read all metadata files in parallel for better performance
    const metadataPromises = folders.map(async (folder) => {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      try {
        const content = await fsPromises.readFile(metaPath, 'utf8');
        return safeJsonParse(content, null);
      } catch {
        return null; // File doesn't exist or can't be read
      }
    });

    const results = await Promise.all(metadataPromises);
    const listings = results.filter(m => m !== null);

    // Sort by date, newest first
    listings.sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt));

    res.json(listings);
  } catch (error) {
    console.error('Error loading listings:', error);
    res.status(500).json({ error: 'Failed to load listings' });
  }
});

app.delete('/api/listings/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Acquire lock to prevent concurrent modifications
    await acquireListingLock(id);

    try {
      const listing = await findListingById(id);
      if (listing) {
        await fsPromises.rm(path.join(downloadsDir, listing.folder), { recursive: true });
        return res.json({ success: true });
      }
      res.status(404).json({ error: 'Listing not found' });
    } finally {
      releaseListingLock(id);
    }
  } catch (error) {
    if (error.message.includes('Lock timeout')) {
      return res.status(409).json({ error: 'Listing is being modified by another request' });
    }
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// Edit listing metadata (title, description, amenities, images, sourceUrl, location, gps)
app.patch('/api/listings/:id', async (req, res) => {
  const { id } = req.params;
  const { title, sourceUrl, description, location, gps, amenities, images } = req.body;

  try {
    // Acquire lock to prevent concurrent modifications
    await acquireListingLock(id);

    try {
      const listing = await findListingById(id);
      if (!listing) {
        releaseListingLock(id);
        return res.status(404).json({ error: 'Listing not found' });
      }

      const { metadata, folder, metaPath } = listing;

    // Update fields
    if (title !== undefined) metadata.title = title;
    if (sourceUrl !== undefined) metadata.sourceUrl = sourceUrl;
    if (description !== undefined) metadata.description = description;

    // Update location if provided
    if (location !== undefined) {
      if (!metadata.location) metadata.location = {};
      const parts = location.split(',').map(p => p.trim());
      if (parts.length >= 1) metadata.location.address = parts[0] || '';
      if (parts.length >= 2) metadata.location.city = parts[1] || '';
      if (parts.length >= 3) metadata.location.country = parts[2] || '';
    }

    // Update GPS if provided (with bounds validation)
    if (gps !== undefined) {
      if (!metadata.location) metadata.location = {};
      const coords = gps.split(',').map(p => parseFloat(p.trim()));
      if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        const [lat, lng] = coords;
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          metadata.location.lat = lat;
          metadata.location.lng = lng;
        }
      }
    }

    if (amenities !== undefined) metadata.amenities = amenities;
    if (images !== undefined) {
      // Delete removed images from disk
      const oldImages = metadata.images || [];
      const newImagePaths = images.map(img => img.local);
      for (const oldImg of oldImages) {
        if (oldImg.local && !newImagePaths.includes(oldImg.local)) {
          const imgPath = path.join(__dirname, oldImg.local);
          if (fs.existsSync(imgPath)) {
            fs.unlinkSync(imgPath);
          }
        }
      }
      metadata.images = images;
    }
    metadata.editedAt = new Date().toISOString();

    // Save updated metadata
    await fsPromises.writeFile(metaPath, JSON.stringify(metadata, null, 2));

      // Also update description.txt
      if (description !== undefined) {
        await fsPromises.writeFile(path.join(downloadsDir, folder, 'description.txt'), description);
      }

      res.json({ success: true, listing: metadata });
    } finally {
      releaseListingLock(id);
    }
  } catch (error) {
    if (error.message.includes('Lock timeout')) {
      return res.status(409).json({ error: 'Listing is being modified by another request' });
    }
    console.error('Error updating listing:', error);
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// Update listing (re-scrape and aggregate data)
app.post('/api/listings/:id/update', async (req, res) => {
  const { id } = req.params;

  try {
    // Find the existing listing using optimized helper
    const listing = await findListingById(id);
    if (!listing || !listing.metadata.sourceUrl) {
      return res.status(404).json({ error: 'Listing not found or missing source URL' });
    }

    const { metadata: existingMetadata, folder: listingFolder, metaPath } = listing;

    console.log(`Updating listing ${id} from ${existingMetadata.sourceUrl}`);

    // Create backup of existing metadata before re-scraping
    const backupPath = metaPath + '.backup';
    try {
      await fsPromises.copyFile(metaPath, backupPath);
      console.log(`Created backup: ${backupPath}`);
    } catch (backupErr) {
      console.warn('Failed to create backup:', backupErr.message);
    }

    // Progress callback for update operations (logs to console)
    const updateProgress = (msg) => console.log(`[Update ${id}] ${msg}`);

    // Re-scrape the listing based on platform
    let result;
    if (existingMetadata.platform === 'booking' || existingMetadata.sourceUrl.includes('booking.com')) {
      result = await scrapeBookingApi(existingMetadata.sourceUrl, updateProgress);
    } else if (existingMetadata.platform === 'vrbo' || existingMetadata.sourceUrl.includes('vrbo.com')) {
      result = await scrapeVrboApi(existingMetadata.sourceUrl, updateProgress);
    } else {
      result = await scrapeAirbnbApi(existingMetadata.sourceUrl, updateProgress);
    }

    if (!result.success) {
      throw new Error('Failed to re-scrape listing');
    }

    // Load the newly scraped metadata
    const newMetaPath = path.join(downloadsDir, listingFolder, 'metadata.json');
    const newMetadata = safeJsonParse(fs.readFileSync(newMetaPath, 'utf8'), {});

    // Aggregate data - ADDITIVE ONLY: existing data is preserved, new data can only fill gaps
    const aggregatedMetadata = mergeMetadataAdditive(existingMetadata, newMetadata);

    // Calculate new images added
    const newImagesCount = aggregatedMetadata.images.length - (existingMetadata.images || []).length;

    // Save aggregated metadata
    fs.writeFileSync(newMetaPath, JSON.stringify(aggregatedMetadata, null, 2));

    // Remove backup on success
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    res.json({
      success: true,
      newImages: newImagesCount,
      totalImages: aggregatedMetadata.images.length,
      updateCount: aggregatedMetadata.updateCount
    });

  } catch (error) {
    console.error('Update error:', error);

    // Try to restore from backup on failure
    try {
      const listing = await findListingById(req.params.id);
      if (listing) {
        const backupPath = listing.metaPath + '.backup';
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, listing.metaPath);
          console.log('Restored metadata from backup');
        }
      }
    } catch (restoreErr) {
      console.error('Failed to restore backup:', restoreErr.message);
    }

    res.status(500).json({
      error: 'Failed to update listing',
      details: error.message
    });
  }
});

// Helper function to merge images without duplicates
function mergeImages(existingImages, newImages) {
  const imageMap = new Map();

  // Add existing images first
  for (const img of existingImages) {
    const key = img.original || img.local;
    if (key) {
      imageMap.set(key, img);
    }
  }

  // Add new images only if they don't already exist
  for (const img of newImages) {
    const key = img.original || img.local;
    if (key && !imageMap.has(key)) {
      imageMap.set(key, img);
    }
  }

  return Array.from(imageMap.values());
}

// ADDITIVE-ONLY merge: existing data is preserved, new data can only fill empty fields and add to arrays
function mergeMetadataAdditive(existing, newData) {
  const result = { ...existing };

  // Fields that should NEVER be overwritten if they have a value
  const protectedStringFields = [
    'id', 'title', 'description', 'location', 'address', 'city', 'country',
    'propertyType', 'hostName', 'hostAvatar', 'hostAbout', 'hostSuperhost',
    'hostJoined', 'sourceUrl', 'platform', 'currency', 'pricePerNight',
    'originalPrice', 'cleaningFee', 'serviceFee', 'guests', 'bedrooms',
    'beds', 'bathrooms', 'rating', 'reviewCount', 'checkIn', 'checkOut',
    'responseRate', 'responseTime', 'cancellationPolicy', 'coordinates'
  ];

  // Only fill empty string/null fields - NEVER overwrite existing values
  for (const field of protectedStringFields) {
    const existingValue = existing[field];
    const newValue = newData[field];

    // Only update if existing is empty/null/undefined AND new has a value
    if ((existingValue === null || existingValue === undefined || existingValue === '') &&
        newValue !== null && newValue !== undefined && newValue !== '') {
      result[field] = newValue;
    }
    // If existing has a value, keep it (don't overwrite)
  }

  // Array fields: only ADD new items, never remove existing ones
  // Images - merge without duplicates
  result.images = mergeImages(existing.images || [], newData.images || []);

  // Amenities - add new ones, keep all existing
  const existingAmenities = new Set(existing.amenities || []);
  const newAmenities = newData.amenities || [];
  for (const amenity of newAmenities) {
    existingAmenities.add(amenity);
  }
  result.amenities = Array.from(existingAmenities);

  // House rules - add new ones, keep all existing
  const existingRules = new Set(existing.houseRules || []);
  const newRules = newData.houseRules || [];
  for (const rule of newRules) {
    existingRules.add(rule);
  }
  result.houseRules = Array.from(existingRules);

  // Highlights - add new ones, keep all existing
  const existingHighlights = new Set(existing.highlights || []);
  const newHighlights = newData.highlights || [];
  for (const highlight of newHighlights) {
    existingHighlights.add(highlight);
  }
  result.highlights = Array.from(existingHighlights);

  // Safety items - add new ones, keep all existing
  const existingSafety = new Set(existing.safetyItems || []);
  const newSafety = newData.safetyItems || [];
  for (const item of newSafety) {
    existingSafety.add(item);
  }
  result.safetyItems = Array.from(existingSafety);

  // Update tracking metadata
  result.firstScrapedAt = existing.firstScrapedAt || existing.scrapedAt;
  result.lastUpdatedAt = new Date().toISOString();
  result.updateCount = (existing.updateCount || 0) + 1;
  result.updateHistory = [
    ...(existing.updateHistory || []),
    { date: new Date().toISOString() }
  ];

  return result;
}

// Generate listing info text file content
function generateListingInfoText(metadata) {
  const lines = [];

  // Title
  lines.push('Title: ');
  lines.push(metadata.title || '');
  lines.push('');

  // City
  if (metadata.location?.city) {
    lines.push('City: ');
    lines.push(metadata.location.city);
    lines.push('');
  }

  // Country
  if (metadata.location?.country) {
    lines.push('Country: ');
    lines.push(metadata.location.country);
    lines.push('');
  }

  // GPS Coordinates
  if (metadata.location?.lat && metadata.location?.lng) {
    lines.push('GPS Coordinates: ');
    lines.push(String(metadata.location.lat));
    lines.push(String(metadata.location.lng));
    lines.push('');

    lines.push('Google Maps: ');
    lines.push(`https://www.google.com/maps?q=${metadata.location.lat},${metadata.location.lng}`);
    lines.push('');
  }

  // Bedrooms
  if (metadata.bedrooms) {
    lines.push('Bedrooms:');
    lines.push(String(metadata.bedrooms));
    lines.push('');
  }

  // Bathrooms
  if (metadata.bathrooms) {
    lines.push('Bathrooms: ');
    lines.push(String(metadata.bathrooms));
    lines.push('');
  }

  // Property Type
  if (metadata.propertyType) {
    lines.push('Property Type: ');
    lines.push(metadata.propertyType);
    lines.push('');
  }

  // Host Name
  if (metadata.host?.name) {
    lines.push('Host Name: ');
    lines.push(metadata.host.name);
    lines.push('');
  }

  // Description
  lines.push('Description:');
  lines.push(metadata.description || '');
  lines.push('');

  // Amenities
  if (metadata.amenities && metadata.amenities.length > 0) {
    lines.push('Amenities:');
    metadata.amenities.forEach(amenity => {
      lines.push(amenity);
    });
    lines.push('');
  }

  // House Rules
  if (metadata.houseRules && metadata.houseRules.length > 0) {
    lines.push('House Rules:');
    metadata.houseRules.forEach(rule => {
      lines.push(rule);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// Download listing as ZIP
app.get('/api/listings/:id/zip', async (req, res) => {
  const { id } = req.params;

  if (fs.existsSync(downloadsDir)) {
    const folders = fs.readdirSync(downloadsDir);

    for (const folder of folders) {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const metadata = safeJsonParse(fs.readFileSync(metaPath, 'utf8'), {});
        if (metadata.id === id) {
          const folderPath = path.join(downloadsDir, folder);

          // Create a clean filename from the title
          const safeTitle = (metadata.title || folder)
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 50);
          const zipFileName = `${safeTitle}.zip`;

          // Set headers for ZIP download
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

          // Create ZIP using archiver
          const archiver = require('archiver');
          const archive = archiver('zip', { zlib: { level: 9 } });

          archive.on('error', (err) => {
            res.status(500).json({ error: err.message });
          });

          // Pipe archive to response
          archive.pipe(res);

          // Generate and add the info text file
          const infoText = generateListingInfoText(metadata);
          archive.append(infoText, { name: 'listing_info.txt' });

          // Add images with clean names
          const imagesPath = path.join(folderPath, 'images');
          const resolvedImagesPath = path.resolve(imagesPath);
          if (fs.existsSync(imagesPath)) {
            const imageFiles = fs.readdirSync(imagesPath);
            let imgCount = 1;

            for (const file of imageFiles) {
              const filePath = path.join(imagesPath, file);
              const resolvedFilePath = path.resolve(filePath);

              // Path traversal protection: ensure file is within images directory
              if (!resolvedFilePath.startsWith(resolvedImagesPath + path.sep)) {
                logger.warn('Zip path traversal blocked', { file, filePath });
                continue;
              }

              // Ensure it's a file, not a directory
              const stat = fs.statSync(resolvedFilePath);
              if (!stat.isFile()) continue;

              const ext = path.extname(file).toLowerCase() || '.jpg';

              // Keep host_avatar with its name
              if (file.includes('host_avatar')) {
                archive.file(resolvedFilePath, { name: `images/host_avatar${ext}` });
              } else {
                // Rename to img1, img2, etc.
                archive.file(resolvedFilePath, { name: `images/img${imgCount}${ext}` });
                imgCount++;
              }
            }
          }

          // Finalize the archive
          await archive.finalize();
          return;
        }
      }
    }
  }

  res.status(404).json({ error: 'Listing not found' });
});

// ============================================
// CLIP IMAGE DEDUPLICATION
// ============================================

let clipPipeline = null;
let clipModelLoading = false;
let clipModelFailed = false;

// Initialize CLIP model (lazy loading)
async function getClipPipeline() {
  if (clipPipeline) return clipPipeline;
  if (clipModelFailed) return null; // Don't retry if it already failed
  if (clipModelLoading) {
    // Wait for model to load
    while (clipModelLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return clipPipeline;
  }

  clipModelLoading = true;
  console.log('Loading CLIP model (first time only, ~100MB download)...');

  try {
    const { pipeline } = await import('@xenova/transformers');
    clipPipeline = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
    console.log('CLIP model loaded successfully!');
  } catch (error) {
    console.error('Failed to load CLIP model:', error.message);
    clipPipeline = null;
    clipModelFailed = true;
  }

  clipModelLoading = false;
  return clipPipeline;
}

// Check if CLIP is available
function isClipAvailable() {
  return clipPipeline !== null && !clipModelFailed;
}

// Calculate cosine similarity between two vectors
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Get CLIP embedding for an image
async function getImageEmbedding(imagePath) {
  const extractor = await getClipPipeline();
  if (!extractor) return null;

  try {
    // Resolve the full path with path traversal protection
    let fullPath = imagePath;
    if (imagePath.startsWith('/downloads/')) {
      fullPath = path.join(__dirname, imagePath);
    } else if (imagePath.startsWith('downloads/')) {
      fullPath = path.join(__dirname, imagePath);
    } else if (!path.isAbsolute(imagePath)) {
      fullPath = path.join(__dirname, 'public', imagePath);
    }

    // Resolve to absolute path and check for path traversal
    fullPath = path.resolve(fullPath);
    const allowedDirs = [
      path.resolve(__dirname, 'downloads'),
      path.resolve(__dirname, 'public')
    ];
    const isAllowed = allowedDirs.some(dir => fullPath.startsWith(dir + path.sep) || fullPath === dir);
    if (!isAllowed) {
      console.log('Path traversal blocked:', imagePath);
      return null;
    }

    if (!fs.existsSync(fullPath)) {
      console.log('Image not found:', fullPath);
      return null;
    }

    const result = await extractor(fullPath);
    return Array.from(result.data);
  } catch (error) {
    console.error('CLIP embedding error for', imagePath, ':', error.message);
    return null;
  }
}

// Analyze images for similarity using CLIP embeddings
const MAX_IMAGES_FOR_CLIP = 100; // Limit to prevent memory issues

async function analyzeImageSimilarityCLIP(images, threshold = 0.92) {
  // Limit the number of images to prevent memory exhaustion
  if (images.length > MAX_IMAGES_FOR_CLIP) {
    console.warn(`Too many images (${images.length}), limiting to ${MAX_IMAGES_FOR_CLIP}`);
    images = images.slice(0, MAX_IMAGES_FOR_CLIP);
  }

  const embeddings = [];

  console.log(`Computing CLIP embeddings for ${images.length} images...`);

  // Compute embeddings for all images
  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const imgPath = img.local || img;
    console.log(`Getting embedding for image ${i}: ${imgPath}`);
    const embedding = await getImageEmbedding(imgPath);
    if (embedding) {
      successCount++;
    } else {
      failCount++;
      console.log(`  -> FAILED to get embedding`);
    }
    embeddings.push({ index: i, embedding, img });
  }
  console.log(`Embeddings: ${successCount} success, ${failCount} failed`);

  // Find similar pairs
  const processed = new Set();
  const groups = [];

  for (let i = 0; i < embeddings.length; i++) {
    if (processed.has(i)) continue;

    const group = [{ ...embeddings[i].img, originalIndex: i, isDuplicate: false }];
    processed.add(i);

    if (embeddings[i].embedding) {
      for (let j = i + 1; j < embeddings.length; j++) {
        if (processed.has(j)) continue;
        if (!embeddings[j].embedding) continue;

        const similarity = cosineSimilarity(embeddings[i].embedding, embeddings[j].embedding);
        console.log(`Comparing image ${i} vs ${j}: similarity = ${similarity.toFixed(3)}`);
        if (similarity >= threshold) {
          group.push({
            ...embeddings[j].img,
            originalIndex: j,
            isDuplicate: true,
            similarity: similarity.toFixed(3)
          });
          processed.add(j);
        }
      }
    }

    groups.push(group);
  }

  // Flatten groups - sort duplicates by similarity (highest first) so most similar are next to original
  const analyzed = [];
  for (const group of groups) {
    // First image is the original (not duplicate)
    analyzed.push(group[0]);
    // Sort remaining by similarity descending
    const duplicates = group.slice(1).sort((a, b) => parseFloat(b.similarity || 0) - parseFloat(a.similarity || 0));
    for (const img of duplicates) {
      analyzed.push(img);
    }
  }

  const duplicates = analyzed.filter(img => img.isDuplicate).length;
  console.log(`Found ${groups.length} unique images, ${duplicates} duplicates`);

  return {
    images: analyzed,
    groups: groups.length,
    duplicates
  };
}

// API endpoint to analyze image similarity with CLIP
app.post('/api/images/analyze', async (req, res) => {
  const { images, threshold = 0.92 } = req.body;

  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ error: 'Images array is required' });
  }

  // Check if CLIP model is available
  const pipeline = await getClipPipeline();
  if (!pipeline) {
    return res.status(503).json({
      success: false,
      error: 'CLIP model is not available. Image similarity analysis is disabled.'
    });
  }

  try {
    console.log(`Analyzing ${images.length} images with CLIP...`);
    const result = await analyzeImageSimilarityCLIP(images, threshold);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('CLIP analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Preload CLIP model on startup (optional, comment out if you want lazy loading)
getClipPipeline().catch(err => console.log('CLIP preload skipped:', err.message));

// ============================================
// MERGE API
// ============================================

// AI Merge using Ollama
app.post('/api/ai/merge', async (req, res) => {
  const { description1, description2 } = req.body;

  try {
    // Check if Ollama is available
    const axios = require('axios');

    const prompt = `You are helping merge two property descriptions from different platforms (Airbnb and Booking.com) for the same property.

AIRBNB DESCRIPTION:
${description1 || 'N/A'}

BOOKING.COM DESCRIPTION:
${description2 || 'N/A'}

Create a single unified description that:
- Combines the best information from both descriptions
- Removes duplicate information
- Flows naturally as one coherent description
- Keeps it concise but informative

Respond with ONLY the merged description text, no JSON, no quotes, no explanation.`;

    const response = await axios.post('http://localhost:11434/api/generate', {
      model: 'phi3:mini',
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.7
      }
    }, { timeout: 120000 });

    // Get the merged description directly
    const mergedDescription = response.data.response.trim();

    res.json({
      success: true,
      description: mergedDescription
    });

  } catch (error) {
    console.error('AI merge error:', error.message);
    res.json({
      success: false,
      error: error.code === 'ECONNREFUSED' ? 'Ollama is not running. Start it with: ollama serve' : error.message
    });
  }
});

// Save merged listing
app.post('/api/listings/merge', async (req, res) => {
  const { leftId, rightId, merged } = req.body;

  try {
    // Get source listings
    let leftListing = null;
    let rightListing = null;

    if (fs.existsSync(downloadsDir)) {
      const folders = fs.readdirSync(downloadsDir);

      for (const folder of folders) {
        const metaPath = path.join(downloadsDir, folder, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const metadata = safeJsonParse(fs.readFileSync(metaPath, 'utf8'), {});
          if (metadata.id === leftId) leftListing = { ...metadata, folder };
          if (metadata.id === rightId) rightListing = { ...metadata, folder };
        }
      }
    }

    // Determine if we're updating an existing unified listing or creating new
    const isUpdatingExisting = leftListing?.platform === 'unified';

    // Get platforms from both listings
    function getListingPlatforms(listing) {
      if (!listing) return [];
      if (listing.platform === 'unified') {
        return listing.platforms || ['airbnb', 'booking']; // Fallback for old format
      }
      return [listing.platform];
    }

    const leftPlatforms = getListingPlatforms(leftListing);
    const rightPlatforms = getListingPlatforms(rightListing);

    // Merge platforms (deduplicate)
    const allPlatforms = [...new Set([...leftPlatforms, ...rightPlatforms])];

    // Set up folder - use existing if updating, create new otherwise
    let mergedId, mergedFolder, mergedDir, imagesDir;

    if (isUpdatingExisting) {
      // Update the existing unified listing
      mergedId = leftListing.id;
      mergedFolder = leftListing.folder;
      mergedDir = path.join(downloadsDir, mergedFolder);
      imagesDir = path.join(mergedDir, 'images');
      console.log(`Updating existing unified listing: ${mergedId}`);
    } else {
      // Create new merged listing
      mergedId = `unified-${Date.now()}`;
      mergedFolder = `unified_${Date.now()}`;
      mergedDir = path.join(downloadsDir, mergedFolder);
      imagesDir = path.join(mergedDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      console.log(`Creating new unified listing: ${mergedId}`);
    }

    // Copy images from sources
    const mergedImages = [];
    const imagesToCopy = merged.images || [];
    for (const img of imagesToCopy) {
      if (img.local) {
        const sourcePath = path.join(__dirname, 'public', img.local);
        const altSourcePath = path.join(__dirname, img.local);
        const actualSource = fs.existsSync(sourcePath) ? sourcePath : altSourcePath;

        if (fs.existsSync(actualSource)) {
          const filename = path.basename(img.local);
          const destPath = path.join(imagesDir, filename);
          // Only copy if not already in destination
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(actualSource, destPath);
          }
          mergedImages.push({
            local: `/downloads/${mergedFolder}/images/${filename}`,
            original: img.original
          });
        } else {
          // Keep original reference if can't copy
          mergedImages.push(img);
        }
      }
    }

    // Build sources object - merge existing sources with new ones
    const existingSources = leftListing?.sources || {};
    const newSources = { ...existingSources };

    // Add source info from left if it's a single platform listing
    if (leftListing && leftListing.platform !== 'unified') {
      newSources[leftListing.platform] = {
        id: leftListing.id,
        url: leftListing.sourceUrl,
        title: leftListing.title
      };
    }

    // Add source info from right
    if (rightListing && rightListing.platform !== 'unified') {
      newSources[rightListing.platform] = {
        id: rightListing.id,
        url: rightListing.sourceUrl,
        title: rightListing.title
      };
    } else if (rightListing && rightListing.platform === 'unified') {
      // Merge sources from unified right listing
      Object.assign(newSources, rightListing.sources || {});
    }

    // Build merged metadata
    const mergedMetadata = {
      id: mergedId,
      platform: 'unified',
      platforms: allPlatforms, // Dynamic platforms array
      title: merged.title || 'Merged Listing',
      description: merged.description || '',
      amenities: merged.amenities || [],
      images: mergedImages,
      sources: newSources,
      location: merged.location || leftListing?.location || rightListing?.location || {},
      host: leftListing?.host || rightListing?.host || {},
      pricing: {
        ...(leftListing?.pricing && leftListing.platform !== 'unified' ? { [leftListing.platform]: leftListing.pricing } : {}),
        ...(leftListing?.pricing && leftListing.platform === 'unified' ? leftListing.pricing : {}),
        ...(rightListing?.pricing && rightListing.platform !== 'unified' ? { [rightListing.platform]: rightListing.pricing } : {}),
        ...(rightListing?.pricing && rightListing.platform === 'unified' ? rightListing.pricing : {})
      },
      sourceUrl: leftListing?.sourceUrl || rightListing?.sourceUrl || '',
      folder: mergedFolder,
      scrapedAt: isUpdatingExisting ? (leftListing.scrapedAt || new Date().toISOString()) : new Date().toISOString(),
      mergedAt: new Date().toISOString(),
      updatedAt: isUpdatingExisting ? new Date().toISOString() : undefined
    };

    // Save metadata
    fs.writeFileSync(
      path.join(mergedDir, 'metadata.json'),
      JSON.stringify(mergedMetadata, null, 2)
    );

    // Save description
    fs.writeFileSync(
      path.join(mergedDir, 'description.txt'),
      merged.description || ''
    );

    res.json({
      success: true,
      listing: mergedMetadata,
      updated: isUpdatingExisting
    });

  } catch (error) {
    console.error('Merge save error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// PROXY MANAGEMENT API
// ============================================

app.get('/api/proxies', (req, res) => {
  res.json({
    proxies: proxyManager.proxies,
    count: proxyManager.proxies.length
  });
});

app.post('/api/proxies', (req, res) => {
  const { host, port, username, password, type = 'http', residential = false } = req.body;

  if (!host || !port) {
    return res.status(400).json({ error: 'Host and port are required' });
  }

  const proxy = {
    host,
    port: parseInt(port),
    username: username || null,
    password: password || null,
    type,
    residential
  };

  proxyManager.addProxy(proxy);

  res.json({
    success: true,
    proxy,
    totalProxies: proxyManager.proxies.length
  });
});

app.post('/api/proxies/bulk', (req, res) => {
  const { proxies } = req.body;

  if (!Array.isArray(proxies)) {
    return res.status(400).json({ error: 'Proxies must be an array' });
  }

  let added = 0;
  for (const p of proxies) {
    if (p.host && p.port) {
      proxyManager.addProxy({
        host: p.host,
        port: parseInt(p.port),
        username: p.username || null,
        password: p.password || null,
        type: p.type || 'http',
        residential: p.residential || false
      });
      added++;
    }
  }

  res.json({
    success: true,
    added,
    totalProxies: proxyManager.proxies.length
  });
});

app.delete('/api/proxies/:index', (req, res) => {
  const index = parseInt(req.params.index);

  if (index >= 0 && index < proxyManager.proxies.length) {
    proxyManager.proxies.splice(index, 1);
    proxyManager.saveProxies();
    res.json({ success: true, totalProxies: proxyManager.proxies.length });
  } else {
    res.status(404).json({ error: 'Proxy not found' });
  }
});

app.delete('/api/proxies', (req, res) => {
  proxyManager.proxies = [];
  proxyManager.saveProxies();
  res.json({ success: true });
});

// Test a proxy
app.post('/api/proxies/test', async (req, res) => {
  const { host, port, username, password, type = 'http' } = req.body;

  if (!host || !port) {
    return res.status(400).json({ error: 'Host and port are required' });
  }

  try {
    const axios = require('axios');
    const HttpsProxyAgent = require('https-proxy-agent');

    // URL-encode credentials to handle special characters safely
    const proxyUrl = username
      ? `${type}://${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@${host}:${port}`
      : `${type}://${host}:${port}`;

    const agent = new HttpsProxyAgent(proxyUrl);

    const startTime = Date.now();
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      timeout: 10000
    });
    const latency = Date.now() - startTime;

    res.json({
      success: true,
      ip: response.data.ip,
      latency: `${latency}ms`
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// TOR API
// ============================================

const { execFile } = require('child_process');
const net = require('net');

// Tor settings state
let torEnabled = false;  // Default off - user must enable manually
const TOR_SOCKS_PORT = 9050;
const TOR_CONTROL_PORT = 9051;

// Get Tor status
app.get('/api/tor/status', async (req, res) => {
  try {
    // Check if Tor service is running
    const isRunning = await checkTorRunning();

    let currentIp = null;
    if (isRunning && torEnabled) {
      currentIp = await getTorIp();
    }

    res.json({
      enabled: torEnabled,
      running: isRunning,
      currentIp,
      socksPort: TOR_SOCKS_PORT
    });
  } catch (error) {
    res.json({
      enabled: torEnabled,
      running: false,
      error: error.message
    });
  }
});

// Toggle Tor on/off
app.post('/api/tor/toggle', async (req, res) => {
  const { enabled } = req.body;

  try {
    const isRunning = await checkTorRunning();

    if (enabled && !isRunning) {
      // Start Tor service
      await startTorService();
    }

    torEnabled = enabled;
    setVrboTorEnabled(enabled);  // Sync VRBO scraper Tor setting

    // Save to settings
    const settingsPath = path.join(configDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = safeJsonParse(fs.readFileSync(settingsPath, 'utf8'), {});
    }
    settings.torEnabled = torEnabled;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    res.json({
      success: true,
      enabled: torEnabled,
      running: await checkTorRunning()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test Tor connection
app.post('/api/tor/test', async (req, res) => {
  try {
    const isRunning = await checkTorRunning();

    if (!isRunning) {
      return res.json({
        success: false,
        error: 'Tor service is not running',
        blocked: false
      });
    }

    // Test connection through Tor
    const axios = require('axios');
    const { SocksProxyAgent } = require('socks-proxy-agent');

    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${TOR_SOCKS_PORT}`);

    const startTime = Date.now();

    // First check Tor Project API
    const torCheck = await axios.get('https://check.torproject.org/api/ip', {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 30000
    });

    const latency = Date.now() - startTime;

    // Try to get geolocation info
    let country = 'Unknown';
    let city = 'Unknown';
    try {
      const geoResponse = await axios.get(`http://ip-api.com/json/${torCheck.data.IP}`, {
        timeout: 10000
      });
      country = geoResponse.data.country || 'Unknown';
      city = geoResponse.data.city || 'Unknown';
    } catch (geoError) {
      console.warn('Geolocation lookup failed:', geoError.message);
    }

    res.json({
      success: true,
      isTor: torCheck.data.IsTor,
      ip: torCheck.data.IP,
      country,
      city,
      latency: `${latency}ms`,
      blocked: false
    });
  } catch (error) {
    // Check if it's a connection issue (might be blocked)
    const isBlocked = error.code === 'ECONNREFUSED' ||
                      error.code === 'ETIMEDOUT' ||
                      error.code === 'ENOTFOUND' ||
                      error.message.includes('timeout');

    res.json({
      success: false,
      error: error.message,
      blocked: isBlocked,
      suggestion: isBlocked ? 'Tor might be blocked in your region. Try using bridges or a VPN.' : null
    });
  }
});

// Request new Tor circuit (new IP)
app.post('/api/tor/new-circuit', async (req, res) => {
  try {
    // Send NEWNYM signal to Tor control port
    // This requires ControlPort to be enabled in torrc
    const result = await requestNewCircuit();

    // Wait for new circuit to establish
    await new Promise(r => setTimeout(r, 3000));

    // Get new IP
    const newIp = await getTorIp();

    res.json({
      success: true,
      newIp,
      message: 'New Tor circuit established'
    });
  } catch (error) {
    // Fallback: restart Tor service
    try {
      await restartTorService();
      await new Promise(r => setTimeout(r, 5000));
      const newIp = await getTorIp();

      res.json({
        success: true,
        newIp,
        message: 'Tor service restarted for new IP'
      });
    } catch (e) {
      res.status(500).json({
        success: false,
        error: 'Could not get new circuit: ' + error.message
      });
    }
  }
});

// Helper functions for Tor
async function checkTorRunning() {
  return new Promise((resolve) => {
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
      socket.destroy();
      resolve(false);
    });

    socket.connect(TOR_SOCKS_PORT, '127.0.0.1');
  });
}

async function getTorIp() {
  const axios = require('axios');
  const { SocksProxyAgent } = require('socks-proxy-agent');

  const agent = new SocksProxyAgent(`socks5://127.0.0.1:${TOR_SOCKS_PORT}`);

  const response = await axios.get('https://check.torproject.org/api/ip', {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 30000
  });

  return response.data.IP;
}

async function startTorService() {
  return new Promise((resolve, reject) => {
    // Use execFile instead of exec to prevent command injection
    execFile('brew', ['services', 'start', 'tor'], (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        // Wait for Tor to start
        setTimeout(resolve, 5000);
      }
    });
  });
}

async function restartTorService() {
  return new Promise((resolve, reject) => {
    // Use execFile instead of exec to prevent command injection
    execFile('brew', ['services', 'restart', 'tor'], (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        setTimeout(resolve, 5000);
      }
    });
  });
}

async function requestNewCircuit() {
  // This requires Tor control port to be enabled
  // For now, we'll use service restart as fallback
  return new Promise((resolve, reject) => {
    // Use execFile instead of exec to prevent command injection
    execFile('killall', ['-HUP', 'tor'], (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Export Tor state for scrapers
function isTorEnabled() {
  return torEnabled;
}

function getTorProxy() {
  return torEnabled ? {
    host: '127.0.0.1',
    port: TOR_SOCKS_PORT,
    type: 'socks5'
  } : null;
}

module.exports = { isTorEnabled, getTorProxy };

// ============================================
// SETTINGS API
// ============================================

app.get('/api/settings', (req, res) => {
  const settingsPath = path.join(configDir, 'settings.json');
  let settings = {
    stealth: {
      blockBotDetection: true,
      randomizeTimezone: true,
      randomizeFingerprint: true,
      humanDelays: true
    },
    torEnabled: false  // Default off
  };

  if (fs.existsSync(settingsPath)) {
    settings = safeJsonParse(fs.readFileSync(settingsPath, 'utf8'), {});
    // Restore Tor state from settings
    if (settings.torEnabled !== undefined) {
      torEnabled = settings.torEnabled;
      setVrboTorEnabled(settings.torEnabled);
    }
  }

  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const settingsPath = path.join(configDir, 'settings.json');

  // Whitelist allowed settings keys and validate types
  const allowedSettings = {
    stealth: {
      blockBotDetection: 'boolean',
      randomizeTimezone: 'boolean',
      randomizeFingerprint: 'boolean',
      humanDelays: 'boolean'
    },
    torEnabled: 'boolean'
  };

  const validated = {};

  // Validate stealth settings
  if (req.body.stealth && typeof req.body.stealth === 'object') {
    validated.stealth = {};
    for (const key of Object.keys(allowedSettings.stealth)) {
      if (typeof req.body.stealth[key] === 'boolean') {
        validated.stealth[key] = req.body.stealth[key];
      }
    }
  }

  // Validate torEnabled
  if (typeof req.body.torEnabled === 'boolean') {
    validated.torEnabled = req.body.torEnabled;
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(validated, null, 2));
  } catch (err) {
    logger.error('Failed to save settings', { error: err.message });
    return res.status(500).json({ error: 'Failed to save settings' });
  }

  res.json({ success: true, settings: validated });
});

// ============================================
// BROWSER PROFILES API
// ============================================

app.get('/api/profiles', (req, res) => {
  const profilesDir = path.join(__dirname, 'browser_profiles');
  const profiles = [];

  if (fs.existsSync(profilesDir)) {
    const folders = fs.readdirSync(profilesDir);
    for (const folder of folders) {
      const stat = fs.statSync(path.join(profilesDir, folder));
      profiles.push({
        name: folder,
        size: getDirectorySize(path.join(profilesDir, folder)),
        lastModified: stat.mtime
      });
    }
  }

  res.json(profiles);
});

app.delete('/api/profiles/:name', (req, res) => {
  const profilesDir = path.join(__dirname, 'browser_profiles');
  const profileName = req.params.name;

  // Validate profile name (no path traversal characters)
  if (!profileName || /[\/\\\.]{2,}|^\.\.?$/.test(profileName)) {
    return res.status(400).json({ error: 'Invalid profile name' });
  }

  const profilePath = path.join(profilesDir, profileName);
  const resolvedPath = path.resolve(profilePath);
  const resolvedProfilesDir = path.resolve(profilesDir);

  // Path traversal protection: ensure profile path is within profiles directory
  if (!resolvedPath.startsWith(resolvedProfilesDir + path.sep)) {
    logger.warn('Profile delete path traversal blocked', { profileName, resolvedPath });
    return res.status(400).json({ error: 'Invalid profile path' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  // Verify it's a directory
  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Invalid profile' });
  }

  try {
    fs.rmSync(resolvedPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete profile', { profileName, error: err.message });
    res.status(500).json({ error: 'Failed to delete profile' });
  }
});

function getDirectorySize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        size += getDirectorySize(filePath);
      } else {
        size += stat.size;
      }
    }
  } catch (err) {
    console.warn('Error calculating directory size:', dirPath, err.message);
  }
  return formatBytes(size);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`UNIDOWN server running at http://localhost:${PORT}`);
  console.log(`Proxies loaded: ${proxyManager.proxies.length}`);
});
