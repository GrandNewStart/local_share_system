# 🔗 Portal

**Portal** is a high-performance, lightweight, and gorgeous P2P desktop application designed for sharing files and clipboard contents between your computers on the local network. It is built using **Tauri v2** (Rust backend) and **React + TypeScript + Tailwind CSS v4** (frontend).

Because it is designed for personal, local network transfers:
* **Direct Connections**: All data streams locally and securely between your machines over plain TCP/HTTP.
* **Lightweight**: Uses native OS webviews to render the interface, keeping RAM consumption under 50MB and download size under 15MB.
* **Instant Transfers**: Simply drag-and-drop a file or click one button to copy your clipboard contents directly to another machine.

---

## 🛠️ Prerequisites

Before setting up Portal, ensure you have the following installed on your computers:

1. **Node.js** (v18 or higher) - [Download Node.js](https://nodejs.org/)
2. **Rust & Cargo** (v1.75 or higher) - Install via:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

---

## 🚀 Quick Start Guide

Follow these simple steps on each of the computers you want to connect:

### 1. Clone & Set Up dependencies
Clone the repository, enter the directory, and install the package dependencies:
```bash
npm install
```

### 2. Run in Development Mode
Launch the application locally. This will compile the Rust backend, run the Vite asset bundler, and open a native desktop application window:
```bash
npm run tauri dev
```

### 3. Build the Release Installer (Production)
To compile a optimized standalone executable installer (e.g. `.dmg` or `.app` for macOS, `.msi` or `.exe` for Windows):
```bash
npm run tauri build
```
The output installer packages will be available in `src-tauri/target/release/bundle/`.

---

## 📖 How to Use Portal

1. **Open the App on Both Computers**: Start Portal on both systems.
2. **Find Your Local IP**: Note your computer's local network IP address, displayed in the top-right corner of the window (e.g., `192.168.1.150`).
3. **Register the Peer**:
   * On Computer A, click the `+` button in the **Network Devices** sidebar.
   * Input the IP address of Computer B and give it a nickname.
   * Click **Save**.
4. **Test the Connection**:
   * Click the **Connect** button on the registered device card.
   * Portal will ping the other system. If Computer B is running the app, its status indicator will pulse **green (Active)**.
5. **Start Sharing**:
   * Select the active peer in the sidebar.
   * **Files**: Drag any file from your computer and drop it directly onto the **Share File** dashed area. Portal will stream it chunk-by-chunk with a live progress bar.
   * **Clipboard**: Copy any text or link on Computer A, and click **Send Local Clipboard**. The text will instantly be written to Computer B's system clipboard (ready to paste with `Cmd+V` or `Ctrl+V`).

---

## 📂 File Locations

* **Received Files**: By default, incoming files are saved in your system's standard **Downloads** folder (e.g., `~/Downloads` on macOS).
* **App Configurations**: Device registration, settings, and histories are saved locally in the standard application data folder:
  * **macOS**: `~/Library/Application Support/tauri-app/config.json`
  * **Windows**: `%APPDATA%\tauri-app\config.json`
  * **Linux**: `~/.config/tauri-app/config.json`

---

## 🐧 Building for Linux (Ubuntu)

To compile Portal on an Ubuntu or Debian system, follow these steps:

### 1. Install System Toolchain & Library Dependencies
Tauri requires GTK and WebKit libraries to compile on Linux. Install them using `apt`:
```bash
sudo apt update
sudo apt install -y libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

### 2. Install Rust and Node.js
If they are not already installed on your Ubuntu machine:
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Build the Executables
Run the following commands in the project root:
```bash
npm install
npm run tauri build
```

Tauri will compile and bundle the app into two formats inside `src-tauri/target/release/bundle/`:
* **`.deb` package** (in `deb/portal_*.deb`): Standard Debian/Ubuntu installer. Install it with `sudo dpkg -i <filename>.deb`.
* **`AppImage`** (in `appimage/portal_*.AppImage`): Portable executable. Run `chmod +x <filename>.AppImage` and run it directly on any Linux distribution!

