import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';

// Ensure screenshots directory exists
const screenshotDir = path.join(__dirname, 'temporary screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

// Find next available index
let idx = 1;
while (fs.existsSync(path.join(screenshotDir, `screenshot-${idx}${label ? '-' + label : ''}.png`))) idx++;
const filename = `screenshot-${idx}${label ? '-' + label : ''}.png`;
const filepath = path.join(screenshotDir, filename);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: 'C:/Users/Yousefelgaiey/.cache/puppeteer/chrome/win64-146.0.7680.153/chrome-win64/chrome.exe',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: filepath, fullPage: false });
await browser.close();

console.log(`Screenshot saved: temporary screenshots/${filename}`);
