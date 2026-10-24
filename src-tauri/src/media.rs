//! Android: локальная раздача медиафайлов плееру WebView. Протокол asset:// на Android
//! отвечает на Range-запросы кусками по 1 МБ, и медиаплеер WebView на аудио больше 1 МБ
//! застревает на загрузке (видео при этом играет). Здесь — свой HTTP только на 127.0.0.1
//! со случайным портом; файл доступен по случайному токену, выданному на этот путь.
//! На компьютере не используется — там asset:// работает.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::{
    body::Body,
    extract::{Path as UrlPath, Request, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tauri::{AppHandle, Manager};
use tower::ServiceExt;

#[derive(Default)]
pub struct LocalMedia {
    /// Порт сервера (запускается при первом запросе адреса).
    port: tokio::sync::Mutex<Option<u16>>,
    /// токен → путь и путь → токен (один токен на файл, чтобы карта не росла).
    files: Mutex<(HashMap<String, PathBuf>, HashMap<PathBuf, String>)>,
}

/// Адрес файла для плеера: http://127.0.0.1:<порт>/m/<токен>.
#[tauri::command]
pub async fn local_media_url(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !Path::new(&p).is_file() {
        return Err("Файл не найден".into());
    }
    let st = app.state::<LocalMedia>();
    let token = {
        let mut g = st.files.lock().unwrap_or_else(|e| e.into_inner());
        match g.1.get(&p) {
            Some(t) => t.clone(),
            None => {
                let t = crate::lan::rand_id();
                g.0.insert(t.clone(), p.clone());
                g.1.insert(p, t.clone());
                t
            }
        }
    };
    let mut port = st.port.lock().await;
    if port.is_none() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
        *port = Some(listener.local_addr().map_err(|e| e.to_string())?.port());
        let router = Router::new()
            .route("/m/{token}", get(serve))
            .layer(middleware::from_fn(crate::lan::only_native_peers))
            .with_state(app.clone());
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
    }
    Ok(format!("http://127.0.0.1:{}/m/{token}", port.unwrap_or_default()))
}

async fn serve(State(app): State<AppHandle>, UrlPath(token): UrlPath<String>, req: Request) -> Response {
    let path = {
        let st = app.state::<LocalMedia>();
        let g = st.files.lock().unwrap_or_else(|e| e.into_inner());
        g.0.get(&token).cloned()
    };
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tower_http::services::ServeFile::new(path).oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
