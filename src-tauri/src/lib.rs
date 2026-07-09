use std::sync::Arc;
use tauri::Manager;

pub mod state;
pub mod server;
pub mod client;
pub mod commands;
pub mod archive;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // Resolve download folder and config folder
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                std::env::temp_dir().join("portal")
            });
            let download_dir = app.path().download_dir().unwrap_or_else(|_| {
                std::env::temp_dir().join("portal_downloads")
            });

            // Initialize State
            let state = Arc::new(state::SharedState::new(
                app_handle,
                app_data_dir,
                download_dir,
            ));

            // Start local server
            server::start_server(Arc::clone(&state));

            // Register state managed by Tauri
            app.manage(state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::get_peers,
            commands::add_peer,
            commands::remove_peer,
            commands::test_connection,
            commands::send_file,
            commands::send_clipboard,
            commands::get_local_ip,
            commands::get_active_transfers,
            commands::get_network_interfaces
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
