/**
 * Shared utilities for scrapers
 * Common functions used across Airbnb, Booking, and VRBO scrapers
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

/**
 * Download image as binary buffer
 * Handles redirects and returns status, buffer, and content type
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Host': parsedUrl.hostname
      }
    };

    const req = protocol.request(requestOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }

      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        resolve({
          status: res.statusCode,
          buffer: buffer,
          contentType: res.headers['content-type']
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Image download timeout'));
    });
    req.end();
  });
}

/**
 * Parse JSON-LD data from HTML
 * Returns array of parsed JSON-LD objects
 */
function extractJsonLd(html) {
  const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const results = [];

  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      const jsonMatch = match.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          results.push(data);
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  return results;
}

/**
 * Create a progress logger function
 * Logs to console and calls optional callback
 */
function createProgress(onProgress) {
  return (msg) => {
    console.log(msg);
    if (onProgress) onProgress(msg);
  };
}

/**
 * Get file extension from content type
 */
function getExtensionFromContentType(contentType) {
  if (!contentType) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}

/**
 * Ensure directory exists, create if not
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Download and save images to a directory
 * Returns array of { original, local } objects for successfully downloaded images
 */
async function downloadImages(imageUrls, imagesDir, folderId, progress) {
  const downloadedImages = [];

  progress(`Found ${imageUrls.length} images to download`);

  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const imgUrl = imageUrls[i];
      progress(`Downloading image ${i + 1}/${imageUrls.length}...`);
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

  return downloadedImages;
}

/**
 * Save metadata to JSON file
 */
function saveMetadata(downloadDir, metadata) {
  fs.writeFileSync(
    path.join(downloadDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
}

/**
 * Save debug HTML for troubleshooting
 */
function saveDebugHtml(debugDir, filename, html) {
  ensureDir(debugDir);
  fs.writeFileSync(path.join(debugDir, filename), html);
  console.log(`Saved debug HTML to ${filename}`);
}

module.exports = {
  downloadImage,
  extractJsonLd,
  createProgress,
  getExtensionFromContentType,
  ensureDir,
  downloadImages,
  saveMetadata,
  saveDebugHtml
};
