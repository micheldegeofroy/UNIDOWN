const fs = require('fs');
const path = require('path');

// ============================================
// PROXY MANAGEMENT
// ============================================

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.configPath = path.join(__dirname, '..', 'config', 'proxies.json');
    this.loadProxies();
  }

  loadProxies() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.proxies = data.proxies || [];
      }
    } catch (e) {
      console.log('No proxy config found, running without proxies');
    }
  }

  addProxy(proxy) {
    // Format: { host, port, username?, password?, type: 'http'|'socks5', residential?: boolean }
    this.proxies.push(proxy);
    this.saveProxies();
  }

  saveProxies() {
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify({ proxies: this.proxies }, null, 2));
  }

  getNext() {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }

  getRandom() {
    if (this.proxies.length === 0) return null;
    return this.proxies[Math.floor(Math.random() * this.proxies.length)];
  }

  formatForPuppeteer(proxy) {
    if (!proxy) return null;
    const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
    return `${proxy.type || 'http'}://${auth}${proxy.host}:${proxy.port}`;
  }

  getProxyArgs(proxy) {
    if (!proxy) return [];
    return [`--proxy-server=${proxy.type || 'http'}://${proxy.host}:${proxy.port}`];
  }
}

// ============================================
// BROWSER PROFILE PERSISTENCE
// ============================================

class ProfileManager {
  constructor() {
    this.profilesDir = path.join(__dirname, '..', 'browser_profiles');
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  getProfilePath(platform) {
    return path.join(this.profilesDir, platform);
  }

  profileExists(platform) {
    return fs.existsSync(this.getProfilePath(platform));
  }
}

// ============================================
// TIMEZONE & LOCALE SPOOFING
// ============================================

const timezoneLocales = {
  'US': { timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
  'US-CA': { timezone: 'America/Los_Angeles', locale: 'en-US', languages: ['en-US', 'en'] },
  'US-TX': { timezone: 'America/Chicago', locale: 'en-US', languages: ['en-US', 'en'] },
  'UK': { timezone: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'] },
  'DE': { timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'] },
  'FR': { timezone: 'Europe/Paris', locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en'] },
  'AU': { timezone: 'Australia/Sydney', locale: 'en-AU', languages: ['en-AU', 'en'] },
  'CA': { timezone: 'America/Toronto', locale: 'en-CA', languages: ['en-CA', 'en', 'fr'] },
};

function getRandomUSTimezone() {
  const usTimezones = ['US', 'US-CA', 'US-TX'];
  const key = usTimezones[Math.floor(Math.random() * usTimezones.length)];
  return timezoneLocales[key];
}

// ============================================
// KNOWN BOT DETECTION SCRIPTS TO BLOCK
// ============================================

const botDetectionDomains = [
  'datadome.co',
  'datadome.com',
  'perimeterx.net',
  'perimeterx.com',
  'px-cdn.net',
  'px-cloud.net',
  'arkoselabs.com',
  'funcaptcha.com',
  'kasada.io',
  'fingerprintjs.com',
  'fpjs.io',
  'distilnetworks.com',
  'distil.io',
  'imperva.com',
  'incapsula.com',
  'akamaihd.net/bot',
  'akamai.com/bot',
  'cloudflare.com/cdn-cgi/challenge',
  'recaptcha.net',
  'geetest.com',
  'hcaptcha.com',
  'threatmetrix.com',
  'iovation.com',
  'forter.com',
  'sift.com',
  'siftscience.com',
  'shape.com',
  'shapesecurity.com',
  'queue-it.net',
];

const botDetectionPaths = [
  '/akam/',
  '/akamai/',
  '/_sec/',
  '/security/',
  '/captcha',
  '/challenge',
  '/bot-detect',
  '/fp.js',
  '/fingerprint',
];

function shouldBlockRequest(url) {
  const urlLower = url.toLowerCase();

  // Check domains
  for (const domain of botDetectionDomains) {
    if (urlLower.includes(domain)) return true;
  }

  // Check paths
  for (const p of botDetectionPaths) {
    if (urlLower.includes(p)) return true;
  }

  return false;
}

// ============================================
// CANVAS & WEBGL FINGERPRINT NOISE
// ============================================

function getCanvasNoise() {
  // Random noise values to make canvas fingerprint unique each session
  return {
    r: Math.floor(Math.random() * 10) - 5,
    g: Math.floor(Math.random() * 10) - 5,
    b: Math.floor(Math.random() * 10) - 5,
  };
}

function getFingerprintNoiseScript(canvasNoise) {
  return `
    // Canvas fingerprint noise
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const imageData = originalGetImageData.call(this, x, y, w, h);
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + ${canvasNoise.r}));
        imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + ${canvasNoise.g}));
        imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + ${canvasNoise.b}));
      }
      return imageData;
    };

    // Canvas toDataURL noise
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + ${canvasNoise.r}));
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.call(this, type, quality);
    };

    // WebGL fingerprint noise
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      // UNMASKED_VENDOR_WEBGL
      if (param === 37445) {
        return 'Intel Inc.';
      }
      // UNMASKED_RENDERER_WEBGL
      if (param === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return originalGetParameter.call(this, param);
    };

    // WebGL2 fingerprint noise
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return originalGetParameter2.call(this, param);
      };
    }

    // AudioContext fingerprint noise
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = originalGetChannelData.call(this, channel);
      for (let i = 0; i < data.length; i += 100) {
        data[i] = data[i] + Math.random() * 0.0001;
      }
      return data;
    };
  `;
}

// ============================================
// ENHANCED BROWSER FINGERPRINT
// ============================================

function getEnhancedFingerprint() {
  const screenResolutions = [
    { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
    { width: 1536, height: 864, availWidth: 1536, availHeight: 824 },
    { width: 1440, height: 900, availWidth: 1440, availHeight: 860 },
    { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400 },
    { width: 1366, height: 768, availWidth: 1366, availHeight: 728 },
  ];

  const colorDepths = [24, 32];
  const pixelRatios = [1, 1.25, 1.5, 2];
  const hardwareConcurrency = [4, 6, 8, 12, 16];
  const deviceMemory = [4, 8, 16, 32];

  const screen = screenResolutions[Math.floor(Math.random() * screenResolutions.length)];

  return {
    screen,
    colorDepth: colorDepths[Math.floor(Math.random() * colorDepths.length)],
    pixelRatio: pixelRatios[Math.floor(Math.random() * pixelRatios.length)],
    hardwareConcurrency: hardwareConcurrency[Math.floor(Math.random() * hardwareConcurrency.length)],
    deviceMemory: deviceMemory[Math.floor(Math.random() * deviceMemory.length)],
  };
}

function getEnhancedFingerprintScript(fingerprint, timezoneData) {
  return `
    // Screen properties
    Object.defineProperty(screen, 'width', { get: () => ${fingerprint.screen.width} });
    Object.defineProperty(screen, 'height', { get: () => ${fingerprint.screen.height} });
    Object.defineProperty(screen, 'availWidth', { get: () => ${fingerprint.screen.availWidth} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${fingerprint.screen.availHeight} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${fingerprint.colorDepth} });
    Object.defineProperty(screen, 'pixelDepth', { get: () => ${fingerprint.colorDepth} });

    // Device properties
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fingerprint.hardwareConcurrency} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fingerprint.deviceMemory} });

    // Pixel ratio
    Object.defineProperty(window, 'devicePixelRatio', { get: () => ${fingerprint.pixelRatio} });

    // Timezone
    const originalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locale, options) {
      options = options || {};
      options.timeZone = options.timeZone || '${timezoneData.timezone}';
      return new originalDateTimeFormat(locale, options);
    };
    Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;

    // Override Date to use correct timezone offset
    const timezoneOffset = new Date().toLocaleString('en-US', { timeZone: '${timezoneData.timezone}', timeZoneName: 'short' });

    // Languages
    Object.defineProperty(navigator, 'language', { get: () => '${timezoneData.languages[0]}' });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(timezoneData.languages)} });

    // Plugins (make it look like a real browser)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      }
    });

    // Permissions API
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Battery API (make it look normal)
    if (navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    }

    // Connection API
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      })
    });
  `;
}

// ============================================
// COMPLETE STEALTH SETUP
// ============================================

async function setupStealthPage(page, options = {}) {
  const {
    proxy = null,
    timezone = null,
    blockBotDetection = true,
  } = options;

  // Get random fingerprint and timezone
  const timezoneData = timezone || getRandomUSTimezone();
  const fingerprint = getEnhancedFingerprint();
  const canvasNoise = getCanvasNoise();

  // Set timezone
  await page.emulateTimezone(timezoneData.timezone);

  // Inject fingerprint noise before page loads
  await page.evaluateOnNewDocument(getFingerprintNoiseScript(canvasNoise));
  await page.evaluateOnNewDocument(getEnhancedFingerprintScript(fingerprint, timezoneData));

  // Additional stealth measures
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // Chrome specific
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Notification permission
    const originalNotification = window.Notification;
    window.Notification = function(title, options) {
      return new originalNotification(title, options);
    };
    window.Notification.permission = 'default';
    window.Notification.requestPermission = () => Promise.resolve('default');

    // Iframe contentWindow
    const originalContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const window = originalContentWindow.get.call(this);
        if (window) {
          Object.defineProperty(window.navigator, 'webdriver', { get: () => undefined });
        }
        return window;
      }
    });
  });

  // Request interception for bot detection
  if (blockBotDetection) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();

      if (shouldBlockRequest(url)) {
        console.log('Blocked bot detection:', url.substring(0, 80));
        request.abort();
      } else {
        request.continue();
      }
    });
  }

  // Handle proxy authentication if needed
  if (proxy && proxy.username) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }

  return { fingerprint, timezoneData, canvasNoise };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  ProxyManager,
  ProfileManager,
  setupStealthPage,
  getRandomUSTimezone,
  timezoneLocales,
  shouldBlockRequest,
  getCanvasNoise,
  getFingerprintNoiseScript,
  getEnhancedFingerprint,
  getEnhancedFingerprintScript,
};
