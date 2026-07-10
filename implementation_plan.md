# Portal: Step-by-Step Implementation Plan (Personal LAN Edition)

This revised plan is tailored for personal, local-only usage (no TLS/PIN security overhead).

---

## Phase 1: Environment Setup & Project Initialization (Completed)
* Installed Node.js & Rust.
* Scaffolded Tauri v2 + React + TypeScript.
* Configured Tailwind CSS v4 in `vite.config.ts` and `src/App.css`.

---

## Phase 2: Core Backend Engine (Completed)
* Setup async background HTTP server (Axum) on port `50050`.
* Configured REST API endpoints for handshakes, file transfers, and clipboard sync.
* Built chunked file streaming receiver and sender routines.
* Registered Tauri command bindings to expose functions to React.

---

## Phase 3: UI/UX Development (React & Tailwind)
* Implement a glassmorphic dark-mode dashboard.
* Create sidebar to list, add, remove, and ping peers.
* Set up real-time connection status indicators.
* Build file drag-and-drop zone using HTML5/Tauri File Drop API.
* Design a clipboard syncing card and history log.

---

## Phase 4: Clipboard Sync & OS Hooks
* Hook into system clipboard using Rust's `arboard` library.
* Listen for clipboard changes every 500ms and sync with target active peer.
* Trigger system OS notifications upon successful transfers.

---

## Phase 5: Testing & Production Build
* Run local instances to test transfers.
* Compile production builds (DMG/MSI).
