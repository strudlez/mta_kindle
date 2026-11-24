import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_PATH = path.join(ROOT, 'target/debug/mta');

const STATION_NAMES = {
  L08: 'Bedford Av',
  A32: 'W 4 St-Wash Sq',
  '901': 'Grand Central-42 St',
  '101': 'Van Cortlandt Park-242 St',
  '103': '238 St',
  '104': '231 St',
  '106': 'Marble Hill-225 St',
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function ensureServerBinaryBuilt() {
  const inputs = [
    path.join(ROOT, 'Cargo.toml'),
    path.join(ROOT, 'src/main.rs'),
    path.join(ROOT, 'templates/mta.html'),
    path.join(ROOT, 'static/js/stops.txt'),
  ];
  let needsBuild = !fs.existsSync(BIN_PATH);
  if (!needsBuild) {
    const binMtime = fs.statSync(BIN_PATH).mtimeMs;
    needsBuild = inputs.some((p) => fs.statSync(p).mtimeMs > binMtime);
  }
  if (needsBuild) {
    const res = Bun.spawnSync(['cargo', 'build'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.exitCode !== 0) {
      throw new Error(`cargo build failed with exit code ${res.exitCode}`);
    }
  }
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      if (res.status === 204) return;
    } catch (_) {
      // retry until bound
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server at ${baseUrl} did not become ready within 10s`);
}

async function realTap(page, locator) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error('Element has no visible bounding box');
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 10, y - 10, { steps: 3 });
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.down();
  await page.mouse.move(x + 1, y + 1, { steps: 2 });
  await page.mouse.up();
}

async function dragScroll(page, x, fromY, toY, wheelDeltaY) {
  await page.mouse.move(x, fromY, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(x, toY, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, wheelDeltaY);
}

describe('End-to-End Browser UI Tests (Kindle Viewport)', () => {
  let mockServer;
  let serverProc;
  let browser;
  let baseUrl;
  let mockMode = 'ok';
  let goodServiceRoutes = [];
  let mtaRequests = [];

  beforeAll(async () => {
    ensureServerBinaryBuilt();

    mockServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/otp/routers/default/nearby') {
          const stopsParam = url.searchParams.get('stops') || '';
          const station = stopsParam.replace('MTASBWY:', '');
          mtaRequests.push(station);

          if (mockMode === '500') {
            return new Response('upstream error', { status: 500 });
          }

          const nowMs = Date.now();
          const baseName = STATION_NAMES[station] || `Station ${station}`;
          const xss = '<img src=x onerror="window.__xss=3">';

          if (mockMode === 'closed') {
            return Response.json([
              {
                stop: { name: baseName },
                alerts: [],
                groups: [],
              },
            ]);
          }

          const isXss = mockMode === 'xss';
          const shortName = station.charAt(0);
          return Response.json([
            {
              stop: { name: isXss ? xss : baseName },
              alerts: [
                {
                  effectiveStartDate: nowMs - 60_000,
                  effectiveEndDate: nowMs + 3_600_000,
                  alertHeaderText: isXss ? xss : 'Active station alert',
                  humanReadableActivePeriod: 'Now',
                },
              ],
              groups: [
                {
                  headsign: isXss ? xss : 'Manhattan',
                  route: { shortName: `${shortName}X` },
                  times: [
                    { serviceDay: 0, realtimeArrival: Math.floor(Date.now() / 1000) + 180 },
                    { serviceDay: 0, realtimeArrival: Math.floor(Date.now() / 1000) + 480 },
                  ],
                },
                {
                  headsign: 'Brooklyn',
                  route: { shortName },
                  times: [
                    { serviceDay: 0, realtimeArrival: Math.floor(Date.now() / 1000) + 300 },
                  ],
                },
              ],
            },
          ]);
        }

        if (url.pathname.startsWith('/api/routes/')) {
          const train = url.pathname.slice('/api/routes/'.length);
          goodServiceRoutes.push(train);

          if (mockMode === '500') {
            return new Response('alerts error', { status: 500 });
          }

          if (mockMode === 'xss') {
            const xss = '<img src=x onerror="window.__xss=4">';
            return Response.json({
              status: xss,
              service_change_summaries: { both: [xss], north: [], south: [] },
              service_irregularity_summaries: {},
            });
          }

          if (train === 'G') {
            return Response.json({
              status: 'Good Service',
              service_change_summaries: { both: [], north: [], south: [] },
              service_irregularity_summaries: {},
            });
          }

          return Response.json({
            status: 'Delays',
            service_change_summaries: {
              both: [`${train} train delays`],
              north: [],
              south: [],
            },
            service_irregularity_summaries: { north: null, south: null },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = Bun.spawn([BIN_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        BIND_ADDR: `127.0.0.1:${port}`,
        API_KEY: 'ui-test-key',
        MTA_BASE_URL: `http://127.0.0.1:${mockServer.port}`,
        GOODSERVICE_BASE_URL: `http://127.0.0.1:${mockServer.port}`,
        RUST_LOG: 'warn',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (serverProc) {
      serverProc.kill();
      await serverProc.exited;
    }
    if (mockServer) mockServer.stop(true);
  });

  async function openKindlePage(urlPath) {
    const context = await browser.newContext({ viewport: { width: 758, height: 1024 } });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const requestedUrls = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('request', (req) => requestedUrls.push(new URL(req.url()).pathname + new URL(req.url()).search));

    await page.goto(`${baseUrl}${urlPath}`, { waitUntil: 'networkidle' });
    return { context, page, pageErrors, consoleErrors, requestedUrls };
  }

  test('renders dashboard, express/local styling, alerts, and lazy-loads stops.txt', async () => {
    mockMode = 'ok';
    const { context, page, pageErrors, consoleErrors, requestedUrls } = await openKindlePage('/');
    try {
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(requestedUrls.some((u) => u.includes('stops.txt'))).toBe(false);

      const station0 = page.locator('#station0');
      await station0.waitFor({ state: 'visible' });
      expect(await station0.locator('.stationTitle').textContent()).toBe('Bedford Av');
      expect(await station0.locator('.inboundTitle').textContent()).toBe('Manhattan');
      expect(await station0.locator('.outboundTitle').textContent()).toBe('Brooklyn');

      // Express LX badge renders as "L" with .express class and rotated transform
      const inboundColor = station0.locator('.inbound1 .trainColor');
      expect(await inboundColor.locator('.trainName').textContent()).toBe('L');
      expect(await inboundColor.evaluate((el) => el.classList.contains('express'))).toBe(true);
      const transform = await inboundColor.evaluate((el) => getComputedStyle(el).transform);
      expect(transform).not.toBe('none');

      // Local badge has circular border-radius
      const outboundColor = station0.locator('.outbound1 .trainColor');
      expect(await outboundColor.evaluate((el) => el.classList.contains('local'))).toBe(true);
      expect(await outboundColor.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');

      // Alerts render when status != Good Service
      await page.locator('.alerts').waitFor({ state: 'visible' });
      expect(await page.locator('.alerts .alertsTitle').textContent()).toBe('L: Delays');
      expect(await page.locator('.alerts .alertsBody').textContent()).toContain('L train delays');

      await page.locator('.alerts2').waitFor({ state: 'visible' });
      expect(await page.locator('.alerts2 .alertsTitle').textContent()).toBe('4: Delays');

      // No horizontal overflow on Kindle viewport
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(overflow).toBe(true);

      // Good Service hides extra alert banner
      await page.goto(`${baseUrl}/#L08&G`, { waitUntil: 'networkidle' });
      expect(await page.locator('.alerts2').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 15000);

  test('station picker supports tap, add, reorder, delete, cancel, validation alert, and multi-station save', async () => {
    mockMode = 'ok';
    goodServiceRoutes = [];
    const { context, page, pageErrors, consoleErrors, requestedUrls } = await openKindlePage('/');
    try {
      await page.locator('#station0 .stationTitle').waitFor({ state: 'visible' });

      // Tap station title to open picker -> lazy loads stops.txt once
      await realTap(page, page.locator('#station0 .stationTitle'));
      await page.locator('#picker').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#pickerSelect option').length > 400);

      expect(requestedUrls.filter((u) => u.includes('stops.txt')).length).toBe(1);
      expect(await page.locator('#pickerSelect option').count()).toBe(476); // default + 475 stops

      // Add A32
      await page.selectOption('#pickerSelect', 'A32');
      await realTap(page, page.locator('#addStationBtn'));
      expect(await page.locator('.picker-item').count()).toBe(2);
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toContain('Bedford Av');
      expect(await page.locator('.picker-item-name').nth(1).textContent()).toContain('W 4 St-Wash Sq');

      // Move up second item -> swaps order; move down first -> restores order
      await realTap(page, page.locator('.picker-item').nth(1).locator('.picker-item-btn').nth(0));
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toContain('W 4 St-Wash Sq');
      await realTap(page, page.locator('.picker-item').nth(0).locator('.picker-item-btn').nth(1));
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toContain('Bedford Av');

      // Cancel discards unsaved edits and returns to main; reopening picker does NOT re-fetch stops.txt
      await realTap(page, page.locator('#hidePickerBtn'));
      await page.locator('#main').waitFor({ state: 'visible' });
      await realTap(page, page.locator('#station0 .stationTitle'));
      await page.locator('#picker').waitFor({ state: 'visible' });
      expect(requestedUrls.filter((u) => u.includes('stops.txt')).length).toBe(1);
      expect(await page.locator('.picker-item').count()).toBe(1);

      // Delete remaining station and tap Save -> triggers alert dialog without navigating
      await realTap(page, page.locator('.picker-item').nth(0).locator('.picker-item-btn').nth(2));
      expect(await page.locator('.picker-item').count()).toBe(0);

      const dialogs = [];
      page.once('dialog', async (d) => {
        dialogs.push(d.message());
        await d.accept();
      });
      await realTap(page, page.locator('#savePickerBtn'));
      expect(dialogs).toEqual(['Please select at least one station.']);

      // Add L08 and A32, then Save -> navigates to ?q=L08,A32&4
      await page.selectOption('#pickerSelect', 'L08');
      await realTap(page, page.locator('#addStationBtn'));
      await page.selectOption('#pickerSelect', 'A32');
      await realTap(page, page.locator('#addStationBtn'));

      goodServiceRoutes = [];
      await Promise.all([
        page.waitForURL((u) => u.search === '?q=L08,A32&4'),
        realTap(page, page.locator('#savePickerBtn')),
      ]);
      await page.waitForLoadState('networkidle');

      await page.locator('#station0').waitFor({ state: 'visible' });
      await page.locator('#station1').waitFor({ state: 'visible' });
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe('Bedford Av');
      expect(await page.locator('#station1 .stationTitle').textContent()).toBe('W 4 St-Wash Sq');
      expect(await page.locator('#stations').evaluate((el) => el.classList.contains('small'))).toBe(true);

      // Multi-station mode applies CSS class colors (CSP-compliant, no inline styles)
      const aBg = await page.locator('#station1 .inbound1 .trainColor').evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(aBg).toBe('rgb(0, 57, 166)'); // #0039A6 for A train

      // Secondary station used ?alerts=0 so goodservice.io was NOT called for 'A'
      expect(requestedUrls.some((u) => u === '/mta/countdown/A32?alerts=0')).toBe(true);
      expect(goodServiceRoutes.includes('A')).toBe(false);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 15000);

  test('defends against DOM and upstream XSS, handles live hashchange, closed stations, and 500s', async () => {
    const { context, page, pageErrors } = await openKindlePage(
      '/#<img src=x onerror=window.__xss=1>&<script>window.__xss=2</script>',
    );
    try {
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe('Bedford Av');

      // Malicious upstream HTML payloads render as inert text, never HTML elements
      mockMode = 'xss';
      await page.goto(`${baseUrl}/#901&4`, { waitUntil: 'networkidle' });
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('img').count()).toBe(0);
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe(
        '<img src=x onerror="window.__xss=3">',
      );

      // Live hash change updates stations and alert2 cleanly
      mockMode = 'ok';
      await page.goto(`${baseUrl}/#L08&4`, { waitUntil: 'networkidle' });
      await page.locator('#station0').waitFor({ state: 'visible' });
      await page.evaluate(() => {
        window.location.hash = '#A32&F';
      });
      await page.waitForFunction(
        () => document.querySelector('#station0 .stationTitle')?.textContent === 'W 4 St-Wash Sq',
      );
      await page.waitForFunction(
        () => document.querySelector('.alerts2 .alertsTitle')?.textContent === 'F: Delays',
      );

      // Closed station hides all train rows cleanly
      mockMode = 'closed';
      await page.goto(`${baseUrl}/#101&4`, { waitUntil: 'networkidle' });
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe('Van Cortlandt Park-242 St');
      expect(await page.locator('#station0 .inbound1').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page.locator('#station0 .outbound1').evaluate((el) => el.classList.contains('hidden'))).toBe(true);

      // Upstream 500 does not cause uncaught JS errors
      mockMode = '500';
      await page.goto(`${baseUrl}/#103&4`, { waitUntil: 'networkidle' });
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 15000);

  test('supports scrolling across 4 stations via pointer drag and wheel gestures', async () => {
    mockMode = 'ok';
    const { context, page, pageErrors } = await openKindlePage('/?q=L08,A32,104,106&4');
    try {
      await page.locator('#station3').waitFor({ state: 'visible' });
      expect(await page.locator('#station3 .stationTitle').textContent()).toBe('Marble Hill-225 St');

      const dims = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      }));
      expect(dims.scrollHeight).toBeGreaterThan(dims.innerHeight);

      await dragScroll(page, 380, 700, 250, 350);
      await page.waitForFunction(() => window.scrollY > 0);
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBeGreaterThan(0);

      const box3 = await page.locator('#station3').boundingBox();
      expect(box3).not.toBeNull();
      expect(box3.height).toBeGreaterThan(50);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 15000);
});
