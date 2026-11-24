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
  const root = new MockElement('body');

  const main = new MockElement('div');
  main.id = 'main';
  main.className = 'body';
  const stations = new MockElement('div');
  stations.id = 'stations';
  stations.appendChild(buildStationTemplate());
  main.appendChild(stations);

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
  const pickerList = new MockElement('div');
  pickerList.id = 'pickerList';
  const pickerSelect = new MockElement('select');
  pickerSelect.id = 'pickerSelect';
  const addBtn = new MockElement('button');
  addBtn.id = 'addStationBtn';
  const saveBtn = new MockElement('button');
  saveBtn.id = 'savePickerBtn';
  const hideBtn = new MockElement('button');
  hideBtn.id = 'hidePickerBtn';
  picker.appendChild(pickerList);
  picker.appendChild(pickerSelect);
  picker.appendChild(addBtn);
  picker.appendChild(saveBtn);
  picker.appendChild(hideBtn);

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
    },
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    setInterval: () => 1,
    setTimeout: (fn) => { fn(); return 1; },
  };

  class MockXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
      this.status = 200;
      this.responseText = '';
    }
    send() {
      xhrRequests.push(this);
    }
  }

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;
  globalThis.XMLHttpRequest = MockXHR;
  globalThis.alert = () => {};

  delete require.cache[require.resolve(JS_PATH)];
  const app = require(JS_PATH);
  return { app, xhrRequests, root, mockWindow, mockDocument, pickerList, pickerSelect };
}

describe('Kindle Compatibility & Static Checks', () => {
  test('js.js uses strictly ES5 syntax', () => {
    const raw = fs.readFileSync(JS_PATH, 'utf8');
    // Strip comments before scanning
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

  test('mta.html has DOCTYPE, no inline handlers/styles, and script in body', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toMatch(/\bonclick\s*=/i);
    expect(html).not.toMatch(/\bstyle\s*=/i);
    const headClose = html.indexOf('</head>');
    const scriptPos = html.indexOf('<script ');
    expect(scriptPos).toBeGreaterThan(headClose);
  });

  test('styles.css uses px units, valid properties, and no flexbox/grid', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    expect(css).not.toContain('float: center');
    expect(css).not.toMatch(/\.trainNam\b/);
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

  test('stops.txt is lazy-loaded only on first showPicker() and cached', () => {
    // Initial load fires countdown + alert2 only, NOT stops.txt
    expect(env.xhrRequests.some((r) => r.url.includes('stops.txt'))).toBe(false);

    env.app.showPicker();
    const stopReqs = env.xhrRequests.filter((r) => r.url.includes('stops.txt'));
    expect(stopReqs.length).toBe(1);

    stopReqs[0].status = 200;
    stopReqs[0].responseText = 'stop_id,stop_name\nL08,Bedford Av\nA32,W 4 St\n';
    stopReqs[0].onload();

    expect(env.app.getState().stopsLoaded).toBe(true);
    expect(env.pickerSelect.children.length).toBe(3); // default + 2 stops

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

    const a2Req = env.xhrRequests.find((r) => r.url.includes('/mta/alerts/'));
    a2Req.status = 200;
    a2Req.responseText = JSON.stringify({ status: xssPayload, alerts: [xssPayload] });
    a2Req.onload();

    const a2 = env.root.querySelector('.alerts2');
    expect(a2.querySelector('.alertsTitle').htmlWrites).toBe(0);
    expect(a2.querySelector('.alertsTitle').textContent).toBe(`4: ${xssPayload}`);
  });

  test('secondary stations pass ?alerts=0 and dirty-checking skips unchanged DOM writes', () => {
    env = setupEnvironment({ hash: '#L08,A32&4' });
    const cdReqs = env.xhrRequests.filter((r) => r.url.includes('/mta/countdown/'));
    expect(cdReqs.map((r) => r.url)).toEqual(['/mta/countdown/L08', '/mta/countdown/A32?alerts=0']);

    const payload = JSON.stringify({
      name: 'Bedford Av',
      alerts: [],
      status: { status: 'Good Service', alerts: [] },
      route_times: {
        Manhattan: [{ seconds: 120, mins: 2, time: '1:02', estimated: false, train_name: 'LX' }],
      },
    });

    cdReqs[0].status = 200;
    cdReqs[0].responseText = payload;
    cdReqs[0].onload();

    const s0 = env.root.querySelector('#station0');
    const titleEl = s0.querySelector('.stationTitle');
    const countEl = s0.querySelector('.inbound1').querySelector('.countdown');
    const writesAfterFirst = titleEl.textWrites;
    const countWritesAfterFirst = countEl.textWrites;

    // Second identical poll causes zero redundant textContent writes
    env.app.loadTimesFromUrl();
    const secondReq = env.xhrRequests.filter((r) => r.url === '/mta/countdown/L08')[1];
    secondReq.status = 200;
    secondReq.responseText = payload;
    secondReq.onload();

    expect(titleEl.textWrites).toBe(writesAfterFirst);
    expect(countEl.textWrites).toBe(countWritesAfterFirst);
  });

  test('handles closed stations, non-200 status, malformed JSON, and hashChange safely', () => {
    const cdReq = env.xhrRequests.find((r) => r.url.includes('/mta/countdown/'));

    // Non-200 and malformed JSON do not throw
    cdReq.status = 502;
    cdReq.responseText = 'Bad Gateway';
    expect(() => cdReq.onload()).not.toThrow();

    cdReq.status = 200;
    cdReq.responseText = '{bad json';
    expect(() => cdReq.onload()).not.toThrow();

    // Closed station hides all rows cleanly
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

    // hashChange updates stations without throwing
    env.mockWindow.location.hash = '#A32,901&F';
    expect(() => env.app.hashChange()).not.toThrow();
    expect(env.app.getState().stations).toEqual(['A32', '901']);
  });
});
