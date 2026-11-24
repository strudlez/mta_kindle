use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use actix_web::{
    get,
    http::header,
    middleware::{self, DefaultHeaders},
    web::{self, Data},
    App, Error, HttpResponse, HttpServer, Result,
};
use awc::{Client, Connector};
use serde::{Deserialize, Serialize};
use url::Url;

const INDEX_HTML: &str = include_str!("../templates/mta.html");
const STOPS_TXT: &str = include_str!("../static/js/stops.txt");

const VALID_TRAINS: &[&str] = &[
    "1", "2", "3", "4", "5", "6", "6X", "7", "7X", "A", "B", "C", "D", "E", "F", "FX", "G", "GS",
    "FS", "H", "J", "L", "M", "N", "Q", "R", "S", "SI", "W", "Z",
];

const CSP_HEADER: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_COUNTDOWN_CACHE_ENTRIES: usize = 500;
const MAX_ALERTS_CACHE_ENTRIES: usize = 100;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

struct CacheEntry<V> {
    value: V,
    inserted_at: Instant,
}

/// Bounded in-memory TTL cache with per-key single-flight request coalescing.
struct TtlCache<V> {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, CacheEntry<V>>>,
    in_flight: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

impl<V: Clone> TtlCache<V> {
    fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries: max_entries.max(1),
            entries: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    fn get_fresh(&self, key: &str) -> Option<V> {
        let guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(key).and_then(|entry| {
            if entry.inserted_at.elapsed() < self.ttl {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    fn acquire_key_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() > self.max_entries {
            guard.retain(|_, weak| weak.strong_count() > 0);
        }
        if let Some(existing) = guard.get(key).and_then(Weak::upgrade) {
            return existing;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        guard.insert(key.to_string(), Arc::downgrade(&lock));
        lock
    }

    fn insert(&self, key: String, value: V) {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let ttl = self.ttl;
        guard.retain(|_, entry| entry.inserted_at.elapsed() < ttl);
        if !guard.contains_key(&key) && guard.len() >= self.max_entries {
            if let Some(oldest_key) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&oldest_key);
            }
        }
        guard.insert(
            key,
            CacheEntry {
                value,
                inserted_at: Instant::now(),
            },
        );
    }

    async fn get_or_try_insert_with<E, F, Fut>(&self, key: &str, loader: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        if let Some(hit) = self.get_fresh(key) {
            return Ok(hit);
        }

        let key_lock = self.acquire_key_lock(key);
        let _flight_guard = key_lock.lock().await;

        if let Some(hit) = self.get_fresh(key) {
            return Ok(hit);
        }

        let value = loader().await?;
        self.insert(key.to_string(), value.clone());
        Ok(value)
    }
}

#[derive(Clone)]
struct AppState {
    api_key: String,
    mta_base_url: String,
    goodservice_base_url: String,
    valid_stops: HashSet<String>,
    alerts_cache: Arc<TtlCache<Arc<TrainStatus>>>,
    countdown_cache: Arc<TtlCache<Arc<CountdownCore>>>,
}

impl AppState {
    fn new(
        api_key: String,
        mta_base_url: String,
        goodservice_base_url: String,
        valid_stops: HashSet<String>,
        cache_ttl: Duration,
    ) -> Self {
        Self {
            api_key,
            mta_base_url,
            goodservice_base_url,
            valid_stops,
            alerts_cache: Arc::new(TtlCache::new(cache_ttl, MAX_ALERTS_CACHE_ENTRIES)),
            countdown_cache: Arc::new(TtlCache::new(cache_ttl, MAX_COUNTDOWN_CACHE_ENTRIES)),
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct Countdown {
    name: String,
    alerts: Vec<String>,
    status: TrainStatus,
    route_times: HashMap<String, Vec<TrainTime>>,
}

#[derive(Debug, Clone)]
struct CountdownCore {
    name: String,
    alerts: Vec<String>,
    route_times: HashMap<String, Vec<TrainTime>>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct TrainTime {
    seconds: i64,
    mins: i64,
    time: String,
    estimated: bool,
    train_name: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct TrainStatus {
    status: String,
    alerts: Vec<String>,
}

impl TrainStatus {
    fn unknown() -> Self {
        Self {
            status: "?".to_string(),
            alerts: Vec::new(),
        }
    }
}

#[derive(Deserialize, Debug, Default)]
struct GoodServiceResponse {
    status: Option<String>,
    #[serde(default)]
    service_change_summaries: ServiceChangeSummaries,
    #[serde(default)]
    service_irregularity_summaries: ServiceIrregularitySummaries,
}

#[derive(Deserialize, Debug, Default)]
struct ServiceChangeSummaries {
    #[serde(default)]
    both: Vec<String>,
    #[serde(default)]
    north: Vec<String>,
    #[serde(default)]
    south: Vec<String>,
}

#[derive(Deserialize, Debug, Default)]
struct ServiceIrregularitySummaries {
    north: Option<String>,
    south: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct MtaNearbyItem {
    #[serde(default)]
    stop: MtaStop,
    #[serde(default)]
    alerts: Vec<MtaAlert>,
    #[serde(default)]
    groups: Vec<MtaGroup>,
}

#[derive(Deserialize, Debug, Default)]
struct MtaStop {
    name: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MtaAlert {
    effective_start_date: Option<i64>,
    effective_end_date: Option<i64>,
    alert_header_text: Option<String>,
    human_readable_active_period: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct MtaGroup {
    headsign: Option<String>,
    #[serde(default)]
    route: MtaRoute,
    #[serde(default)]
    times: Vec<MtaTime>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MtaRoute {
    short_name: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MtaTime {
    service_day: Option<i64>,
    realtime_arrival: Option<i64>,
}

#[derive(Deserialize, Debug, Default)]
struct CountdownQuery {
    alerts: Option<u8>,
}

#[derive(Deserialize, Debug, Default)]
struct BatchQuery {
    stations: String,
    extra: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
struct BatchResponse {
    stations: HashMap<String, Countdown>,
    extra_alert: Option<TrainStatus>,
}

fn parse_valid_stops(csv: &str) -> HashSet<String> {
    csv.lines()
        .skip(1)
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let id = trimmed.split(',').next()?.trim();
            if !id.is_empty() && id.len() <= 5 && id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
                Some(id.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn is_valid_train(train: &str) -> bool {
    VALID_TRAINS.contains(&train)
}

fn is_valid_station(station: &str, valid_stops: &HashSet<String>) -> bool {
    !station.is_empty()
        && station.len() <= 5
        && station
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && valid_stops.contains(station)
}

fn station_alert_line(station: &str) -> Option<&'static str> {
    let ch = station.chars().next()?;
    if ch == '9' {
        return Some("GS");
    }
    let mut buf = [0u8; 4];
    let s = ch.encode_utf8(&mut buf);
    VALID_TRAINS.iter().copied().find(|&t| t == s)
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn to_countdown(time: i64, now_sec: i64, estimated: bool, name: &str) -> TrainTime {
    let mut diff = time - now_sec;
    // When the day changes we go from 23h to 0h
    if diff < -14400 {
        diff += 86400;
    }
    let diffmin = diff / 60;

    let mut hour = (time / 3600) % 12;
    if hour == 0 {
        hour = 12;
    }
    let min = (time / 60).rem_euclid(60);
    TrainTime {
        seconds: diff,
        mins: diffmin,
        time: format!("{}:{:02}", hour, min),
        estimated,
        train_name: name.to_string(),
    }
}

fn build_alerts_url(base_url: &str, train: &str) -> Result<String, Error> {
    let base = Url::parse(base_url).map_err(|_| actix_web::error::ErrorInternalServerError("invalid base url"))?;
    base.join(&format!("/api/routes/{}", train))
        .map(|u| u.to_string())
        .map_err(|_| actix_web::error::ErrorBadRequest("invalid train"))
}

fn build_mta_url(base_url: &str, station: &str, api_key: &str) -> Result<String, Error> {
    let base = Url::parse(base_url).map_err(|_| actix_web::error::ErrorInternalServerError("invalid base url"))?;
    let mut url = base
        .join("/otp/routers/default/nearby")
        .map_err(|_| actix_web::error::ErrorBadRequest("invalid station"))?;
    url.query_pairs_mut()
        .append_pair("stops", &format!("MTASBWY:{}", station))
        .append_pair("apikey", api_key);
    Ok(url.to_string())
}

async fn fetch_alerts(client: &Client, state: &AppState, train: &str) -> Result<Arc<TrainStatus>, Error> {
    let train_key = train.to_string();
    state
        .alerts_cache
        .get_or_try_insert_with(&train_key, || async {
            let req_url = build_alerts_url(&state.goodservice_base_url, &train_key)?;
            let mut res = client
                .get(&req_url)
                .send()
                .await
                .map_err(|err| {
                    log::warn!("goodservice request failed for {}: {}", train_key, err);
                    actix_web::error::ErrorBadGateway("upstream error")
                })?;

            if !res.status().is_success() {
                log::warn!("goodservice returned status {} for {}", res.status(), train_key);
                return Err(actix_web::error::ErrorBadGateway("upstream error"));
            }

            let parsed = res.json::<GoodServiceResponse>().await.map_err(|err| {
                log::warn!("goodservice invalid json for {}: {}", train_key, err);
                actix_web::error::ErrorBadGateway("invalid upstream response")
            })?;

            let status = parsed.status.unwrap_or_else(|| "?".to_string());
            let mut alerts = Vec::new();
            alerts.extend(parsed.service_change_summaries.both);
            alerts.extend(parsed.service_change_summaries.north);
            alerts.extend(parsed.service_change_summaries.south);
            if let Some(north) = parsed.service_irregularity_summaries.north {
                alerts.push(north);
            }
            if let Some(south) = parsed.service_irregularity_summaries.south {
                alerts.push(south);
            }

            Ok(Arc::new(TrainStatus { status, alerts }))
        })
        .await
}

async fn fetch_countdown_core(
    client: &Client,
    state: &AppState,
    station: &str,
) -> Result<Arc<CountdownCore>, Error> {
    let station_key = station.to_string();
    state
        .countdown_cache
        .get_or_try_insert_with(&station_key, || async {
            let now_sec = unix_now_secs();
            let req_url = build_mta_url(&state.mta_base_url, &station_key, &state.api_key)?;
            let mut res = client
                .get(&req_url)
                .send()
                .await
                .map_err(|err| {
                    // Never log req_url because it contains the API key query parameter
                    log::warn!("mta request failed for station {}: {}", station_key, err);
                    actix_web::error::ErrorBadGateway("upstream error")
                })?;

            if !res.status().is_success() {
                log::warn!("mta returned status {} for station {}", res.status(), station_key);
                return Err(actix_web::error::ErrorBadGateway("upstream error"));
            }

            let items = res.json::<Vec<MtaNearbyItem>>().await.map_err(|err| {
                log::warn!("mta invalid json for station {}: {}", station_key, err);
                actix_web::error::ErrorBadGateway("invalid upstream response")
            })?;

            let item = items
                .into_iter()
                .next()
                .ok_or_else(|| actix_web::error::ErrorNotFound("station not found"))?;

            let mut alerts = Vec::new();
            for alert in item.alerts {
                let alert_start = alert.effective_start_date.unwrap_or(0) / 1000;
                let alert_end = alert.effective_end_date.unwrap_or(0) / 1000;
                if alert_start == 0
                    || alert_end == 0
                    || alert_start > now_sec + 3600
                    || alert_end < now_sec
                {
                    continue;
                }
                let header_text = alert.alert_header_text.unwrap_or_default();
                let active_period = alert.human_readable_active_period.unwrap_or_default();
                alerts.push(format!("{} : {}", header_text, active_period));
            }

            let mut route_times: HashMap<String, Vec<TrainTime>> = HashMap::new();
            for group in item.groups {
                let route = group.headsign.unwrap_or_else(|| "???".to_string());
                let train_name = group.route.short_name.unwrap_or_else(|| "?".to_string());
                let mut routes = Vec::with_capacity(group.times.len());

                for train in group.times {
                    if let (Some(today_sec), Some(realtime_arrival)) =
                        (train.service_day, train.realtime_arrival)
                    {
                        routes.push(to_countdown(
                            realtime_arrival,
                            now_sec - today_sec,
                            false,
                            &train_name,
                        ));
                    }
                }

                if let Some(existing) = route_times.get_mut(&route) {
                    existing.extend(routes);
                } else {
                    route_times.insert(route, routes);
                }
            }

            for routes in route_times.values_mut() {
                routes.sort_by_key(|r| r.seconds);
            }

            let stop_name = item.stop.name.unwrap_or_else(|| "error".to_string());

            Ok(Arc::new(CountdownCore {
                name: stop_name,
                alerts,
                route_times,
            }))
        })
        .await
}

#[get("/")]
async fn mta() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .insert_header((header::CACHE_CONTROL, "no-cache"))
        .body(INDEX_HTML)
}

#[get("/mta/alerts/{train}")]
async fn train_alerts(
    path: web::Path<String>,
    client: Data<Client>,
    state: Data<AppState>,
) -> Result<HttpResponse> {
    let train = path.into_inner();
    if !is_valid_train(&train) {
        return Err(actix_web::error::ErrorBadRequest("invalid train line"));
    }

    let status = fetch_alerts(&client, &state, &train).await?;
    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(status.as_ref()))
}

#[get("/mta/countdown/{station}")]
async fn countdown(
    path: web::Path<String>,
    query: web::Query<CountdownQuery>,
    client: Data<Client>,
    state: Data<AppState>,
) -> Result<HttpResponse> {
    let station = path.into_inner();
    if !is_valid_station(&station, &state.valid_stops) {
        return Err(actix_web::error::ErrorBadRequest("invalid station"));
    }

    let include_alerts = query.alerts != Some(0);
    let alert_line = if include_alerts {
        station_alert_line(&station)
    } else {
        None
    };

    let (core_res, status_res) = match alert_line {
        Some(line) => {
            let (core, alerts) = tokio::join!(
                fetch_countdown_core(&client, &state, &station),
                fetch_alerts(&client, &state, line)
            );
            (core, Some(alerts))
        }
        None => (fetch_countdown_core(&client, &state, &station).await, None),
    };

    let core = core_res?;
    let status = match status_res {
        Some(Ok(s)) => (*s).clone(),
        Some(Err(err)) => {
            log::warn!("degrading alert status for {}: {}", station, err);
            TrainStatus::unknown()
        }
        None => TrainStatus::unknown(),
    };

    let response = Countdown {
        name: core.name.clone(),
        alerts: core.alerts.clone(),
        status,
        route_times: core.route_times.clone(),
    };

    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(&response))
}

#[get("/mta/batch")]
async fn batch(
    query: web::Query<BatchQuery>,
    client: Data<Client>,
    state: Data<AppState>,
) -> Result<HttpResponse> {
    let station_ids: Vec<String> = query
        .stations
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();
    if station_ids.is_empty()
        || station_ids.len() > 10
        || station_ids
            .iter()
            .any(|s| !is_valid_station(s, &state.valid_stops))
    {
        return Err(actix_web::error::ErrorBadRequest("invalid stations"));
    }

    let extra_train = match query.extra.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => {
            if !is_valid_train(t) {
                return Err(actix_web::error::ErrorBadRequest("invalid extra train"));
            }
            Some(t.to_string())
        }
        _ => None,
    };

    let mut station_handles = Vec::with_capacity(station_ids.len());
    for st in &station_ids {
        let c = client.clone();
        let s = state.clone();
        let st_owned = st.clone();
        station_handles.push((
            st_owned.clone(),
            actix_web::rt::spawn(async move {
                fetch_countdown_core(&c, &s, &st_owned).await
            }),
        ));
    }

    let primary_alert_handle = station_alert_line(&station_ids[0]).map(|line| {
        let c = client.clone();
        let s = state.clone();
        actix_web::rt::spawn(async move { fetch_alerts(&c, &s, line).await })
    });

    let extra_alert_handle = extra_train.as_ref().map(|train| {
        let c = client.clone();
        let s = state.clone();
        let t = train.clone();
        actix_web::rt::spawn(async move { fetch_alerts(&c, &s, &t).await })
    });

    let primary_status = match primary_alert_handle {
        Some(handle) => match handle.await {
            Ok(Ok(s)) => (*s).clone(),
            Ok(Err(err)) => {
                log::warn!("degrading primary batch alert for {}: {}", station_ids[0], err);
                TrainStatus::unknown()
            }
            Err(err) => {
                log::warn!("primary batch alert task failed: {}", err);
                TrainStatus::unknown()
            }
        },
        None => TrainStatus::unknown(),
    };

    let mut stations_map = HashMap::with_capacity(station_handles.len());
    for (idx, (st, handle)) in station_handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(core)) => {
                let status = if idx == 0 {
                    primary_status.clone()
                } else {
                    TrainStatus::unknown()
                };
                stations_map.insert(
                    st,
                    Countdown {
                        name: core.name.clone(),
                        alerts: core.alerts.clone(),
                        status,
                        route_times: core.route_times.clone(),
                    },
                );
            }
            Ok(Err(err)) => {
                log::warn!("batch countdown failed for {}: {}", st, err);
            }
            Err(err) => {
                log::warn!("batch countdown task panicked for {}: {}", st, err);
            }
        }
    }

    if stations_map.is_empty() {
        return Err(actix_web::error::ErrorBadGateway("upstream error"));
    }

    let extra_alert = match extra_alert_handle {
        Some(handle) => match handle.await {
            Ok(Ok(s)) => Some((*s).clone()),
            Ok(Err(err)) => {
                log::warn!("degrading extra batch alert: {}", err);
                None
            }
            Err(err) => {
                log::warn!("extra batch alert task failed: {}", err);
                None
            }
        },
        None => None,
    };

    let response = BatchResponse {
        stations: stations_map,
        extra_alert,
    };

    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(&response))
}

#[get("/favicon.ico")]
async fn favicon() -> HttpResponse {
    HttpResponse::NoContent().finish()
}

fn security_headers() -> DefaultHeaders {
    DefaultHeaders::new()
        .add(("X-Content-Type-Options", "nosniff"))
        .add(("X-Frame-Options", "DENY"))
        .add(("Referrer-Policy", "no-referrer"))
        .add(("Content-Security-Policy", CSP_HEADER))
}

fn configure_app(cfg: &mut web::ServiceConfig) {
    cfg.service(mta)
        .service(countdown)
        .service(train_alerts)
        .service(batch)
        .service(favicon)
        .service(
            web::scope("/mta/static")
                .wrap(DefaultHeaders::new().add(("Cache-Control", "public, max-age=3600")))
                .service(actix_files::Files::new("", "./static")),
        )
        .service(
            web::scope("/static")
                .wrap(DefaultHeaders::new().add(("Cache-Control", "public, max-age=3600")))
                .service(actix_files::Files::new("", "./static")),
        );
}

fn build_http_client() -> Client {
    Client::builder()
        .add_default_header((header::USER_AGENT, "mta-kindle/0.1"))
        .timeout(UPSTREAM_TIMEOUT)
        .connector(Connector::new())
        .finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    let api_key = std::env::var("API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "API_KEY environment variable is required",
            )
        })?;

    let bind_addr = std::env::var("BIND_ADDR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "127.0.0.1:8080".to_string());

    let mta_base_url = std::env::var("MTA_BASE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://otp-mta-prod.camsys-apps.com".to_string());

    let goodservice_base_url = std::env::var("GOODSERVICE_BASE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://www.goodservice.io".to_string());

    let state = Data::new(AppState::new(
        api_key,
        mta_base_url,
        goodservice_base_url,
        parse_valid_stops(STOPS_TXT),
        DEFAULT_CACHE_TTL,
    ));

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(Data::new(build_http_client()))
            .wrap(middleware::Compress::default())
            .wrap(middleware::Logger::default())
            .wrap(security_headers())
            .configure(configure_app)
    })
    .bind(&bind_addr)?
    .workers(2)
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use actix_web::{http::StatusCode, HttpRequest};

    #[test]
    fn test_validation_helpers() {
        let stops = parse_valid_stops(STOPS_TXT);
        assert!(stops.len() >= 470);
        assert!(is_valid_station("L08", &stops));
        assert!(is_valid_station("A32", &stops));
        assert!(is_valid_station("901", &stops));

        assert!(!is_valid_station("", &stops));
        assert!(!is_valid_station("ZZZ", &stops));
        assert!(!is_valid_station("../", &stops));
        assert!(!is_valid_station("L08&x=1", &stops));
        assert!(!is_valid_station("L08#a", &stops));
        assert!(!is_valid_station("é08", &stops));

        assert!(is_valid_train("L"));
        assert!(is_valid_train("4"));
        assert!(is_valid_train("6X"));
        assert!(is_valid_train("GS"));
        assert!(!is_valid_train(""));
        assert!(!is_valid_train("../"));
        assert!(!is_valid_train("L?x=1"));
        assert!(!is_valid_train("é"));
        assert!(!is_valid_train("INVALID"));

        assert_eq!(station_alert_line("L08"), Some("L"));
        assert_eq!(station_alert_line("901"), Some("GS"));
        assert_eq!(station_alert_line("H01"), Some("H"));
        assert_eq!(station_alert_line(""), None);
        assert_eq!(station_alert_line("é08"), None);
    }

    #[test]
    fn test_to_countdown() {
        let normal = to_countdown(3600 * 13 + 5 * 60, 3600 * 13, false, "L");
        assert_eq!(normal.seconds, 300);
        assert_eq!(normal.mins, 5);
        assert_eq!(normal.time, "1:05");
        assert_eq!(normal.train_name, "L");

        // Midnight wraparound: arrival at 00:05 (300s) when now is 23:55 (86100s)
        let wrap = to_countdown(300, 86100, false, "4");
        assert_eq!(wrap.seconds, 600);
        assert_eq!(wrap.mins, 10);
        assert_eq!(wrap.time, "12:05");

        // Noon formatting
        let noon = to_countdown(3600 * 12 + 30 * 60, 3600 * 12, false, "A");
        assert_eq!(noon.time, "12:30");
    }

    #[actix_web::test]
    async fn test_ttl_cache_coalescing_and_bounds() {
        let cache = Arc::new(TtlCache::new(Duration::from_millis(80), 2));
        let calls = Arc::new(AtomicUsize::new(0));

        // 10 concurrent misses for the same key must coalesce to 1 loader invocation
        let mut handles = Vec::new();
        for _ in 0..10 {
            let c = cache.clone();
            let n = calls.clone();
            handles.push(tokio::spawn(async move {
                c.get_or_try_insert_with::<&'static str, _, _>("k1", || async {
                    n.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(15)).await;
                    Ok(100)
                })
                .await
            }));
        }
        for h in handles {
            assert_eq!(h.await.unwrap().unwrap(), 100);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Cache hit within TTL
        let v = cache
            .get_or_try_insert_with::<&'static str, _, _>("k1", || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(200)
            })
            .await
            .unwrap();
        assert_eq!(v, 100);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Wait for TTL expiry
        tokio::time::sleep(Duration::from_millis(95)).await;
        let v2 = cache
            .get_or_try_insert_with::<&'static str, _, _>("k1", || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(300)
            })
            .await
            .unwrap();
        assert_eq!(v2, 300);
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // Bounded eviction (max_entries = 2)
        cache
            .get_or_try_insert_with::<&'static str, _, _>("k2", || async { Ok(2) })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
        cache
            .get_or_try_insert_with::<&'static str, _, _>("k3", || async { Ok(3) })
            .await
            .unwrap();
        let guard = cache.entries.lock().unwrap();
        assert!(guard.len() <= 2);
        assert!(!guard.contains_key("k1"));
    }

    #[derive(Clone)]
    struct MockCounters {
        mta_hits: Arc<AtomicUsize>,
        alerts_hits: Arc<AtomicUsize>,
        last_mta_query: Arc<Mutex<String>>,
        mta_mode: Arc<Mutex<&'static str>>,
        alerts_mode: Arc<Mutex<&'static str>>,
    }

    impl MockCounters {
        fn new() -> Self {
            Self {
                mta_hits: Arc::new(AtomicUsize::new(0)),
                alerts_hits: Arc::new(AtomicUsize::new(0)),
                last_mta_query: Arc::new(Mutex::new(String::new())),
                mta_mode: Arc::new(Mutex::new("ok")),
                alerts_mode: Arc::new(Mutex::new("ok")),
            }
        }
    }

    async fn spawn_mock_upstream(counters: MockCounters) -> (String, actix_web::dev::ServerHandle) {
        let server = HttpServer::new(move || {
            let c = counters.clone();
            App::new()
                .app_data(Data::new(c))
                .route(
                    "/api/routes/{train}",
                    web::get().to(|c: Data<MockCounters>| async move {
                        c.alerts_hits.fetch_add(1, Ordering::SeqCst);
                        let mode = *c.alerts_mode.lock().unwrap();
                        match mode {
                            "500" => HttpResponse::InternalServerError().body("upstream err"),
                            "bad_json" => HttpResponse::Ok().body("{not json"),
                            _ => HttpResponse::Ok().content_type("application/json").body(
                                r#"{
                                    "status": "Delays",
                                    "service_change_summaries": {
                                        "both": ["Slow speeds"],
                                        "north": ["Skip 1st Ave"],
                                        "south": []
                                    },
                                    "service_irregularity_summaries": {
                                        "north": "Signal problem",
                                        "south": null
                                    }
                                }"#,
                            ),
                        }
                    }),
                )
                .route(
                    "/otp/routers/default/nearby",
                    web::get().to(|req: HttpRequest, c: Data<MockCounters>| async move {
                        c.mta_hits.fetch_add(1, Ordering::SeqCst);
                        *c.last_mta_query.lock().unwrap() = req.query_string().to_string();
                        let mode = *c.mta_mode.lock().unwrap();
                        let now_ms = unix_now_secs() * 1000;
                        match mode {
                            "500" => HttpResponse::InternalServerError().body("mta err"),
                            "bad_json" => HttpResponse::Ok().body("{bad"),
                            "empty" => HttpResponse::Ok().content_type("application/json").body("[]"),
                            _ => {
                                let body = format!(
                                    r#"[{{
                                        "stop": {{"name": "Bedford Av"}},
                                        "alerts": [
                                            {{
                                                "effectiveStartDate": {},
                                                "effectiveEndDate": {},
                                                "alertHeaderText": "Active alert",
                                                "humanReadableActivePeriod": "Now"
                                            }},
                                            {{
                                                "effectiveStartDate": 1000,
                                                "effectiveEndDate": 2000,
                                                "alertHeaderText": "Expired alert",
                                                "humanReadableActivePeriod": "Past"
                                            }}
                                        ],
                                        "groups": [
                                            {{
                                                "headsign": "Manhattan",
                                                "route": {{"shortName": "L"}},
                                                "times": [
                                                    {{"serviceDay": 0, "realtimeArrival": 600}},
                                                    {{"serviceDay": 0, "realtimeArrival": 300}}
                                                ]
                                            }}
                                        ]
                                    }}]"#,
                                    now_ms - 60_000,
                                    now_ms + 3600_000
                                );
                                HttpResponse::Ok().content_type("application/json").body(body)
                            }
                        }
                    }),
                )
        })
        .bind(("127.0.0.1", 0))
        .unwrap();

        let port = server.addrs()[0].port();
        let running = server.run();
        let handle = running.handle();
        actix_web::rt::spawn(running);
        (format!("http://127.0.0.1:{}", port), handle)
    }

    #[actix_web::test]
    async fn test_http_routes_security_and_caching() {
        let counters = MockCounters::new();
        let (base_url, handle) = spawn_mock_upstream(counters.clone()).await;

        let state = Data::new(AppState::new(
            "test-secret-key".to_string(),
            base_url.clone(),
            base_url,
            parse_valid_stops(STOPS_TXT),
            Duration::from_secs(30),
        ));

        let app = actix_web::test::init_service(
            App::new()
                .app_data(state)
                .app_data(Data::new(build_http_client()))
                .wrap(security_headers())
                .configure(configure_app),
        )
        .await;

        // 1. Index HTML + Security Headers + No inline onclick
        let req = actix_web::test::TestRequest::get().uri("/").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            resp.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
        assert_eq!(resp.headers().get("X-Frame-Options").unwrap(), "DENY");
        assert!(resp.headers().get("Content-Security-Policy").is_some());
        let html_body = actix_web::test::read_body(resp).await;
        let html_str = std::str::from_utf8(&html_body).unwrap();
        assert!(!html_str.contains("onclick="));

        // 2. Favicon returns 204
        let req = actix_web::test::TestRequest::get().uri("/favicon.ico").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // 3. Static files + Cache-Control (both /mta/static and /static for reverse proxies)
        for path in [
            "/mta/static/js/js.js",
            "/mta/static/css/styles.css",
            "/mta/static/js/stops.txt",
            "/static/js/js.js",
            "/static/css/styles.css",
        ] {
            let req = actix_web::test::TestRequest::get().uri(path).to_request();
            let resp = actix_web::test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::OK, "failed static {}", path);
            assert!(resp.headers().get(header::CACHE_CONTROL).is_some());
        }

        // 4. Invalid train & invalid station rejected BEFORE upstream hits
        for bad_alert in [
            "/mta/alerts/INVALID",
            "/mta/alerts/../etc",
            "/mta/alerts/L%3Fx=1",
            "/mta/alerts/%C3%A9",
        ] {
            let req = actix_web::test::TestRequest::get().uri(bad_alert).to_request();
            let resp = actix_web::test::call_service(&app, req).await;
            assert!(
                resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::NOT_FOUND,
                "unexpected status for {}: {}",
                bad_alert,
                resp.status()
            );
        }
        for bad_station in [
            "/mta/countdown/",
            "/mta/countdown/ZZZ",
            "/mta/countdown/L08%26apikey=evil",
            "/mta/countdown/%C3%A908",
            "/mta/countdown/../L08",
        ] {
            let req = actix_web::test::TestRequest::get().uri(bad_station).to_request();
            let resp = actix_web::test::call_service(&app, req).await;
            assert!(
                resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::NOT_FOUND,
                "unexpected status for {}: {}",
                bad_station,
                resp.status()
            );
        }
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), 0);
        assert_eq!(counters.mta_hits.load(Ordering::SeqCst), 0);

        // 5. Valid alerts request + caching
        let req = actix_web::test::TestRequest::get().uri("/mta/alerts/4").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let body: serde_json::Value = actix_web::test::read_body_json(resp).await;
        assert_eq!(body["status"], "Delays");
        assert_eq!(body["alerts"].as_array().unwrap().len(), 3);
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), 1);

        // Second hit uses cache
        let req = actix_web::test::TestRequest::get().uri("/mta/alerts/4").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), 1);

        // 6. Countdown with ?alerts=0 skips goodservice.io
        let req = actix_web::test::TestRequest::get()
            .uri("/mta/countdown/L08?alerts=0")
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(counters.mta_hits.load(Ordering::SeqCst), 1);
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), 1); // unchanged
        assert_eq!(
            *counters.last_mta_query.lock().unwrap(),
            "stops=MTASBWY%3AL08&apikey=test-secret-key"
        );
        let cd: serde_json::Value = actix_web::test::read_body_json(resp).await;
        assert_eq!(cd["name"], "Bedford Av");
        assert_eq!(cd["status"]["status"], "?");
        assert_eq!(cd["alerts"].as_array().unwrap().len(), 1);
        let times = cd["route_times"]["Manhattan"].as_array().unwrap();
        assert!(times[0]["seconds"].as_i64().unwrap() <= times[1]["seconds"].as_i64().unwrap());

        // 7. Countdown with alerts fetches goodservice.io for L while reusing MTA cache
        let req = actix_web::test::TestRequest::get().uri("/mta/countdown/L08").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(counters.mta_hits.load(Ordering::SeqCst), 1); // cached
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), 2);
        let cd2: serde_json::Value = actix_web::test::read_body_json(resp).await;
        assert_eq!(cd2["status"]["status"], "Delays");

        // 8. Degraded goodservice.io does not break countdown
        *counters.alerts_mode.lock().unwrap() = "500";
        let req = actix_web::test::TestRequest::get().uri("/mta/countdown/A32").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cd3: serde_json::Value = actix_web::test::read_body_json(resp).await;
        assert_eq!(cd3["status"]["status"], "?");

        // 9. Upstream alerts 500 -> 502
        let req = actix_web::test::TestRequest::get().uri("/mta/alerts/A").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        // 10. Upstream MTA empty -> 404, bad_json -> 502, 500 -> 502
        *counters.mta_mode.lock().unwrap() = "empty";
        let req = actix_web::test::TestRequest::get().uri("/mta/countdown/101?alerts=0").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        *counters.mta_mode.lock().unwrap() = "bad_json";
        let req = actix_web::test::TestRequest::get().uri("/mta/countdown/103?alerts=0").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        *counters.mta_mode.lock().unwrap() = "500";
        let req = actix_web::test::TestRequest::get().uri("/mta/countdown/104?alerts=0").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        // 11. /mta/batch validation and single-request fan-out
        *counters.mta_mode.lock().unwrap() = "ok";
        *counters.alerts_mode.lock().unwrap() = "ok";
        let hits_before_bad = counters.mta_hits.load(Ordering::SeqCst);
        for bad_batch in [
            "/mta/batch?stations=",
            "/mta/batch?stations=ZZZ",
            "/mta/batch?stations=L13,INVALID",
            "/mta/batch?stations=L13&extra=BAD",
            "/mta/batch?stations=L13,M12,G30,L08,A32,101,103,104,106,901,R14",
        ] {
            let req = actix_web::test::TestRequest::get().uri(bad_batch).to_request();
            let resp = actix_web::test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "expected 400 for {}", bad_batch);
        }
        assert_eq!(counters.mta_hits.load(Ordering::SeqCst), hits_before_bad);

        let alerts_before_batch = counters.alerts_hits.load(Ordering::SeqCst);
        let req = actix_web::test::TestRequest::get()
            .uri("/mta/batch?stations=L13,M12,G30&extra=F")
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let batch_json: serde_json::Value = actix_web::test::read_body_json(resp).await;
        assert!(batch_json["stations"]["L13"].is_object());
        assert!(batch_json["stations"]["M12"].is_object());
        assert!(batch_json["stations"]["G30"].is_object());
        assert_eq!(batch_json["stations"]["M12"]["status"]["status"], "?");
        assert_eq!(batch_json["stations"]["G30"]["status"]["status"], "?");
        assert_eq!(batch_json["extra_alert"]["status"], "Delays");
        // Only F (extra) should have been fetched since L was already cached earlier; M and G were skipped
        assert_eq!(counters.alerts_hits.load(Ordering::SeqCst), alerts_before_batch + 1);

        handle.stop(true).await;
    }
}
