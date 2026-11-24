(function() {
  'use strict';

  var STATIONS = ['L08'];
  var EXTRA_TRAIN = '4';
  var ALL_STATIONS = [];
  var ALL_STATIONS_MAP = {};
  var STOPS_BY_LINE_BORO = {};
  var currentPickerStations = [];
  var stopsLoaded = false;
  var stopsLoading = false;
  var pickerStep = 'lines';
  var selectedLine = '';
  var selectedBoro = '';
  var stationTemplate = null;
  var stationRefs = [];

  var XHR_TIMEOUT_MS = 15000;
  var STAGGER_DELAY_MS = 500;
  var POLL_INTERVAL_MS = 60000;
  var RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
  var OFFLINE_BANNER_MS = 5 * 60 * 1000;
  var QUICK_RETRY_DELAY_MS = 15000;

  var pageLoadedAt = (new Date()).getTime();
  var pickerOpen = false;
  var batchSupported = true;
  var staggerTimer = null;
  var quickRetryTimer = null;
  var inFlightRequests = {};
  var lastSuccessAt = 0;
  var consecutiveFailures = 0;
  var lastStationSnapshots = {};
  var cachedTrainsExhausted = false;

  var LINE_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7'],
    ['A', 'C', 'E', 'B', 'D', 'F', 'M'],
    ['G', 'J', 'Z', 'L', 'N', 'Q', 'R'],
    ['W', 'S']
  ];
  var BORO_ORDER = ['M', 'Bk', 'Q', 'Bx'];
  var BORO_NAMES = {
    M: 'Manhattan',
    Bk: 'Brooklyn',
    Q: 'Queens',
    Bx: 'Bronx'
  };

  var TRAIN_COLOR_CLASSES = [
    'train-color-default',
    'train-color-123',
    'train-color-456',
    'train-color-7',
    'train-color-ace',
    'train-color-bdfm',
    'train-color-nqrw',
    'train-color-jz',
    'train-color-g'
  ];

  function trimStr(str) {
    return String(str === null || str === undefined ? '' : str).replace(/^\s+|\s+$/g, '');
  }

  function hasOwnKeys(obj) {
    if (!obj) return false;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        return true;
      }
    }
    return false;
  }

  function isValidStation(id) {
    return typeof id === 'string' && /^[A-Z0-9]{2,5}$/.test(id);
  }

  function isValidTrain(id) {
    return typeof id === 'string' && /^[A-Z0-9]{1,2}$/.test(id);
  }

  function naturalCmp(a, b) {
    var sa = (typeof a === 'string' ? a : (a && a.name ? a.name : '')).toLowerCase();
    var sb = (typeof b === 'string' ? b : (b && b.name ? b.name : '')).toLowerCase();
    var re = /(\d+|\D+)/g;
    var ta = sa.match(re) || [];
    var tb = sb.match(re) || [];
    var len = ta.length < tb.length ? ta.length : tb.length;
    for (var i = 0; i < len; i++) {
      if (ta[i] === tb[i]) continue;
      var na = /^\d+$/.test(ta[i]);
      var nb = /^\d+$/.test(tb[i]);
      if (na && nb) {
        var diff = parseInt(ta[i], 10) - parseInt(tb[i], 10);
        if (diff !== 0) return diff;
      }
      return ta[i] < tb[i] ? -1 : 1;
    }
    return ta.length - tb.length;
  }

  function setText(el, val) {
    if (!el) return;
    var str = (val === null || val === undefined) ? '' : String(val);
    if (el.textContent !== str) {
      el.textContent = str;
    }
  }

  function setHidden(el, hidden) {
    if (!el) return;
    var hasHidden = el.classList.contains('hidden');
    if (hidden && !hasHidden) {
      el.classList.add('hidden');
    } else if (!hidden && hasHidden) {
      el.classList.remove('hidden');
    }
  }

  function setClassToggle(el, addCls, removeCls) {
    if (!el) return;
    if (!el.classList.contains(addCls)) {
      el.classList.add(addCls);
    }
    if (el.classList.contains(removeCls)) {
      el.classList.remove(removeCls);
    }
  }

  function clearChildren(el) {
    if (!el) return;
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function clearStaggerTimer() {
    if (staggerTimer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(staggerTimer);
    }
    staggerTimer = null;
  }

  function clearQuickRetryTimer() {
    if (quickRetryTimer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(quickRetryTimer);
    }
    quickRetryTimer = null;
  }

  function scheduleQuickRetry() {
    clearQuickRetryTimer();
    if (typeof window.setTimeout === 'function') {
      quickRetryTimer = window.setTimeout(function() {
        quickRetryTimer = null;
        refreshAll();
      }, QUICK_RETRY_DELAY_MS);
    }
  }

  function formatOfflineAge(elapsedMs) {
    if (typeof elapsedMs !== 'number' || elapsedMs < OFFLINE_BANNER_MS) return '';
    var mins = Math.floor(elapsedMs / 60000);
    if (mins < 10) return '\u00b7 5m+ ago';
    if (mins < 15) return '\u00b7 10m+ ago';
    if (mins < 30) return '\u00b7 15m+ ago';
    if (mins < 60) return '\u00b7 30m+ ago';
    return '\u00b7 ' + Math.floor(mins / 60) + 'h+ ago';
  }

  function saveStationSnapshot(station, js, nowMs) {
    if (!station || !js) return;
    lastStationSnapshots[station] = {
      data: js,
      fetchedAt: typeof nowMs === 'number' ? nowMs : (new Date()).getTime()
    };
  }

  function projectStationData(snap, nowMs) {
    var elapsedSec = Math.floor((nowMs - snap.fetchedAt) / 1000);
    if (elapsedSec < 0) elapsedSec = 0;

    var src = snap.data || {};
    var srcRoutes = src.route_times || {};
    var outRoutes = {};
    var origCount = 0;
    var remainingCount = 0;

    for (var route in srcRoutes) {
      if (!Object.prototype.hasOwnProperty.call(srcRoutes, route)) continue;
      var list = srcRoutes[route] || [];
      var kept = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t) continue;
        origCount++;
        if (typeof t.seconds === 'number') {
          var rem = t.seconds - elapsedSec;
          if (rem < 0) continue;
          kept.push({
            seconds: rem,
            mins: Math.floor(rem / 60),
            time: t.time,
            estimated: t.estimated,
            train_name: t.train_name
          });
          remainingCount++;
        } else {
          kept.push(t);
          remainingCount++;
        }
      }
      outRoutes[route] = kept;
    }

    return {
      data: {
        name: src.name,
        alerts: src.alerts,
        status: src.status,
        route_times: outRoutes
      },
      origCount: origCount,
      remainingCount: remainingCount
    };
  }

  function tickCachedCountdowns(nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : (new Date()).getTime();
    var totalOrig = 0;
    var totalRemaining = 0;

    for (var j = 0; j < STATIONS.length; j++) {
      var st = STATIONS[j];
      var snap = lastStationSnapshots[st];
      var refs = stationRefs[j] || cacheStationRefs(document.getElementById('station' + j));
      if (snap && refs && refs.root) {
        var projected = projectStationData(snap, now);
        totalOrig += projected.origCount;
        totalRemaining += projected.remainingCount;
        renderStationData(st, refs, projected.data, false);
      }
    }

    cachedTrainsExhausted = (totalOrig > 0 && totalRemaining === 0);
    return totalRemaining;
  }

  function updateOfflineUi(nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : (new Date()).getTime();
    var mainEl = document.getElementById('main');
    var stationsEl = document.getElementById('stations');
    var bannerEl = document.getElementById('offlineBanner');
    var ageEl = document.getElementById('offlineAge');
    var emptyEl = document.getElementById('offlineEmpty');

    var isInitialOffline = (lastSuccessAt === 0 && consecutiveFailures > 0);
    var elapsed = lastSuccessAt > 0 ? (now - lastSuccessAt) : 0;
    var isExtendedOffline = (lastSuccessAt > 0 && consecutiveFailures > 0 && elapsed >= OFFLINE_BANNER_MS);
    var showBanner = isInitialOffline || isExtendedOffline;
    var showEmpty = isInitialOffline || (isExtendedOffline && cachedTrainsExhausted);

    setHidden(bannerEl, !showBanner);
    setHidden(emptyEl, !showEmpty);
    setHidden(stationsEl, showEmpty);

    if (mainEl) {
      if (showBanner && !mainEl.classList.contains('is-offline')) {
        mainEl.classList.add('is-offline');
      } else if (!showBanner && mainEl.classList.contains('is-offline')) {
        mainEl.classList.remove('is-offline');
      }
    }

    if (stationsEl) {
      var shouldStale = isExtendedOffline && !showEmpty;
      if (shouldStale && !stationsEl.classList.contains('stale')) {
        stationsEl.classList.add('stale');
      } else if (!shouldStale && stationsEl.classList.contains('stale')) {
        stationsEl.classList.remove('stale');
      }
    }

    setText(ageEl, isExtendedOffline ? formatOfflineAge(elapsed) : '');
  }

  function markPollSuccess(nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : (new Date()).getTime();
    clearQuickRetryTimer();
    consecutiveFailures = 0;
    cachedTrainsExhausted = false;
    lastSuccessAt = now;
    updateOfflineUi(now);
  }

  function markPollFailure(nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : (new Date()).getTime();
    consecutiveFailures += 1;
    if (consecutiveFailures === 1) {
      scheduleQuickRetry();
    }
    if (lastSuccessAt > 0) {
      tickCachedCountdowns(now);
    }
    updateOfflineUi(now);
  }

  function abortRequest(slot) {
    var entry = inFlightRequests[slot];
    if (!entry) return;
    entry.done = true;
    if (entry.timer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(entry.timer);
    }
    delete inFlightRequests[slot];
    try {
      if (entry.xhr && typeof entry.xhr.abort === 'function') {
        entry.xhr.abort();
      }
    } catch (e) {
      // ignore abort errors on old WebKit
    }
  }

  function abortAllRequests(includeStops) {
    clearStaggerTimer();
    for (var slot in inFlightRequests) {
      if (Object.prototype.hasOwnProperty.call(inFlightRequests, slot)) {
        if (!includeStops && slot === 'stops') continue;
        abortRequest(slot);
      }
    }
  }

  function sendJsonGet(slot, url, onSuccess, onError) {
    abortRequest(slot);

    var xhttp = new XMLHttpRequest();
    var entry = { xhr: xhttp, timer: null, done: false };
    inFlightRequests[slot] = entry;

    function finish() {
      if (entry.done) return false;
      entry.done = true;
      if (entry.timer !== null && typeof window.clearTimeout === 'function') {
        window.clearTimeout(entry.timer);
      }
      if (inFlightRequests[slot] === entry) {
        delete inFlightRequests[slot];
      }
      return true;
    }

    if (typeof window.setTimeout === 'function') {
      entry.timer = window.setTimeout(function() {
        if (!finish()) return;
        try {
          if (typeof xhttp.abort === 'function') xhttp.abort();
        } catch (e) {}
        if (onError) onError(0);
      }, XHR_TIMEOUT_MS);
    }

    try {
      xhttp.timeout = XHR_TIMEOUT_MS;
    } catch (e) {}

    xhttp.onload = function() {
      if (!finish()) return;
      if (xhttp.status !== 200) {
        if (onError) onError(xhttp.status);
        return;
      }
      var js;
      try {
        js = JSON.parse(xhttp.responseText);
      } catch (e) {
        if (onError) onError(0);
        return;
      }
      if (onSuccess) onSuccess(js);
    };

    xhttp.onerror = function() {
      if (!finish()) return;
      if (onError) onError(0);
    };

    xhttp.ontimeout = function() {
      if (!finish()) return;
      if (onError) onError(0);
    };

    xhttp.onabort = function() {
      finish();
    };

    xhttp.open('GET', url, true);
    xhttp.send();
    return xhttp;
  }

  function maybePeriodicReload(nowMs) {
    if (pickerOpen) return false;
    var now = typeof nowMs === 'number' ? nowMs : (new Date()).getTime();
    if (now - pageLoadedAt >= RELOAD_INTERVAL_MS) {
      if (window.location && typeof window.location.reload === 'function') {
        window.location.reload();
        return true;
      }
    }
    return false;
  }

  function indexStops(list) {
    var map = {};
    var byLineBoro = {};
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      map[st.id] = st;
      var rts = st.routes || [];
      for (var r = 0; r < rts.length; r++) {
        var line = rts[r];
        if (!byLineBoro[line]) byLineBoro[line] = {};
        var boro = st.borough || 'Other';
        if (!byLineBoro[line][boro]) byLineBoro[line][boro] = [];
        byLineBoro[line][boro].push(st);
      }
    }
    for (var ln in byLineBoro) {
      if (!Object.prototype.hasOwnProperty.call(byLineBoro, ln)) continue;
      for (var br in byLineBoro[ln]) {
        if (Object.prototype.hasOwnProperty.call(byLineBoro[ln], br)) {
          byLineBoro[ln][br].sort(naturalCmp);
        }
      }
    }
    ALL_STATIONS_MAP = map;
    STOPS_BY_LINE_BORO = byLineBoro;
  }

  function loadStops(callback) {
    if (stopsLoaded) {
      if (callback) callback();
      return;
    }
    if (stopsLoading) return;
    stopsLoading = true;

    abortRequest('stops');
    var xhttp = new XMLHttpRequest();
    var entry = { xhr: xhttp, timer: null, done: false };
    inFlightRequests.stops = entry;

    xhttp.onload = function() {
      stopsLoading = false;
      entry.done = true;
      delete inFlightRequests.stops;
      if (xhttp.status !== 200) return;

      var lines = xhttp.responseText.split('\n');
      var parsed = [];
      for (var i = 1; i < lines.length; i++) {
        var line = trimStr(lines[i]);
        if (!line) continue;
        var parts = line.split(',');
        if (parts.length < 2) continue;
        var id = trimStr(parts[0]);
        var rawName = trimStr(parts[1]);
        if (!isValidStation(id)) continue;
        var boro = parts.length >= 3 ? trimStr(parts[2]) : '';
        var routesStr = parts.length >= 4 ? trimStr(parts[3]) : id.charAt(0);
        var routeTokens = routesStr ? routesStr.split(/\s+/) : [id.charAt(0)];
        parsed.push({
          id: id,
          name: rawName,
          borough: boro,
          routes: routeTokens
        });
      }
      ALL_STATIONS = parsed;
      indexStops(parsed);
      stopsLoaded = true;
      if (pickerOpen) {
        drawPickerList();
        drawPickerStep();
      }
      if (callback) callback();
    };
    xhttp.onerror = function() {
      stopsLoading = false;
      entry.done = true;
      delete inFlightRequests.stops;
    };
    xhttp.open('GET', '/mta/static/js/stops.txt', true);
    xhttp.send();
  }

  function showPicker() {
    pickerOpen = true;
    pickerStep = 'lines';
    selectedLine = '';
    selectedBoro = '';
    setHidden(document.getElementById('main'), true);
    setHidden(document.getElementById('picker'), false);

    currentPickerStations = STATIONS.slice();
    drawPickerList();
    drawPickerStep();

    if (!stopsLoaded) {
      loadStops();
    }
  }

  function hidePicker() {
    pickerOpen = false;
    setHidden(document.getElementById('picker'), true);
    setHidden(document.getElementById('main'), false);
  }

  function makeIconBtn(label, extraClass, handler) {
    var btn = document.createElement('span');
    btn.className = extraClass ? ('icon-btn ' + extraClass) : 'icon-btn';
    btn.textContent = label;
    btn.addEventListener('click', handler);
    return btn;
  }

  function drawPickerList() {
    var pickerList = document.getElementById('pickerList');
    if (!pickerList) return;
    clearChildren(pickerList);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < currentPickerStations.length; i++) {
      var id = currentPickerStations[i];
      var info = ALL_STATIONS_MAP[id];
      var name = info ? info.name : id;
      var routes = info && info.routes ? info.routes : [id.charAt(0)];

      var row = document.createElement('div');
      row.className = 'picker-item';

      var left = document.createElement('span');
      left.className = 'picker-item-left';
      for (var r = 0; r < routes.length; r++) {
        var bullet = document.createElement('span');
        bullet.className = 'mini-bullet ' + getTrainColorClass(routes[r]);
        bullet.textContent = routes[r];
        left.appendChild(bullet);
      }
      var nameSpan = document.createElement('span');
      nameSpan.className = 'picker-item-name';
      nameSpan.textContent = name;
      left.appendChild(nameSpan);
      row.appendChild(left);

      var actions = document.createElement('span');
      actions.className = 'picker-item-actions';
      (function(idx) {
        actions.appendChild(makeIconBtn('\u25B2', '', function() { moveStation(idx, -1); }));
        actions.appendChild(makeIconBtn('\u25BC', '', function() { moveStation(idx, 1); }));
        actions.appendChild(makeIconBtn('\u00D7', 'icon-btn-del', function() { deleteStation(idx); }));
      })(i);
      row.appendChild(actions);

      frag.appendChild(row);
    }
    pickerList.appendChild(frag);
  }

  function getLineBoroughs(line) {
    var boroMap = STOPS_BY_LINE_BORO[line];
    if (!boroMap) return [];
    var out = [];
    for (var i = 0; i < BORO_ORDER.length; i++) {
      var b = BORO_ORDER[i];
      if (boroMap[b] && boroMap[b].length > 0) {
        out.push(b);
      }
    }
    for (var k in boroMap) {
      if (Object.prototype.hasOwnProperty.call(boroMap, k) && BORO_ORDER.indexOf(k) === -1 && boroMap[k].length > 0) {
        out.push(k);
      }
    }
    return out;
  }

  function selectLine(line) {
    selectedLine = line;
    var boros = getLineBoroughs(line);
    if (boros.length === 1) {
      selectedBoro = boros[0];
      pickerStep = 'stations';
    } else {
      selectedBoro = '';
      pickerStep = 'boroughs';
    }
    drawPickerStep();
  }

  function selectBorough(boro) {
    selectedBoro = boro;
    pickerStep = 'stations';
    drawPickerStep();
  }

  function addStationById(id) {
    if (!isValidStation(id)) return;
    currentPickerStations.push(id);
    pickerStep = 'lines';
    selectedLine = '';
    selectedBoro = '';
    drawPickerList();
    drawPickerStep();
  }

  function makeStepHeader(line, titleText, backLabel, onBack) {
    var bar = document.createElement('div');
    bar.className = 'step-header';

    var title = document.createElement('span');
    title.className = 'step-title';
    if (line) {
      var bullet = document.createElement('span');
      bullet.className = 'step-bullet ' + getTrainColorClass(line);
      bullet.textContent = line;
      title.appendChild(bullet);
    }
    var txt = document.createElement('span');
    txt.className = 'step-title-text';
    txt.textContent = titleText;
    title.appendChild(txt);
    bar.appendChild(title);

    if (backLabel && onBack) {
      var actions = document.createElement('span');
      actions.className = 'mta-actions';
      var backBtn = document.createElement('button');
      backBtn.className = 'btn-secondary';
      backBtn.type = 'button';
      backBtn.textContent = backLabel;
      backBtn.addEventListener('click', onBack);
      actions.appendChild(backBtn);
      bar.appendChild(actions);
    }
    return bar;
  }

  function drawPickerStep() {
    var manageEl = document.getElementById('pickerManage');
    var headerEl = document.getElementById('pickerStepHeader');
    var bodyEl = document.getElementById('pickerStepBody');
    if (!headerEl || !bodyEl) return;

    clearChildren(headerEl);
    clearChildren(bodyEl);

    if (!stopsLoaded) {
      setHidden(manageEl, false);
      var loading = document.createElement('div');
      loading.className = 'picker-status';
      loading.textContent = 'Loading stations...';
      bodyEl.appendChild(loading);
      return;
    }

    if (pickerStep === 'lines') {
      setHidden(manageEl, false);
      var lbl = document.createElement('div');
      lbl.className = 'section-label';
      lbl.textContent = 'Add a station \u2014 pick a line';
      headerEl.appendChild(lbl);

      var grid = document.createElement('div');
      grid.className = 'line-grid';
      for (var r = 0; r < LINE_ROWS.length; r++) {
        var rowDiv = document.createElement('div');
        rowDiv.className = 'line-row';
        var rowLines = LINE_ROWS[r];
        for (var c = 0; c < rowLines.length; c++) {
          (function(ln) {
            var btn = document.createElement('span');
            btn.className = 'line-btn ' + getTrainColorClass(ln);
            btn.textContent = ln;
            btn.addEventListener('click', function() {
              selectLine(ln);
            });
            rowDiv.appendChild(btn);
          })(rowLines[c]);
        }
        grid.appendChild(rowDiv);
      }
      bodyEl.appendChild(grid);
      return;
    }

    if (pickerStep === 'boroughs') {
      setHidden(manageEl, false);
      var bLbl = document.createElement('div');
      bLbl.className = 'section-label';
      bLbl.textContent = 'Add a station \u2014 pick a borough';
      headerEl.appendChild(bLbl);

      var subBar = makeStepHeader(selectedLine, 'Line ' + selectedLine, '\u2190 Lines', function() {
        pickerStep = 'lines';
        selectedLine = '';
        drawPickerStep();
      });
      subBar.className = 'mta-bar-sub';
      headerEl.appendChild(subBar);

      var boros = getLineBoroughs(selectedLine);
      var boroFrag = document.createDocumentFragment();
      for (var i = 0; i < boros.length; i++) {
        (function(bCode) {
          var list = STOPS_BY_LINE_BORO[selectedLine][bCode] || [];
          var card = document.createElement('div');
          card.className = 'boro-card';
          card.textContent = BORO_NAMES[bCode] || bCode;

          var meta = document.createElement('span');
          meta.className = 'boro-meta';
          meta.textContent = list.length + (list.length === 1 ? ' stop \u203A' : ' stops \u203A');
          card.appendChild(meta);

          card.addEventListener('click', function() {
            selectBorough(bCode);
          });
          boroFrag.appendChild(card);
        })(boros[i]);
      }
      bodyEl.appendChild(boroFrag);
      return;
    }

    // Step 3: Full-screen 3-column natural-alphabetical station grid
    setHidden(manageEl, true);
    var multiBoro = getLineBoroughs(selectedLine).length > 1;
    var backLabel = multiBoro ? '\u2190 Boroughs' : '\u2190 Lines';
    var boroName = BORO_NAMES[selectedBoro] || selectedBoro;
    headerEl.appendChild(makeStepHeader(selectedLine, boroName, backLabel, function() {
      if (multiBoro) {
        pickerStep = 'boroughs';
        selectedBoro = '';
      } else {
        pickerStep = 'lines';
        selectedLine = '';
        selectedBoro = '';
      }
      drawPickerStep();
    }));

    var stationsList = (STOPS_BY_LINE_BORO[selectedLine] && STOPS_BY_LINE_BORO[selectedLine][selectedBoro]) || [];
    var colsWrap = document.createElement('div');
    colsWrap.className = 'station-cols';

    for (var s = 0; s < stationsList.length; s++) {
      (function(st, idx) {
        var cell = document.createElement('div');
        cell.className = ((idx + 1) % 3 === 0) ? 'station-cell station-cell-last' : 'station-cell';

        var tile = document.createElement('div');
        tile.className = 'station-opt';
        tile.textContent = st.name;

        if (st.routes && st.routes.length > 1) {
          var tag = document.createElement('span');
          tag.className = 'st-routes';
          tag.textContent = ' (' + st.routes.join('/') + ')';
          tile.appendChild(tag);
        }

        tile.addEventListener('click', function() {
          addStationById(st.id);
        });
        cell.appendChild(tile);
        colsWrap.appendChild(cell);
      })(stationsList[s], s);
    }
    bodyEl.appendChild(colsWrap);
  }

  function moveStation(index, dir) {
    var target = index + dir;
    if (target >= 0 && target < currentPickerStations.length) {
      var tmp = currentPickerStations[index];
      currentPickerStations[index] = currentPickerStations[target];
      currentPickerStations[target] = tmp;
      drawPickerList();
    }
  }

  function deleteStation(index) {
    if (index >= 0 && index < currentPickerStations.length) {
      currentPickerStations.splice(index, 1);
      drawPickerList();
    }
  }

  function savePicker() {
    var valid = [];
    for (var i = 0; i < currentPickerStations.length; i++) {
      if (isValidStation(currentPickerStations[i])) {
        valid.push(encodeURIComponent(currentPickerStations[i]));
      }
    }
    if (valid.length > 0) {
      var searchStr = valid.join(',');
      if (isValidTrain(EXTRA_TRAIN)) {
        searchStr += '&' + encodeURIComponent(EXTRA_TRAIN);
      }
      window.location.search = '?q=' + searchStr;
    } else {
      alert('Please select at least one station.');
    }
  }

  function parseQueryParam(search) {
    if (!search) return '';
    var s = search.charAt(0) === '?' ? search.substring(1) : search;
    if (s.indexOf('q=') === 0) {
      return s.substring(2);
    }
    return s;
  }

  function setFromHash() {
    var raw = '';
    if (window.location.search) {
      raw = parseQueryParam(window.location.search);
    }
    if (window.location.hash) {
      raw = window.location.hash.substring(1);
    }
    if (!raw) return;

    try {
      raw = decodeURIComponent(raw);
    } catch (e) {
      // keep raw if malformed percent encoding
    }

    var stationPart = raw;
    var ampIdx = raw.indexOf('&');
    if (ampIdx > -1) {
      stationPart = raw.substring(0, ampIdx);
      var restParts = raw.substring(ampIdx + 1).split('&');
      var extraPart = trimStr(restParts[0]).toUpperCase();
      if (extraPart === '') {
        EXTRA_TRAIN = '';
      } else if (isValidTrain(extraPart)) {
        EXTRA_TRAIN = extraPart;
      } else {
        EXTRA_TRAIN = '';
      }
    }

    var candidates = stationPart.split(',');
    var validated = [];
    for (var i = 0; i < candidates.length; i++) {
      var cand = trimStr(candidates[i]).toUpperCase();
      if (isValidStation(cand)) {
        validated.push(cand);
      }
    }
    if (validated.length > 0) {
      STATIONS = validated;
    } else {
      STATIONS = ['L08'];
    }
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function hashChange() {
    if (window.location.hash) {
      var prevStations = STATIONS.slice();
      var prevExtra = EXTRA_TRAIN;
      setFromHash();
      if (!arraysEqual(prevStations, STATIONS)) {
        setupStations();
      } else if (prevExtra !== EXTRA_TRAIN) {
        refreshAll();
      }
    }
  }

  function cacheStationRefs(stationEl) {
    var refs = {
      root: stationEl,
      title: stationEl.querySelector('.stationTitle'),
      dirs: {
        inbound: {
          title: stationEl.querySelector('.inboundTitle'),
          rows: []
        },
        outbound: {
          title: stationEl.querySelector('.outboundTitle'),
          rows: []
        }
      }
    };
    var dirNames = ['inbound', 'outbound'];
    for (var d = 0; d < dirNames.length; d++) {
      var dir = dirNames[d];
      for (var j = 0; j < 3; j++) {
        var row = stationEl.querySelector('.' + dir + (j + 1));
        refs.dirs[dir].rows.push({
          row: row,
          name: row ? row.querySelector('.trainName') : null,
          color: row ? row.querySelector('.trainColor') : null,
          count: row ? row.querySelector('.countdown') : null,
          time: row ? row.querySelector('.realtime') : null
        });
      }
    }
    return refs;
  }

  function setupStations() {
    var stationsContainer = document.getElementById('stations');
    if (!stationsContainer) return;

    if (!stationTemplate) {
      var initial = document.getElementById('station0');
      if (initial) {
        stationTemplate = initial.cloneNode(true);
      }
    }
    if (!stationTemplate) return;

    clearChildren(stationsContainer);
    stationRefs = [];

    var frag = document.createDocumentFragment();
    for (var i = 0; i < STATIONS.length; i++) {
      var node = stationTemplate.cloneNode(true);
      node.id = 'station' + i;
      setHidden(node, true);
      frag.appendChild(node);
      stationRefs.push(cacheStationRefs(node));
    }
    stationsContainer.appendChild(frag);

    if (STATIONS.length > 1 && window.innerWidth < 1200) {
      stationsContainer.classList.add('small');
    } else {
      stationsContainer.classList.remove('small');
    }

    clearQuickRetryTimer();
    lastStationSnapshots = {};
    lastSuccessAt = 0;
    consecutiveFailures = 0;
    cachedTrainsExhausted = false;
    updateOfflineUi();

    refreshAll();
  }

  function renderStationData(station, refsOrEl, js, doAlert) {
    if (!js) return;
    var refs = refsOrEl && refsOrEl.dirs ? refsOrEl : cacheStationRefs(refsOrEl);
    var stationEl = refs.root;
    var train = station.charAt(0);

    setHidden(stationEl, false);
    setText(refs.title, js.name || '');

    if (doAlert && js.status) {
      var alerts = '';
      var alertList = js.status.alerts || [];
      for (var a = 0; a < alertList.length; a++) {
        if (alerts !== '') {
          alerts += '\n';
        }
        alerts += alertList[a];
      }
      var body = document.getElementById('main');
      var alertEl = body ? body.querySelector('.alerts') : null;
      if (alertEl) {
        if (js.status.status === 'Good Service') {
          setHidden(alertEl, true);
        } else {
          setHidden(alertEl, false);
          setText(alertEl.querySelector('.alertsTitle'), train + ': ' + (js.status.status || '?'));
          setText(alertEl.querySelector('.alertsBody'), alerts);
        }
      }
    }

    var outbound = false;
    var routeTimes = js.route_times;
    if (!routeTimes || !hasOwnKeys(routeTimes)) {
      routeTimes = { outbound: [], inbound: [] };
    }

    var idx = 0;
    var secondRoute = '';
    var route;
    for (route in routeTimes) {
      if (Object.prototype.hasOwnProperty.call(routeTimes, route)) {
        if (idx > 1) break;
        if (idx === 1) {
          secondRoute = route;
        }
        idx++;
      }
    }

    idx = 0;
    for (route in routeTimes) {
      if (!Object.prototype.hasOwnProperty.call(routeTimes, route)) continue;
      if (idx > 1) break;

      var dirName = 'outbound';
      var rName = route.replace(/ [-&] .*/, '').replace(/, .*/, '');
      var otherRoute = idx === 0 ? secondRoute : '';
      idx++;

      if (route === 'Manhattan' ||
        route === '34 St - Hudson Yards' ||
        route === '8 Av' ||
        route.indexOf('Uptown') > -1 ||
        otherRoute === 'Church Av' ||
        otherRoute.indexOf('Downtown') > -1 ||
        outbound === true) {
        dirName = 'inbound';
      } else {
        outbound = true;
      }

      var times = routeTimes[route] || [];
      var dirRefs = refs.dirs[dirName];
      setText(dirRefs.title, rName);

      for (var j = 0; j < 3; j++) {
        var rowRef = dirRefs.rows[j];
        if (!rowRef || !rowRef.row) continue;

        if (j >= times.length) {
          setHidden(rowRef.row, true);
        } else {
          setHidden(rowRef.row, false);
          var time = times[j];
          var trainName = String(time.train_name || '?');

          if (trainName.length === 2 && trainName.charAt(1) === 'X') {
            trainName = trainName.charAt(0);
            setClassToggle(rowRef.color, 'express', 'local');
          } else {
            setClassToggle(rowRef.color, 'local', 'express');
          }

          setText(rowRef.name, trainName);
          if (STATIONS.length > 1) {
            colorTrain(rowRef.color, trainName);
          }
          setText(rowRef.count, time.mins);
          setText(rowRef.time, time.time);
        }
      }
    }
  }

  function renderExtraAlert(train, js) {
    var body = document.getElementById('main');
    var alertEl = body ? body.querySelector('.alerts2') : null;
    if (!alertEl) return;
    if (!isValidTrain(train) || !js) {
      setHidden(alertEl, true);
      return;
    }

    var alerts = '';
    var alertList = js.alerts || [];
    for (var i = 0; i < alertList.length; i++) {
      if (alerts !== '') {
        alerts += '\n';
      }
      alerts += alertList[i];
    }
    if (js.status === 'Good Service') {
      setHidden(alertEl, true);
    } else {
      setHidden(alertEl, false);
      setText(alertEl.querySelector('.alertsTitle'), train + ': ' + (js.status || '?'));
      setText(alertEl.querySelector('.alertsBody'), alerts);
    }
  }

  function loadTimes(station, refsOrEl, doAlert, slot, onDone) {
    if (!isValidStation(station)) {
      if (onDone) onDone(false);
      return;
    }
    var reqSlot = slot || ('station:' + station);
    var url = '/mta/countdown/' + encodeURIComponent(station) + (doAlert ? '' : '?alerts=0');
    sendJsonGet(
      reqSlot,
      url,
      function(js) {
        saveStationSnapshot(station, js);
        renderStationData(station, refsOrEl, js, doAlert);
        if (onDone) onDone(true);
      },
      function() {
        if (onDone) onDone(false);
      }
    );
  }

  function loadTimesFromUrl() {
    for (var i = 0; i < STATIONS.length; i++) {
      var station = STATIONS[i];
      var refs = stationRefs[i] || cacheStationRefs(document.getElementById('station' + i));
      if (refs && refs.root) {
        loadTimes(station, refs, i === 0, 'station:' + i);
      }
    }
  }

  function getTrainColorClass(train) {
    if (train === '1' || train === '2' || train === '3') return 'train-color-123';
    if (train === '4' || train === '5' || train === '6') return 'train-color-456';
    if (train === '7') return 'train-color-7';
    if (train === 'A' || train === 'C' || train === 'E') return 'train-color-ace';
    if (train === 'B' || train === 'D' || train === 'F' || train === 'M') return 'train-color-bdfm';
    if (train === 'N' || train === 'Q' || train === 'R' || train === 'W') return 'train-color-nqrw';
    if (train === 'J' || train === 'Z') return 'train-color-jz';
    if (train === 'G') return 'train-color-g';
    return 'train-color-default';
  }

  function colorTrain(el, train) {
    if (!el) return;
    var targetCls = getTrainColorClass(train);
    if (el.classList.contains(targetCls)) return;
    for (var i = 0; i < TRAIN_COLOR_CLASSES.length; i++) {
      var cls = TRAIN_COLOR_CLASSES[i];
      if (cls !== targetCls && el.classList.contains(cls)) {
        el.classList.remove(cls);
      }
    }
    el.classList.add(targetCls);
  }

  function loadAlert2(onDone) {
    if (!isValidTrain(EXTRA_TRAIN)) {
      renderExtraAlert('', null);
      if (onDone) onDone(false);
      return;
    }

    var train = EXTRA_TRAIN;
    sendJsonGet(
      'alert2',
      '/mta/alerts/' + encodeURIComponent(train),
      function(js) {
        renderExtraAlert(train, js);
        if (onDone) onDone(true);
      },
      function() {
        if (onDone) onDone(false);
      }
    );
  }

  function startStaggeredFallback() {
    abortAllRequests(false);

    var tasks = [];
    for (var i = 0; i < STATIONS.length; i++) {
      (function(idx) {
        tasks.push(function(next) {
          var station = STATIONS[idx];
          var refs = stationRefs[idx] || cacheStationRefs(document.getElementById('station' + idx));
          if (!refs || !refs.root) {
            next(false);
            return;
          }
          loadTimes(station, refs, idx === 0, 'station:' + idx, next);
        });
      })(i);
    }

    if (isValidTrain(EXTRA_TRAIN)) {
      tasks.push(function(next) {
        loadAlert2(next);
      });
    } else {
      renderExtraAlert('', null);
    }

    var anySucceeded = false;
    function finishStaggered() {
      if (anySucceeded) {
        markPollSuccess();
        maybePeriodicReload();
      } else {
        markPollFailure();
      }
    }
    function runStep(stepIdx) {
      if (stepIdx >= tasks.length) {
        finishStaggered();
        return;
      }
      tasks[stepIdx](function(ok) {
        if (ok) anySucceeded = true;
        if (stepIdx + 1 < tasks.length) {
          if (typeof window.setTimeout === 'function') {
            staggerTimer = window.setTimeout(function() {
              staggerTimer = null;
              runStep(stepIdx + 1);
            }, STAGGER_DELAY_MS);
          } else {
            runStep(stepIdx + 1);
          }
        } else {
          finishStaggered();
        }
      });
    }

    runStep(0);
  }

  function refreshAll() {
    clearStaggerTimer();
    clearQuickRetryTimer();

    if (!batchSupported) {
      startStaggeredFallback();
      return;
    }

    var encodedStations = [];
    for (var i = 0; i < STATIONS.length; i++) {
      if (isValidStation(STATIONS[i])) {
        encodedStations.push(encodeURIComponent(STATIONS[i]));
      }
    }
    if (encodedStations.length === 0) return;

    if (!isValidTrain(EXTRA_TRAIN)) {
      renderExtraAlert('', null);
    }

    var url = '/mta/batch?stations=' + encodedStations.join(',');
    var requestedExtra = '';
    if (isValidTrain(EXTRA_TRAIN)) {
      requestedExtra = EXTRA_TRAIN;
      url += '&extra=' + encodeURIComponent(requestedExtra);
    }

    for (var slot in inFlightRequests) {
      if (Object.prototype.hasOwnProperty.call(inFlightRequests, slot)) {
        if (slot !== 'stops' && slot !== 'batch') {
          abortRequest(slot);
        }
      }
    }

    sendJsonGet(
      'batch',
      url,
      function(data) {
        if (!data || !data.stations) {
          markPollFailure();
          return;
        }
        var now = (new Date()).getTime();
        for (var j = 0; j < STATIONS.length; j++) {
          var st = STATIONS[j];
          var refs = stationRefs[j] || cacheStationRefs(document.getElementById('station' + j));
          if (refs && refs.root && data.stations[st]) {
            saveStationSnapshot(st, data.stations[st], now);
            renderStationData(st, refs, data.stations[st], j === 0);
          }
        }
        if (requestedExtra && data.extra_alert) {
          renderExtraAlert(requestedExtra, data.extra_alert);
        }
        markPollSuccess(now);
        maybePeriodicReload(now);
      },
      function(status) {
        if (status === 404) {
          batchSupported = false;
          startStaggeredFallback();
        } else {
          markPollFailure();
        }
      }
    );
  }

  function bindUiEvents() {
    var editBtn = document.getElementById('editStationsBtn');
    if (editBtn) editBtn.addEventListener('click', showPicker);

    var saveBtn = document.getElementById('savePickerBtn');
    if (saveBtn) saveBtn.addEventListener('click', savePicker);

    var hideBtn = document.getElementById('hidePickerBtn');
    if (hideBtn) hideBtn.addEventListener('click', hidePicker);

    if (window.addEventListener) {
      window.addEventListener('hashchange', hashChange, false);
    } else if (window.attachEvent) {
      window.attachEvent('onhashchange', hashChange);
    }
  }

  function init() {
    setFromHash();
    bindUiEvents();
    setupStations();

    if (typeof window.setInterval === 'function') {
      window.setInterval(refreshAll, POLL_INTERVAL_MS);
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      setFromHash: setFromHash,
      hashChange: hashChange,
      showPicker: showPicker,
      hidePicker: hidePicker,
      drawPickerList: drawPickerList,
      drawPickerStep: drawPickerStep,
      selectLine: selectLine,
      selectBorough: selectBorough,
      addStationById: addStationById,
      moveStation: moveStation,
      deleteStation: deleteStation,
      savePicker: savePicker,
      setupStations: setupStations,
      loadTimesFromUrl: loadTimesFromUrl,
      loadTimes: loadTimes,
      loadAlert2: loadAlert2,
      loadStops: loadStops,
      refreshAll: refreshAll,
      abortAllRequests: abortAllRequests,
      maybePeriodicReload: maybePeriodicReload,
      formatOfflineAge: formatOfflineAge,
      tickCachedCountdowns: tickCachedCountdowns,
      updateOfflineUi: updateOfflineUi,
      markPollSuccess: markPollSuccess,
      markPollFailure: markPollFailure,
      colorTrain: colorTrain,
      naturalCmp: naturalCmp,
      isValidStation: isValidStation,
      isValidTrain: isValidTrain,
      getState: function() {
        return {
          stations: STATIONS,
          extraTrain: EXTRA_TRAIN,
          allStations: ALL_STATIONS,
          currentPickerStations: currentPickerStations,
          stopsLoaded: stopsLoaded,
          pickerStep: pickerStep,
          selectedLine: selectedLine,
          selectedBoro: selectedBoro,
          batchSupported: batchSupported,
          pickerOpen: pickerOpen,
          lastSuccessAt: lastSuccessAt,
          consecutiveFailures: consecutiveFailures,
          lastStationSnapshots: lastStationSnapshots,
          cachedTrainsExhausted: cachedTrainsExhausted,
          inFlightSlots: inFlightRequests
        };
      },
      setState: function(s) {
        if (s.stations !== undefined) STATIONS = s.stations;
        if (s.extraTrain !== undefined) EXTRA_TRAIN = s.extraTrain;
        if (s.allStations !== undefined) {
          ALL_STATIONS = s.allStations;
          indexStops(ALL_STATIONS);
        }
        if (s.currentPickerStations !== undefined) currentPickerStations = s.currentPickerStations;
        if (s.stopsLoaded !== undefined) stopsLoaded = s.stopsLoaded;
        if (s.pickerStep !== undefined) pickerStep = s.pickerStep;
        if (s.selectedLine !== undefined) selectedLine = s.selectedLine;
        if (s.selectedBoro !== undefined) selectedBoro = s.selectedBoro;
        if (s.batchSupported !== undefined) batchSupported = s.batchSupported;
        if (s.pickerOpen !== undefined) pickerOpen = s.pickerOpen;
        if (s.pageLoadedAt !== undefined) pageLoadedAt = s.pageLoadedAt;
        if (s.lastSuccessAt !== undefined) lastSuccessAt = s.lastSuccessAt;
        if (s.consecutiveFailures !== undefined) consecutiveFailures = s.consecutiveFailures;
        if (s.lastStationSnapshots !== undefined) lastStationSnapshots = s.lastStationSnapshots;
        if (s.cachedTrainsExhausted !== undefined) cachedTrainsExhausted = s.cachedTrainsExhausted;
      }
    };
  }
})();
