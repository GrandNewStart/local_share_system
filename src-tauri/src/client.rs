use futures_util::TryStreamExt;
use reqwest::Body;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::codec::{BytesCodec, FramedRead};
use tauri::Emitter;

use crate::state::{SharedState, Transfer};

#[derive(Serialize)]
struct HandshakeRequest {
    device_name: String,
    ip_address: String,
    auth_token: String,
}

#[derive(Deserialize)]
struct HandshakeResponse {
    #[allow(dead_code)]
    status: String,
    device_name: String,
}

#[derive(Serialize)]
struct FileRequestPayload {
    filename: String,
    size_bytes: u64,
    peer_name: String,
}

#[derive(Deserialize)]
struct FileRequestResponse {
    approved: bool,
    transfer_token: String,
}

#[derive(Serialize)]
struct ClipboardPayload {
    content: String,
    peer_name: String,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    token: String,
    filename: String,
    progress: u64,
    size: u64,
    is_download: bool,
    peer_name: String,
}

pub async fn perform_handshake(
    peer_ip: String,
    peer_port: u16,
    state: Arc<SharedState>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("http://{}:{}/api/v1/handshake", peer_ip, peer_port);

    // Get current device settings
    let (device_name, local_ip) = {
        let settings = state.settings.lock().unwrap();
        let ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        (settings.device_name.clone(), ip)
    };

    let payload = HandshakeRequest {
        device_name,
        ip_address: local_ip,
        auth_token: "test_token".to_string(), // In future PIN authentication
    };

    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        let res_data = response
            .json::<HandshakeResponse>()
            .await
            .map_err(|e| format!("Invalid handshake response: {}", e))?;
            
        Ok(res_data.device_name)
    } else {
        Err(format!("Peer returned status: {}", response.status()))
    }
}

pub async fn send_file_to_peer(
    peer_ip: String,
    peer_port: u16,
    file_path: PathBuf,
    state: Arc<SharedState>,
) -> Result<(), String> {
    let filename = file_path
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .into_owned();

    let file_metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size = file_metadata.len();

    let client = reqwest::Client::new();
    
    // Get sender device name
    let sender_name = {
        let settings = state.settings.lock().unwrap();
        settings.device_name.clone()
    };

    // 1. Request file transfer approval
    let request_url = format!("http://{}:{}/api/v1/files/request", peer_ip, peer_port);
    let request_payload = FileRequestPayload {
        filename: filename.clone(),
        size_bytes: file_size,
        peer_name: sender_name.clone(),
    };

    let request_res = client
        .post(&request_url)
        .json(&request_payload)
        .send()
        .await
        .map_err(|e| format!("Transfer request failed: {}", e))?;

    if !request_res.status().is_success() {
        return Err("Peer rejected file transfer".to_string());
    }

    let request_data = request_res
        .json::<FileRequestResponse>()
        .await
        .map_err(|e| format!("Invalid file request response: {}", e))?;

    if !request_data.approved {
        return Err("Peer rejected file transfer request".to_string());
    }

    let token = request_data.transfer_token;
    
    // Register active transfer locally
    let transfer = Transfer {
        token: token.clone(),
        filename: filename.clone(),
        size: file_size,
        progress: 0,
        is_download: false,
        peer_name: sender_name.clone(),
    };
    
    {
        let mut active = state.active_transfers.lock().unwrap();
        active.insert(token.clone(), transfer.clone());
    }
    
    let _ = state.app_handle.emit("transfer-start", transfer);

    // 2. Stream upload the file contents
    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let upload_url = format!(
        "http://{}:{}/api/v1/files/upload/{}",
        peer_ip, peer_port, token
    );

    let state_clone = Arc::clone(&state);
    let filename_clone = filename.clone();
    let token_clone = token.clone();
    let peer_name_clone = sender_name.clone();
    
    let mut bytes_sent = 0u64;

    let stream = FramedRead::new(file, BytesCodec::new()).map_ok(move |bytes| {
        let chunk_len = bytes.len() as u64;
        bytes_sent += chunk_len;

        // Emit progress update locally
        let _ = state_clone.app_handle.emit(
            "transfer-progress",
            ProgressPayload {
                token: token_clone.clone(),
                filename: filename_clone.clone(),
                progress: bytes_sent,
                size: file_size,
                is_download: false,
                peer_name: peer_name_clone.clone(),
            },
        );

        bytes
    });

    let body = Body::wrap_stream(stream);

    let upload_res = client
        .put(&upload_url)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("File upload failed: {}", e))?;

    // Clean up local transfer list
    {
        let mut active = state.active_transfers.lock().unwrap();
        active.remove(&token);
    }

    if upload_res.status().is_success() {
        let _ = state.app_handle.emit("transfer-complete", token);
        Ok(())
    } else {
        Err(format!("Upload failed with status: {}", upload_res.status()))
    }
}

pub async fn send_clipboard_to_peer(
    peer_ip: String,
    peer_port: u16,
    content: String,
    state: Arc<SharedState>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://{}:{}/api/v1/clipboard/sync", peer_ip, peer_port);

    let device_name = {
        let settings = state.settings.lock().unwrap();
        settings.device_name.clone()
    };

    let payload = ClipboardPayload {
        content,
        peer_name: device_name,
    };

    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Clipboard sync failed: {}", e))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("Peer returned status: {}", response.status()))
    }
}
