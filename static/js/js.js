var STATION = 'L08';
var EXTRA_TRAIN = '4';
setFromHash();

function setFromHash() {
  urlParams = new URLSearchParams(window.location.search);
  hash = urlParams.get('q');

  if (window.location.hash) {
    hash = window.location.hash.replace('#','');
  }
  if (hash) {
    if (hash.search('&') > -1) {
      s = hash.split('&');
      STATION = s[0]
      EXTRA_TRAIN = s[1]
    } else {
      STATION = hash
    }
  }
}

function hashChange() {
  if (window.location.hash) {
    st = STATION;
    et = EXTRA_TRAIN;
    setFromHash();
    if (st != STATION) {
      loadTimes();
    }
    if (et != EXTRA_TRAIN) {
      loadAlert2();
    }
  }
}

function loadTimes() {
  const xhttp = new XMLHttpRequest();
  train = STATION[0]
  xhttp.onload = function() {
    js = JSON.parse(this.responseText);
    var station = document.getElementById("station");
    station.classList.remove("hidden");
    station.querySelector(".stationTitle").innerHTML = js.name;
    alerts = "";
    for (i = 0; i < js.status.alerts.length; i++) {
      if (alerts != "") {
        alerts += "\n";
      }
      alerts += js.status.alerts[i];
    }
    var alertEl = station.querySelector(".alerts");
    if (js.status.status == "Good Service") {
      alertEl.classList.add("hidden");
    } else {
      alertEl.classList.remove("hidden");
      alertEl.querySelector(".alertsTitle").innerHTML = train + ': ' + js.status.status
      alertEl.querySelector(".alertsBody").innerText = alerts
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
      station.querySelector("." + name + "Title").innerHTML = rName;
      for (j = 0; j < 3; j++) {
        el = station.querySelector("." + name + (j+1))
        elName = el.querySelector(".trainName");
        elCount = el.querySelector(".countdown");
        elTime = el.querySelector(".realtime");
        if (j >= times.length) {
          el.classList.add("hidden");
        } else {
          el.classList.remove("hidden");
          time = times[j];
          elName.innerHTML = time.train_name;
          elCount.innerHTML = time.mins;
          elTime.innerHTML = time.time;
        }
      }
    }
  }
  xhttp.open("GET", "/mta/countdown/" + STATION, true);
  xhttp.send();
}

function loadAlert2() {
  if (EXTRA_TRAIN == '') {
    var station = document.getElementById("station");
    var alertEl = station.querySelector(".alerts2");
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
    var station = document.getElementById("station");
    var alertEl = station.querySelector(".alerts2");
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

loadTimes();
window.setTimeout(loadAlert2, 10);

window.setInterval(loadTimes, 60000);
window.setInterval(loadAlert2, 60000);

window.setTimeout(function() {
  if(window.addEventListener) {
    window.addEventListener("hashchange", hashChange, false);
  }
  else if (window.attachEvent) {
    window.attachEvent("hashchange", hashChange, false);
  }
}, 10);

