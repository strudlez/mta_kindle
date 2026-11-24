import { describe, expect, test, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const JS_PATH = path.join(ROOT, 'static/js/js.js');
const HTML_PATH = path.join(ROOT, 'templates/mta.html');
const CSS_PATH = path.join(ROOT, 'static/css/styles.css');

class MockClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  syncFromAttr(val) {
    this.set = new Set(String(val || '').split(/\s+/).filter(Boolean));
  }
  add(...names) {
    for (const n of names) this.set.add(n);
    this.el._className = Array.from(this.set).join(' ');
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
    this.el._className = Array.from(this.set).join(' ');
  }
  contains(name) {
    return this.set.has(name);
  }
}

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this._className = '';
    this.classList = new MockClassList(this);
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this._textContent = '';
    this.textWrites = 0;
    this.htmlWrites = 0;
    this.value = '';
  }

  get className() {
    return this._className;
  }

  set className(val) {
    this._className = String(val || '');
    this.classList.syncFromAttr(this._className);
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(val) {
    this.textWrites += 1;
    this._textContent = String(val ?? '');
  }

  get innerHTML() {
    return '';
  }

  set innerHTML(val) {
    this.htmlWrites += 1;
    this._innerHTML = String(val ?? '');
  }

  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      for (const c of child.children.slice()) {
        this.appendChild(c);
      }
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx > -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  cloneNode(deep = false) {
    const copy = new MockElement(this.tagName);
    copy.id = this.id;
    copy.className = this.className;
    copy._textContent = this._textContent;
    if (deep) {
      for (const c of this.children) {
        copy.appendChild(c.cloneNode(true));
      }
    }
    return copy;
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchClick() {
    let cur = this;
    while (cur) {
      for (const fn of cur.listeners.click || []) {
        fn({ target: this });
      }
      cur = cur.parentNode;
    }
  }

  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    for (const child of this.children) {
      if ((cls && child.classList.contains(cls)) || (id && child.id === id)) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const results = [];
    for (const child of this.children) {
      if (cls && child.classList.contains(cls)) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

function buildStationTemplate() {
  const s0 = new MockElement('div');
  s0.id = 'station0';
  s0.className = 'hidden';

  const title = new MockElement('div');
  title.className = 'stationTitle';
  s0.appendChild(title);

  const dirs = new MockElement('div');
  dirs.className = 'directions';

  for (const dirName of ['inbound', 'outbound']) {
    const dir = new MockElement('div');
    dir.className = `${dirName} direction`;
    const dirTitle = new MockElement('div');
    dirTitle.className = `${dirName}Title`;
    dir.appendChild(dirTitle);

    for (let i = 1; i <= 3; i++) {
      const row = new MockElement('div');
      row.className = `${dirName}${i} train`;
      const color = new MockElement('div');
      color.className = 'trainColor';
      const name = new MockElement('div');
      name.className = 'trainName';
      color.appendChild(name);
      const countdown = new MockElement('div');
      countdown.className = 'countdown';
      const realtime = new MockElement('div');
      realtime.className = 'realtime';
      row.appendChild(color);
      row.appendChild(countdown);
      row.appendChild(realtime);
      dir.appendChild(row);
    }
    dirs.appendChild(dir);
  }
  s0.appendChild(dirs);
  return s0;
}

function setupEnvironment(locationOpts = {}) {
  const xhrRequests = [];
  const timers = [];
  let nextTimerId = 1;
  let reloadCount = 0;
  const root = new MockElement('body');

  const main = new MockElement('div');
  main.id = 'main';
  main.className = 'body';
  const offlineBanner = new MockElement('div');
  offlineBanner.id = 'offlineBanner';
  offlineBanner.className = 'hidden';
  const offlineAge = new MockElement('span');
  offlineAge.id = 'offlineAge';
  offlineBanner.appendChild(offlineAge);
  main.appendChild(offlineBanner);
  const editBtn = new MockElement('button');
  editBtn.id = 'editStationsBtn';
  main.appendChild(editBtn);
  const stations = new MockElement('div');
  stations.id = 'stations';
  stations.appendChild(buildStationTemplate());
  main.appendChild(stations);
  const offlineEmpty = new MockElement('div');
  offlineEmpty.id = 'offlineEmpty';
  offlineEmpty.className = 'hidden';
  main.appendChild(offlineEmpty);

  for (const cls of ['alerts', 'alerts2']) {
    const a = new MockElement('div');
    a.className = `${cls} hidden`;
    const t = new MockElement('div');
    t.className = 'alertsTitle';
    const b = new MockElement('div');
    b.className = 'alertsBody';
    a.appendChild(t);
    a.appendChild(b);
    main.appendChild(a);
  }

  const picker = new MockElement('div');
  picker.id = 'picker';
  picker.className = 'body hidden';
  const pickerManage = new MockElement('div');
  pickerManage.id = 'pickerManage';
  const pickerList = new MockElement('div');
  pickerList.id = 'pickerList';
  const saveBtn = new MockElement('button');
  saveBtn.id = 'savePickerBtn';
  const hideBtn = new MockElement('button');
  hideBtn.id = 'hidePickerBtn';
  pickerManage.appendChild(pickerList);
  pickerManage.appendChild(saveBtn);
  pickerManage.appendChild(hideBtn);

  const pickerBrowse = new MockElement('div');
  pickerBrowse.id = 'pickerBrowse';
  const pickerStepHeader = new MockElement('div');
  pickerStepHeader.id = 'pickerStepHeader';
  const pickerStepBody = new MockElement('div');
  pickerStepBody.id = 'pickerStepBody';
  pickerBrowse.appendChild(pickerStepHeader);
  pickerBrowse.appendChild(pickerStepBody);

  picker.appendChild(pickerManage);
  picker.appendChild(pickerBrowse);

  root.appendChild(main);
  root.appendChild(picker);

  const mockDocument = {
    readyState: 'complete',
    createElement: (tag) => new MockElement(tag),
    createDocumentFragment: () => new MockElement('#FRAGMENT'),
    getElementById: (id) => root.querySelector(`#${id}`),
    addEventListener: () => {},
  };

  const mockWindow = {
    innerWidth: 1000,
    location: {
      search: locationOpts.search || '',
      hash: locationOpts.hash || '',
      reload() {
        reloadCount += 1;
      },
    },
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    setInterval: () => 1,
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
  };

  class MockXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
      this.status = 200;
      this.responseText = '';
      this.aborted = false;
    }
    send() {
      xhrRequests.push(this);
    }
    abort() {
      this.aborted = true;
      if (typeof this.onabort === 'function') this.onabort();
    }
  }

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;
  globalThis.XMLHttpRequest = MockXHR;
  globalThis.alert = () => {};

  delete require.cache[require.resolve(JS_PATH)];
  const app = require(JS_PATH);
  return {
    app,
    xhrRequests,
    timers,
    getReloadCount: () => reloadCount,
    root,
    mockWindow,
    mockDocument,
    main,
    stations,
    offlineBanner,
    offlineAge,
    offlineEmpty,
    editBtn,
    pickerManage,
    pickerList,
    pickerStepHeader,
    pickerStepBody,
  };
}

describe('Kindle Compatibility & Static Checks', () => {
  test('js.js uses strictly ES5 syntax', () => {
    const raw = fs.readFileSync(JS_PATH, 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(const|let|class|async|await)\b/);
    expect(code).not.toMatch(/=>/);
    expect(code).not.toContain('`');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain('URLSearchParams');
    expect(code).not.toMatch(/\.includes\s*\(/);
    expect(code).not.toContain('?.');
    expect(code).not.toContain('??');
  });

  test('mta.html stays in Quirks Mode for Kindle, has no inline handlers/styles, and script in body', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    expect(html.toUpperCase()).not.toContain('<!DOCTYPE');
    expect(html).not.toMatch(/\bonclick\s*=/i);
    expect(html).not.toMatch(/\bstyle\s*=/i);
    const headClose = html.indexOf('</head>');
    const scriptPos = html.indexOf('<script ');
    expect(scriptPos).toBeGreaterThan(headClose);
  });

  test('styles.css uses px units, pre-line alerts, valid properties, and no flexbox/grid', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    expect(css).not.toContain('float: center');
    expect(css).not.toMatch(/\.trainNam\b/);
    expect(css).toContain('white-space: pre-line');
    expect(css).not.toMatch(/display:\s*(flex|grid)/i);
    expect(css).not.toMatch(/(font-size|height)\s*:\s*\d+\s*;/);
  });
});

describe('Frontend Logic, Security & Performance', () => {
  let env;

  beforeEach(() => {
    env = setupEnvironment();
  });

  test('setFromHash parses valid hash/query and blocks XSS payloads', () => {
    env = setupEnvironment({ hash: '#A32,L08&F' });
    expect(env.app.getState().stations).toEqual(['A32', 'L08']);
    expect(env.app.getState().extraTrain).toBe('F');

    env = setupEnvironment({ hash: '#<img src=x onerror=alert(1)>&<script>' });
    expect(env.app.getState().stations).toEqual(['L08']);
    expect(env.app.getState().extraTrain).toBe('');

    env = setupEnvironment({ search: '?q=901&' });
    expect(env.app.getState().stations).toEqual(['901']);
    expect(env.app.getState().extraTrain).toBe('');
  });

  test('naturalCmp sorts street numbers numerically (14 < 18 < 96 < 103 < 116)', () => {
    const names = ['116 St', '14 St', '103 St', '96 St', '18 St', 'Times Sq-42 St', '28 St'];
    names.sort(env.app.naturalCmp);
    expect(names).toEqual(['14 St', '18 St', '28 St', '96 St', '103 St', '116 St', 'Times Sq-42 St']);
  });

  test('3-step picker lazy-loads stops.txt once, skips single-borough step, and renders natural order', () => {
    expect(env.xhrRequests.some((r) => r.url.includes('stops.txt'))).toBe(false);

    env.editBtn.dispatchClick();
    expect(env.app.getState().pickerOpen).toBe(true);
    const stopReqs = env.xhrRequests.filter((r) => r.url.includes('stops.txt'));
    expect(stopReqs.length).toBe(1);

    stopReqs[0].status = 200;
    stopReqs[0].responseText = [
      'stop_id,stop_name,borough,routes',
      'L08,Bedford Av,Bk,L',
      'L13,Montrose Av,Bk,L',
      '127,Times Sq-42 St,M,1 2 3',
      '120,96 St,M,1 2 3',
      '119,103 St,M,1',
      '725,Times Sq-42 St,M,7',
      '701,Flushing-Main St,Q,7',
      'G30,Broadway,Bk,G',
    ].join('\n');
    stopReqs[0].onload();

    expect(env.app.getState().stopsLoaded).toBe(true);
    expect(env.app.getState().pickerStep).toBe('lines');
    expect(env.pickerStepBody.querySelectorAll('.line-btn').length).toBe(23);

    // Line L serves only Bk in fixture -> auto-skips borough step straight to stations
    env.app.selectLine('L');
    expect(env.app.getState().pickerStep).toBe('stations');
    expect(env.app.getState().selectedBoro).toBe('Bk');
    expect(env.pickerManage.classList.contains('hidden')).toBe(true);

    // Line 7 serves M and Q -> shows borough step
    env.app.selectLine('7');
    expect(env.app.getState().pickerStep).toBe('boroughs');
    expect(env.pickerStepBody.querySelectorAll('.boro-card').length).toBe(2);

    // Line 1 in Manhattan sorts 96 St before 103 St before Times Sq-42 St
    env.app.selectLine('1');
    env.app.selectBorough('M');
    const tiles = env.pickerStepBody.querySelectorAll('.station-opt').map((el) => el.textContent);
    expect(tiles).toEqual(['96 St', '103 St', 'Times Sq-42 St']);

    // Adding station resets to lines step and shows pickerManage
    env.app.addStationById('127');
    expect(env.app.getState().currentPickerStations).toEqual(['L08', '127']);
    expect(env.app.getState().pickerStep).toBe('lines');
    expect(env.pickerManage.classList.contains('hidden')).toBe(false);

    // Reopening picker does not re-fetch stops.txt
    env.app.hidePicker();
    env.app.showPicker();
    expect(env.xhrRequests.filter((r) => r.url.includes('stops.txt')).length).toBe(1);
  });

  test('drawPickerList, loadTimes, and loadAlert2 never use innerHTML on untrusted data', () => {
    const xssPayload = '<img src=x onerror=alert(1)>';
    env.app.setState({ currentPickerStations: [xssPayload, 'L08'] });
    env.app.drawPickerList();

    expect(env.pickerList.htmlWrites).toBe(0);
    expect(env.pickerList.children.length).toBe(2);
    expect(env.pickerList.children[0].querySelector('.picker-item-name').textContent).toBe(xssPayload);

    env.app.loadTimes('L08', env.root.querySelector('#station0'), true);
    const cdReq = env.xhrRequests.find((r) => r.url.includes('/mta/countdown/'));
    cdReq.status = 200;
    cdReq.responseText = JSON.stringify({
      name: xssPayload,
      alerts: [],
      status: { status: xssPayload, alerts: [xssPayload] },
      route_times: {
        [xssPayload]: [{ seconds: 60, mins: 1, time: '12:01', estimated: false, train_name: xssPayload }],
      },
    });
    cdReq.onload();

    const s0 = env.root.querySelector('#station0');
    expect(s0.htmlWrites).toBe(0);
    expect(s0.querySelector('.stationTitle').htmlWrites).toBe(0);
    expect(s0.querySelector('.stationTitle').textContent).toBe(xssPayload);
    expect(s0.querySelector('.outboundTitle').textContent).toBe(xssPayload);
    expect(s0.querySelector('.outbound1').querySelector('.trainName').textContent).toBe(xssPayload);

    env.app.loadAlert2();
    const a2Req = env.xhrRequests.find((r) => r.url.includes('/mta/alerts/'));
    a2Req.status = 200;
    a2Req.responseText = JSON.stringify({ status: xssPayload, alerts: [xssPayload] });
    a2Req.onload();

    const a2 = env.root.querySelector('.alerts2');
    expect(a2.querySelector('.alertsTitle').htmlWrites).toBe(0);
    expect(a2.querySelector('.alertsTitle').textContent).toBe(`4: ${xssPayload}`);
  });

  test('batch polling uses 1 request, falls back to staggered on 404, and dirty-checks DOM writes', () => {
    env = setupEnvironment({ hash: '#L08,A32&4' });
    const batchReqs = env.xhrRequests.filter((r) => r.url.startsWith('/mta/batch'));
    expect(batchReqs.length).toBe(1);
    expect(batchReqs[0].url).toBe('/mta/batch?stations=L08,A32&extra=4');

    const batchPayload = JSON.stringify({
      stations: {
        L08: {
          name: 'Bedford Av',
          alerts: [],
          status: { status: 'Good Service', alerts: [] },
          route_times: {
            Manhattan: [{ seconds: 120, mins: 2, time: '1:02', estimated: false, train_name: 'LX' }],
          },
        },
        A32: {
          name: 'W 4 St-Wash Sq',
          alerts: [],
          status: { status: '?', alerts: [] },
          route_times: {
            Uptown: [{ seconds: 180, mins: 3, time: '1:03', estimated: false, train_name: 'A' }],
          },
        },
      },
      extra_alert: { status: 'Delays', alerts: ['4 delayed'] },
    });

    batchReqs[0].status = 200;
    batchReqs[0].responseText = batchPayload;
    batchReqs[0].onload();

    const s0 = env.root.querySelector('#station0');
    const titleEl = s0.querySelector('.stationTitle');
    const countEl = s0.querySelector('.inbound1').querySelector('.countdown');
    const writesAfterFirst = titleEl.textWrites;
    const countWritesAfterFirst = countEl.textWrites;

    // Second identical batch poll causes zero redundant textContent writes
    env.app.refreshAll();
    const secondBatch = env.xhrRequests.filter((r) => r.url.startsWith('/mta/batch'))[1];
    secondBatch.status = 200;
    secondBatch.responseText = batchPayload;
    secondBatch.onload();

    expect(titleEl.textWrites).toBe(writesAfterFirst);
    expect(countEl.textWrites).toBe(countWritesAfterFirst);

    // 404 on /mta/batch falls back to sequential staggered /mta/countdown/ + /mta/alerts/
    env.app.refreshAll();
    const thirdBatch = env.xhrRequests.filter((r) => r.url.startsWith('/mta/batch'))[2];
    thirdBatch.status = 404;
    thirdBatch.onload();
    expect(env.app.getState().batchSupported).toBe(false);

    const after404 = env.xhrRequests.slice(3);
    expect(after404.map((r) => r.url)).toEqual(['/mta/countdown/L08']);
    after404[0].status = 200;
    after404[0].responseText = JSON.stringify({
      name: 'Bedford Av',
      alerts: [],
      status: { status: 'Good Service', alerts: [] },
      route_times: {},
    });
    after404[0].onload();

    const pendingStagger = env.timers.filter((t) => !t.cleared && t.delay === 500);
    expect(pendingStagger.length).toBe(1);
    pendingStagger[0].fn();
    expect(env.xhrRequests[env.xhrRequests.length - 1].url).toBe('/mta/countdown/A32?alerts=0');
  });

  test('overlapping poll aborts hung XHR, 15s watchdog aborts, and 6h reload skips when picker is open', () => {
    const firstBatch = env.xhrRequests[0];
    expect(firstBatch.aborted).toBe(false);

    env.app.refreshAll();
    expect(firstBatch.aborted).toBe(true);

    const secondBatch = env.xhrRequests[1];
    const watchdog = env.timers.find((t) => !t.cleared && t.delay === 15000);
    expect(watchdog).toBeDefined();
    watchdog.fn();
    expect(secondBatch.aborted).toBe(true);

    env.app.setState({
      pageLoadedAt: Date.now() - 7 * 60 * 60 * 1000,
      pickerOpen: true,
    });
    expect(env.app.maybePeriodicReload()).toBe(false);
    expect(env.getReloadCount()).toBe(0);

    env.app.setState({ pickerOpen: false });
    env.app.refreshAll();
    const healthyBatch = env.xhrRequests[env.xhrRequests.length - 1];
    healthyBatch.status = 200;
    healthyBatch.responseText = JSON.stringify({ stations: {}, extra_alert: null });
    healthyBatch.onload();
    expect(env.getReloadCount()).toBe(1);
  });

  test('handles closed stations, non-200 status, malformed JSON, and hashChange safely', () => {
    const batchReq = env.xhrRequests.find((r) => r.url.startsWith('/mta/batch'));

    batchReq.status = 502;
    batchReq.responseText = 'Bad Gateway';
    expect(() => batchReq.onload()).not.toThrow();

    env.app.refreshAll();
    const batchReq2 = env.xhrRequests[env.xhrRequests.length - 1];
    batchReq2.status = 200;
    batchReq2.responseText = '{bad json';
    expect(() => batchReq2.onload()).not.toThrow();

    env.app.loadTimes('L08', env.root.querySelector('#station0'), true);
    const cdReq = env.xhrRequests[env.xhrRequests.length - 1];
    cdReq.status = 200;
    cdReq.responseText = JSON.stringify({
      name: 'Closed St',
      alerts: [],
      status: { status: 'Good Service', alerts: [] },
      route_times: {},
    });
    expect(() => cdReq.onload()).not.toThrow();
    const s0 = env.root.querySelector('#station0');
    expect(s0.querySelector('.inbound1').classList.contains('hidden')).toBe(true);
    expect(s0.querySelector('.outbound1').classList.contains('hidden')).toBe(true);

    env.mockWindow.location.hash = '#A32,901&F';
    expect(() => env.app.hashChange()).not.toThrow();
    expect(env.app.getState().stations).toEqual(['A32', '901']);
  });

  test('brief <5m outage ticks cached countdowns, drops past trains, quick-retries once at 15s, and hides banner', () => {
    const t0 = Date.now();
    const firstBatch = env.xhrRequests.find((r) => r.url.startsWith('/mta/batch'));
    firstBatch.status = 200;
    firstBatch.responseText = JSON.stringify({
      stations: {
        L08: {
          name: 'Bedford Av',
          alerts: [],
          status: { status: 'Good Service', alerts: [] },
          route_times: {
            Manhattan: [
              { seconds: 90, mins: 1, time: '11:01', estimated: false, train_name: 'L' },
              { seconds: 210, mins: 3, time: '11:03', estimated: false, train_name: 'L' },
              { seconds: 510, mins: 8, time: '11:08', estimated: false, train_name: 'L' },
              { seconds: 810, mins: 13, time: '11:13', estimated: false, train_name: 'L' },
            ],
          },
        },
      },
      extra_alert: null,
    });
    firstBatch.onload();

    const s0 = env.root.querySelector('#station0');
    expect(env.offlineBanner.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('stale')).toBe(false);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('1');
    expect(s0.querySelector('.inbound2').querySelector('.countdown').textContent).toBe('3');
    expect(s0.querySelector('.inbound3').querySelector('.countdown').textContent).toBe('8');

    // Pin snapshot & lastSuccessAt to deterministic t0, then fail 1st poll at +60s (< 5m)
    const snap = env.app.getState().lastStationSnapshots.L08;
    snap.fetchedAt = t0;
    env.app.setState({ lastSuccessAt: t0 });

    env.app.markPollFailure(t0 + 60 * 1000);
    expect(env.offlineBanner.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('stale')).toBe(false);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('0');
    expect(s0.querySelector('.inbound2').querySelector('.countdown').textContent).toBe('2');
    expect(s0.querySelector('.inbound3').querySelector('.countdown').textContent).toBe('7');

    // Exactly one 15s quick-retry timer is scheduled on the 1st failure
    const quickRetries = env.timers.filter((t) => !t.cleared && t.delay === 15000);
    expect(quickRetries.length).toBe(1);
    const reqCountBefore = env.xhrRequests.length;
    quickRetries[0].fn();
    expect(env.xhrRequests.length).toBe(reqCountBefore + 1);
    expect(env.xhrRequests[env.xhrRequests.length - 1].url).toBe('/mta/batch?stations=L08&extra=4');

    // 2nd consecutive failure at +120s (< 5m): 90s train dropped, 4th train promoted, no extra quick-retry
    const timersBefore2ndFail = env.timers.length;
    const failedRetry = env.xhrRequests[env.xhrRequests.length - 1];
    failedRetry.status = 502;
    failedRetry.onload();
    env.app.markPollFailure(t0 + 120 * 1000);
    expect(env.offlineBanner.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('stale')).toBe(false);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('1');
    expect(s0.querySelector('.inbound1').querySelector('.realtime').textContent).toBe('11:03');
    expect(s0.querySelector('.inbound2').querySelector('.countdown').textContent).toBe('6');
    expect(s0.querySelector('.inbound3').querySelector('.countdown').textContent).toBe('11');
    expect(s0.querySelector('.inbound3').querySelector('.realtime').textContent).toBe('11:13');
    const newActiveRetries = env.timers.slice(timersBefore2ndFail).filter((t) => !t.cleared && t.delay === 15000);
    expect(newActiveRetries.length).toBe(0);
  });

  test('5+ min outage shows offline banner, coarse dirty-checked age, dims and drops past trains, exhausts cleanly, and auto-recovers', () => {
    expect(env.app.formatOfflineAge(4 * 60 * 1000)).toBe('');
    expect(env.app.formatOfflineAge(5 * 60 * 1000)).toBe('· 5m+ ago');
    expect(env.app.formatOfflineAge(9 * 60 * 1000)).toBe('· 5m+ ago');
    expect(env.app.formatOfflineAge(10 * 60 * 1000)).toBe('· 10m+ ago');
    expect(env.app.formatOfflineAge(15 * 60 * 1000)).toBe('· 15m+ ago');
    expect(env.app.formatOfflineAge(30 * 60 * 1000)).toBe('· 30m+ ago');
    expect(env.app.formatOfflineAge(60 * 60 * 1000)).toBe('· 1h+ ago');
    expect(env.app.formatOfflineAge(135 * 60 * 1000)).toBe('· 2h+ ago');

    const t0 = Date.now();
    const firstBatch = env.xhrRequests.find((r) => r.url.startsWith('/mta/batch'));
    firstBatch.status = 200;
    firstBatch.responseText = JSON.stringify({
      stations: {
        L08: {
          name: 'Bedford Av',
          alerts: [],
          status: { status: 'Good Service', alerts: [] },
          route_times: {
            Manhattan: [
              { seconds: 150, mins: 2, time: '11:02', estimated: false, train_name: 'L' },
              { seconds: 630, mins: 10, time: '11:10', estimated: false, train_name: 'L' },
            ],
          },
        },
      },
      extra_alert: null,
    });
    firstBatch.onload();

    const s0 = env.root.querySelector('#station0');
    env.app.getState().lastStationSnapshots.L08.fetchedAt = t0;
    env.app.setState({ lastSuccessAt: t0 });

    // At +6m offline: banner visible, dimmed stale state, 150s train dropped, 630s train ticked to 4m
    env.app.markPollFailure(t0 + 6 * 60 * 1000);
    expect(env.offlineBanner.classList.contains('hidden')).toBe(false);
    expect(env.offlineAge.textContent).toBe('· 5m+ ago');
    expect(env.main.classList.contains('is-offline')).toBe(true);
    expect(env.stations.classList.contains('stale')).toBe(true);
    expect(env.offlineEmpty.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('hidden')).toBe(false);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('4');
    expect(s0.querySelector('.inbound1').querySelector('.realtime').textContent).toBe('11:10');
    expect(s0.querySelector('.inbound2').classList.contains('hidden')).toBe(true);

    // At +7m offline: same 5m+ bucket skips redundant offlineAge textContent write
    const ageWrites = env.offlineAge.textWrites;
    env.app.markPollFailure(t0 + 7 * 60 * 1000);
    expect(env.offlineAge.textWrites).toBe(ageWrites);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('3');

    // At +12m offline: all cached trains have passed -> stations hide and offlineEmpty shows
    env.app.markPollFailure(t0 + 12 * 60 * 1000);
    expect(env.offlineAge.textContent).toBe('· 10m+ ago');
    expect(env.app.getState().cachedTrainsExhausted).toBe(true);
    expect(env.stations.classList.contains('hidden')).toBe(true);
    expect(env.offlineEmpty.classList.contains('hidden')).toBe(false);

    // Auto-recovery on next successful poll
    env.app.refreshAll();
    const recoveredBatch = env.xhrRequests[env.xhrRequests.length - 1];
    recoveredBatch.status = 200;
    recoveredBatch.responseText = JSON.stringify({
      stations: {
        L08: {
          name: 'Bedford Av',
          alerts: [],
          status: { status: 'Good Service', alerts: [] },
          route_times: {
            Manhattan: [{ seconds: 240, mins: 4, time: '11:16', estimated: false, train_name: 'L' }],
          },
        },
      },
      extra_alert: null,
    });
    recoveredBatch.onload();

    expect(env.offlineBanner.classList.contains('hidden')).toBe(true);
    expect(env.offlineEmpty.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('hidden')).toBe(false);
    expect(env.main.classList.contains('is-offline')).toBe(false);
    expect(env.stations.classList.contains('stale')).toBe(false);
    expect(env.app.getState().consecutiveFailures).toBe(0);
    expect(s0.querySelector('.inbound1').querySelector('.countdown').textContent).toBe('4');
  });

  test('initial-load failure shows offline banner and empty message immediately, and staggered fallback tracks failures', () => {
    const firstBatch = env.xhrRequests.find((r) => r.url.startsWith('/mta/batch'));
    firstBatch.status = 502;
    firstBatch.onload();

    expect(env.offlineBanner.classList.contains('hidden')).toBe(false);
    expect(env.offlineAge.textContent).toBe('');
    expect(env.offlineEmpty.classList.contains('hidden')).toBe(false);
    expect(env.stations.classList.contains('hidden')).toBe(true);
    expect(env.main.classList.contains('is-offline')).toBe(true);

    // 15s quick-retry runs next
    const retryTimer = env.timers.find((t) => !t.cleared && t.delay === 15000);
    expect(retryTimer).toBeDefined();
    retryTimer.fn();

    // Test 404 staggered fallback failing then succeeding
    const batch404 = env.xhrRequests[env.xhrRequests.length - 1];
    batch404.status = 404;
    batch404.onload();
    expect(env.app.getState().batchSupported).toBe(false);

    const cdFail = env.xhrRequests[env.xhrRequests.length - 1];
    cdFail.status = 502;
    cdFail.onload();
    const staggerStep = env.timers.find((t) => !t.cleared && t.delay === 500);
    expect(staggerStep).toBeDefined();
    staggerStep.fn();
    const alertFail = env.xhrRequests[env.xhrRequests.length - 1];
    alertFail.status = 502;
    alertFail.onload();
    expect(env.offlineBanner.classList.contains('hidden')).toBe(false);

    // Next staggered cycle succeeds -> clears offline state
    env.app.refreshAll();
    const cdOk = env.xhrRequests[env.xhrRequests.length - 1];
    cdOk.status = 200;
    cdOk.responseText = JSON.stringify({
      name: 'Bedford Av',
      alerts: [],
      status: { status: 'Good Service', alerts: [] },
      route_times: {
        Manhattan: [{ seconds: 180, mins: 3, time: '11:03', estimated: false, train_name: 'L' }],
      },
    });
    cdOk.onload();
    const staggerStep2 = env.timers.filter((t) => !t.cleared && t.delay === 500).pop();
    staggerStep2.fn();
    const alertOk = env.xhrRequests[env.xhrRequests.length - 1];
    alertOk.status = 200;
    alertOk.responseText = JSON.stringify({ status: 'Good Service', alerts: [] });
    alertOk.onload();

    expect(env.offlineBanner.classList.contains('hidden')).toBe(true);
    expect(env.offlineEmpty.classList.contains('hidden')).toBe(true);
    expect(env.stations.classList.contains('hidden')).toBe(false);
    expect(env.main.classList.contains('is-offline')).toBe(false);
  });
});
