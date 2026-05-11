# Codex Project Manager

Desktop Windows app for managing Codex project folders and local dev-server processes.

## Run

```powershell
$env:npm_config_cache='D:\npm-cache'
npm install
npm run dev
```

The Vite renderer runs at `http://127.0.0.1:5173`; Electron opens the desktop UI from that local server.

## Current V1

- Add a project folder manually.
- Auto import Codex workspace roots from `%USERPROFILE%\.codex\.codex-global-state.json`.
- Auto find portable runtime folders on available drives, including `9router`, `n8n-local`, `VieNeu-TTS`, `workflow-fit-local`, `XemVideoTikTok`, and `AIImageUpscaler`.
- Auto scan common project folders under Documents and Desktop.
- Detect npm/pnpm/yarn, Vite, Next, Docker Compose, and Python project hints.
- Start, stop, and restart enabled processes.
- Kill only process trees started by this app.
- Show PID, uptime, detected URL, last log, last error, and realtime logs.
- Edit project/process name, path, cwd, command, args, URL, port, and enabled state.

## Moving To Another PC

Use the portable zip:

```text
release/Codex-Project-Manager-portable.zip
```

On the other PC, unzip it and run:

```text
Codex Project Manager.exe
```

For development from source, copy this app folder, then run:

```powershell
$env:npm_config_cache='D:\npm-cache'
npm install
npm run dev
```

On startup, the app reads Codex's local workspace state and also searches available drives for known runtime folders by name. If a runtime folder exists on a different drive or user path, Scan can relink it automatically.

## Build Portable Zip

```powershell
$env:npm_config_cache='D:\npm-cache'
$env:ELECTRON_BUILDER_CACHE='D:\electron-builder-cache'
npm install
npm run build
```

The unpacked app is in `release/win-unpacked`. Zip that folder to move it to another PC.
