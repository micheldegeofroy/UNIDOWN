const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { scrapeAirbnbApi, searchAirbnbApi } = require('./scrapers/airbnb-api');
const { scrapeAirbnb, searchAirbnbProperty, proxyManager: airbnbProxyManager } = require('./scrapers/airbnb');
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
    } else {
      return res.status(400).json({
        error: 'Please provide a valid Airbnb listing URL or property name.'
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

  if (!url.includes('airbnb.com')) {
    return res.status(400).json({ error: 'Please provide a valid Airbnb URL' });
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
let torEnabled = false;
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
    torEnabled: false
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
