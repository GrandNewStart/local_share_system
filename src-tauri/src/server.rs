use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{post, put},
    Json, Router,
};
use axum::body::Body;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tower_http::cors::CorsLayer;
use tauri::Emitter;
use uuid::Uuid;

use crate::state::{SharedState, Peer, Transfer};

#[derive(Deserialize)]
pub struct HandshakeRequest {
    pub device_name: String,
    pub ip_address: String,
    pub auth_token: String,
}

#[derive(Serialize)]
pub struct HandshakeResponse {
    pub status: String,
    pub device_name: String,
    pub protocol_version: String,
}

#[derive(Deserialize)]
pub struct FileRequestPayload {
    pub filename: String,
    pub size_bytes: u64,
    pub peer_name: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Serialize)]
pub struct FileRequestResponse {
    pub approved: bool,
    pub transfer_token: String,
}

#[derive(Deserialize)]
pub struct ClipboardPayload {
    pub content: String,
    pub peer_name: String,
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

async fn handle_handshake(
    State(state): State<Arc<SharedState>>,
    Json(payload): Json<HandshakeRequest>,
) -> impl IntoResponse {
    {
        let mut peers = state.peers.lock().unwrap();
        
        // Check if peer already exists, or update it
        let mut found = false;
        for peer in peers.iter_mut() {
            if peer.ip == payload.ip_address {
                peer.name = payload.device_name.clone();
                peer.status = "Active".to_string();
                found = true;
                break;
            }
        }
        
        if !found {
            peers.push(Peer {
                id: Uuid::new_v4().to_string(),
                name: payload.device_name.clone(),
                ip: payload.ip_address.clone(),
                port: 50050,
                status: "Active".to_string(),
            });
        }
    }
    
    let _ = state.save_to_disk();
    let _ = state.app_handle.emit("refresh-peers", ());

    let settings = state.settings.lock().unwrap();
    Json(HandshakeResponse {
        status: "connected".to_string(),
        device_name: settings.device_name.clone(),
        protocol_version: "1.0.0".to_string(),
    })
}

async fn handle_file_request(
    State(state): State<Arc<SharedState>>,
    Json(payload): Json<FileRequestPayload>,
) -> impl IntoResponse {
    let token = Uuid::new_v4().to_string();
    
    // Insert new transfer in state
    let transfer = Transfer {
        token: token.clone(),
        filename: payload.filename.clone(),
        size: payload.size_bytes,
        progress: 0,
        is_download: true,
        peer_name: payload.peer_name.clone(),
        is_directory: payload.is_directory,
    };
    
    let mut active = state.active_transfers.lock().unwrap();
    active.insert(token.clone(), transfer.clone());

    // Emit file request received to frontend
    let _ = state.app_handle.emit("transfer-start", transfer);

    Json(FileRequestResponse {
        approved: true,
        transfer_token: token,
    })
}

async fn handle_file_upload(
    State(state): State<Arc<SharedState>>,
    Path(token): Path<String>,
    body: Body,
) -> impl IntoResponse {
    let transfer_info = {
        let active = state.active_transfers.lock().unwrap();
        active.get(&token).cloned()
    };

    let transfer = match transfer_info {
        Some(t) => t,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    // Prepare save directory path
    let download_dir = {
        let settings = state.settings.lock().unwrap();
        std::path::PathBuf::from(settings.download_dir.clone())
    };

    // Ensure save directory exists
    let _ = tokio::fs::create_dir_all(&download_dir).await;

    // Securely join path to prevent traversal
    let sanitized_filename = std::path::Path::new(&transfer.filename)
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("uploaded_file"));
    let dest_path = download_dir.join(sanitized_filename);

    let temp_zip_path = std::env::temp_dir().join(format!("incoming_{}.zip", token));
    let upload_path = if transfer.is_directory {
        temp_zip_path.clone()
    } else {
        dest_path.clone()
    };

    let mut file = match File::create(&upload_path).await {
        Ok(f) => f,
        Err(_) => {
            {
                let mut active = state.active_transfers.lock().unwrap();
                active.remove(&token);
            }
            let _ = state.app_handle.emit("transfer-error", token.clone());
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let mut stream = body.into_data_stream();
    let mut written_bytes = 0;

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(_) => {
                {
                    let mut active = state.active_transfers.lock().unwrap();
                    active.remove(&token);
                }
                let _ = state.app_handle.emit("transfer-error", token.clone());
                let _ = tokio::fs::remove_file(&upload_path).await;
                return StatusCode::BAD_REQUEST.into_response();
            }
        };

        if let Err(_) = file.write_all(&chunk).await {
            {
                let mut active = state.active_transfers.lock().unwrap();
                active.remove(&token);
            }
            let _ = state.app_handle.emit("transfer-error", token.clone());
            let _ = tokio::fs::remove_file(&upload_path).await;
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }

        written_bytes += chunk.len() as u64;

        // Update progress in state
        {
            let mut active = state.active_transfers.lock().unwrap();
            if let Some(t) = active.get_mut(&token) {
                t.progress = written_bytes;
            }
        }

        // Emit progress update to React frontend
        let _ = state.app_handle.emit(
            "transfer-progress",
            ProgressPayload {
                token: token.clone(),
                filename: transfer.filename.clone(),
                progress: written_bytes,
                size: transfer.size,
                is_download: true,
                peer_name: transfer.peer_name.clone(),
            },
        );
    }

    // Flush file to disk
    let _ = file.flush().await;

    // Clean up active transfers list
    {
        let mut active = state.active_transfers.lock().unwrap();
        active.remove(&token);
    }

    // Decompress if directory
    if transfer.is_directory {
        let unzip_res = crate::archive::unzip_archive(&temp_zip_path, &download_dir);
        let _ = tokio::fs::remove_file(&temp_zip_path).await;
        
        if let Err(err) = unzip_res {
            let _ = state.app_handle.emit("transfer-error", token.clone());
            eprintln!("Unzip failed: {}", err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // Emit transfer success to React frontend
    let _ = state.app_handle.emit("transfer-complete", token);

    StatusCode::OK.into_response()
}

async fn handle_clipboard_sync(
    State(state): State<Arc<SharedState>>,
    Json(payload): Json<ClipboardPayload>,
) -> impl IntoResponse {
    // Set clipboard text
    let set_result = tokio::task::spawn_blocking(move || {
        arboard::Clipboard::new().and_then(|mut ctx| ctx.set_text(payload.content))
    }).await;

    match set_result {
        Ok(Ok(_)) => {
            let _ = state.app_handle.emit("clipboard-synced", payload.peer_name);
            StatusCode::OK.into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub fn start_server(state: Arc<SharedState>) {
    let (ip_str, port) = {
        let settings = state.settings.lock().unwrap();
        (settings.bind_ip.clone(), settings.port)
    };

    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/api/v1/handshake", post(handle_handshake))
            .route("/api/v1/files/request", post(handle_file_request))
            .route("/api/v1/files/upload/:token", put(handle_file_upload))
            .route("/api/v1/clipboard/sync", post(handle_clipboard_sync))
            .layer(CorsLayer::permissive())
            .with_state(state);

        let ip: std::net::IpAddr = ip_str.parse().unwrap_or_else(|_| std::net::IpAddr::V4(std::net::Ipv4Addr::new(0, 0, 0, 0)));
        let addr = SocketAddr::new(ip, port);
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });
}
