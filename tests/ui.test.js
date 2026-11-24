import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_PATH = path.join(ROOT, 'target/debug/mta');

const STATION_NAMES = {
  L08: 'Bedford Av',
  L10: 'Lorimer St',
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

          const shortName = station.charAt(0);
          if (mockMode === 'offline_schedule') {
            const nowSec = Math.floor(Date.now() / 1000);
            return Response.json([
              {
                stop: { name: baseName },
                alerts: [],
                groups: [
                  {
                    headsign: 'Manhattan',
                    route: { shortName },
                    times: [
                      { serviceDay: 0, realtimeArrival: nowSec + 150 },
                      { serviceDay: 0, realtimeArrival: nowSec + 330 },
                      { serviceDay: 0, realtimeArrival: nowSec + 630 },
                      { serviceDay: 0, realtimeArrival: nowSec + 930 },
                    ],
                  },
                  {
                    headsign: 'Brooklyn',
                    route: { shortName },
                    times: [
                      { serviceDay: 0, realtimeArrival: nowSec + 450 },
                    ],
                  },
                ],
              },
            ]);
          }

          const isXss = mockMode === 'xss';
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
              both: [`${train} train delays`, `${train} local service`],
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
    browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
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

      const editBtn = page.locator('#editStationsBtn');
      await editBtn.waitFor({ state: 'visible' });
      const iconStatus = await editBtn.locator('.edit-icon').evaluate((img) => ({
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      }));
      expect(iconStatus).toEqual({ complete: true, naturalWidth: 44, naturalHeight: 44 });

      const inboundColor = station0.locator('.inbound1 .trainColor');
      expect(await inboundColor.locator('.trainName').textContent()).toBe('L');
      expect(await inboundColor.evaluate((el) => el.classList.contains('express'))).toBe(true);
      const transform = await inboundColor.evaluate((el) => getComputedStyle(el).transform);
      expect(transform).not.toBe('none');

      const outboundColor = station0.locator('.outbound1 .trainColor');
      expect(await outboundColor.evaluate((el) => el.classList.contains('local'))).toBe(true);
      expect(await outboundColor.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');

      await page.locator('.alerts').waitFor({ state: 'visible' });
      expect(await page.locator('.alerts .alertsTitle').textContent()).toBe('L: Delays');
      expect(await page.locator('.alerts .alertsBody').textContent()).toContain('L train delays');

      await page.locator('.alerts2').waitFor({ state: 'visible' });
      expect(await page.locator('.alerts2 .alertsTitle').textContent()).toBe('4: Delays');
      expect(await page.evaluate(() => document.compatMode)).toBe('BackCompat');
      const alertsStyle = await page.locator('.alerts2 .alertsBody').evaluate((el) => ({
        whiteSpace: getComputedStyle(el).whiteSpace,
        height: el.getBoundingClientRect().height,
      }));
      expect(alertsStyle.whiteSpace).toBe('pre-line');
      expect(alertsStyle.height).toBeGreaterThan(30);

      const staticResp = await page.request.get(`${baseUrl}/static/css/styles.css`);
      expect(staticResp.status()).toBe(200);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(overflow).toBe(true);

      await page.goto(`${baseUrl}/#L08&G`, { waitUntil: 'networkidle' });
      expect(await page.locator('.alerts2').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 15000);

  test('3-tap picker supports line, borough, 3-col natural grid, reorder, cancel, delete, and batch save', async () => {
    mockMode = 'ok';
    goodServiceRoutes = [];
    const { context, page, pageErrors, consoleErrors, requestedUrls } = await openKindlePage('/');
    try {
      await page.locator('#station0 .stationTitle').waitFor({ state: 'visible' });

      // Tap top-right pencil button -> opens Step 1 (Line bullets) & lazy-loads stops.txt once
      await realTap(page, page.locator('#editStationsBtn'));
      await page.locator('#picker').waitFor({ state: 'visible' });
      await page.locator('.line-btn').first().waitFor({ state: 'visible' });
      expect(requestedUrls.filter((u) => u.includes('stops.txt')).length).toBe(1);

      // Step 1 -> tap line '1' -> Step 2 (Boroughs) -> tap Manhattan -> 35 stops fit <= 900px without scroll
      await realTap(page, page.locator('.line-btn', { hasText: /^1$/ }));
      await page.locator('.boro-card').first().waitFor({ state: 'visible' });
      await realTap(page, page.locator('.boro-card', { hasText: 'Manhattan' }));
      await page.locator('.station-opt').first().waitFor({ state: 'visible' });

      expect(await page.locator('#pickerManage').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      const gridMetrics = await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('.station-opt')).map((el) => el.textContent);
        return {
          count: tiles.length,
          first3: tiles.slice(0, 3),
          hasTimesSq: tiles.some((t) => t.startsWith('Times Sq-42 St')),
          last: tiles[tiles.length - 1],
          pickerH: document.getElementById('picker').getBoundingClientRect().height,
          scrollH: document.documentElement.scrollHeight,
          innerH: window.innerHeight,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      expect(gridMetrics.count).toBe(35);
      expect(gridMetrics.first3).toEqual(['14 St (1/2/3)', '18 St', '23 St']);
      expect(gridMetrics.hasTimesSq).toBe(true);
      expect(gridMetrics.last).toBe('WTC Cortlandt');
      expect(gridMetrics.pickerH).toBeLessThanOrEqual(900);
      expect(gridMetrics.scrollH).toBeLessThanOrEqual(gridMetrics.innerH);
      expect(gridMetrics.scrollW).toBeLessThanOrEqual(gridMetrics.innerW + 1);

      // Navigate back: <- Boroughs -> <- Lines -> tap A -> Manhattan -> W 4 St-Wash Sq
      await realTap(page, page.locator('#pickerStepHeader .btn-secondary'));
      await page.locator('.boro-card').first().waitFor({ state: 'visible' });
      await realTap(page, page.locator('#pickerStepHeader .btn-secondary'));
      await page.locator('.line-btn').first().waitFor({ state: 'visible' });

      await realTap(page, page.locator('.line-btn', { hasText: /^A$/ }));
      await realTap(page, page.locator('.boro-card', { hasText: 'Manhattan' }));
      await realTap(page, page.locator('.station-opt', { hasText: 'W 4 St-Wash Sq' }));

      // Returned to Step 1 with W 4 St-Wash Sq added and single-row actions
      expect(await page.locator('#pickerManage').evaluate((el) => el.classList.contains('hidden'))).toBe(false);
      expect(await page.locator('.picker-item').count()).toBe(2);
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toBe('Bedford Av');
      expect(await page.locator('.picker-item-name').nth(1).textContent()).toBe('W 4 St-Wash Sq');

      // Reorder up then down
      await realTap(page, page.locator('.picker-item').nth(1).locator('.icon-btn').nth(0));
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toBe('W 4 St-Wash Sq');
      await realTap(page, page.locator('.picker-item').nth(0).locator('.icon-btn').nth(1));
      expect(await page.locator('.picker-item-name').nth(0).textContent()).toBe('Bedford Av');

      // Cancel discards unsaved edits; tapping station title does NOT open picker; reopening via pencil does NOT re-fetch stops.txt
      await realTap(page, page.locator('#hidePickerBtn'));
      await page.locator('#main').waitFor({ state: 'visible' });
      await realTap(page, page.locator('#station0 .stationTitle'));
      expect(await page.locator('#picker').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      await realTap(page, page.locator('#editStationsBtn'));
      await page.locator('#picker').waitFor({ state: 'visible' });
      expect(requestedUrls.filter((u) => u.includes('stops.txt')).length).toBe(1);
      expect(await page.locator('.picker-item').count()).toBe(1);

      // Delete remaining station and tap Save -> triggers alert dialog
      await realTap(page, page.locator('.picker-item').nth(0).locator('.icon-btn').nth(2));
      expect(await page.locator('.picker-item').count()).toBe(0);

      const dialogs = [];
      page.once('dialog', async (d) => {
        dialogs.push(d.message());
        await d.accept();
      });
      await realTap(page, page.locator('#savePickerBtn'));
      expect(dialogs).toEqual(['Please select at least one station.']);

      // Add Bedford Av (L -> Bk) and W 4 St-Wash Sq (A -> M) and Save
      await realTap(page, page.locator('.line-btn', { hasText: /^L$/ }));
      await realTap(page, page.locator('.boro-card', { hasText: 'Brooklyn' }));
      await realTap(page, page.locator('.station-opt', { hasText: 'Bedford Av' }));

      await realTap(page, page.locator('.line-btn', { hasText: /^A$/ }));
      await realTap(page, page.locator('.boro-card', { hasText: 'Manhattan' }));
      await realTap(page, page.locator('.station-opt', { hasText: 'W 4 St-Wash Sq' }));

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

      const aBg = await page.locator('#station1 .inbound1 .trainColor').evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(aBg).toBe('rgb(0, 57, 166)');

      expect(requestedUrls.some((u) => u === '/mta/batch?stations=L08,A32&extra=4')).toBe(true);
      expect(goodServiceRoutes.includes('A')).toBe(false);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 20000);

  test('defends against DOM and upstream XSS, handles live hashchange, closed stations, and 500s', async () => {
    const { context, page, pageErrors } = await openKindlePage(
      '/#<img src=x onerror=window.__xss=1>&<script>window.__xss=2</script>',
    );
    try {
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe('Bedford Av');

      mockMode = 'xss';
      await page.goto(`${baseUrl}/#901&4`, { waitUntil: 'networkidle' });
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('#stations img, .alerts img, .alerts2 img').count()).toBe(0);
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe(
        '<img src=x onerror="window.__xss=3">',
      );

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

      mockMode = 'closed';
      await page.goto(`${baseUrl}/#101&4`, { waitUntil: 'networkidle' });
      await page.locator('#station0').waitFor({ state: 'visible' });
      expect(await page.locator('#station0 .stationTitle').textContent()).toBe('Van Cortlandt Park-242 St');
      expect(await page.locator('#station0 .inbound1').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page.locator('#station0 .outbound1').evaluate((el) => el.classList.contains('hidden'))).toBe(true);

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

  test('offline indicator handles initial 15s quick-retry, <5m local ticking, 5m+ dimmed past-train drop, exhaustion, and auto-recovery', async () => {
    mockMode = 'offline_schedule';
    let clientOffline = true;
    const ctx1 = await browser.newContext({ viewport: { width: 758, height: 1024 } });
    const page1 = await ctx1.newPage();
    const errors1 = [];
    page1.on('pageerror', (e) => errors1.push(e.message));
    try {
      await page1.clock.install();
      await page1.route('**/mta/batch*', async (route) => {
        if (clientOffline) {
          await route.fulfill({ status: 502, body: 'offline' });
        } else {
          await route.continue();
        }
      });

      await page1.goto(`${baseUrl}/#L10&G`, { waitUntil: 'domcontentloaded' });
      await page1.locator('#offlineBanner').waitFor({ state: 'visible' });
      await page1.locator('#offlineEmpty').waitFor({ state: 'visible' });

      const initLayout = await page1.evaluate(() => {
        const banner = document.getElementById('offlineBanner').getBoundingClientRect();
        const edit = document.getElementById('editStationsBtn').getBoundingClientRect();
        return {
          bannerText: document.getElementById('offlineBanner').textContent.trim(),
          bannerBottom: banner.bottom,
          editTop: edit.top,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      expect(initLayout.bannerText).toBe('OFFLINE');
      expect(initLayout.editTop).toBeGreaterThanOrEqual(initLayout.bannerBottom);
      expect(initLayout.scrollW).toBeLessThanOrEqual(initLayout.innerW + 1);

      // Part 1 recovery: restore connectivity and advance 15s -> automatic quick-retry recovers via real server
      clientOffline = false;
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 200),
        page1.clock.fastForward(15000),
      ]);
      await page1.locator('#station0').waitFor({ state: 'visible' });
      expect(await page1.locator('#offlineBanner').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#offlineEmpty').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#station0 .inbound1 .countdown').textContent()).toBe('2');
      expect(await page1.locator('#station0 .inbound2 .countdown').textContent()).toBe('5');
      expect(await page1.locator('#station0 .inbound3 .countdown').textContent()).toBe('10');

      // Part 2a: +1m brief outage (<5m) -> ticks down locally, keeps banner hidden
      clientOffline = true;
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 502),
        page1.clock.fastForward(60000),
      ]);
      await page1.waitForFunction(() => document.querySelector('#station0 .inbound1 .countdown')?.textContent === '1');
      expect(await page1.locator('#offlineBanner').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#stations').evaluate((el) => el.classList.contains('stale'))).toBe(false);
      expect(await page1.locator('#station0 .inbound2 .countdown').textContent()).toBe('4');
      expect(await page1.locator('#station0 .inbound3 .countdown').textContent()).toBe('9');

      // Part 2b: +3m total offline -> 150s train passes into past and drops; 4th train (15m -> 12m) promotes
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 502),
        page1.clock.fastForward(120000),
      ]);
      await page1.waitForFunction(() => document.querySelector('#station0 .inbound1 .countdown')?.textContent === '2');
      expect(await page1.locator('#offlineBanner').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#station0 .inbound2 .countdown').textContent()).toBe('7');
      expect(await page1.locator('#station0 .inbound3 .countdown').textContent()).toBe('12');

      // Part 3: +6m total offline (>=5m) -> banner appears, stale dimmed colors, 330s train dropped
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 502),
        page1.clock.fastForward(180000),
      ]);
      await page1.locator('#offlineBanner').waitFor({ state: 'visible' });
      const staleState = await page1.evaluate(() => {
        const banner = document.getElementById('offlineBanner');
        const edit = document.getElementById('editStationsBtn').getBoundingClientRect();
        const bBox = banner.getBoundingClientRect();
        const cd = document.querySelector('#station0 .inbound1 .countdown');
        const tc = document.querySelector('#station0 .inbound1 .trainColor');
        return {
          bannerText: banner.textContent.replace(/\s+/g, ' ').trim(),
          staleClass: document.getElementById('stations').classList.contains('stale'),
          cdColor: getComputedStyle(cd).color,
          tcBg: getComputedStyle(tc).backgroundColor,
          c1: cd.textContent,
          c2: document.querySelector('#station0 .inbound2 .countdown').textContent,
          row3Hidden: document.querySelector('#station0 .inbound3').classList.contains('hidden'),
          editTop: edit.top,
          bannerBottom: bBox.bottom,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      expect(staleState.bannerText).toBe('OFFLINE · 5m+ ago');
      expect(staleState.staleClass).toBe(true);
      expect(staleState.cdColor).toBe('rgb(153, 153, 153)');
      expect(staleState.tcBg).toBe('rgb(187, 187, 187)');
      expect(staleState.c1).toBe('4');
      expect(staleState.c2).toBe('9');
      expect(staleState.row3Hidden).toBe(true);
      expect(staleState.editTop).toBeGreaterThanOrEqual(staleState.bannerBottom);
      expect(staleState.scrollW).toBeLessThanOrEqual(staleState.innerW + 1);

      // Part 4: +16m total offline -> all cached trains in the past -> stations hide, offlineEmpty shows
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 502),
        page1.clock.fastForward(600000),
      ]);
      await page1.locator('#offlineEmpty').waitFor({ state: 'visible' });
      expect(await page1.locator('#stations').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#offlineAge').textContent()).toBe('· 15m+ ago');

      // Part 5: connectivity returns -> next 60s poll auto-recovers cleanly
      clientOffline = false;
      await Promise.all([
        page1.waitForResponse((r) => r.url().includes('/mta/batch') && r.status() === 200),
        page1.clock.fastForward(60000),
      ]);
      await page1.locator('#station0').waitFor({ state: 'visible' });
      expect(await page1.locator('#offlineBanner').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#offlineEmpty').evaluate((el) => el.classList.contains('hidden'))).toBe(true);
      expect(await page1.locator('#stations').evaluate((el) => el.classList.contains('stale'))).toBe(false);
      expect(await page1.locator('#station0 .inbound1 .countdown').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(0, 0, 0)');
      expect(await page1.locator('#station0 .inbound1 .countdown').textContent()).toBe('2');
      expect(errors1).toEqual([]);
    } finally {
      await ctx1.close();
    }
  }, 25000);
});
