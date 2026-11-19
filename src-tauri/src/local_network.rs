#[cfg(any(mestia_addon, not(all(windows, target_arch = "x86_64"))))]
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
#[cfg(any(mestia_addon, not(all(windows, target_arch = "x86_64"))))]
use std::net::Ipv4Addr;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Пускаем только Mestia с других устройств, а не веб-страницы из браузера на этом же
/// устройстве. Браузер ставит Origin на WebSocket и на запросы через CORS — у Mestia
/// (reqwest/tungstenite) его нет, а <video> гостя при обычной загрузке медиа его не шлёт.
/// Host — только IP: имя вместо адреса означает DNS-rebinding.
#[cfg(any(mestia_addon, not(all(windows, target_arch = "x86_64"))))]
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
#[cfg(any(mestia_addon, not(all(windows, target_arch = "x86_64"))))]
pub(crate) fn host_is_ip(host: &str) -> bool {
    if let Some(rest) = host.strip_prefix('[') {
        return rest
            .split(']')
            .next()
            .is_some_and(|ip| ip.parse::<std::net::Ipv6Addr>().is_ok());
    }
    host.split(':')
        .next()
        .is_some_and(|ip| ip.parse::<Ipv4Addr>().is_ok())
}
