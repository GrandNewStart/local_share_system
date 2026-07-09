use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub status: String, // "Active", "Connecting", "Offline"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub device_name: String,
    pub download_dir: String,
    pub port: u16,
    pub bind_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigData {
    pub settings: AppSettings,
    pub peers: Vec<Peer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transfer {
    pub token: String,
    pub filename: String,
    pub size: u64,
    pub progress: u64,
    pub is_download: bool,
    pub peer_name: String,
    pub is_directory: bool,
}

pub struct SharedState {
    pub peers: Mutex<Vec<Peer>>,
    pub settings: Mutex<AppSettings>,
    pub active_transfers: Mutex<HashMap<String, Transfer>>,
    pub config_path: PathBuf,
    pub app_handle: tauri::AppHandle,
}

impl SharedState {
    pub fn new(app_handle: tauri::AppHandle, app_data_dir: PathBuf, default_download_dir: PathBuf) -> Self {
        let config_path = app_data_dir.join("config.json");
        
        // Ensure config directory exists
        if let Some(parent) = config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Try to load existing configuration
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(config_data) = serde_json::from_str::<ConfigData>(&content) {
                    return Self {
                        peers: Mutex::new(config_data.peers),
                        settings: Mutex::new(config_data.settings),
                        active_transfers: Mutex::new(HashMap::new()),
                        config_path,
                        app_handle,
                    };
                }
            }
        }

        // Default settings if none exist
        let default_device_name = hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "Unknown Device".to_string());

        let default_settings = AppSettings {
            device_name: default_device_name,
            download_dir: default_download_dir.to_string_lossy().into_owned(),
            port: 50050,
            bind_ip: "0.0.0.0".to_string(),
        };

        let state = Self {
            peers: Mutex::new(Vec::new()),
            settings: Mutex::new(default_settings),
            active_transfers: Mutex::new(HashMap::new()),
            config_path,
            app_handle,
        };
        
        let _ = state.save_to_disk();
        state
    }

    pub fn save_to_disk(&self) -> Result<(), String> {
        let peers = self.peers.lock().map_err(|e| e.to_string())?.clone();
        let settings = self.settings.lock().map_err(|e| e.to_string())?.clone();
        
        let config_data = ConfigData { settings, peers };
        let serialized = serde_json::to_string_pretty(&config_data).map_err(|e| e.to_string())?;
        
        fs::write(&self.config_path, serialized).map_err(|e| e.to_string())?;
        Ok(())
    }
}
