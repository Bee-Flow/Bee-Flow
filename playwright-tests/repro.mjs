import { chromium } from 'playwright';

const URL = process.env.TARGET || 'http://localhost:5176/app';
const HEADED = process.env.HEADLESS !== '1';

const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 150 : 0 });
// Fresh profile => no browser cache, no localStorage. Isolates "is it the
// browser's cache" from "is it the server".
const ctx = await browser.newContext();
const page = await ctx.newPage();

const failed = [];
const bad = [];
const console_ = [];

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console_.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console_.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console_.push(`[goto] ${e.message}`));
await page.waitForTimeout(3000);

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '(unreadable)');

console.log('=== FAILED REQUESTS ===');
console.log(failed.length ? failed.join('\n') : '(none)');
console.log('\n=== HTTP >=400 ===');
console.log(bad.length ? bad.join('\n') : '(none)');
console.log('\n=== CONSOLE ===');
console.log(console_.length ? console_.join('\n') : '(none)');
console.log('\n=== VISIBLE TEXT ===');
console.log(bodyText);

await page.screenshot({ path: 'repro.png', fullPage: false });
await browser.close();
