var STATIONS = ['L08'];
var EXTRA_TRAIN = '4';
setFromHash();

function setFromHash() {
  hash = ''
  if (window.location.search) {
    hash = window.location.search.replace('?q=','')
  }
  if (window.location.hash) {
    hash = window.location.hash.replace('#','');
  }
  if (hash) {
    if (hash.search('&') > -1) {
      s = hash.split('&');
      STATIONS = s[0].split(',')
      EXTRA_TRAIN = s[1]
    } else {
      STATIONS = hash.split(',')
    }
  }
}

function hashChange() {
  if (window.location.hash) {
    st = STATIONS[0];
    et = EXTRA_TRAIN;
    setFromHash();
    if (st != STATIONS[0]) {
      loadTimes();
    }
    if (et != EXTRA_TRAIN) {
      loadAlert2();
    }
  }
}

function setupStations() {
  if (STATIONS.length > 1) {
    var stationBase = document.getElementById("station0");
    var stationHtml = '';
    for (var i = 0; i < STATIONS.length; i++) {
      stationHtml += '<div id = "station' + i + '">' + stationBase.innerHTML + '</div>';
    }
    document.getElementById("stations").innerHTML = stationHtml;
  }
  window.setTimeout(loadTimesFromUrl, 1);
}

function loadTimesFromUrl() {
  for (var i = 0; i < STATIONS.length; i++) {
    var station = STATIONS[i];
    var stationEl = document.getElementById("station" + i);
    loadTimes(station, stationEl, (i == 0));
  }
}

function loadTimes(station, stationEl, doAlert) {
  const xhttp = new XMLHttpRequest();
  var train = station[0]
  xhttp.onload = function() {
    js = JSON.parse(this.responseText);
    stationEl.classList.remove("hidden");
    stationEl.querySelector(".stationTitle").innerHTML = js.name;
    alerts = "";
    for (i = 0; i < js.status.alerts.length; i++) {
      if (alerts != "") {
        alerts += "\n";
      }
      alerts += js.status.alerts[i];
    }
    if (doAlert) {
      var body = document.getElementById("main")
      var alertEl = body.querySelector(".alerts");
      if (js.status.status == "Good Service") {
        alertEl.classList.add("hidden");
      } else {
        alertEl.classList.remove("hidden");
        alertEl.querySelector(".alertsTitle").innerHTML = train + ': ' + js.status.status
        alertEl.querySelector(".alertsBody").innerText = alerts
      }
    }
    outbound = false;

    route_times = js.route_times;
    // If the station is closed, clear the list
    if (route_times.length == 0) {
      route_times = {'outbound': [], 'inbound': []};
    }
    i = 0;
    var secondRoute = ""
    for (var route in route_times) {
      if (i > 1) {
        break;
      }
      if (i == 1) {
        secondRoute = route
      }
      i++;
    }
    i = 0;
    for (var route in route_times) {
      if (i > 1) {
        break;
      }
      name = "outbound"
      rName = route.replace(/ [-&] .*/, "").replace(/, .*/, "");
      otherRoute = ""
      if (i == 0) {
        otherRoute = secondRoute
      }
      i++;
      if (route == "Manhattan" ||
        route == '34 St - Hudson Yards' ||
        route == '8 Av' ||
        route.search("Uptown") > -1 ||
        otherRoute == 'Church Av' ||
        otherRoute.search('Downtown') > -1 ||
        outbound == true) {
        name = "inbound";
      } else {
        outbound = true;
      }
      times = route_times[route]
      stationEl.querySelector("." + name + "Title").innerHTML = rName;
      for (j = 0; j < 3; j++) {
        el = stationEl.querySelector("." + name + (j+1))
        elName = el.querySelector(".trainName");
        elColor = el.querySelector(".trainColor");
        elCount = el.querySelector(".countdown");
        elTime = el.querySelector(".realtime");
        if (j >= times.length) {
          el.classList.add("hidden");
        } else {
          el.classList.remove("hidden");
          time = times[j];
          var trainName = time.train_name;

          if (trainName.length == 2 && trainName[1] == 'X') {
            trainName = trainName[0];
            elColor.classList.add('express');
            elColor.classList.remove('local');
          } else {
            elColor.classList.add('local');
            elColor.classList.remove('express');
          }

          elName.innerHTML = trainName;
          if (STATIONS.length > 1) {
            colorTrain(elColor, trainName);
          }
          elCount.innerHTML = time.mins;
          elTime.innerHTML = time.time;
        }
      }
    }
  }
  xhttp.open("GET", "/mta/countdown/" + station, true);
  xhttp.send();
}

function colorTrain(el, train) {
  color = '#777';
  if (train == '1' || train == '2' || train == '3') {
    color = '#EE352E';
  } else if (train == '4' || train == '5' || train == '6') {
    color = '#00933C';
  } else if (train == '7') {
    color = '#B933AD';
  } else if (train == 'A' || train == 'C' || train == 'E') {
    color = '#0039A6';
  } else if (train == 'B' || train == 'D' || train == 'F' || train == 'M') {
    color = '#FF6319';
  } else if (train == 'N' || train == 'Q' || train == 'R' || train == 'W') {
    color = '#FCCC0A';
  } else if (train == 'J' || train == 'Z') {
    color = '#996633';
  } else if (train == 'L') {
  } else if (train == 'G') {
    color = '#6CBE45';
  }
  el.style.setProperty('background-color', color);
}

function loadAlert2() {
  if (EXTRA_TRAIN == '') {
    var body = document.getElementById("main");
    var alertEl = body.querySelector(".alerts2");
    alertEl.classList.add("hidden");
    return;
  }
  const xhttp = new XMLHttpRequest();
  const train = EXTRA_TRAIN;
  xhttp.onload = function() {
    js = JSON.parse(this.responseText);
    alerts = "";
    for (i = 0; i < js.alerts.length; i++) {
      if (alerts != "") {
        alerts += "\n";
      }
      alerts += js.alerts[i];
    }
    var body = document.getElementById("main");
    var alertEl = body.querySelector(".alerts2");
    if (js.status == "Good Service") {
      alertEl.classList.add("hidden");
    } else {
      alertEl.classList.remove("hidden");
      alertEl.querySelector(".alertsTitle").innerHTML = train + ': ' + js.status
      alertEl.querySelector(".alertsBody").innerText = alerts
    }
  }
  xhttp.open("GET", "/mta/alerts/" + train, true);
  xhttp.send();
}

window.setTimeout(setupStations, 1);
window.setTimeout(loadAlert2, 10);

window.setInterval(loadTimesFromUrl, 60000);
window.setInterval(loadAlert2, 60000);

window.setTimeout(function() {
  if(window.addEventListener) {
    window.addEventListener("hashchange", hashChange, false);
  }
  else if (window.attachEvent) {
    window.attachEvent("hashchange", hashChange, false);
  }
}, 10);

