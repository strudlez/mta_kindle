(function() {
  'use strict';

  var STATIONS = ['L08'];
  var EXTRA_TRAIN = '4';
  var ALL_STATIONS = [];
  var ALL_STATIONS_MAP = {};
  var currentPickerStations = [];
  var stopsLoaded = false;
  var stopsLoading = false;
  var selectPopulated = false;
  var stationTemplate = null;
  var stationRefs = [];

  var XHR_TIMEOUT_MS = 15000;
  var STAGGER_DELAY_MS = 500;
  var POLL_INTERVAL_MS = 60000;
  var RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;

  var pageLoadedAt = (new Date()).getTime();
  var pickerOpen = false;
  var batchSupported = true;
  var staggerTimer = null;
  var inFlightRequests = {};

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

  function clearStaggerTimer() {
    if (staggerTimer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(staggerTimer);
    }
    staggerTimer = null;
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

  function populateSelectOptions() {
    if (selectPopulated || !stopsLoaded) return;
    var select = document.getElementById('pickerSelect');
    if (!select) return;
    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }
    var frag = document.createDocumentFragment();
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select a station...';
    frag.appendChild(defaultOpt);

    for (var i = 0; i < ALL_STATIONS.length; i++) {
      var opt = document.createElement('option');
      opt.value = ALL_STATIONS[i].id;
      opt.textContent = ALL_STATIONS[i].name;
      frag.appendChild(opt);
    }
    select.appendChild(frag);
    selectPopulated = true;
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
      var map = {};
      for (var i = 1; i < lines.length; i++) {
        var line = trimStr(lines[i]);
        if (!line) continue;
        var commaIdx = line.indexOf(',');
        if (commaIdx > -1) {
          var id = trimStr(line.substring(0, commaIdx));
          var rawName = trimStr(line.substring(commaIdx + 1));
          if (!isValidStation(id)) continue;
          var trainLine = id.charAt(0);
          var displayName = rawName + ' (' + trainLine + ')';
          parsed.push({ id: id, name: displayName });
          map[id] = displayName;
        }
      }
      parsed.sort(function(a, b) {
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
      });
      ALL_STATIONS = parsed;
      ALL_STATIONS_MAP = map;
      stopsLoaded = true;
      selectPopulated = false;
      populateSelectOptions();
      drawPickerList();
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
    setHidden(document.getElementById('main'), true);
    setHidden(document.getElementById('picker'), false);

    currentPickerStations = STATIONS.slice();
    drawPickerList();

    if (stopsLoaded) {
      populateSelectOptions();
    } else {
      loadStops();
    }
  }

  function hidePicker() {
    pickerOpen = false;
    setHidden(document.getElementById('picker'), true);
    setHidden(document.getElementById('main'), false);
  }

  function makePickerBtn(label, index, handler) {
    var btn = document.createElement('span');
    btn.className = 'picker-item-btn';
    btn.textContent = label;
    btn.addEventListener('click', function() {
      handler(index);
    });
    return btn;
  }

  function drawPickerList() {
    var pickerList = document.getElementById('pickerList');
    if (!pickerList) return;
    while (pickerList.firstChild) {
      pickerList.removeChild(pickerList.firstChild);
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < currentPickerStations.length; i++) {
      var id = currentPickerStations[i];
      var name = ALL_STATIONS_MAP[id] || id;

      var row = document.createElement('div');
      row.className = 'picker-item';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'picker-item-name';
      nameSpan.textContent = name;
      row.appendChild(nameSpan);

      (function(idx) {
        row.appendChild(makePickerBtn('\u25B2', idx, function(i2) { moveStation(i2, -1); }));
        row.appendChild(makePickerBtn('\u25BC', idx, function(i2) { moveStation(i2, 1); }));
        row.appendChild(makePickerBtn('X', idx, function(i2) { deleteStation(i2); }));
      })(i);

      frag.appendChild(row);
    }
    pickerList.appendChild(frag);
  }

  function addStation() {
    var select = document.getElementById('pickerSelect');
    if (!select) return;
    var val = select.value;
    if (isValidStation(val)) {
      currentPickerStations.push(val);
      drawPickerList();
      select.value = '';
    }
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

    while (stationsContainer.firstChild) {
      stationsContainer.removeChild(stationsContainer.firstChild);
    }
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
    function runStep(stepIdx) {
      if (stepIdx >= tasks.length) {
        if (anySucceeded) {
          maybePeriodicReload();
        }
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
        } else if (anySucceeded) {
          maybePeriodicReload();
        }
      });
    }

    runStep(0);
  }

  function refreshAll() {
    clearStaggerTimer();

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

    // Abort any older fallback requests before issuing a batch request
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
        if (!data || !data.stations) return;
        for (var j = 0; j < STATIONS.length; j++) {
          var st = STATIONS[j];
          var refs = stationRefs[j] || cacheStationRefs(document.getElementById('station' + j));
          if (refs && refs.root && data.stations[st]) {
            renderStationData(st, refs, data.stations[st], j === 0);
          }
        }
        if (requestedExtra && data.extra_alert) {
          renderExtraAlert(requestedExtra, data.extra_alert);
        }
        maybePeriodicReload();
      },
      function(status) {
        if (status === 404) {
          batchSupported = false;
          startStaggeredFallback();
        }
      }
    );
  }

  function bindUiEvents() {
    var stationsEl = document.getElementById('stations');
    if (stationsEl) {
      stationsEl.addEventListener('click', function(evt) {
        var target = evt.target;
        while (target && target !== stationsEl) {
          if (target.classList && target.classList.contains('stationTitle')) {
            showPicker();
            return;
          }
          target = target.parentNode;
        }
      });
    }

    var addBtn = document.getElementById('addStationBtn');
    if (addBtn) addBtn.addEventListener('click', addStation);

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
      addStation: addStation,
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
      colorTrain: colorTrain,
      isValidStation: isValidStation,
      isValidTrain: isValidTrain,
      getState: function() {
        return {
          stations: STATIONS,
          extraTrain: EXTRA_TRAIN,
          allStations: ALL_STATIONS,
          currentPickerStations: currentPickerStations,
          stopsLoaded: stopsLoaded,
          batchSupported: batchSupported,
          pickerOpen: pickerOpen,
          inFlightSlots: inFlightRequests
        };
      },
      setState: function(s) {
        if (s.stations !== undefined) STATIONS = s.stations;
        if (s.extraTrain !== undefined) EXTRA_TRAIN = s.extraTrain;
        if (s.allStations !== undefined) {
          ALL_STATIONS = s.allStations;
          ALL_STATIONS_MAP = {};
          for (var i = 0; i < ALL_STATIONS.length; i++) {
            ALL_STATIONS_MAP[ALL_STATIONS[i].id] = ALL_STATIONS[i].name;
          }
        }
        if (s.currentPickerStations !== undefined) currentPickerStations = s.currentPickerStations;
        if (s.stopsLoaded !== undefined) stopsLoaded = s.stopsLoaded;
        if (s.batchSupported !== undefined) batchSupported = s.batchSupported;
        if (s.pickerOpen !== undefined) pickerOpen = s.pickerOpen;
        if (s.pageLoadedAt !== undefined) pageLoadedAt = s.pageLoadedAt;
      }
    };
  }
})();
