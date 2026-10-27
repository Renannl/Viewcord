use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Window,
};
use tauri_plugin_deep_link::DeepLinkExt;
use once_cell::sync::Lazy;
use std::sync::Mutex;

mod discord_rpc;

static PENDING_DEEP_LINK: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static RENDERER_READY: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

#[tauri::command]
fn get_pending_deep_link() -> Option<String> {
    let mut pending = PENDING_DEEP_LINK.lock().unwrap();
    pending.take()
}

#[tauri::command]
fn renderer_ready(app: AppHandle) {
    {
        let mut ready = RENDERER_READY.lock().unwrap();
        *ready = true;
    }

    let mut pending = PENDING_DEEP_LINK.lock().unwrap();
    if let Some(room_id) = pending.take() {
        let _ = app.emit("deep-link", room_id);
    }
}

#[tauri::command]
fn minimize_window(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn close_window(window: Window) {
    let _ = window.hide();
}

#[tauri::command]
async fn ensure_discord_rpc() -> Result<bool, String> {
    discord_rpc::ensure_connected().await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn update_room(room_id: String) -> Result<(), String> {
    discord_rpc::ensure_connected().await.map_err(|e| e.to_string())?;
    discord_rpc::update_presence(Some(&room_id)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_room() -> Result<(), String> {
    discord_rpc::update_presence(None).await.map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            renderer_ready,
            minimize_window,
            close_window,
            ensure_discord_rpc,
            update_room,
            clear_room,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Deep link handler
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                if let Some(url) = urls.first() {
                    let url_str = url.to_string();
                    println!("Deep link recebido: {}", url_str);

                    if let Some(room_id) = extract_room_id(&url_str) {
                        {
                            let mut pending = PENDING_DEEP_LINK.lock().unwrap();
                            *pending = Some(room_id.clone());
                        }

                        let ready = RENDERER_READY.lock().unwrap();
                        if *ready {
                            let _ = handle.emit("deep-link", room_id);
                        }
                    }
                }
            });

            // Tray icon — ÚNICO, definido aqui (não declarar também no tauri.conf.json)
            let show_item = MenuItem::with_id(app, "show", "Abrir ViewCord", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Usa o ícone padrão do app (icons/icon.png do bundle.icon) — evita ícone vazio
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("ícone padrão não encontrado em bundle.icon");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        discord_rpc::stop_presence();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Show window on first launch (unless started hidden)
            let window = app.get_webview_window("main").unwrap();
            if !std::env::args().any(|arg| arg == "--hidden") {
                let _ = window.show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao rodar ViewCord");
}

fn extract_room_id(url: &str) -> Option<String> {
    let url = url.trim_start_matches("viewcord://");
    url.split('&')
        .find(|param| param.starts_with("room="))
        .map(|param| param.trim_start_matches("room=").to_string())
}
