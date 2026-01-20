const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const imghash = require('imghash');
const { scrapeAirbnbApi, searchAirbnbApi } = require('./scrapers/airbnb-api');
const { scrapeAirbnb, searchAirbnbProperty, proxyManager: airbnbProxyManager } = require('./scrapers/airbnb');
const { scrapeBookingApi, closeBrowser: closeBookingBrowser } = require('./scrapers/booking-api');
const { ProxyManager } = require('./scrapers/stealth');

const app = express();
const PORT = process.env.PORT || 30002;

// Shared proxy manager
const proxyManager = new ProxyManager();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

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
// SCRAPING API
// ============================================

app.post('/api/scrape', async (req, res) => {
  const { url, propertyName, useBrowser } = req.body;

  if (!url && !propertyName) {
    return res.status(400).json({ error: 'URL or property name is required' });
  }

  try {
    let result;

    if (propertyName) {
      // Search by property name
      console.log(`Searching for property: ${propertyName}`);
      if (useBrowser) {
        // Use browser-based search (slower, may be blocked)
        result = await searchAirbnbProperty(propertyName);
      } else {
        // Use API-based search (faster, more reliable)
        const searchResult = await searchAirbnbApi(propertyName);
        if (searchResult.results && searchResult.results.length > 0) {
          // Scrape the first result
          const firstResult = searchResult.results[0];
          result = await scrapeAirbnbApi(firstResult.url);
        } else {
          throw new Error(`No results found for "${propertyName}"`);
        }
      }
    } else if (url.includes('airbnb.com')) {
      // Direct URL scrape - use API by default
      if (useBrowser) {
        result = await scrapeAirbnb(url);
      } else {
        result = await scrapeAirbnbApi(url);
      }
    } else if (url.includes('booking.com')) {
      // Booking.com scrape - uses Puppeteer with stealth
      result = await scrapeBookingApi(url);
    } else {
      return res.status(400).json({
        error: 'Please provide a valid Airbnb or Booking.com listing URL.'
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({
      error: 'Failed to scrape listing',
      details: error.message
    });
  }
});

// ============================================
// SAVED URLS API
// ============================================

const savedUrlsPath = path.join(configDir, 'saved-urls.json');

// Get all saved URLs
app.get('/api/saved-urls', (req, res) => {
  let savedUrls = [];
  if (fs.existsSync(savedUrlsPath)) {
    savedUrls = JSON.parse(fs.readFileSync(savedUrlsPath, 'utf8'));
  }
  res.json(savedUrls);
});

// Add a new saved URL
app.post('/api/saved-urls', (req, res) => {
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  if (!url.includes('airbnb.com') && !url.includes('booking.com')) {
    return res.status(400).json({ error: 'Please provide a valid Airbnb or Booking.com URL' });
  }

  let savedUrls = [];
  if (fs.existsSync(savedUrlsPath)) {
    savedUrls = JSON.parse(fs.readFileSync(savedUrlsPath, 'utf8'));
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
  fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));

  res.json({ success: true, entry: newEntry });
});

// Delete a saved URL
app.delete('/api/saved-urls/:id', (req, res) => {
  const { id } = req.params;

  if (!fs.existsSync(savedUrlsPath)) {
    return res.status(404).json({ error: 'No saved URLs found' });
  }

  let savedUrls = JSON.parse(fs.readFileSync(savedUrlsPath, 'utf8'));
  const index = savedUrls.findIndex(item => item.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'URL not found' });
  }

  savedUrls.splice(index, 1);
  fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));

  res.json({ success: true });
});

// Update a saved URL (name)
app.patch('/api/saved-urls/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!fs.existsSync(savedUrlsPath)) {
    return res.status(404).json({ error: 'No saved URLs found' });
  }

  let savedUrls = JSON.parse(fs.readFileSync(savedUrlsPath, 'utf8'));
  const index = savedUrls.findIndex(item => item.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'URL not found' });
  }

  if (name) {
    savedUrls[index].name = name.trim();
  }

  fs.writeFileSync(savedUrlsPath, JSON.stringify(savedUrls, null, 2));

  res.json({ success: true, entry: savedUrls[index] });
});

// ============================================
// LISTINGS API
// ============================================

app.get('/api/listings', (req, res) => {
  const listings = [];

  if (fs.existsSync(downloadsDir)) {
    const folders = fs.readdirSync(downloadsDir);

    for (const folder of folders) {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        listings.push(metadata);
      }
    }
  }

  // Sort by date, newest first
  listings.sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt));

  res.json(listings);
});

app.delete('/api/listings/:id', (req, res) => {
  const { id } = req.params;

  if (fs.existsSync(downloadsDir)) {
    const folders = fs.readdirSync(downloadsDir);

    for (const folder of folders) {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (metadata.id === id) {
          // Delete the folder
          fs.rmSync(path.join(downloadsDir, folder), { recursive: true });
          return res.json({ success: true });
        }
      }
    }
  }

  res.status(404).json({ error: 'Listing not found' });
});

// Edit listing metadata (title, description, amenities, images)
app.patch('/api/listings/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, amenities, images } = req.body;

  if (fs.existsSync(downloadsDir)) {
    const folders = fs.readdirSync(downloadsDir);

    for (const folder of folders) {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (metadata.id === id) {
          // Update fields
          if (title !== undefined) metadata.title = title;
          if (description !== undefined) metadata.description = description;
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
          fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

          // Also update description.txt
          if (description !== undefined) {
            fs.writeFileSync(path.join(downloadsDir, folder, 'description.txt'), description);
          }

          return res.json({ success: true, listing: metadata });
        }
      }
    }
  }

  res.status(404).json({ error: 'Listing not found' });
});

// Update listing (re-scrape and aggregate data)
app.post('/api/listings/:id/update', async (req, res) => {
  const { id } = req.params;

  try {
    // Find the existing listing
    let existingMetadata = null;
    let listingFolder = null;

    if (fs.existsSync(downloadsDir)) {
      const folders = fs.readdirSync(downloadsDir);

      for (const folder of folders) {
        const metaPath = path.join(downloadsDir, folder, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (metadata.id === id) {
            existingMetadata = metadata;
            listingFolder = folder;
            break;
          }
        }
      }
    }

    if (!existingMetadata || !existingMetadata.sourceUrl) {
      return res.status(404).json({ error: 'Listing not found or missing source URL' });
    }

    console.log(`Updating listing ${id} from ${existingMetadata.sourceUrl}`);

    // Re-scrape the listing based on platform
    let result;
    if (existingMetadata.platform === 'booking' || existingMetadata.sourceUrl.includes('booking.com')) {
      result = await scrapeBookingApi(existingMetadata.sourceUrl);
    } else {
      result = await scrapeAirbnbApi(existingMetadata.sourceUrl);
    }

    if (!result.success) {
      throw new Error('Failed to re-scrape listing');
    }

    // Load the newly scraped metadata
    const newMetaPath = path.join(downloadsDir, listingFolder, 'metadata.json');
    const newMetadata = JSON.parse(fs.readFileSync(newMetaPath, 'utf8'));

    // Aggregate data - merge existing with new
    const aggregatedMetadata = {
      ...newMetadata,
      // Keep the original scraped date, add update date
      firstScrapedAt: existingMetadata.firstScrapedAt || existingMetadata.scrapedAt,
      scrapedAt: new Date().toISOString(),
      // Merge images (avoid duplicates based on original URL)
      images: mergeImages(existingMetadata.images || [], newMetadata.images || []),
      // Merge amenities (avoid duplicates)
      amenities: [...new Set([...(existingMetadata.amenities || []), ...(newMetadata.amenities || [])])],
      // Merge house rules (avoid duplicates)
      houseRules: [...new Set([...(existingMetadata.houseRules || []), ...(newMetadata.houseRules || [])])],
      // Keep non-null values (prefer new data, but keep old if new is empty)
      description: newMetadata.description || existingMetadata.description,
      title: newMetadata.title || existingMetadata.title,
      // Keep historical data
      updateCount: (existingMetadata.updateCount || 0) + 1,
      updateHistory: [
        ...(existingMetadata.updateHistory || []),
        { date: new Date().toISOString() }
      ]
    };

    // Calculate new images added
    const newImagesCount = aggregatedMetadata.images.length - (existingMetadata.images || []).length;

    // Save aggregated metadata
    fs.writeFileSync(newMetaPath, JSON.stringify(aggregatedMetadata, null, 2));

    res.json({
      success: true,
      newImages: newImagesCount,
      totalImages: aggregatedMetadata.images.length,
      updateCount: aggregatedMetadata.updateCount
    });

  } catch (error) {
    console.error('Update error:', error);
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

  // Add new images (will overwrite if same URL)
  for (const img of newImages) {
    const key = img.original || img.local;
    if (key && !imageMap.has(key)) {
      imageMap.set(key, img);
    }
  }

  return Array.from(imageMap.values());
}

// Download listing as ZIP
app.get('/api/listings/:id/zip', async (req, res) => {
  const { id } = req.params;

  if (fs.existsSync(downloadsDir)) {
    const folders = fs.readdirSync(downloadsDir);

    for (const folder of folders) {
      const metaPath = path.join(downloadsDir, folder, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (metadata.id === id) {
          const folderPath = path.join(downloadsDir, folder);
          const zipFileName = `${folder}.zip`;

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

          // Add the folder contents to the archive
          archive.directory(folderPath, folder);

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
// IMAGE DEDUPLICATION (Perceptual Hashing)
// ============================================

// Calculate hamming distance between two hashes
function hammingDistance(hash1, hash2) {
  if (hash1.length !== hash2.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return distance;
}

// Get perceptual hash for an image
async function getImageHash(imagePath) {
  try {
    // Resolve the full path
    let fullPath = imagePath;
    if (imagePath.startsWith('/downloads/')) {
      fullPath = path.join(__dirname, imagePath);
    } else if (imagePath.startsWith('downloads/')) {
      fullPath = path.join(__dirname, imagePath);
    } else if (!path.isAbsolute(imagePath)) {
      fullPath = path.join(__dirname, 'public', imagePath);
    }

    if (!fs.existsSync(fullPath)) {
      console.log('Image not found:', fullPath);
      return null;
    }

    const hash = await imghash.hash(fullPath, 16); // 16-bit hash for good balance
    return hash;
  } catch (error) {
    console.error('Hash error for', imagePath, ':', error.message);
    return null;
  }
}

// Deduplicate images based on perceptual hash
async function deduplicateImages(images, threshold = 5) {
  const uniqueImages = [];
  const hashes = [];

  for (const img of images) {
    const imgPath = img.local || img;
    const hash = await getImageHash(imgPath);

    if (!hash) {
      // Can't hash, keep the image anyway
      uniqueImages.push(img);
      continue;
    }

    // Check if this hash is similar to any existing hash
    let isDuplicate = false;
    for (const existingHash of hashes) {
      const distance = hammingDistance(hash, existingHash);
      if (distance <= threshold) {
        isDuplicate = true;
        console.log(`Duplicate found: distance=${distance}, threshold=${threshold}`);
        break;
      }
    }

    if (!isDuplicate) {
      uniqueImages.push(img);
      hashes.push(hash);
    }
  }

  return uniqueImages;
}

// Analyze images and return with similarity grouping
async function analyzeImageSimilarity(images, threshold = 5) {
  const results = [];
  const hashes = [];

  // First pass: compute all hashes
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const imgPath = img.local || img;
    const hash = await getImageHash(imgPath);
    hashes.push({ index: i, hash, img });
  }

  // Second pass: find similar pairs and group them
  const processed = new Set();
  const groups = [];

  for (let i = 0; i < hashes.length; i++) {
    if (processed.has(i)) continue;

    const group = [{ ...hashes[i].img, originalIndex: i, isDuplicate: false }];
    processed.add(i);

    if (hashes[i].hash) {
      for (let j = i + 1; j < hashes.length; j++) {
        if (processed.has(j)) continue;
        if (!hashes[j].hash) continue;

        const distance = hammingDistance(hashes[i].hash, hashes[j].hash);
        if (distance <= threshold) {
          group.push({ ...hashes[j].img, originalIndex: j, isDuplicate: true, similarity: distance });
          processed.add(j);
        }
      }
    }

    groups.push(group);
  }

  // Flatten groups - first item is unique (green), rest are duplicates (red)
  const analyzed = [];
  for (const group of groups) {
    for (const img of group) {
      analyzed.push(img);
    }
  }

  return {
    images: analyzed,
    groups: groups.length,
    duplicates: analyzed.filter(img => img.isDuplicate).length
  };
}

// API endpoint to analyze image similarity (for merge UI)
app.post('/api/images/analyze', async (req, res) => {
  const { images, threshold = 5 } = req.body;

  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ error: 'Images array is required' });
  }

  try {
    console.log(`Analyzing ${images.length} images for similarity...`);
    const result = await analyzeImageSimilarity(images, threshold);
    console.log(`Found ${result.groups} groups, ${result.duplicates} duplicates`);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to deduplicate images
app.post('/api/images/dedupe', async (req, res) => {
  const { images, threshold = 5 } = req.body;

  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ error: 'Images array is required' });
  }

  try {
    console.log(`Deduplicating ${images.length} images with threshold ${threshold}...`);
    const uniqueImages = await deduplicateImages(images, threshold);
    const removed = images.length - uniqueImages.length;

    console.log(`Removed ${removed} duplicates, ${uniqueImages.length} unique images remain`);

    res.json({
      success: true,
      original: images.length,
      unique: uniqueImages.length,
      removed,
      images: uniqueImages
    });
  } catch (error) {
    console.error('Dedupe error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
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

    // Deduplicate images using perceptual hashing before copying
    console.log(`Deduplicating ${merged.images?.length || 0} images...`);
    const uniqueImages = await deduplicateImages(merged.images || [], 5);
    console.log(`After dedup: ${uniqueImages.length} unique images`);

    // Copy images from sources
    const mergedImages = [];
    for (const img of uniqueImages) {
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
      location: leftListing?.location || rightListing?.location || {},
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

    const proxyUrl = username
      ? `${type}://${username}:${password}@${host}:${port}`
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

const { exec } = require('child_process');
const net = require('net');

// Tor settings state
let torEnabled = true;
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

    // Save to settings
    const settingsPath = path.join(configDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
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
    } catch (e) {}

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
    exec('brew services start tor', (error, stdout, stderr) => {
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
    exec('brew services restart tor', (error, stdout, stderr) => {
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
    exec('killall -HUP tor', (error) => {
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
    torEnabled: true
  };

  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Restore Tor state from settings
    if (settings.torEnabled !== undefined) {
      torEnabled = settings.torEnabled;
    }
  }

  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const settingsPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
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
  const profilePath = path.join(profilesDir, req.params.name);

  if (fs.existsSync(profilePath)) {
    fs.rmSync(profilePath, { recursive: true });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Profile not found' });
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
  } catch (e) {}
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
