/**
 * Airbnb API-based scraper
 * Uses direct HTTP requests instead of browser automation
 * Based on pyairbnb approach: https://github.com/johnbalvin/pyairbnb
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Headers that mimic Chrome browser
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

/**
 * Make HTTP request with proper headers
 */
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        ...BROWSER_HEADERS,
        'Host': parsedUrl.hostname,
        ...options.headers
      }
    };

    const req = protocol.request(requestOptions, (res) => {
      let data = [];

      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        let body;

        // Handle gzip/deflate encoding
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          const zlib = require('zlib');
          body = zlib.gunzipSync(buffer).toString('utf8');
        } else if (encoding === 'deflate') {
          const zlib = require('zlib');
          body = zlib.inflateSync(buffer).toString('utf8');
        } else if (encoding === 'br') {
          const zlib = require('zlib');
          body = zlib.brotliDecompressSync(buffer).toString('utf8');
        } else {
          body = buffer.toString('utf8');
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
          cookies: res.headers['set-cookie'] || []
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Get high-quality image URL by removing compression layer
 */
function getHighQualityImageUrl(url) {
  // Remove /im/ from path to get full resolution
  // /im/pictures → /pictures
  return url.replace('/im/pictures', '/pictures');
}

/**
 * Download binary file (images)
 */
function downloadImage(url) {
  // Convert to high quality URL
  const highQualityUrl = getHighQualityImageUrl(url);
  console.log(`High-quality URL: ${highQualityUrl}`);

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(highQualityUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': 'https://www.airbnb.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Host': parsedUrl.hostname
      }
    };

    const req = protocol.request(requestOptions, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }

      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          buffer: buffer
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
 * Extract API key from Airbnb page
 */
async function getApiKey() {
  console.log('Fetching API key from Airbnb...');
  const response = await makeRequest('https://www.airbnb.com');

  // Extract API key using regex
  const apiKeyMatch = response.body.match(/"api_config":\{"key":"([^"]+)"/);
  if (!apiKeyMatch) {
    throw new Error('Could not extract API key from Airbnb');
  }

  console.log('API key obtained successfully');
  return apiKeyMatch[1];
}

/**
 * Parse room details from HTML
 */
function parseRoomDetails(html, roomUrl) {
  const data = {
    url: roomUrl,
    title: '',
    description: '',
    images: [],
    host: {},
    amenities: [],
    location: {},
    reviews: { count: 0, rating: 0 },
    price: {},
    propertyType: '',
    bedrooms: 0,
    bathrooms: 0,
    beds: 0,
    maxGuests: 0
  };

  try {
    // Extract room ID
    const roomIdMatch = roomUrl.match(/\/rooms\/(\d+)/);
    if (roomIdMatch) {
      data.roomId = roomIdMatch[1];
    }

    // Look for JSON-LD data
    const jsonLdMatch = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const match of jsonLdMatch) {
        try {
          const jsonContent = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
          const jsonData = JSON.parse(jsonContent);

          if (jsonData['@type'] === 'Product' || jsonData['@type'] === 'House' || jsonData['@type'] === 'Apartment') {
            data.title = jsonData.name || '';
            data.description = jsonData.description || '';
            if (jsonData.image) {
              data.images = Array.isArray(jsonData.image) ? jsonData.image : [jsonData.image];
            }
            if (jsonData.aggregateRating) {
              data.reviews.rating = parseFloat(jsonData.aggregateRating.ratingValue) || 0;
              data.reviews.count = parseInt(jsonData.aggregateRating.reviewCount) || 0;
            }
          }
        } catch (e) {
          // Continue if JSON parsing fails
        }
      }
    }

    // Extract data from Airbnb's data script
    const dataScriptMatch = html.match(/data-deferred-state-0="([^"]+)"/);
    if (dataScriptMatch) {
      try {
        const decoded = dataScriptMatch[1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        const scriptData = JSON.parse(decoded);

        // Navigate the nested structure to find listing data
        if (scriptData.niobeMinimalClientData) {
          const clientData = scriptData.niobeMinimalClientData;
          for (const key of clientData) {
            if (key[1] && key[1].data && key[1].data.presentation) {
              const presentation = key[1].data.presentation;
              if (presentation.stayProductDetailPage) {
                const pdp = presentation.stayProductDetailPage;

                // Extract sections data
                if (pdp.sections && pdp.sections.sections) {
                  for (const section of pdp.sections.sections) {
                    if (section.sectionComponentType === 'TITLE_DEFAULT') {
                      data.title = section.section?.title || data.title;
                    }
                    if (section.sectionComponentType === 'DESCRIPTION_DEFAULT') {
                      data.description = section.section?.htmlDescription?.htmlText || data.description;
                    }
                    if (section.sectionComponentType === 'PHOTOS_DEFAULT') {
                      const photos = section.section?.mediaItems || [];
                      data.images = photos.map(p => p.baseUrl).filter(Boolean);
                    }
                    if (section.sectionComponentType === 'HOST_PROFILE_DEFAULT') {
                      const hostSection = section.section;
                      if (hostSection) {
                        data.host = {
                          name: hostSection.hostAvatar?.title || '',
                          isSuperhost: hostSection.isSuperhost || false,
                          profilePicture: hostSection.hostAvatar?.imageUrl || ''
                        };
                      }
                    }
                    if (section.sectionComponentType === 'AMENITIES_DEFAULT') {
                      const amenityGroups = section.section?.seeAllAmenitiesGroups || [];
                      data.amenities = amenityGroups.flatMap(g =>
                        (g.amenities || []).map(a => a.title)
                      ).filter(Boolean);
                    }
                    if (section.sectionComponentType === 'LOCATION_DEFAULT') {
                      const loc = section.section;
                      if (loc) {
                        data.location = {
                          city: loc.subtitle || '',
                          lat: loc.lat,
                          lng: loc.lng
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.log('Error parsing deferred state:', e.message);
      }
    }

    // Fallback: extract title from meta tags
    if (!data.title) {
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      if (titleMatch) {
        data.title = titleMatch[1];
      }
    }

    // Extract description from meta
    if (!data.description) {
      const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
      if (descMatch) {
        data.description = descMatch[1];
      }
    }

    // Extract images from meta
    if (data.images.length === 0) {
      const imgMatches = html.matchAll(/<meta property="og:image" content="([^"]+)"/g);
      for (const match of imgMatches) {
        data.images.push(match[1]);
      }
    }

    // Extract price if visible
    const priceMatch = html.match(/\$(\d+(?:,\d{3})*)\s*(?:night|per night)/i);
    if (priceMatch) {
      data.price.amount = parseInt(priceMatch[1].replace(/,/g, ''));
      data.price.currency = 'USD';
    }

  } catch (error) {
    console.error('Error parsing room details:', error.message);
  }

  return data;
}

/**
 * Scrape Airbnb listing using API approach
 */
async function scrapeAirbnbApi(url) {
  console.log(`Scraping (API): ${url}`);

  try {
    // Fetch the page
    const response = await makeRequest(url);

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: Failed to fetch page`);
    }

    // Parse the HTML
    const data = parseRoomDetails(response.body, url);

    // Save debug HTML
    const debugDir = path.join(__dirname, '..', 'downloads', 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    fs.writeFileSync(path.join(debugDir, `api_response_${Date.now()}.html`), response.body);

    // Download images and save in listings-compatible format
    const folderId = data.roomId || `airbnb_${Date.now()}`;
    const downloadDir = path.join(__dirname, '..', 'downloads', folderId);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const imagesDir = path.join(downloadDir, 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Download images using binary download function
    const downloadedImages = [];
    for (let i = 0; i < Math.min(5, data.images.length); i++) {
      try {
        const imgUrl = data.images[i];
        console.log(`Downloading image ${i + 1}: ${imgUrl}`);
        const imgResponse = await downloadImage(imgUrl);

        if (imgResponse.status === 200 && imgResponse.buffer.length > 1000) {
          // Determine extension from content type
          let ext = 'jpg';
          if (imgResponse.contentType) {
            if (imgResponse.contentType.includes('png')) ext = 'png';
            else if (imgResponse.contentType.includes('webp')) ext = 'webp';
          }

          const imgName = `image_${i + 1}.${ext}`;
          const imgPath = path.join(imagesDir, imgName);
          fs.writeFileSync(imgPath, imgResponse.buffer);
          console.log(`Downloaded: ${imgName} (${imgResponse.buffer.length} bytes)`);
          downloadedImages.push({
            original: imgUrl,
            local: `/downloads/${folderId}/images/${imgName}`
          });
        } else {
          console.log(`Image ${i + 1} failed: status ${imgResponse.status}, size ${imgResponse.buffer.length}`);
        }
      } catch (imgError) {
        console.log(`Failed to download image ${i + 1}:`, imgError.message);
      }
    }

    // Save description
    if (data.description) {
      fs.writeFileSync(path.join(downloadDir, 'description.txt'), data.description);
    }

    // Save metadata in listings-compatible format
    const metadata = {
      id: folderId,
      folder: folderId,
      platform: 'airbnb',
      title: data.title || 'Untitled',
      description: data.description || '',
      images: downloadedImages,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      rating: data.reviews?.rating || 0,
      reviewCount: data.reviews?.count || 0,
      host: data.host || {},
      amenities: data.amenities || [],
      location: data.location || {}
    };

    fs.writeFileSync(
      path.join(downloadDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // Update data with downloaded images for response
    data.images = downloadedImages.map(img => img.original);

    return {
      success: true,
      data: data
    };

  } catch (error) {
    console.error('API scraping error:', error.message);
    throw error;
  }
}

/**
 * Search for properties using Airbnb API
 */
async function searchAirbnbApi(query, options = {}) {
  console.log(`Searching (API): ${query}`);

  try {
    // Get API key first
    const apiKey = await getApiKey();

    // Build search URL
    const searchUrl = `https://www.airbnb.com/s/${encodeURIComponent(query)}/homes`;

    // Fetch search results page
    const response = await makeRequest(searchUrl);

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: Failed to fetch search results`);
    }

    // Parse search results
    const results = parseSearchResults(response.body, query);

    return {
      success: true,
      query: query,
      results: results
    };

  } catch (error) {
    console.error('API search error:', error.message);
    throw error;
  }
}

/**
 * Parse search results from HTML
 */
function parseSearchResults(html, query) {
  const results = [];
  const seenIds = new Set();

  try {
    // Method 1: Extract from embedded JSON (searchResults)
    const searchResultsMatch = html.match(/"searchResults":\[([\s\S]*?)\],"paginationInfo"/);
    if (searchResultsMatch) {
      try {
        const jsonStr = '{"results":[' + searchResultsMatch[1] + ']}';
        const parsed = JSON.parse(jsonStr);

        for (const item of parsed.results) {
          if (item.listing && item.listing.id) {
            const listing = item.listing;
            if (!seenIds.has(listing.id)) {
              seenIds.add(listing.id);
              results.push({
                roomId: listing.id,
                url: `https://www.airbnb.com/rooms/${listing.id}`,
                title: listing.name || '',
                rating: item.avgRatingLocalized || '',
                thumbnail: listing.contextualPictures?.[0]?.picture || ''
              });
            }
          }
        }
      } catch (e) {
        console.log('Error parsing searchResults JSON:', e.message);
      }
    }

    // Method 2: Look for listing IDs in the page
    if (results.length === 0) {
      const idMatches = html.matchAll(/"listing":\{[^}]*"id":"(\d+)"/g);
      for (const match of idMatches) {
        const roomId = match[1];
        if (!seenIds.has(roomId)) {
          seenIds.add(roomId);
          results.push({
            roomId: roomId,
            url: `https://www.airbnb.com/rooms/${roomId}`
          });
        }
      }
    }

    // Method 3: Look for href links as fallback
    if (results.length === 0) {
      const linkMatches = html.matchAll(/href="(\/rooms\/\d+[^"]*)"[^>]*>/g);
      for (const match of linkMatches) {
        const href = match[1];
        const roomIdMatch = href.match(/\/rooms\/(\d+)/);
        if (roomIdMatch && !seenIds.has(roomIdMatch[1])) {
          seenIds.add(roomIdMatch[1]);
          results.push({
            roomId: roomIdMatch[1],
            url: `https://www.airbnb.com${href.split('?')[0]}`
          });
        }
      }
    }

  } catch (error) {
    console.error('Error parsing search results:', error.message);
  }

  return results;
}

module.exports = {
  scrapeAirbnbApi,
  searchAirbnbApi,
  getApiKey,
  makeRequest
};
