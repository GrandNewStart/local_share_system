use std::sync::Arc;
use tauri::Manager;
use tauri::Emitter;

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
            app.manage(state.clone());

            // 1. Network configuration background polling loop
            let app_handle_network = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_ip = local_ip_address::local_ip().map(|ip| ip.to_string()).ok();
                let mut last_ifs = local_ip_address::list_afinet_netifas().ok();

                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;

                    if let Ok(current_ifs) = local_ip_address::list_afinet_netifas() {
                        let changed = match &last_ifs {
                            Some(last) => last != &current_ifs,
                            None => true,
                        };

                        if changed {
                            last_ifs = Some(current_ifs);
                            let new_ip = local_ip_address::local_ip().map(|ip| ip.to_string()).ok();
                            if new_ip != last_ip {
                                last_ip = new_ip.clone();
                                let _ = app_handle_network.emit("local-ip-changed", new_ip);
                            }
                            let _ = app_handle_network.emit("interfaces-changed", ());
                        }
                    }
                }
            });

            // 2. Peer heartbeat background check loop
            let state_heartbeat = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

                    let peers = {
                        match state_heartbeat.peers.lock() {
                            Ok(lock) => lock.clone(),
                            Err(_) => continue,
                        }
                    };

                    let mut changed = false;
                    for peer in peers {
                        let addr = format!("{}:{}", peer.ip, peer.port);
                        let is_online = tokio::time::timeout(
                            std::time::Duration::from_secs(1),
                            tokio::net::TcpStream::connect(&addr)
                        ).await.is_ok();

                        let new_status = if is_online { "Active" } else { "Offline" };

                        {
                            if let Ok(mut lock) = state_heartbeat.peers.lock() {
                                if let Some(p) = lock.iter_mut().find(|x| x.id == peer.id) {
                                    if p.status != new_status {
                                        p.status = new_status.to_string();
                                        changed = true;
                                    }
                                }
                            }
                        }
                    }

                    if changed {
                        let _ = state_heartbeat.save_to_disk();
                        let _ = state_heartbeat.app_handle.emit("refresh-peers", ());
                    }
                }
            });

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
