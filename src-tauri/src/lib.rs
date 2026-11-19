#[cfg(any(target_os = "android", all(windows, target_arch = "x86_64")))]
mod addon_wire;
#[cfg(any(target_os = "android", all(windows, target_arch = "x86_64")))]
mod addon_runtime;
#[cfg(all(windows, target_arch = "x86_64"))]
mod addons;
#[cfg(target_os = "android")]
mod android_addons;
#[cfg(desktop)]
mod desktop_process;
mod downloader;
mod file_paths;
mod engine;
#[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
mod lan;
mod local_network;
#[cfg(not(all(windows, target_arch = "x86_64")))]
mod media;
#[cfg(all(desktop, any(test, not(all(windows, target_arch = "x86_64")))))]
mod media_tags;
#[cfg(mobile)]
mod mobile;
mod storage;
#[cfg(desktop)]
mod transcription;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Показать и сфокусировать главное окно.
#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // На Linux (особенно Steam Deck / AMD GPU) WebKitGTK с DMABUF-рендерером
    // часто отдаёт пустое белое окно без интерфейса. Отключаем его до создания
    // webview, если пользователь не переопределил переменную сам.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Миграции БД выполняются плагином SQL при первом подключении к sqlite:mestia.db.
    let migrations = vec![
        Migration {
            version: 1,
            description: "init schema",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "history download params (for resume/restart)",
            sql: "ALTER TABLE history ADD COLUMN format TEXT;\
                  ALTER TABLE history ADD COLUMN is_audio INTEGER;\
                  ALTER TABLE history ADD COLUMN audio_format TEXT;\
                  ALTER TABLE history ADD COLUMN mode TEXT;\
                  ALTER TABLE history ADD COLUMN items TEXT;\
                  ALTER TABLE history ADD COLUMN out_dir TEXT;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "index videos.url (findVideoByUrl)",
            sql: "CREATE INDEX IF NOT EXISTS idx_videos_url ON videos(url);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "persistent download queue",
            sql: "CREATE TABLE IF NOT EXISTS download_queue (history_id INTEGER PRIMARY KEY, options TEXT NOT NULL);",
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default();
    // Первым регистрируем проверку экземпляра до запуска остальных плагинов.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        show_main(app);
    }));

    #[cfg(not(all(windows, target_arch = "x86_64")))]
    let builder = builder.manage(media::LocalMedia::default());
    #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
    let builder = builder.manage(lan::Lan::default());
    #[cfg(any(target_os = "android", all(windows, target_arch = "x86_64")))]
    let builder = builder.manage(addon_runtime::AddonWorkers::default());
    #[cfg(target_os = "android")]
    let builder = builder.manage(android_addons::InstallLock::default());

    let builder = builder
        .manage(engine::ActiveProcs::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:mestia.db", migrations)
                .build(),
        );

    // Android: yt-dlp/ffmpeg, foreground-сервис и прочее — в Kotlin-плагине.
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init());

    // Компьютер: sidecar-бинарники, самообновление, слежение за папкой, трей.
    #[cfg(desktop)]
    let builder = builder
        .manage(storage::LibWatcher::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Иконка в системном трее с меню.
        .setup(|app| {
            let (show_label, quit_label) = match storage::setting(app.handle(), "lang").as_deref() {
                Some("ru") => ("Открыть Mestia", "Выход"),
                Some("zh") => ("打开 Mestia", "退出"),
                _ => ("Open Mestia", "Quit"),
            };
            let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Mestia")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // «Умное» закрытие главного окна (мини-окна плеера закрываются обычно).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("app://close-requested", ());
                }
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            transcription::transcription_info,
            #[cfg(desktop)]
            transcription::download_transcription_model,
            #[cfg(desktop)]
            transcription::delete_transcription_model,
            #[cfg(desktop)]
            transcription::transcription_addon_status,
            #[cfg(desktop)]
            transcription::transcription_addon_storage,
            #[cfg(desktop)]
            transcription::install_transcription_addon,
            #[cfg(desktop)]
            transcription::uninstall_transcription_addon,
            #[cfg(desktop)]
            transcription::transcribe,
            #[cfg(desktop)]
            transcription::save_transcript,
            #[cfg(all(desktop, not(all(windows, target_arch = "x86_64"))))]
            storage::read_media_tags,
            #[cfg(all(desktop, not(all(windows, target_arch = "x86_64"))))]
            storage::write_media_tags,
            downloader::fetch_metadata,
            downloader::start_download,
            downloader::cancel_download,
            downloader::update_ytdlp,
            storage::exit_app,
            storage::uninstall_app,
            storage::generate_thumbnail,
            storage::watch_library,
            storage::existing_paths,
            storage::get_storage_root,
            storage::available_storage,
            storage::set_storage_root,
            storage::pick_storage_dir,
            storage::get_setting,
            storage::set_setting,
            storage::updater_supported,
            storage::scan_media,
            storage::scan_dirs,
            storage::create_folder_dir,
            storage::move_video_file,
            storage::open_folder,
            storage::open_path,
            storage::delete_file,
            storage::delete_folder,
            storage::rename_folder,
            storage::reveal_in_explorer,
            storage::subtitle_track,
            storage::take_shared_text,
            storage::move_app_to_back,
            storage::set_fullscreen,
            storage::set_app_icon,
            storage::set_launcher_icon,
            storage::media_session,
            storage::ensure_media_access,
            storage::set_playback_active,
            #[cfg(all(windows, target_arch = "x86_64"))]
            addons::addon_packages,
            #[cfg(all(windows, target_arch = "x86_64"))]
            addons::install_addon_package,
            #[cfg(all(windows, target_arch = "x86_64"))]
            addons::uninstall_addon_package,
            #[cfg(all(windows, target_arch = "x86_64"))]
            addons::addon_command,
            #[cfg(target_os = "android")]
            android_addons::addon_packages,
            #[cfg(target_os = "android")]
            android_addons::install_addon_package,
            #[cfg(target_os = "android")]
            android_addons::uninstall_addon_package,
            #[cfg(target_os = "android")]
            android_addons::addon_command,
            #[cfg(not(all(windows, target_arch = "x86_64")))]
            media::local_media_url,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_info,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_start,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_stop,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_peers,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_probe,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_answer_offer,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_send,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_start,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_state,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_stop,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_join,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_cmd,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_leave,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_add,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_move,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_remove,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_play,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_queue,
            #[cfg(not(any(target_os = "android", all(windows, target_arch = "x86_64"))))]
            lan::lan_room_propose,
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка запуска приложения Mestia");
}
