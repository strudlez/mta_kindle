import { chromium } from 'playwright-core';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_PATH = path.join(ROOT, 'target/debug/mta');
const HAS_ENV = fs.existsSync(path.join(ROOT, '.env'));

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

function ensureBuilt() {
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
    console.log('Building mta server...');
    const res = Bun.spawnSync(['cargo', 'build'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.exitCode !== 0) process.exit(res.exitCode || 1);
  }
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      if (res.status === 204) return;
    } catch (_) {}
    await Bun.sleep(50);
  }
  throw new Error('Server did not become ready');
}

ensureBuilt();
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const initialQuery = process.argv[2] || '?q=L13,M12,G30&4';

const env = {
  ...process.env,
  BIND_ADDR: `127.0.0.1:${port}`,
  RUST_LOG: 'info',
};
if (!HAS_ENV && !env.API_KEY) {
  console.warn('Warning: .env not found; set API_KEY to load live MTA data.');
  env.API_KEY = 'preview-dummy-key';
}

const serverProc = Bun.spawn([BIN_PATH], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });
const cleanup = async () => {
  try { serverProc.kill(); } catch (_) {}
  await serverProc.exited.catch(() => {});
};
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });

try {
  await waitForServer(baseUrl);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 758, height: 1024 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+',
  });
  await context.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = 'html { filter: grayscale(100%); }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  console.log(`Opening Kindle preview (758x1024, grayscale, 6x CPU throttle) at ${baseUrl}/${initialQuery}`);
  console.log('Close the browser window to exit.');
  await page.goto(`${baseUrl}/${initialQuery}`);

  await new Promise((resolve) => browser.on('disconnected', resolve));
} finally {
  await cleanup();
}
