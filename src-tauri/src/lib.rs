mod downloader;
mod storage;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Показать и сфокусировать главное окно.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    ];

    tauri::Builder::default()
        .manage(downloader::ActiveProcs::default())
        .manage(storage::LibWatcher::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:mestia.db", migrations)
                .build(),
        )
        // Иконка в системном трее с меню.
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Открыть Mestia", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
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
        })
        .invoke_handler(tauri::generate_handler![
            downloader::fetch_metadata,
            downloader::start_download,
            downloader::cancel_download,
            downloader::update_ytdlp,
            storage::exit_app,
            storage::generate_thumbnail,
            storage::watch_library,
            storage::existing_paths,
            storage::get_storage_root,
            storage::set_storage_root,
            storage::get_setting,
            storage::set_setting,
            storage::scan_media,
            storage::scan_dirs,
            storage::create_folder_dir,
            storage::move_video_file,
            storage::open_folder,
            storage::delete_file,
            storage::delete_folder,
            storage::rename_folder,
            storage::reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка запуска приложения Mestia");
}
