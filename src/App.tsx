import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface Peer {
  id: string;
  name: string;
  ip: string;
  port: number;
  status: string; // "Active" | "Connecting" | "Offline"
}

interface Transfer {
  token: string;
  filename: string;
  size: number;
  progress: number;
  is_download: boolean;
  peer_name: string;
}

interface ProgressPayload {
  token: string;
  filename: string;
  progress: number;
  size: number;
  is_download: boolean;
  peer_name: string;
}

interface DragDropPayload {
  paths: string[];
}

function App() {
  const [localIp, setLocalIp] = useState<string>("127.0.0.1");
  const [deviceName, setDeviceName] = useState<string>("Local PC");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<Peer | null>(null);
  const selectedPeerRef = useRef<Peer | null>(null);

  useEffect(() => {
    selectedPeerRef.current = selectedPeer;
  }, [selectedPeer]);
  const [activeTransfers, setActiveTransfers] = useState<Record<string, Transfer>>({});
  const [clipboardHistory, setClipboardHistory] = useState<Array<{ text: string; time: string; from: string }>>([]);
  const [inputName, setInputName] = useState("");
  const [inputIp, setInputIp] = useState("");
  const [isAddingPeer, setIsAddingPeer] = useState(false);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsDeviceName, setSettingsDeviceName] = useState("");
  const [settingsDownloadDir, setSettingsDownloadDir] = useState("");
  const [settingsPort, setSettingsPort] = useState(50050);
  const [settingsBindIp, setSettingsBindIp] = useState("0.0.0.0");
  const [availableInterfaces, setAvailableInterfaces] = useState<Array<{ name: string; ip: string }>>([]);

  // Initialize and load state
  useEffect(() => {
    // 1. Get Local IP
    invoke<string>("get_local_ip")
      .then(setLocalIp)
      .catch((err) => console.error("Failed to get local IP:", err));

    // 2. Get Settings (Device Name)
    invoke<{ device_name: string }>("get_settings")
      .then((settings) => setDeviceName(settings.device_name))
      .catch((err) => console.error("Failed to get settings:", err));

    // 3. Load Peers list
    loadPeers();

    // 4. Setup Tauri Event Listeners (Once on mount)
    let active = true;
    const unlisteners: Array<() => void> = [];

    const register = async (eventName: string, handler: any) => {
      const unlisten = await listen(eventName, handler);
      if (!active) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    };

    register("refresh-peers", () => {
      loadPeers();
    });

    register("transfer-start", (event: any) => {
      const transfer = event.payload;
      setActiveTransfers((prev) => ({
        ...prev,
        [transfer.token]: transfer,
      }));
    });

    register("transfer-progress", (event: { payload: ProgressPayload }) => {
      const payload = event.payload;
      setActiveTransfers((prev) => {
        if (!prev[payload.token]) return prev;
        return {
          ...prev,
          [payload.token]: {
            ...prev[payload.token],
            progress: payload.progress,
          },
        };
      });
    });

    register("transfer-complete", (event: any) => {
      const token = event.payload;
      setActiveTransfers((prev) => {
        const updated = { ...prev };
        const completed = updated[token];
        if (completed) {
          showNotification(
            completed.is_download
              ? `Successfully received: ${completed.filename}`
              : `Successfully sent: ${completed.filename}`
          );
        }
        delete updated[token];
        return updated;
      });
    });

    register("clipboard-synced", (event: any) => {
      const fromPeer = event.payload;
      showNotification(`Clipboard synced from ${fromPeer}`);
      navigator.clipboard.readText().then((text) => {
        if (text) {
          setClipboardHistory((prev) => [
            {
              text: text.substring(0, 100),
              time: new Date().toLocaleTimeString(),
              from: fromPeer,
            },
            ...prev.slice(0, 19),
          ]);
        }
      }).catch(() => {});
    });

    register("tauri://drag-drop", (event: { payload: DragDropPayload }) => {
      setDragging(false);
      const currentPeer = selectedPeerRef.current;
      if (!currentPeer) {
        setErrorMsg("Please select a device in the sidebar first!");
        setTimeout(() => setErrorMsg(null), 4000);
        return;
      }
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        paths.forEach((path) => {
          sendPath(path);
        });
      }
    });

    register("tauri://drag-over", () => {
      setDragging(true);
    });

    register("tauri://drag-leave", () => {
      setDragging(false);
    });

    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  const loadPeers = () => {
    invoke<Peer[]>("get_peers")
      .then((loadedPeers) => {
        setPeers(loadedPeers);
        // Sync selected peer state if it still exists
        setSelectedPeer((current) => {
          if (!current) return null;
          const found = loadedPeers.find((p) => p.id === current.id);
          return found || null;
        });
      })
      .catch((err) => console.error("Failed to load peers:", err));
  };

  const showNotification = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => {
      setSuccessMsg((current) => (current === msg ? null : current));
    }, 4000);
  };

  const openSettings = () => {
    invoke<any>("get_settings")
      .then((settings) => {
        setSettingsDeviceName(settings.device_name);
        setSettingsDownloadDir(settings.download_dir);
        setSettingsPort(settings.port);
        setSettingsBindIp(settings.bind_ip);
        setIsSettingsOpen(true);
      })
      .catch((err) => console.error("Failed to load settings:", err));

    invoke<Array<{ name: string; ip: string }>>("get_network_interfaces")
      .then(setAvailableInterfaces)
      .catch((err) => console.error("Failed to load interfaces:", err));
  };

  const saveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const settings = {
      device_name: settingsDeviceName,
      download_dir: settingsDownloadDir,
      port: settingsPort,
      bind_ip: settingsBindIp,
    };

    invoke("update_settings", { settings })
      .then(() => {
        setDeviceName(settingsDeviceName);
        setIsSettingsOpen(false);
        showNotification("Settings saved successfully!");
        
        // Refresh local IP in case bind IP was updated
        invoke<string>("get_local_ip")
          .then(setLocalIp)
          .catch((err) => console.error("Failed to get local IP:", err));
      })
      .catch((err) => {
        setErrorMsg(`Failed to save settings: ${err}`);
        setTimeout(() => setErrorMsg(null), 4000);
      });
  };

  const addDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputName || !inputIp) return;

    invoke<Peer>("add_peer", { name: inputName, ip: inputIp })
      .then((peer) => {
        setInputName("");
        setInputIp("");
        setIsAddingPeer(false);
        setSelectedPeer(peer);
        showNotification(`Device "${peer.name}" registered successfully!`);
      })
      .catch((err) => {
        setErrorMsg(`Failed to add device: ${err}`);
        setTimeout(() => setErrorMsg(null), 4000);
      });
  };

  const deletePeer = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    invoke("remove_peer", { id })
      .then(() => {
        if (selectedPeer?.id === id) {
          setSelectedPeer(null);
        }
        showNotification("Device removed successfully.");
      })
      .catch((err) => console.error(err));
  };

  const pingPeer = (peer: Peer) => {
    setPingingId(peer.id);
    invoke<string>("test_connection", { peerIp: peer.ip, peerPort: peer.port })
      .then((confirmedName) => {
        setPingingId(null);
        showNotification(`Connected to ${confirmedName}!`);
      })
      .catch((err) => {
        setPingingId(null);
        setErrorMsg(`Failed to connect to ${peer.name}: ${err}`);
        setTimeout(() => setErrorMsg(null), 4000);
      });
  };

  const sendPath = (path: string) => {
    const currentPeer = selectedPeerRef.current;
    if (!currentPeer) return;

    invoke("send_file", {
      peerIp: currentPeer.ip,
      peerPort: currentPeer.port,
      filePath: path,
    }).catch((err) => {
      setErrorMsg(`Failed to send file: ${err}`);
      setTimeout(() => setErrorMsg(null), 5000);
    });
  };

  const sendClipboardData = () => {
    if (!selectedPeer) return;

    navigator.clipboard.readText().then((text) => {
      if (!text) {
        setErrorMsg("Clipboard is empty or contains non-text data.");
        setTimeout(() => setErrorMsg(null), 3000);
        return;
      }

      invoke("send_clipboard", {
        peerIp: selectedPeer.ip,
        peerPort: selectedPeer.port,
        content: text,
      })
        .then(() => {
          showNotification("Clipboard content sent successfully!");
        })
        .catch((err) => {
          setErrorMsg(`Failed to sync clipboard: ${err}`);
          setTimeout(() => setErrorMsg(null), 4000);
        });
    }).catch(() => {
      setErrorMsg("Failed to read system clipboard.");
      setTimeout(() => setErrorMsg(null), 3000);
    });
  };

  // Helper formatting utilities
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <div className="min-h-screen relative flex flex-col font-sans select-none text-gray-100 overflow-hidden bg-[#0F0C20]">
      {/* Background ambient glow shapes */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full glow-purple-blur z-0" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full glow-cyan-blur z-0" />

      {/* Top Header Navigation */}
      <header className="w-full flex items-center justify-between px-8 py-5 border-b border-white/5 glass-panel z-10">
        <div className="flex items-center gap-3">
          <svg className="w-8 h-8 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span className="text-xl font-extrabold tracking-wide uppercase gradient-text">Portal</span>
        </div>
        
        <div className="flex items-center gap-6 text-sm text-gray-400">
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
            <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
            <span>Device: <strong className="text-gray-200">{deviceName}</strong></span>
          </div>
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            <span>Local IP: <strong className="text-gray-200">{localIp}</strong></span>
          </div>
          <button 
            onClick={openSettings} 
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-gray-400 hover:text-white transition-all cursor-pointer"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Dynamic Alerts */}
      {errorMsg && (
        <div className="absolute top-24 left-1/2 transform -translate-x-1/2 z-50 bg-red-950/80 border border-red-500/50 text-red-200 px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 backdrop-blur-md animate-bounce">
          <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="absolute top-24 left-1/2 transform -translate-x-1/2 z-50 bg-cyan-950/80 border border-cyan-500/50 text-cyan-200 px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 backdrop-blur-md transition-all duration-300">
          <svg className="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Panel Layout */}
      <main className="flex-1 flex overflow-hidden z-10">
        
        {/* LEFT PANEL: Device Sidebar */}
        <section className="w-80 border-r border-white/5 bg-[#141029]/40 flex flex-col p-6 overflow-y-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold tracking-tight text-gray-200">Network Devices</h2>
            <button
              onClick={() => setIsAddingPeer(!isAddingPeer)}
              className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-cyan-400 border border-white/5 transition-all"
              title="Add Device"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {/* Expandable Add Device Form */}
          {isAddingPeer && (
            <form onSubmit={addDevice} className="glass-panel p-4 rounded-xl border border-white/10 mb-6 flex flex-col gap-3 animate-fadeIn">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Nickname</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. MacBook Pro"
                  value={inputName}
                  onChange={(e) => setInputName(e.target.value)}
                  className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">IP Address</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 192.168.1.150"
                  value={inputIp}
                  onChange={(e) => setInputIp(e.target.value)}
                  className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition"
                />
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setIsAddingPeer(false)}
                  className="flex-1 text-xs bg-white/5 border border-white/5 text-gray-300 py-1.5 rounded-lg hover:bg-white/10 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 text-xs gradient-btn text-white py-1.5 rounded-lg font-bold"
                >
                  Save
                </button>
              </div>
            </form>
          )}

          {/* Peers List */}
          <div className="flex-1 flex flex-col gap-3">
            {peers.length === 0 ? (
              <div className="text-center py-8 text-gray-500 text-sm">
                <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                No registered devices.<br/>Click the "+" button to add one.
              </div>
            ) : (
              peers.map((peer) => {
                const isSelected = selectedPeer?.id === peer.id;
                return (
                  <div
                    key={peer.id}
                    onClick={() => setSelectedPeer(peer)}
                    className={`glass-card p-4 rounded-xl cursor-pointer relative ${
                      isSelected ? "glass-card-active border-purple-500/50" : ""
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-gray-200 text-sm">{peer.name}</h3>
                      <div className="flex gap-1">
                        {/* Connection status indicator */}
                        <span className={`w-2 h-2 rounded-full mt-1.5 ${
                          peer.status === "Active" ? "bg-green-400 animate-pulse" :
                          peer.status === "Connecting" ? "bg-amber-400 animate-bounce" : "bg-gray-600"
                        }`} />
                      </div>
                    </div>
                    
                    <p className="text-xs text-gray-400 mb-3">{peer.ip}</p>
                    
                    <div className="flex items-center justify-between pt-2 border-t border-white/5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          pingPeer(peer);
                        }}
                        disabled={pingingId === peer.id}
                        className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 transition"
                      >
                        {pingingId === peer.id ? (
                          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        ) : "Connect"}
                      </button>
                      <button
                        onClick={(e) => deletePeer(e, peer.id)}
                        className="text-xs text-red-400/70 hover:text-red-400 transition"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* RIGHT PANEL: Workspace (Active Actions) */}
        <section className="flex-1 flex flex-col p-8 overflow-y-auto">
          {!selectedPeer ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center opacity-70">
              <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-6 shadow-inner animate-pulse">
                <svg className="w-12 h-12 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071a9 9 0 0114.14 0M1.414 6.586a14 14 0 0119.172 0" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-200 mb-2">No Active Peer Connection</h2>
              <p className="text-sm text-gray-400 max-w-sm">
                Select a registered device on the sidebar, or add a new IP, then click "Connect" to start sharing files and clipboards.
              </p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-8 animate-fadeIn">
              
              {/* Active Peer Card Info */}
              <div className="flex items-center justify-between bg-white/5 p-4 rounded-xl border border-white/5">
                <div>
                  <h2 className={`text-base font-bold flex items-center gap-2 ${
                    selectedPeer.status === "Active" ? "text-cyan-400" :
                    selectedPeer.status === "Connecting" ? "text-amber-400" : "text-gray-400"
                  }`}>
                    {selectedPeer.status === "Active" ? `Connected to ${selectedPeer.name}` :
                     selectedPeer.status === "Connecting" ? `Connecting to ${selectedPeer.name}...` :
                     `Disconnected from ${selectedPeer.name}`}
                    <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                      selectedPeer.status === "Active" ? "bg-green-400 animate-pulse" :
                      selectedPeer.status === "Connecting" ? "bg-amber-400 animate-bounce" : "bg-gray-600"
                    }`} />
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    {selectedPeer.status === "Active" ? `Ready for file drops and clipboard syncs over IP ${selectedPeer.ip}` :
                     selectedPeer.status === "Connecting" ? `Testing connection to IP ${selectedPeer.ip}` :
                     `Device is offline. Click 'Connect' in the sidebar to establish a connection.`}
                  </p>
                </div>
              </div>

              {/* Grid split: Files and Clipboard */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-1">
                
                {/* FILE TRANSFER PANEL */}
                <div className="flex flex-col gap-4 relative">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400">Share File</h3>
                  
                  {/* Drag and Drop Zone */}
                  <div
                    className={`flex-1 min-h-[220px] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-8 text-center transition-all ${
                      selectedPeer.status !== "Active" ? "opacity-30 select-none pointer-events-none" : ""
                    } ${
                      dragging
                        ? "border-cyan-400 bg-cyan-950/20 scale-[1.02]"
                        : "border-white/10 bg-[#16122F]/40 hover:border-cyan-400/50"
                    }`}
                  >
                    <svg className={`w-14 h-14 mb-4 transition-transform duration-300 ${dragging ? "scale-110 text-cyan-400" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <h4 className="font-bold text-gray-200 text-sm mb-1">Drag & Drop Files Here</h4>
                    <p className="text-xs text-gray-400 max-w-xs">
                      Drop any file from your computer directly into this window to transfer it immediately.
                    </p>
                  </div>

                  {selectedPeer.status !== "Active" && (
                    <div className="absolute inset-0 top-8 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-2xl p-4 z-20 border border-white/5">
                      <svg className="w-8 h-8 text-amber-500/80 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-xs font-bold text-gray-300">Device Not Connected</span>
                      <span className="text-[10px] text-gray-400 mt-1">Connect in sidebar to enable file drops</span>
                    </div>
                  )}

                  {/* Active Transfers List */}
                  {Object.keys(activeTransfers).length > 0 && (
                    <div className="glass-panel p-4 rounded-xl border border-white/5 flex flex-col gap-3">
                      <h4 className="text-xs font-bold text-gray-300 uppercase tracking-wider">Active Transfers</h4>
                      {Object.values(activeTransfers).map((transfer) => {
                        const percent = transfer.size > 0 ? Math.round((transfer.progress / transfer.size) * 100) : 0;
                        return (
                          <div key={transfer.token} className="text-xs">
                            <div className="flex justify-between mb-1">
                              <span className="font-semibold truncate max-w-[180px] text-gray-200">
                                {transfer.is_download ? "📥" : "📤"} {transfer.filename}
                              </span>
                              <span className="text-gray-400">
                                {formatBytes(transfer.progress)} / {formatBytes(transfer.size)} ({percent}%)
                              </span>
                            </div>
                            <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden border border-white/5">
                              <div
                                className="bg-gradient-to-r from-purple-500 to-cyan-400 h-full rounded-full transition-all duration-300"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* CLIPBOARD PANEL */}
                <div className="flex flex-col gap-4 relative">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400">Clipboard Sync</h3>

                  <div className={`glass-panel p-6 rounded-2xl border border-white/5 flex-1 flex flex-col justify-between min-h-[220px] transition-all ${
                    selectedPeer.status !== "Active" ? "opacity-30 select-none pointer-events-none" : ""
                  }`}>
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                      <svg className="w-12 h-12 text-purple-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                      </svg>
                      <h4 className="font-bold text-gray-200 text-sm mb-1">Clipboard Sharing</h4>
                      <p className="text-xs text-gray-400 max-w-xs mb-6">
                        Copy anything to your system clipboard (text, URL, etc.), then click the button below to paste it directly onto the target device.
                      </p>
                    </div>

                    <button
                      onClick={sendClipboardData}
                      className="w-full py-3 rounded-xl gradient-btn font-bold text-sm text-white flex items-center justify-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                      </svg>
                      Send Local Clipboard
                    </button>
                  </div>

                  {selectedPeer.status !== "Active" && (
                    <div className="absolute inset-0 top-8 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-2xl p-4 z-20 border border-white/5">
                      <svg className="w-8 h-8 text-amber-500/80 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-xs font-bold text-gray-300">Device Not Connected</span>
                      <span className="text-[10px] text-gray-400 mt-1">Connect in sidebar to enable clipboard sync</span>
                    </div>
                  )}

                  {/* Sync logs history */}
                  {clipboardHistory.length > 0 && (
                    <div className="glass-panel p-4 rounded-xl border border-white/5 flex flex-col gap-2 max-h-[180px] overflow-y-auto">
                      <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Recent Clipboard Logs</h4>
                      {clipboardHistory.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs py-1.5 border-b border-white/5 last:border-0">
                          <div className="truncate max-w-[200px]">
                            <span className="text-purple-400 font-semibold">[{item.from}]</span>{" "}
                            <span className="text-gray-300">{item.text}</span>
                          </div>
                          <span className="text-[10px] text-gray-500">{item.time}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

            </div>
          )}
        </section>

      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 animate-fadeIn">
          <form onSubmit={saveSettings} className="glass-panel w-[480px] p-8 rounded-2xl border border-white/10 flex flex-col gap-5">
            <h2 className="text-xl font-bold text-gray-200 flex items-center gap-2 border-b border-white/5 pb-4 mb-2">
              <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </h2>

            <div>
              <label className="text-xs text-gray-400 block mb-1">Device Nickname</label>
              <input
                type="text"
                required
                value={settingsDeviceName}
                onChange={(e) => setSettingsDeviceName(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 block mb-1">Save Directory</label>
              <input
                type="text"
                required
                value={settingsDownloadDir}
                onChange={(e) => setSettingsDownloadDir(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="text-xs text-gray-400 block mb-1">Network Interface</label>
                <select
                  value={settingsBindIp}
                  onChange={(e) => setSettingsBindIp(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition cursor-pointer appearance-none"
                  style={{ backgroundImage: 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%23a1a1aa\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'M6 8l4 4 4-4\'/%3E%3C/svg%3E")', backgroundPosition: 'right 0.5rem center', backgroundSize: '1.25em 1.25em', backgroundRepeat: 'no-repeat' }}
                >
                  {availableInterfaces.map((iface) => (
                    <option key={iface.ip} value={iface.ip} className="bg-[#141029]">
                      {iface.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-400 block mb-1">Port</label>
                <input
                  type="number"
                  required
                  min="1024"
                  max="65535"
                  value={settingsPort}
                  onChange={(e) => setSettingsPort(parseInt(e.target.value))}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 transition"
                />
              </div>
            </div>

            <p className="text-[10px] text-amber-400 leading-normal bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg flex gap-2 items-start mt-2">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Changes to the <strong>Network Interface</strong> or <strong>Port</strong> will take effect after restarting the application.</span>
            </p>

            <div className="flex gap-3 justify-end mt-4 border-t border-white/5 pt-4">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="px-5 py-2.5 text-sm bg-white/5 border border-white/5 text-gray-300 rounded-xl hover:bg-white/10 transition"
              >
                Close
              </button>
              <button
                type="submit"
                className="px-6 py-2.5 text-sm gradient-btn text-white rounded-xl font-bold"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
