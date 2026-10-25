//! Локальная сеть: обмен файлами между устройствами с Mestia и совместный просмотр.
//!
//! Обнаружение — UDP-анонсы (multicast + broadcast подсети) раз в 2 с на порт `PORT`;
//! передача и комната — HTTP/WebSocket-сервер (axum) на TCP `PORT` (если занят — любой).
//! Приём файлов — только после подтверждения пользователем. Комната открыта всем в сети,
//! пока ведущий её держит: ведущий — источник истины, гости подстраиваются под его
//! состояние с поправкой на разницу часов (NTP-подобный замер по WebSocket).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Query, Request, State,
    },
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, watch};
use tower::ServiceExt;

pub const PORT: u16 = 53318;
const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 18);
const PEER_TTL: Duration = Duration::from_secs(8);
const ANNOUNCE_EVERY: Duration = Duration::from_secs(2);
const OFFER_TIMEOUT: Duration = Duration::from_secs(90);
/// Принятая сессия без новых данных дольше этого — отправитель пропал, отпускаем «не спать».
const SESSION_IDLE: Duration = Duration::from_secs(120);

/// Устройство в сети.
#[derive(Clone, Serialize, PartialEq)]
pub struct Peer {
    id: String,
    name: String,
    platform: String,
    /// ip:port HTTP-сервера.
    addr: String,
    /// Название комнаты совместного просмотра, если устройство её держит.
    room: Option<String>,
    /// Добавлено вручную по адресу (анонсы могут не доходить) — не устаревает.
    manual: bool,
    #[serde(skip)]
    seen: Option<Instant>,
}

/// Принятое предложение: какие файлы ждём и куда класть.
struct Session {
    dir: PathBuf,
    from: String,
    files: HashMap<String, (String, u64)>,
    /// Пока сессия жива, устройство не засыпает (снимается вместе с ней).
    awake: Option<Awake>,
    /// Последние полученные данные — для SESSION_IDLE.
    touched: Instant,
}

// ── Не засыпать во время передачи ───────────────────────────────────────────

/// Пока жив — передача не прерывается сном. Android: служба загрузок (foreground)
/// с wake lock и Wi-Fi lock, процент — в её уведомлении; компьютер — запрет сна
/// системы. Создаётся, когда пользователь жмёт «Отправить»/«Принять»: приложение на
/// экране, и Android разрешает запустить службу (из фона — уже нет).
pub(crate) struct Awake {
    #[cfg_attr(desktop, allow(dead_code))]
    app: AppHandle,
    id: String,
    #[cfg_attr(desktop, allow(dead_code))]
    notified: Mutex<Option<Instant>>,
}

impl Awake {
    pub(crate) fn new(app: &AppHandle, id: String) -> Self {
        #[cfg(mobile)]
        {
            let (app, id) = (app.clone(), id.clone());
            tauri::async_runtime::spawn_blocking(move || crate::mobile::keep_awake(&app, &id, true));
        }
        #[cfg(desktop)]
        desktop_awake(true);
        Awake { app: app.clone(), id, notified: Mutex::new(None) }
    }

    /// Процент передачи в уведомлении Android — не чаще раза в секунду.
    #[cfg_attr(desktop, allow(unused_variables))]
    fn progress(&self, name: &str, done: u64, total: u64) {
        #[cfg(mobile)]
        {
            let mut last = self.notified.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
                return;
            }
            *last = Some(Instant::now());
            let pct = if total > 0 { done as f64 * 100.0 / total as f64 } else { 0.0 };
            let (app, id, name) = (self.app.clone(), self.id.clone(), name.to_string());
            tauri::async_runtime::spawn_blocking(move || {
                crate::mobile::download_progress(&app, &id, Some(&name), pct)
            });
        }
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        #[cfg(mobile)]
        {
            let (app, id) = (self.app.clone(), self.id.clone());
            tauri::async_runtime::spawn_blocking(move || crate::mobile::keep_awake(&app, &id, false));
        }
        #[cfg(desktop)]
        desktop_awake(false);
        let _ = &self.id;
    }
}

/// Компьютер: счётчик активных передач; запрет сна держит отдельный поток — на
/// Windows он привязан к потоку (SetThreadExecutionState), а задачи tokio кочуют.
#[cfg(desktop)]
fn desktop_awake(on: bool) {
    use std::sync::mpsc as smpsc;
    use std::sync::OnceLock;
    static CTL: OnceLock<Mutex<(usize, smpsc::Sender<bool>)>> = OnceLock::new();
    let ctl = CTL.get_or_init(|| {
        let (tx, rx) = smpsc::channel::<bool>();
        std::thread::spawn(move || {
            let mut guard = None;
            for want in rx {
                if want && guard.is_none() {
                    guard = keepawake::Builder::default()
                        .idle(true)
                        .reason("Mestia: передача файлов")
                        .app_name("Mestia")
                        .app_reverse_domain("com.mestia.app")
                        .create()
                        .ok();
                } else if !want {
                    guard = None;
                }
            }
        });
        Mutex::new((0, tx))
    });
    let mut g = ctl.lock().unwrap_or_else(|e| e.into_inner());
    let was = g.0;
    g.0 = if on { was + 1 } else { was.saturating_sub(1) };
    if (was == 0) != (g.0 == 0) {
        let _ = g.1.send(g.0 > 0);
    }
}

struct Guest {
    name: String,
    tx: mpsc::UnboundedSender<String>,
}

/// Комната, которую держит это устройство.
struct HostRoom {
    id: String,
    /// Очередь воспроизведения и id играющего сейчас элемента.
    queue: Vec<QItem>,
    current: Option<String>,
    guests: HashMap<u64, Guest>,
    next: u64,
    /// Последнее состояние — новому гостю сразу.
    last: Option<String>,
}

struct Running {
    port: u16,
    alive: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    peers: HashMap<String, Peer>,
    offers: HashMap<String, oneshot::Sender<bool>>,
    /// Приём одобрен, сессия ещё не создана: «не спать» уже включено (id предложения).
    accepted: HashMap<String, Awake>,
    sessions: HashMap<String, Session>,
    room: Option<HostRoom>,
    /// Канал команд к ведущему комнаты, к которой мы подключены (drop → выход).
    joined: Option<mpsc::UnboundedSender<String>>,
    /// Гость: последняя очередь комнаты (адреса уже полные).
    guest_queue: Option<Value>,
    /// Гость: свои файлы, предложенные в очередь, по токену (/api/share/media).
    shares: HashMap<String, PathBuf>,
}

#[derive(Default)]
pub struct Lan(Mutex<Inner>);

fn lan(app: &AppHandle) -> MutexGuard<'_, Inner> {
    app.state::<Lan>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Случайный идентификатор (RandomState засеивается ОС; криптостойкость не нужна).
pub(crate) fn rand_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(nanos);
    let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
    h2.write_u64(h.finish());
    format!("{:016x}{:016x}", h.finish(), h2.finish())
}

fn es(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// HTTP-клиент для соседних устройств: мимо системного прокси (HTTP_PROXY, прокси Windows) —
/// иначе запрос к 192.168.x.x уходит в прокси и устройство «не отвечает».
fn lan_client() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

// ── Устройство ──────────────────────────────────────────────────────────────

fn device_id(app: &AppHandle) -> String {
    if let Some(id) = crate::storage::setting(app, "lanId").filter(|s| !s.is_empty()) {
        return id;
    }
    let id = rand_id();
    let _ = crate::storage::write_setting(app, "lanId", json!(id));
    id
}

fn device_name(app: &AppHandle) -> String {
    if let Some(n) = crate::storage::setting(app, "lanName").filter(|s| !s.trim().is_empty()) {
        return n.trim().to_string();
    }
    #[cfg(mobile)]
    return crate::mobile::device_name(app).unwrap_or_else(|| "Android".into());
    #[cfg(desktop)]
    {
        let _ = app;
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .ok()
            .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Mestia".into())
    }
}

fn platform() -> &'static str {
    std::env::consts::OS
}

/// IPv4-адреса интерфейсов (без loopback и link-local) с broadcast-адресом подсети.
fn ipv4_ifaces() -> Vec<(Ipv4Addr, Option<Ipv4Addr>)> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v) if !v.ip.is_link_local() => Some((v.ip, v.broadcast)),
            _ => None,
        })
        .collect()
}

fn self_payload(app: &AppHandle, port: u16, bye: bool) -> Value {
    let room = lan(app).room.as_ref().map(|r| current_item(r).map(|x| x.title.clone()).unwrap_or_default());
    json!({
        "mestia": 1,
        "id": device_id(app),
        "name": device_name(app),
        "platform": platform(),
        "port": port,
        "room": room,
        "bye": bye,
    })
}

// ── Включение / выключение ──────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LanInfo {
    running: bool,
    id: String,
    name: String,
    port: u16,
    ips: Vec<String>,
}

fn info(app: &AppHandle) -> LanInfo {
    let port = lan(app).running.as_ref().map(|r| r.port);
    LanInfo {
        running: port.is_some(),
        id: device_id(app),
        name: device_name(app),
        port: port.unwrap_or(PORT),
        ips: ipv4_ifaces().into_iter().map(|(ip, _)| ip.to_string()).collect(),
    }
}

#[tauri::command(async)]
pub fn lan_info(app: AppHandle) -> LanInfo {
    info(&app)
}

/// Включает видимость: сервер + анонсы. Повторный вызов — просто вернуть сведения.
#[tauri::command]
pub async fn lan_start(app: AppHandle) -> Result<LanInfo, String> {
    if lan(&app).running.is_some() {
        return Ok(info(&app));
    }
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.map_err(es)?,
    };
    let port = listener.local_addr().map_err(es)?.port();
    let (stop, mut stop_rx) = watch::channel(false);
    let router = routes(app.clone());
    tauri::async_runtime::spawn(async move {
        // ConnectInfo — адрес гостя нужен, чтобы раздавать предложенные им файлы.
        let _ = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = stop_rx.changed().await;
            })
            .await;
    });
    let alive = Arc::new(AtomicBool::new(true));
    #[cfg(mobile)]
    crate::mobile::multicast_lock(&app, true);
    {
        let (app, alive) = (app.clone(), alive.clone());
        std::thread::spawn(move || discovery(app, alive, port));
    }
    lan(&app).running = Some(Running { port, alive, stop });
    Ok(info(&app))
}

/// Выключает видимость: закрывает комнату, сервер и анонсы.
#[tauri::command(async)]
pub fn lan_stop(app: AppHandle) {
    stop_room(&app);
    let running = {
        let mut g = lan(&app);
        g.peers.retain(|_, p| p.manual);
        g.joined = None;
        g.guest_queue = None;
        g.shares.clear();
        g.running.take()
    };
    if let Some(r) = running {
        r.alive.store(false, Ordering::Relaxed);
        let _ = r.stop.send(true);
        #[cfg(mobile)]
        crate::mobile::multicast_lock(&app, false);
    }
    emit_peers(&app);
}

#[tauri::command(async)]
pub fn lan_peers(app: AppHandle) -> Vec<Peer> {
    peers_sorted(&app)
}

fn peers_sorted(app: &AppHandle) -> Vec<Peer> {
    let mut v: Vec<Peer> = lan(app).peers.values().cloned().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

fn emit_peers(app: &AppHandle) {
    let _ = app.emit("lan://peers", peers_sorted(app));
}

/// Добавить устройство вручную по адресу (ip или ip:port) — если анонсы не доходят.
#[tauri::command]
pub async fn lan_probe(app: AppHandle, addr: String) -> Result<Peer, String> {
    let addr = addr.trim().trim_start_matches("http://").trim_end_matches('/').to_string();
    let addr = if addr.contains(':') { addr } else { format!("{addr}:{PORT}") };
    let v: Value = lan_client().build().map_err(es)?
        .get(format!("http://{addr}/api/info"))
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| format!("Устройство {addr} не отвечает (connection refused)"))?
        .json()
        .await
        .map_err(es)?;
    if v["mestia"].as_u64() != Some(1) {
        return Err("По этому адресу не Mestia".into());
    }
    let peer = Peer {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str().unwrap_or("?").to_string(),
        platform: v["platform"].as_str().unwrap_or_default().to_string(),
        addr,
        room: v["room"].as_str().map(String::from),
        manual: true,
        seen: Some(Instant::now()),
    };
    lan(&app).peers.insert(peer.id.clone(), peer.clone());
    emit_peers(&app);
    Ok(peer)
}

// ── Обнаружение (UDP) ───────────────────────────────────────────────────────

fn bind_udp() -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    s.set_broadcast(true)?;
    s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT).into())?;
    let u: UdpSocket = s.into();
    u.set_read_timeout(Some(Duration::from_millis(500)))?;
    let _ = u.set_multicast_loop_v4(false);
    Ok(u)
}

fn discovery(app: AppHandle, alive: Arc<AtomicBool>, port: u16) {
    let sock = match bind_udp() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[lan] UDP {PORT}: {e}");
            return;
        }
    };
    let me = device_id(&app);
    let mut last: Option<Instant> = None;
    let mut buf = [0u8; 4096];
    while alive.load(Ordering::Relaxed) {
        if last.map_or(true, |t| t.elapsed() >= ANNOUNCE_EVERY) {
            announce(&app, &sock, port, false);
            last = Some(Instant::now());
        }
        if let Ok((n, src)) = sock.recv_from(&mut buf) {
            handle_packet(&app, &me, &buf[..n], src);
        }
        expire(&app);
    }
    announce(&app, &sock, port, true);
}

fn announce(app: &AppHandle, sock: &UdpSocket, port: u16, bye: bool) {
    let msg = self_payload(app, port, bye).to_string();
    let sref = socket2::SockRef::from(sock);
    for (ip, bcast) in ipv4_ifaces() {
        // Интерфейсы меняются (переподключение Wi-Fi) — вступаем в группу заново; повтор — ошибка, не страшно.
        let _ = sock.join_multicast_v4(&GROUP, &ip);
        if sref.set_multicast_if_v4(&ip).is_ok() {
            let _ = sock.send_to(msg.as_bytes(), (GROUP, PORT));
        }
        // Точки доступа на телефонах часто режут multicast — дублируем broadcast'ом подсети.
        if let Some(b) = bcast {
            let _ = sock.send_to(msg.as_bytes(), (b, PORT));
        }
    }
}

fn handle_packet(app: &AppHandle, me: &str, data: &[u8], src: SocketAddr) {
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let Some(id) = v["id"].as_str() else {
        return;
    };
    if v["mestia"].as_u64() != Some(1) || id == me {
        return;
    }
    let changed = {
        let mut g = lan(app);
        if v["bye"].as_bool() == Some(true) {
            g.peers.remove(id).is_some()
        } else {
            let peer = Peer {
                id: id.to_string(),
                name: v["name"].as_str().unwrap_or("?").to_string(),
                platform: v["platform"].as_str().unwrap_or_default().to_string(),
                addr: format!("{}:{}", src.ip(), v["port"].as_u64().unwrap_or(PORT as u64)),
                room: v["room"].as_str().map(String::from),
                manual: false,
                seen: None,
            };
            let old = g.peers.get(id).map(|p| Peer { seen: None, manual: false, ..p.clone() });
            let changed = old.as_ref() != Some(&peer);
            g.peers.insert(id.to_string(), Peer { seen: Some(Instant::now()), ..peer });
            changed
        }
    };
    if changed {
        emit_peers(app);
    }
}

fn expire(app: &AppHandle) {
    lan(app).sessions.retain(|_, s| s.touched.elapsed() < SESSION_IDLE);
    let removed = {
        let mut g = lan(app);
        let before = g.peers.len();
        g.peers
            .retain(|_, p| p.manual || p.seen.map_or(false, |t| t.elapsed() < PEER_TTL));
        before != g.peers.len()
    };
    if removed {
        emit_peers(app);
    }
}

// ── HTTP-сервер ─────────────────────────────────────────────────────────────

fn routes(app: AppHandle) -> Router {
    Router::new()
        .route("/api/info", get(info_h))
        .route("/api/offer", post(offer_h))
        .route("/api/upload", put(upload_h).layer(DefaultBodyLimit::disable()))
        .route("/api/room", get(room_h))
        .route("/api/room/media", get(media_h))
        .route("/api/room/ws", get(ws_h))
        .route("/api/share/media", get(share_h))
        .layer(middleware::from_fn(only_native_peers))
        .with_state(app)
}

/// Пускаем только Mestia с других устройств, а не веб-страницы из браузера на этом же
/// устройстве. Браузер ставит Origin на WebSocket и на запросы через CORS — у Mestia
/// (reqwest/tungstenite) его нет, а <video> гостя при обычной загрузке медиа его не шлёт.
/// Host — только IP: имя вместо адреса означает DNS-rebinding.
pub(crate) async fn only_native_peers(req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(host_is_ip);
    if req.headers().contains_key(header::ORIGIN) || !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

/// «192.168.1.5», «192.168.1.5:53318», «[::1]:53318» — да; «evil.example:53318» — нет.
fn host_is_ip(host: &str) -> bool {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().is_some_and(|ip| ip.parse::<std::net::Ipv6Addr>().is_ok());
    }
    host.split(':').next().is_some_and(|ip| ip.parse::<Ipv4Addr>().is_ok())
}

async fn info_h(State(app): State<AppHandle>) -> Json<Value> {
    let port = lan(&app).running.as_ref().map(|r| r.port).unwrap_or(PORT);
    Json(self_payload(&app, port, false))
}

#[derive(Serialize, Deserialize, Clone)]
struct OfferFile {
    id: String,
    name: String,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct Offer {
    from_id: String,
    from_name: String,
    files: Vec<OfferFile>,
}

/// Предложение файлов: ждём ответа пользователя (lan_answer_offer), до 90 с.
async fn offer_h(State(app): State<AppHandle>, Json(o): Json<Offer>) -> Response {
    if o.files.is_empty() || o.files.len() > 2000 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let id = rand_id();
    let (tx, rx) = oneshot::channel();
    lan(&app).offers.insert(id.clone(), tx);
    let total: u64 = o.files.iter().map(|f| f.size).sum();
    let _ = app.emit(
        "lan://offer",
        json!({ "id": id, "from": o.from_name, "files": o.files, "total": total }),
    );
    let ok = matches!(tokio::time::timeout(OFFER_TIMEOUT, rx).await, Ok(Ok(true)));
    lan(&app).offers.remove(&id);
    let awake = lan(&app).accepted.remove(&id);
    let _ = app.emit("lan://offer-closed", &id);
    if !ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    let app2 = app.clone();
    let dir = match tauri::async_runtime::spawn_blocking(move || crate::storage::storage_root(&app2)).await {
        Ok(Ok(d)) => d,
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let session = rand_id();
    lan(&app).sessions.insert(
        session.clone(),
        Session {
            dir,
            from: o.from_name,
            files: o.files.into_iter().map(|f| (f.id, (f.name, f.size))).collect(),
            awake,
            touched: Instant::now(),
        },
    );
    Json(json!({ "session": session })).into_response()
}

/// Ответ пользователя на входящее предложение.
#[tauri::command(async)]
pub fn lan_answer_offer(app: AppHandle, id: String, accept: bool) {
    let mut g = lan(&app);
    if let Some(tx) = g.offers.remove(&id) {
        // «Принять» нажали на экране — сейчас можно запустить службу «не спать».
        if accept {
            g.accepted.insert(id.clone(), Awake::new(&app, format!("lan-in:{id}")));
        }
        let _ = tx.send(accept);
    }
}

/// Имя файла от чужого устройства: только последний компонент, без запрещённых символов.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = crate::storage::sanitize(base)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}

#[derive(Deserialize)]
struct UploadQ {
    session: String,
    file: String,
}

async fn upload_h(State(app): State<AppHandle>, Query(q): Query<UploadQ>, body: Body) -> StatusCode {
    let taken = {
        let mut g = lan(&app);
        g.sessions.get_mut(&q.session).and_then(|s| {
            s.files.remove(&q.file).map(|m| (s.dir.clone(), m, s.from.clone()))
        })
    };
    let Some((dir, (name, size), from)) = taken else {
        return StatusCode::FORBIDDEN;
    };
    let name = safe_name(&name);
    let target = crate::storage::unique_path(dir.join(&name));
    let tmp = dir.join(format!(".{name}.mestia-part"));
    let id = format!("{}:{}", q.session, q.file);
    let progress = |done: u64| {
        json!({ "id": id, "name": name, "done": done, "total": size, "dir": "in", "peer": from })
    };

    let res: Result<(), StatusCode> = async {
        let mut f = tokio::fs::File::create(&tmp).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut stream = body.into_data_stream();
        let (mut got, mut tick) = (0u64, Instant::now());
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
            got += chunk.len() as u64;
            if got > size {
                return Err(StatusCode::BAD_REQUEST);
            }
            f.write_all(&chunk).await.map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
            if tick.elapsed() > Duration::from_millis(250) {
                let _ = app.emit("lan://progress", progress(got));
                tick = Instant::now();
                if let Some(s) = lan(&app).sessions.get_mut(&q.session) {
                    s.touched = tick;
                    if let Some(a) = &s.awake {
                        a.progress(&name, got, size);
                    }
                }
            }
        }
        f.flush().await.map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
        if got != size {
            return Err(StatusCode::BAD_REQUEST);
        }
        Ok(())
    }
    .await;

    {
        let mut g = lan(&app);
        if g.sessions.get(&q.session).is_some_and(|s| s.files.is_empty()) {
            g.sessions.remove(&q.session);
        }
    }
    if let Err(code) = res {
        let _ = tokio::fs::remove_file(&tmp).await;
        let _ = app.emit("lan://progress", json!({ "id": id, "name": name, "done": 0, "total": size, "dir": "in", "peer": from, "error": true }));
        return code;
    }
    if tokio::fs::rename(&tmp, &target).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    #[cfg(mobile)]
    {
        let (app, p) = (app.clone(), target.to_string_lossy().to_string());
        tauri::async_runtime::spawn_blocking(move || crate::mobile::scan_file(&app, &p));
    }
    let _ = app.emit("lan://progress", progress(size));
    let _ = app.emit(
        "lan://received",
        json!({ "name": name, "path": target.to_string_lossy(), "from": from }),
    );
    StatusCode::OK
}

// ── Отправка файлов ─────────────────────────────────────────────────────────

/// Отправить файлы на устройство addr: предложение → (после согласия) загрузка по одному.
#[tauri::command]
pub async fn lan_send(app: AppHandle, addr: String, peer: String, paths: Vec<String>) -> Result<(), String> {
    let files: Vec<(OfferFile, PathBuf)> = paths
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let path = PathBuf::from(p);
            let size = std::fs::metadata(&path).ok().filter(|m| m.is_file())?.len();
            let name = path.file_name()?.to_string_lossy().to_string();
            Some((OfferFile { id: i.to_string(), name, size }, path))
        })
        .collect();
    if files.is_empty() {
        return Err("Файлы не найдены".into());
    }
    // «Отправить» нажали на экране: держим устройство бодрым до конца (drop в конце функции).
    let awake = Arc::new(Awake::new(&app, format!("lan-out:{}", rand_id())));
    let client = lan_client()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(es)?;
    let offer = Offer {
        from_id: device_id(&app),
        from_name: device_name(&app),
        files: files.iter().map(|(f, _)| f.clone()).collect(),
    };
    let resp = client
        .post(format!("http://{addr}/api/offer"))
        .json(&offer)
        .timeout(OFFER_TIMEOUT + Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Устройство недоступно (connection refused)".to_string())?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Получатель отклонил передачу".into());
    }
    let session: Value = resp.error_for_status().map_err(es)?.json().await.map_err(es)?;
    let session = session["session"].as_str().unwrap_or_default().to_string();

    for (f, path) in files {
        let id = format!("{session}:{}", f.id);
        let file = tokio::fs::File::open(&path).await.map_err(es)?;
        let (app2, id2, name2, peer2, total) = (app.clone(), id.clone(), f.name.clone(), peer.clone(), f.size);
        let awake2 = awake.clone();
        let (mut done, mut tick) = (0u64, Instant::now());
        let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).map(move |r| {
            if let Ok(b) = &r {
                done += b.len() as u64;
                if tick.elapsed() > Duration::from_millis(250) {
                    let _ = app2.emit(
                        "lan://progress",
                        json!({ "id": id2, "name": name2, "done": done, "total": total, "dir": "out", "peer": peer2 }),
                    );
                    awake2.progress(&name2, done, total);
                    tick = Instant::now();
                }
            }
            r
        });
        let r = client
            .put(format!("http://{addr}/api/upload"))
            .query(&[("session", session.as_str()), ("file", f.id.as_str())])
            .header("content-length", f.size)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await;
        let ok = matches!(&r, Ok(resp) if resp.status().is_success());
        let _ = app.emit(
            "lan://progress",
            json!({ "id": id, "name": f.name, "done": if ok { f.size } else { 0 }, "total": f.size, "dir": "out", "peer": peer, "error": !ok }),
        );
        if !ok {
            return Err(match r {
                Ok(resp) if resp.status() == reqwest::StatusCode::INSUFFICIENT_STORAGE => {
                    "У получателя не хватает места (no space left)".into()
                }
                Ok(resp) => format!("Передача «{}» прервана: {}", f.name, resp.status()),
                Err(e) => format!("Передача «{}» прервана: {e}", f.name),
            });
        }
    }
    Ok(())
}

// ── Комната: ведущий ────────────────────────────────────────────────────────

/// Откуда берётся файл элемента очереди.
#[derive(Clone)]
enum QSrc {
    /// Файл ведущего — раздаётся с /api/room/media?item=<id>.
    Local(PathBuf),
    /// Файл, предложенный гостем, — раздаётся с устройства гостя (полный URL).
    Remote(String),
}

#[derive(Clone)]
struct QItem {
    id: String,
    title: String,
    kind: String,
    /// Кто предложил (гость); None — добавил ведущий.
    by: Option<String>,
    guest: Option<u64>,
    src: QSrc,
}

/// Сдвинуть элемент очереди на delta позиций (в пределах списка).
fn move_item(q: &mut Vec<QItem>, id: &str, delta: i64) -> bool {
    let Some(i) = q.iter().position(|x| x.id == id) else {
        return false;
    };
    let j = (i as i64 + delta).clamp(0, q.len() as i64 - 1) as usize;
    if i == j {
        return false;
    }
    let it = q.remove(i);
    q.insert(j, it);
    true
}

fn current_item(room: &HostRoom) -> Option<&QItem> {
    room.current.as_ref().and_then(|c| room.queue.iter().find(|x| &x.id == c))
}

/// Очередь в JSON: ведущему — с путями своих файлов, гостям — с адресами для плеера
/// (свои файлы ведущего — относительным путём, гость дополнит адресом ведущего).
fn queue_json(room: &HostRoom, for_host: bool) -> Value {
    let items: Vec<Value> = room
        .queue
        .iter()
        .map(|x| {
            let (path, url) = match &x.src {
                QSrc::Local(p) if for_host => (Some(p.to_string_lossy().to_string()), None),
                QSrc::Local(_) => (None, Some(format!("/api/room/media?item={}", x.id))),
                QSrc::Remote(u) => (None, Some(u.clone())),
            };
            json!({ "id": x.id, "title": x.title, "kind": x.kind, "by": x.by, "path": path, "url": url })
        })
        .collect();
    json!({ "t": "queue", "items": items, "current": room.current })
}

/// Разослать очередь гостям и показать ведущему.
fn broadcast_queue(app: &AppHandle) {
    let host = {
        let mut g = lan(app);
        let Some(room) = g.room.as_mut() else {
            return;
        };
        let msg = queue_json(room, false).to_string();
        room.guests.retain(|_, c| c.tx.send(msg.clone()).is_ok());
        queue_json(room, true)
    };
    let _ = app.emit("lan://room-queue", host);
}

fn local_item(path: String, title: String, kind: String) -> Result<QItem, String> {
    if !Path::new(&path).is_file() {
        return Err("Файл не найден".into());
    }
    Ok(QItem { id: rand_id(), title, kind, by: None, guest: None, src: QSrc::Local(PathBuf::from(path)) })
}

/// Открыть комнату совместного просмотра с файлом path первым в очереди.
#[tauri::command(async)]
pub fn lan_room_start(app: AppHandle, path: String, title: String, kind: String) -> Result<String, String> {
    if lan(&app).running.is_none() {
        return Err("Сначала включите видимость в сети".into());
    }
    let first = local_item(path, title, kind)?;
    stop_room(&app);
    let id = rand_id();
    lan(&app).room = Some(HostRoom {
        id: id.clone(),
        current: Some(first.id.clone()),
        queue: vec![first],
        guests: HashMap::new(),
        next: 0,
        last: None,
    });
    broadcast_queue(&app);
    Ok(id)
}

/// Добавить свой файл в конец очереди.
#[tauri::command(async)]
pub fn lan_room_add(app: AppHandle, path: String, title: String, kind: String) -> Result<(), String> {
    let item = local_item(path, title, kind)?;
    match lan(&app).room.as_mut() {
        Some(room) => room.queue.push(item),
        None => return Err("Комната закрыта".into()),
    }
    broadcast_queue(&app);
    Ok(())
}

/// Переставить элемент очереди (delta: -1 — выше, +1 — ниже).
#[tauri::command(async)]
pub fn lan_room_move(app: AppHandle, id: String, delta: i64) {
    let moved = lan(&app).room.as_mut().is_some_and(|r| move_item(&mut r.queue, &id, delta));
    if moved {
        broadcast_queue(&app);
    }
}

/// Убрать элемент из очереди (текущий — нельзя: сначала переключитесь на другой).
#[tauri::command(async)]
pub fn lan_room_remove(app: AppHandle, id: String) {
    let removed = lan(&app).room.as_mut().is_some_and(|r| {
        let before = r.queue.len();
        if r.current.as_deref() != Some(id.as_str()) {
            r.queue.retain(|x| x.id != id);
        }
        before != r.queue.len()
    });
    if removed {
        broadcast_queue(&app);
    }
}

/// Включить элемент очереди у всех (ведущий сам запускает его в своём плеере).
#[tauri::command(async)]
pub fn lan_room_play(app: AppHandle, id: String) {
    let ok = lan(&app).room.as_mut().is_some_and(|r| {
        let found = r.queue.iter().any(|x| x.id == id);
        if found {
            r.current = Some(id.clone());
            r.last = None; // состояние прошлого файла к новому не относится
        }
        found
    });
    if ok {
        broadcast_queue(&app);
    }
}

/// Очередь текущей комнаты (ведущему — свою, гостю — последнюю полученную).
#[tauri::command(async)]
pub fn lan_room_queue(app: AppHandle) -> Value {
    let g = lan(&app);
    match (&g.room, &g.guest_queue) {
        (Some(room), _) => queue_json(room, true),
        (None, Some(q)) => q.clone(),
        _ => Value::Null,
    }
}

/// Состояние плеера ведущего → всем гостям (с меткой времени ведущего).
#[tauri::command(async)]
pub fn lan_room_state(app: AppHandle, playing: bool, pos: f64, rate: f64) {
    let mut g = lan(&app);
    let Some(room) = g.room.as_mut() else {
        return;
    };
    let msg = json!({
        "t": "state", "playing": playing, "pos": pos, "rate": rate, "item": room.current,
        "at": now_ms(), "peers": room.guests.len() + 1,
    })
    .to_string();
    room.guests.retain(|_, c| c.tx.send(msg.clone()).is_ok());
    room.last = Some(msg);
}

#[tauri::command(async)]
pub fn lan_room_stop(app: AppHandle) {
    stop_room(&app);
}

fn stop_room(app: &AppHandle) {
    if let Some(room) = lan(app).room.take() {
        let end = json!({ "t": "end" }).to_string();
        for c in room.guests.values() {
            let _ = c.tx.send(end.clone());
        }
        // guests дропаются → каналы закрываются → сокеты гостей завершаются.
    }
}

fn emit_guests(app: &AppHandle) {
    let names: Vec<String> = lan(app)
        .room
        .as_ref()
        .map(|r| r.guests.values().map(|g| g.name.clone()).collect())
        .unwrap_or_default();
    let _ = app.emit("lan://room-guests", names);
}

async fn room_h(State(app): State<AppHandle>) -> Response {
    let g = lan(&app);
    match g.room.as_ref() {
        Some(r) => {
            let cur = current_item(r);
            Json(json!({
                "id": r.id,
                "title": cur.map(|x| x.title.clone()).unwrap_or_default(),
                "kind": cur.map(|x| x.kind.clone()).unwrap_or_else(|| "video".into()),
            }))
            .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve_path(path: PathBuf, req: Request) -> Response {
    match tower_http::services::ServeFile::new(path).oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct MediaQ {
    item: Option<String>,
}

/// Файл ведущего из очереди (с Range — плеер гостя перематывает без докачки).
async fn media_h(State(app): State<AppHandle>, Query(q): Query<MediaQ>, req: Request) -> Response {
    let path = {
        let g = lan(&app);
        g.room.as_ref().and_then(|r| {
            let it = match &q.item {
                Some(id) => r.queue.iter().find(|x| &x.id == id),
                None => current_item(r),
            };
            match it.map(|x| &x.src) {
                Some(QSrc::Local(p)) => Some(p.clone()),
                _ => None,
            }
        })
    };
    match path {
        Some(p) => serve_path(p, req).await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct ShareQ {
    t: String,
}

/// Гость: свой файл, предложенный в очередь чужой комнаты (доступ — по токену).
async fn share_h(State(app): State<AppHandle>, Query(q): Query<ShareQ>, req: Request) -> Response {
    let path = lan(&app).shares.get(&q.t).cloned();
    match path {
        Some(p) => serve_path(p, req).await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn ws_h(
    State(app): State<AppHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> Response {
    if lan(&app).room.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.on_upgrade(move |s| guest_socket(app, s, peer))
}

async fn guest_socket(app: AppHandle, socket: WebSocket, peer: SocketAddr) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let gid = {
        let mut g = lan(&app);
        let Some(room) = g.room.as_mut() else {
            return;
        };
        let gid = room.next;
        room.next += 1;
        let _ = tx.send(queue_json(room, false).to_string());
        if let Some(s) = &room.last {
            let _ = tx.send(s.clone());
        }
        room.guests.insert(gid, Guest { name: "…".into(), tx });
        gid
    };
    emit_guests(&app);
    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(s) => if sink.send(Message::Text(s.into())).await.is_err() { break },
                None => break,
            },
            inc = stream.next() => match inc {
                Some(Ok(Message::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    match v["t"].as_str() {
                        Some("ping") => {
                            let pong = json!({ "t": "pong", "c": v["c"], "h": now_ms() }).to_string();
                            if sink.send(Message::Text(pong.into())).await.is_err() { break }
                        }
                        Some("hello") => {
                            let name = v["name"].as_str().unwrap_or("?").to_string();
                            if let Some(gst) = lan(&app).room.as_mut().and_then(|r| r.guests.get_mut(&gid)) {
                                gst.name = name;
                            }
                            emit_guests(&app);
                        }
                        Some("cmd") => {
                            let _ = app.emit("lan://room-cmd", json!({ "action": v["action"], "pos": v["pos"] }));
                        }
                        Some("propose") => {
                            // Файл гостя играет у всех прямо с его устройства.
                            let (Some(port), Some(token)) = (v["port"].as_u64(), v["token"].as_str()) else { continue };
                            let url = format!("http://{}:{port}/api/share/media?t={token}", peer.ip());
                            let added = {
                                let mut g = lan(&app);
                                g.room.as_mut().map(|r| {
                                    let by = r.guests.get(&gid).map(|x| x.name.clone());
                                    r.queue.push(QItem {
                                        id: rand_id(),
                                        title: v["title"].as_str().unwrap_or("?").to_string(),
                                        kind: v["kind"].as_str().unwrap_or("video").to_string(),
                                        by,
                                        guest: Some(gid),
                                        src: QSrc::Remote(url),
                                    });
                                })
                            };
                            if added.is_some() {
                                broadcast_queue(&app);
                            }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    // Ушёл гость — его файлы больше недоступны (кроме уже играющего: доиграет из буфера).
    if let Some(room) = lan(&app).room.as_mut() {
        room.guests.remove(&gid);
        let cur = room.current.clone();
        room.queue.retain(|x| x.guest != Some(gid) || Some(&x.id) == cur.as_ref());
    }
    emit_guests(&app);
    broadcast_queue(&app);
}

// ── Комната: гость ──────────────────────────────────────────────────────────

/// Оценка разницы часов с ведущим по замерам ping/pong: берём замер с наименьшим RTT
/// из последних — у него наименьшая погрешность (как в NTP).
#[derive(Default)]
struct Clock {
    samples: Vec<(f64, f64)>, // (rtt, offset)
}

impl Clock {
    /// c — наше время отправки, h — время ведущего, t1 — наше время получения.
    /// true — если оценка сдвига изменилась.
    fn add(&mut self, c: f64, h: f64, t1: f64) -> bool {
        let rtt = t1 - c;
        if !(0.0..10_000.0).contains(&rtt) {
            return false;
        }
        let before = self.offset();
        self.samples.push((rtt, h - (c + t1) / 2.0));
        if self.samples.len() > 12 {
            self.samples.remove(0);
        }
        before != self.offset()
    }

    /// Время ведущего минус наше, мс.
    fn offset(&self) -> Option<f64> {
        self.samples
            .iter()
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|s| s.1)
    }
}

#[derive(Serialize)]
pub struct JoinInfo {
    title: String,
    kind: String,
}

/// Подключиться к комнате на устройстве addr.
#[tauri::command]
pub async fn lan_room_join(app: AppHandle, addr: String) -> Result<JoinInfo, String> {
    leave(&app);
    let info: Value = lan_client().build().map_err(es)?
        .get(format!("http://{addr}/api/room"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| "Устройство недоступно (connection refused)".to_string())?
        .error_for_status()
        .map_err(|_| "Комната уже закрыта".to_string())?
        .json()
        .await
        .map_err(es)?;
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/room/ws"))
        .await
        .map_err(es)?;
    let (tx, rx) = mpsc::unbounded_channel();
    lan(&app).joined = Some(tx);
    tauri::async_runtime::spawn(guest_loop(app.clone(), ws, rx, device_name(&app), addr));
    Ok(JoinInfo {
        title: info["title"].as_str().unwrap_or_default().to_string(),
        kind: info["kind"].as_str().unwrap_or("video").to_string(),
    })
}

/// Очередь от ведущего → адреса для плеера гостя: свои файлы ведущего — через его адрес.
fn absolutize_queue(mut q: Value, addr: &str) -> Value {
    if let Some(items) = q["items"].as_array_mut() {
        for it in items {
            if let Some(u) = it["url"].as_str().filter(|u| u.starts_with('/')) {
                it["url"] = json!(format!("http://{addr}{u}"));
            }
        }
    }
    q
}

type GuestWs = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn guest_loop(
    app: AppHandle,
    ws: GuestWs,
    mut rx: mpsc::UnboundedReceiver<String>,
    name: String,
    addr: String,
) {
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    let (mut sink, mut stream) = ws.split();
    let hello = json!({ "t": "hello", "name": name }).to_string();
    let _ = sink.send(WsMsg::Text(hello.into())).await;
    let mut clock = Clock::default();
    let mut last: Option<Value> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut n = 0u32;
    // Состояние ведущего в наших часах (at — момент, к которому относится pos).
    let emit_state = |app: &AppHandle, s: &Value, off: f64| {
        let _ = app.emit(
            "lan://room-state",
            json!({
                "playing": s["playing"], "pos": s["pos"], "rate": s["rate"], "peers": s["peers"],
                "item": s["item"], "at": s["at"].as_f64().unwrap_or(0.0) - off,
            }),
        );
    };
    loop {
        tokio::select! {
            _ = tick.tick() => {
                // Первые замеры часто (быстрый старт), дальше — раз в 5 с (дрейф часов).
                if n < 8 || n % 20 == 0 {
                    let ping = json!({ "t": "ping", "c": now_ms() }).to_string();
                    if sink.send(WsMsg::Text(ping.into())).await.is_err() { break }
                }
                n = n.wrapping_add(1);
            }
            cmd = rx.recv() => match cmd {
                Some(s) => if sink.send(WsMsg::Text(s.into())).await.is_err() { break },
                None => return, // вышли сами (lan_room_leave)
            },
            inc = stream.next() => match inc {
                Some(Ok(WsMsg::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    match v["t"].as_str() {
                        Some("pong") => {
                            let (c, h) = (v["c"].as_f64().unwrap_or(0.0), v["h"].as_f64().unwrap_or(0.0));
                            if clock.add(c, h, now_ms()) {
                                if let (Some(s), Some(off)) = (&last, clock.offset()) { emit_state(&app, s, off) }
                            }
                        }
                        Some("state") => {
                            if let Some(off) = clock.offset() { emit_state(&app, &v, off) }
                            last = Some(v);
                        }
                        Some("queue") => {
                            let q = absolutize_queue(v, &addr);
                            lan(&app).guest_queue = Some(q.clone());
                            let _ = app.emit("lan://room-queue", q);
                        }
                        Some("end") => break,
                        _ => {}
                    }
                }
                Some(Ok(WsMsg::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    let _ = app.emit("lan://room-end", ());
}

/// Гость: команда ведущему (play/pause/seek).
#[tauri::command(async)]
pub fn lan_room_cmd(app: AppHandle, action: String, pos: f64) {
    if let Some(tx) = lan(&app).joined.as_ref() {
        let _ = tx.send(json!({ "t": "cmd", "action": action, "pos": pos }).to_string());
    }
}

/// Гость: предложить свой файл в очередь. Файл раздаёт наш сервер по одноразовому токену.
#[tauri::command(async)]
pub fn lan_room_propose(app: AppHandle, path: String, title: String, kind: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err("Файл не найден".into());
    }
    let mut g = lan(&app);
    let Some(port) = g.running.as_ref().map(|r| r.port) else {
        return Err("Сначала включите видимость в сети".into());
    };
    let token = rand_id();
    let msg = json!({ "t": "propose", "title": title, "kind": kind, "port": port, "token": token }).to_string();
    let sent = g.joined.as_ref().is_some_and(|tx| tx.send(msg).is_ok());
    if !sent {
        return Err("Вы не в комнате".into());
    }
    g.shares.insert(token, PathBuf::from(path));
    Ok(())
}

fn leave(app: &AppHandle) {
    let mut g = lan(app);
    g.joined = None;
    g.guest_queue = None;
    g.shares.clear();
}

#[tauri::command(async)]
pub fn lan_room_leave(app: AppHandle) {
    leave(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_prefers_lowest_rtt_sample() {
        let mut c = Clock::default();
        // Часы ведущего впереди на 1000 мс; второй замер — с маленьким RTT.
        assert!(c.add(0.0, 1100.0, 200.0)); // rtt 200, offset 1000
        assert!(c.add(1000.0, 2015.0, 1020.0)); // rtt 20, offset 1005 (точнее)
        assert_eq!(c.offset(), Some(1005.0));
        // Шумный замер с большим RTT не сбивает оценку.
        assert!(!c.add(2000.0, 3400.0, 2500.0));
        assert_eq!(c.offset(), Some(1005.0));
        // Отрицательный RTT игнорируется.
        assert!(!c.add(10.0, 0.0, 5.0));
    }

    fn item(id: &str) -> QItem {
        QItem { id: id.into(), title: id.into(), kind: "video".into(), by: None, guest: None, src: QSrc::Remote(String::new()) }
    }

    #[test]
    fn move_item_reorders_within_bounds() {
        let mut q = vec![item("a"), item("b"), item("c")];
        let ids = |q: &Vec<QItem>| q.iter().map(|x| x.id.clone()).collect::<Vec<_>>().join("");
        assert!(move_item(&mut q, "c", -1));
        assert_eq!(ids(&q), "acb");
        assert!(move_item(&mut q, "a", 5)); // упирается в конец
        assert_eq!(ids(&q), "cba");
        assert!(!move_item(&mut q, "c", -1)); // уже первый
        assert!(!move_item(&mut q, "zz", 1));
    }

    #[test]
    fn absolutize_queue_prefixes_host_paths_only() {
        let q = json!({ "items": [
            { "url": "/api/room/media?item=1" },
            { "url": "http://10.0.0.7:53318/api/share/media?t=x" },
        ] });
        let q = absolutize_queue(q, "192.168.1.5:53318");
        assert_eq!(q["items"][0]["url"], "http://192.168.1.5:53318/api/room/media?item=1");
        assert_eq!(q["items"][1]["url"], "http://10.0.0.7:53318/api/share/media?t=x");
    }

    #[test]
    fn host_must_be_ip_literal() {
        assert!(host_is_ip("192.168.1.5"));
        assert!(host_is_ip("192.168.1.5:53318"));
        assert!(host_is_ip("[::1]:53318"));
        assert!(!host_is_ip("evil.example:53318"));
        assert!(!host_is_ip("localhost:53318"));
        assert!(!host_is_ip("1.2.3.4.evil.example"));
        assert!(!host_is_ip(""));
    }

    #[tokio::test]
    async fn browser_and_rebinding_requests_are_rejected() {
        let app = Router::new()
            .route("/api/info", get(|| async { "ok" }))
            .layer(middleware::from_fn(only_native_peers));
        let call = |host: &str, origin: Option<&str>| {
            let mut r = axum::http::Request::builder().uri("/api/info").header(header::HOST, host);
            if let Some(o) = origin {
                r = r.header(header::ORIGIN, o);
            }
            app.clone().oneshot(r.body(Body::empty()).unwrap())
        };
        // Mestia с другого устройства — пускаем.
        assert_eq!(call("192.168.1.5:53318", None).await.unwrap().status(), StatusCode::OK);
        // Веб-страница из браузера (Origin) и DNS-rebinding (имя вместо IP) — нет.
        assert_eq!(call("192.168.1.5:53318", Some("https://evil.example")).await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(call("evil.example:53318", None).await.unwrap().status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn safe_name_strips_paths_and_dots() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\x\\клип.mp4"), "клип.mp4");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("a:b?.mp3"), "a_b_.mp3");
        assert_eq!(safe_name(""), "file");
    }
}
