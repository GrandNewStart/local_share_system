use std::sync::Arc;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::state::{SharedState, Peer, AppSettings, Transfer};
use crate::client;

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<SharedState>>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
pub fn update_settings(
    settings: AppSettings,
    state: State<'_, Arc<SharedState>>,
) -> Result<(), String> {
    {
        let mut current_settings = state.settings.lock().map_err(|e| e.to_string())?;
        *current_settings = settings;
    }
    state.save_to_disk()?;
    Ok(())
}

#[tauri::command]
pub fn get_peers(state: State<'_, Arc<SharedState>>) -> Result<Vec<Peer>, String> {
    let peers = state.peers.lock().map_err(|e| e.to_string())?;
    Ok(peers.clone())
}

#[tauri::command]
pub fn add_peer(
    name: String,
    ip: String,
    state: State<'_, Arc<SharedState>>,
) -> Result<Peer, String> {
    let peer = Peer {
        id: Uuid::new_v4().to_string(),
        name,
        ip,
        port: 50050,
        status: "Offline".to_string(),
    };

    {
        let mut peers = state.peers.lock().map_err(|e| e.to_string())?;
        peers.push(peer.clone());
    }

    state.save_to_disk()?;
    let _ = state.app_handle.emit("refresh-peers", ());
    Ok(peer)
}

#[tauri::command]
pub fn remove_peer(id: String, state: State<'_, Arc<SharedState>>) -> Result<(), String> {
    {
        let mut peers = state.peers.lock().map_err(|e| e.to_string())?;
        peers.retain(|p| p.id != id);
    }
    state.save_to_disk()?;
    let _ = state.app_handle.emit("refresh-peers", ());
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    peer_ip: String,
    peer_port: u16,
    state: State<'_, Arc<SharedState>>,
) -> Result<String, String> {
    let state_inner = state.inner().clone();
    
    // Set status to Connecting
    {
        let mut peers = state_inner.peers.lock().map_err(|e| e.to_string())?;
        if let Some(peer) = peers.iter_mut().find(|p| p.ip == peer_ip) {
            peer.status = "Connecting".to_string();
        }
    }
    let _ = state_inner.app_handle.emit("refresh-peers", ());

    match client::perform_handshake(peer_ip.clone(), peer_port, Arc::clone(&state_inner)).await {
        Ok(device_name) => {
            // Update to Active and save the confirmed device name
            {
                let mut peers = state_inner.peers.lock().map_err(|e| e.to_string())?;
                if let Some(peer) = peers.iter_mut().find(|p| p.ip == peer_ip) {
                    peer.name = device_name.clone();
                    peer.status = "Active".to_string();
                }
            }
            let _ = state_inner.save_to_disk();
            let _ = state_inner.app_handle.emit("refresh-peers", ());
            Ok(device_name)
        }
        Err(err) => {
            // Revert status to Offline
            {
                let mut peers = state_inner.peers.lock().map_err(|e| e.to_string())?;
                if let Some(peer) = peers.iter_mut().find(|p| p.ip == peer_ip) {
                    peer.status = "Offline".to_string();
                }
            }
            let _ = state_inner.app_handle.emit("refresh-peers", ());
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn send_file(
    peer_ip: String,
    peer_port: u16,
    file_path: String,
    state: State<'_, Arc<SharedState>>,
) -> Result<(), String> {
    let state_inner = state.inner().clone();
    let path = std::path::PathBuf::from(file_path);
    client::send_file_to_peer(peer_ip, peer_port, path, state_inner).await
}

#[tauri::command]
pub async fn send_clipboard(
    peer_ip: String,
    peer_port: u16,
    content: String,
    state: State<'_, Arc<SharedState>>,
) -> Result<(), String> {
    let state_inner = state.inner().clone();
    client::send_clipboard_to_peer(peer_ip, peer_port, content, state_inner).await
}

#[tauri::command]
pub fn get_local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_transfers(state: State<'_, Arc<SharedState>>) -> Result<Vec<Transfer>, String> {
    let active = state.active_transfers.lock().map_err(|e| e.to_string())?;
    Ok(active.values().cloned().collect())
}
