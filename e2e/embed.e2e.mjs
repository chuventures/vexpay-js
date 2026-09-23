// End-to-end: @vexpay/js embedding the real hosted checkout (spec: sdk-browser-checkout).
//
// Needs a running local stack and the sandbox smoke tenant:
//   VEXPAY_API_URL=http://127.0.0.1:3010
//   CHECKOUT_ORIGIN=http://127.0.0.1:3011
//   VEXPAY_TEST_API_KEY=dev-local-api-key-sandbox   (seeded; test-mode + sandbox provider)
//   VEXPAY_SANDBOX_OTP=<current sandbox OTP>
//   PLAYWRIGHT_CHANNEL=chrome                 optional: use installed Chrome
//
// Prefer: pnpm sdk:smoke (orchestrates session + webhook + this suite).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (see header comment).`);
  return value;
};
const API = env('VEXPAY_API_URL').replace(/\/$/, '');
const CHECKOUT_ORIGIN = env('CHECKOUT_ORIGIN').replace(/\/$/, '');
const API_KEY = env('VEXPAY_TEST_API_KEY');
const OTP = env('VEXPAY_SANDBOX_OTP');
const ALLOWED = 'http://localhost:5173';

const BUYER = { name: 'Maria Perez', cedulaDigits: '12345678', phoneDigits: '1234567' };

const bundle = readFileSync(join(here, '../dist/vexpay.global.js'), 'utf8');
const shopPage = `<!doctype html><html><body>
<h1>Tienda de prueba</h1>
<div id="pay"></div>
<button id="redirect">Pagar en VEXPay</button>
<script src="/vexpay.global.js"></script>
<script>
  const q = new URLSearchParams(location.search);
  window.__events = [];
  window.__raw = [];
  // Record every postMessage the page receives, before the SDK filters it.
  window.addEventListener('message', (e) => window.__raw.push({ origin: e.origin, data: e.data }));
  const options = { clientSecret: q.get('secret'), checkoutOrigin: q.get('origin'), readyTimeoutMs: Number(q.get('timeout') || 15000) };
  const checkout = VexPay.checkout(options);
  for (const name of ['ready', 'completed', 'failed', 'expired', 'error']) {
    checkout.on(name, (payload) => window.__events.push({ name, payload }));
  }
  checkout.mount('#pay');
  document.getElementById('redirect').onclick = () => VexPay.redirectToCheckout(options);
</script></body></html>`;

function startShop(port) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/vexpay.global.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(bundle);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(shopPage);
  });
  return new Promise((resolve) => server.listen(port, 'localhost', () => resolve(server)));
}

async function createSession(extra = {}) {
  const res = await fetch(`${API}/v1/checkout/sessions`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ amountUsd: 5, methods: ['c2p'], allowedOrigins: [ALLOWED], reference: 'e2e-embed', ...extra }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`create session failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function retrieveSession(id) {
  const res = await fetch(`${API}/v1/checkout/sessions/${id}`, { headers: { 'x-api-key': API_KEY } });
  return res.json();
}

const shopUrl = (port, session, timeout) =>
  `http://localhost:${port}/?secret=${encodeURIComponent(session.clientSecret)}&origin=${encodeURIComponent(CHECKOUT_ORIGIN)}${timeout ? `&timeout=${timeout}` : ''}`;

const waitForEvent = (page, name, timeout = 30_000) =>
  page.waitForFunction((n) => window.__events.some((e) => e.name === n), name, { timeout });

async function fillBuyer(frame) {
  await frame.locator('#buyer-name').fill(BUYER.name);
  await frame.locator('#buyer-cedula').fill(BUYER.cedulaDigits);
  await frame.locator('#buyer-phone').fill(BUYER.phoneDigits);
  await frame.locator('#buyer-bank:not([disabled])').click();
  await frame.getByPlaceholder('Busca por nombre o código').fill('0102');
  await frame.getByRole('dialog').getByRole('button', { name: /Venezuela/ }).first().click();
  await frame.locator('form button[type=submit]').click();
  await frame.locator('#otp-code').waitFor({ timeout: 20_000 });
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push([name, 'pass']);
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push([name, 'FAIL']);
    console.error(`✗ ${name}\n  ${error?.stack ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const shops = await Promise.all([startShop(5173), startShop(5174)]);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });

await scenario('allowed origin: ready → Pago Móvil → completed, server confirms paid, no buyer data leaks', async () => {
  const session = await createSession();
  const page = await browser.newPage();
  await page.goto(shopUrl(5173, session));
  await waitForEvent(page, 'ready');

  const frame = page.frameLocator('iframe');
  await fillBuyer(frame);
  await frame.locator('#otp-code').fill(OTP);
  await frame.locator('form button[type=submit]').click();
  await waitForEvent(page, 'completed');

  const events = await page.evaluate(() => window.__events);
  const ready = events.find((e) => e.name === 'ready');
  const completed = events.find((e) => e.name === 'completed');
  assert(ready.payload.sessionId === session.id, `ready sessionId ${ready.payload.sessionId} !== ${session.id}`);
  assert(completed.payload.sessionId === session.id, 'completed carries the session id');
  assert(typeof completed.payload.paymentId === 'string', 'completed carries a paymentId');

  const server = await retrieveSession(session.id);
  assert(server.status === 'paid', `server status is ${server.status}`);
  assert(server.paymentId === completed.payload.paymentId, 'server paymentId matches the event');

  const raw = JSON.stringify(await page.evaluate(() => window.__raw));
  for (const secret of [BUYER.cedulaDigits, BUYER.phoneDigits, OTP, BUYER.name]) {
    assert(!raw.includes(secret), `host page received buyer data (${secret}) via postMessage`);
  }
  const origins = new Set((await page.evaluate(() => window.__raw)).map((m) => m.origin));
  assert([...origins].every((o) => o === CHECKOUT_ORIGIN), `messages from unexpected origins: ${[...origins]}`);
  await page.close();
});

await scenario('failed attempt emits failed with a code', async () => {
  const session = await createSession();
  const page = await browser.newPage();
  await page.goto(shopUrl(5173, session));
  await waitForEvent(page, 'ready');
  const frame = page.frameLocator('iframe');
  await fillBuyer(frame);
  await frame.locator('#otp-code').fill('000000');
  await frame.locator('form button[type=submit]').click();
  await waitForEvent(page, 'failed');
  const failed = (await page.evaluate(() => window.__events)).find((e) => e.name === 'failed');
  assert(failed.payload.sessionId === session.id && typeof failed.payload.code === 'string', 'failed has id + code');
  assert((await retrieveSession(session.id)).status === 'failed', 'server reports failed');
  await page.close();
});

await scenario('redirectToCheckout navigates to the hosted page', async () => {
  const session = await createSession();
  const page = await browser.newPage();
  await page.goto(shopUrl(5173, session));
  await page.click('#redirect');
  await page.waitForURL(`${CHECKOUT_ORIGIN}/pay/**`, { timeout: 20_000 });
  assert(page.url() === session.url.replace(/^https?:\/\/[^/]+/, CHECKOUT_ORIGIN), `landed on ${page.url()}`);
  await page.close();
});

await scenario('unlisted origin: checkout is blocked and origin_not_allowed fires', async () => {
  const session = await createSession();
  const page = await browser.newPage();
  await page.goto(shopUrl(5174, session, 5000));
  await waitForEvent(page, 'error', 15_000);
  const events = await page.evaluate(() => window.__events);
  assert(events.length === 1 && events[0].payload.code === 'origin_not_allowed', JSON.stringify(events));
  const rendered = await page.frames()[1]?.locator('#buyer-name').count().catch(() => 0);
  assert(!rendered, 'checkout form rendered inside a blocked frame');
  await page.close();
});

await browser.close();
await Promise.all(shops.map((s) => new Promise((resolve) => s.close(resolve))));
const failed = results.filter(([, r]) => r !== 'pass');
console.log(`\n${results.length - failed.length}/${results.length} embed scenarios passed.`);
process.exit(failed.length ? 1 : 0);
