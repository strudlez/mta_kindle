use std::{sync::Arc, collections::HashMap, str};
use actix_files::NamedFile;
use actix_web::{Result};
use actix_web::{get, web, App, HttpRequest, HttpResponse, HttpServer, middleware, web::Data};
use askama::{Template};
use awc::{http::header, Client, Connector};
use rustls::{ClientConfig, OwnedTrustAnchor, RootCertStore};
use serde::{Serialize};
use serde_json::{Value};
use chrono::{Utc};
use chrono_tz::{America::New_York};
use cached::proc_macro::cached;
#[macro_use]
extern crate lazy_static;
#[macro_use]
extern crate dotenv_codegen;

const EMPTY_VEC : Vec<Value> = Vec::new();
lazy_static! {
    static ref API_KEY: String = dotenv!("API_KEY").to_string();
}

#[derive(Template)]
#[template(path = "mta.html")]
struct Mta;

#[get("/")]
async fn mta() -> Result<HttpResponse> {
    let s = Mta.render().unwrap();
    Ok(HttpResponse::Ok().content_type("text/html").body(s))
}

#[get("/mta/times")]
async fn get_time(_query: web::Query<HashMap<String, String>>) -> Result<HttpResponse> {
    let time = 0;
    Ok(HttpResponse::Ok().content_type("text/text").body(time.to_string()))
}

#[derive(Serialize, Debug, Clone)]
struct Countdown {
    name: String,
    alerts: Vec<String>,
    status: TrainStatus,
    route_times: HashMap<String, Vec<TrainTime>>,
}

#[derive(Serialize, Debug, Clone)]
struct TrainTime {
    seconds: i64,
    mins: i64,
    time: String,
    estimated: bool,
    train_name: String,
}

#[derive(Serialize, Debug, Clone)]
struct TrainStatus {
    status: String,
    alerts: Vec<String>
}

fn to_countdown(time: i64, now_sec: i64, estimated: bool, name: &str) -> TrainTime {
    let mut diff = time - now_sec;
    // Is rounded or floor preferable
    // When the day changes we go from 23h to 0h
    if diff < -14400 {
        diff = diff + 86400
    }
    let diffmin = diff/60;

    let mut hour = (time / 3600) % 12;
    if hour == 0 {
        hour = 12
    }
    let min = (time / 60) % 60;
    return TrainTime {
        seconds: diff,
        mins: diffmin,
        time: format!("{}:{:02}", hour, min),
        estimated: estimated,
        train_name: name.to_string(),
    };
}

#[get("/mta/alerts/{train:.*}")]
async fn train_alerts(req: HttpRequest, client: Data<Client>) -> Result<HttpResponse> {
    let train = req.match_info().query("train");
    let train_status = get_alerts(client, train.to_string());
    let train_result = train_status.await.unwrap();
    Ok(HttpResponse::Ok().content_type("text/json").body(serde_json::to_string(&train_result)?))
}

// Cache requests to not hammer servers
#[cached(
    time = 30,
    convert = r##"{ format!("{}", train) }"##,
    option = true,
    key = "String"
)]
async fn get_alerts(client: Data<Client>, train: String) -> Option<TrainStatus> {
    let train_owned = train.to_owned();
    let req_path = [
        "https://www.goodservice.io/api/routes/",
        &train_owned].join("");
    let mut res = client.get(req_path).send().await.unwrap();

    let payload = res
        .json::<Value>()
        .await
        .unwrap();
    let json = payload.as_object().unwrap();

    let status = json.get("status").and_then(Value::as_str)
        .unwrap_or("?");
    let mut alerts: Vec<String> = Vec::new();
    let serv = json.get("service_change_summaries").and_then(Value::as_object);
    for change in serv.and_then(|j| {j.get("both")}).and_then(Value::as_array).unwrap_or(&EMPTY_VEC).iter() {
            let changes = change.as_str();
            if changes.is_some() {
                alerts.push(changes.unwrap().to_string());
            }
        }
    for change in serv.and_then(|j| {j.get("north")}).and_then(Value::as_array).unwrap_or(&EMPTY_VEC).iter() {
            let changes = change.as_str();
            if changes.is_some() {
                alerts.push(changes.unwrap().to_string());
            }
        }
    for change in serv.and_then(|j| {j.get("south")}).and_then(Value::as_array).unwrap_or(&EMPTY_VEC).iter() {
            let changes = change.as_str();
            if changes.is_some() {
                alerts.push(changes.unwrap().to_string());
            }
        }
    let irr = json.get("service_irregularity_summaries").and_then(Value::as_object);
    let irr_n = irr.and_then(|i| {i.get("north")}).and_then(Value::as_str);
    let irr_s = irr.and_then(|i| {i.get("south")}).and_then(Value::as_str);
    if irr_n.is_some() {
        alerts.push(irr_n.unwrap().to_string());
    }
    if irr_s.is_some() {
        alerts.push(irr_s.unwrap().to_string());
    }

    Some(TrainStatus {
        status: status.to_string(),
        alerts: alerts
    })
}

#[get("/mta/countdown/{station:.*}")]
async fn countdown(req: HttpRequest, client: Data<Client>) -> Result<HttpResponse> {
    let station = req.match_info().query("station");
    let result = get_countdown(client, station.to_string()).await.unwrap();
    Ok(HttpResponse::Ok().content_type("text/json").body(serde_json::to_string(&result)?))

}

// Cache requests to not hammer servers
#[cached(
    time = 30,
    convert = r##"{ format!("{}", station) }"##,
    option = true,
    key = "String"
)]
async fn get_countdown(client: Data<Client>, station: String) -> Option<Countdown> {
    let station_owned = station.to_owned();
    let now = Utc::now().with_timezone(&New_York);
    let now_sec = now.timestamp();

    let req_path = [
        "https://otp-mta-prod.camsys-apps.com/otp/routers/default/nearby?stops=MTASBWY:",
        &station_owned,
        "&apikey=",
        &API_KEY].join("");
    let mut res = client.get(req_path).send().await.unwrap();

    let payload = res
        .json::<Vec<Value>>()
        .await;
    let train_status = get_alerts(client, station_owned[..1].to_string());

    let mut alerts : Vec<String> = Vec::new();
    let mut route_times : HashMap<String, Vec<TrainTime>> = HashMap::new();
    let json = payload.unwrap();
    let item = json.get(0).and_then(Value::as_object).unwrap();
    for alert in item.get("alerts").and_then(Value::as_array).unwrap_or(&EMPTY_VEC).iter() {
        let alert_start = alert.get("effectiveStartDate")
            .and_then(Value::as_i64).unwrap_or(0) / 1000;
        let alert_end = alert.get("effectiveEndDate")
            .and_then(Value::as_i64).unwrap_or(0) / 1000;
        if alert_start == 0 || alert_end == 0 ||
            alert_start > now_sec + 3600 || alert_end < now_sec {
            continue;
        }
        let alert_text = [
            alert.get("alertHeaderText").and_then(Value::as_str).unwrap_or(""),
            alert.get("humanReadableActivePeriod").and_then(Value::as_str).unwrap_or(""),
        ].join(" : ");
        alerts.push(alert_text);
    };
    for group in item.get("groups").and_then(Value::as_array).unwrap_or(&EMPTY_VEC) {
        let route = group.get("headsign").and_then(Value::as_str).unwrap_or("???");
        let train_name = group.get("route").and_then(Value::as_object)
            .and_then(|r| { r.get("shortName") }).and_then(Value::as_str).unwrap_or("?");
        let mut routes : Vec<TrainTime> = Vec::new();

        for train in group.get("times").and_then(Value::as_array).unwrap_or(&EMPTY_VEC) {
            let today_sec = train.get("serviceDay").and_then(Value::as_i64).unwrap();
            let time = train.get("realtimeArrival").and_then(Value::as_i64)
                .map(|i| {to_countdown(i, now_sec - today_sec, false, train_name)});

            if time.is_some() {
                routes.push(time.unwrap());
            }
        }
        if route_times.contains_key(&route.to_string()) {
            let all_routes = route_times.get_mut(&route.to_string()).unwrap();
            for time in routes {
                all_routes.push(time);
            }
        } else {
            route_times.insert(route.to_string(), routes);
        }
    }
    for routes in route_times.values_mut() {
        routes.sort_by_key(|r| r.seconds);
    }
    let stop_name = item.get("stop").and_then(Value::as_object)
        .and_then(|stop| { stop.get("name") }).and_then(Value::as_str)
        .unwrap_or("error");

    Some(Countdown {
        name : stop_name.to_string(),
        // TODO actually use alerts
        alerts : alerts,
        status: train_status.await.unwrap(),
        route_times : route_times
    })
}

async fn favicon() -> Result<NamedFile> {
    Ok(NamedFile::open("static/favicon.ico")?)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    lazy_static::initialize(&API_KEY);
    let client_tls_config = Arc::new(rustls_config());
    HttpServer::new(move || {
        // create client _inside_ `HttpServer::new` closure to have one per worker thread
        let client = Client::builder()
            // Wikipedia requires a User-Agent header to make requests
            .add_default_header((header::USER_AGENT, "awc-example/1.0"))
            // a "connector" wraps the stream into an encrypted connection
            .connector(Connector::new().rustls(Arc::clone(&client_tls_config)))
            .finish();

        App::new()
            .app_data(Data::new(client))
            .wrap(middleware::Logger::default())
            .service(mta)
            .service(get_time)
            .service(countdown)
            .service(train_alerts)
            .service(web::resource("/favicon.ico").route(web::get().to(favicon)))
            .service(actix_files::Files::new("/static", "./static"))
            .service(actix_files::Files::new("/mta/static", "./static"))
    })
    .bind(("127.0.0.1", 8080))?
    .workers(5)
    .run()
    .await
}

/// Create simple rustls client config from root certificates.
fn rustls_config() -> ClientConfig {
    let mut root_store = RootCertStore::empty();
    root_store.add_server_trust_anchors(webpki_roots::TLS_SERVER_ROOTS.0.iter().map(|ta| {
        OwnedTrustAnchor::from_subject_spki_name_constraints(
            ta.subject,
            ta.spki,
            ta.name_constraints,
        )
    }));

    rustls::ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(root_store)
        .with_no_client_auth()
}
