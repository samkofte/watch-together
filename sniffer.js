/**
 * Universal Headless Media Sniffer (Puppeteer-Core).
 * Uses local Chrome or Edge to intercept raw media network requests (.m3u8, .mp4, video streams, blob URLs)
 * from ANY website without requiring site-specific scrapers.
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function getBrowserPath() {
  for (const p of BROWSER_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  const executablePath = getBrowserPath();
  if (!executablePath) {
    throw new Error('Chrome or Edge browser executable not found on host machine.');
  }

  browserInstance = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--mute-audio',
      '--disable-web-security',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  return browserInstance;
}

/**
 * Sniffs network traffic for video streams (.m3u8, .mp4, .ts master playlists)
 * @param {string} targetUrl 
 * @param {number} timeoutMs 
 * @returns {Promise<{success: boolean, type?: string, url?: string, title?: string, headers?: object}>}
 */
async function sniffStream(targetUrl, timeoutMs = 12000) {
  let browser;
  let page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.setViewport({ width: 1280, height: 720 });

    let detectedStream = null;

    // Listen to network requests
    page.on('request', (req) => {
      const url = req.url();
      const resourceType = req.resourceType();

      // Check for video streams
      if (url.includes('.m3u8') && !url.includes('ad') && !url.includes('analytics')) {
        if (!detectedStream) {
          detectedStream = {
            type: 'hls',
            url: url,
            headers: req.headers()
          };
        }
      } else if (
        (resourceType === 'media' || url.includes('.mp4')) &&
        !url.includes('ad') &&
        !url.includes('preview')
      ) {
        if (!detectedStream) {
          detectedStream = {
            type: 'direct',
            url: url,
            headers: req.headers()
          };
        }
      }
    });

    // Listen to network responses for Content-Type matching
    page.on('response', (res) => {
      const url = res.url();
      const headers = res.headers();
      const contentType = headers['content-type'] || '';

      if (
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('application/x-mpegurl')
      ) {
        if (!detectedStream) {
          detectedStream = {
            type: 'hls',
            url: url,
            headers: headers
          };
        }
      } else if (contentType.includes('video/mp4') || contentType.includes('video/webm')) {
        if (!detectedStream && !url.includes('ad')) {
          detectedStream = {
            type: 'direct',
            url: url,
            headers: headers
          };
        }
      }
    });

    // Navigate to page
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    }).catch(() => {});

    // Get page title
    const pageTitle = await page.title().catch(() => 'Video');

    // Wait a brief moment or trigger play if a video or iframe exists
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (detectedStream) break;

      // Try clicking common play buttons or video tags inside page/iframes
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v && v.paused) {
          v.play().catch(() => {});
        }
        const playBtn = document.querySelector('.vjs-big-play-button, .play-button, button.play, .jw-display-icon-container');
        if (playBtn) playBtn.click();
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 600));
    }

    if (detectedStream) {
      return {
        success: true,
        type: detectedStream.type,
        url: detectedStream.url,
        title: pageTitle,
        provider: 'headless_sniffer'
      };
    }

    return { success: false, error: 'No media stream intercepted within timeout' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

module.exports = { sniffStream };
