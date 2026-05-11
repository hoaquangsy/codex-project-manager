const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");

const isDev = !app.isPackaged;
const running = new Map();
const portRuntime = new Map();
const logBuffers = new Map();
const DETECTION_VERSION = 5;
const PORTABLE_PROJECT_NAMES = [
  "9router",
  "n8n-local",
  "VieNeu-TTS",
  "workflow-fit-local",
  "XemVideoTikTok",
  "AIImageUpscaler"
];
let mainWindow;
let configPath;
let config = { projects: [] };
let portScanTimer;

function appLog(message) {
  try {
    const target = path.join(app.getPath("userData"), "manager.log");
    fssync.appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging must never block app startup.
  }
}

function processKey(projectId, processId) {
  return `${projectId}:${processId}`;
}

function makeId(input) {
  const base = String(input || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || crypto.randomUUID().slice(0, 8);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadConfig() {
  configPath = path.join(app.getPath("userData"), "projects.json");
  config = await readJson(configPath, { projects: [] });
  if (!Array.isArray(config.projects)) config.projects = [];
}

async function saveConfig() {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function getProject(projectId) {
  return config.projects.find((project) => project.id === projectId);
}

function getProcess(project, processId) {
  return project?.processes?.find((item) => item.id === processId);
}

function getRuntimeState() {
  const byKey = {};
  for (const [key, value] of portRuntime.entries()) {
    if (running.has(key)) continue;
    byKey[key] = {
      pid: value.pid,
      startedAt: null,
      status: "external",
      detectedUrl: value.detectedUrl,
      lastLog: value.lastLog,
      lastError: ""
    };
  }
  for (const [key, value] of running.entries()) {
    byKey[key] = {
      pid: value.child.pid,
      startedAt: value.startedAt,
      status: value.status,
      detectedUrl: value.detectedUrl,
      lastLog: value.lastLog,
      lastError: value.lastError
    };
  }
  return { projects: config.projects, running: byKey };
}

function extractPortFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "http:") return 80;
    if (parsed.protocol === "https:") return 443;
  } catch {
    const match = String(url).match(/:(\d{2,5})(?:\/|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function configuredPort(proc) {
  return Number(proc?.port) || extractPortFromUrl(proc?.url);
}

function parseNetstatListeningPorts(output) {
  const ports = new Map();
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("TCP") || !/\bLISTENING\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddress = parts[1];
    const pid = Number(parts[4]);
    const portMatch = localAddress.match(/:(\d+)$/);
    const port = portMatch ? Number(portMatch[1]) : null;
    if (port && pid) ports.set(port, pid);
  }
  return ports;
}

function readListeningPorts() {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true }, (error, stdout) => {
      if (error) {
        appLog(`port scan failed: ${error.message}`);
        resolve(new Map());
        return;
      }
      resolve(parseNetstatListeningPorts(stdout));
    });
  });
}

async function refreshExternalRuntime() {
  const listening = await readListeningPorts();
  const next = new Map();

  for (const project of config.projects || []) {
    for (const proc of project.processes || []) {
      const port = configuredPort(proc);
      if (!port || !listening.has(port)) continue;
      const key = processKey(project.id, proc.id);
      if (running.has(key)) continue;
      next.set(key, {
        pid: listening.get(port),
        status: "external",
        detectedUrl: proc.url || `http://localhost:${port}`,
        lastLog: `Detected external listener on port ${port}`,
        port
      });
    }
  }

  const before = JSON.stringify([...portRuntime.entries()]);
  const after = JSON.stringify([...next.entries()]);
  portRuntime.clear();
  for (const [key, value] of next.entries()) portRuntime.set(key, value);
  if (before !== after) {
    appLog(`external runtime detected: ${next.size} process(es)`);
    sendState();
  }
}

function startExternalRuntimePolling() {
  if (portScanTimer) clearInterval(portScanTimer);
  refreshExternalRuntime().catch((error) => appLog(`external runtime refresh failed: ${error?.message || error}`));
  portScanTimer = setInterval(() => {
    refreshExternalRuntime().catch((error) => appLog(`external runtime refresh failed: ${error?.message || error}`));
  }, 3000);
}

function sendState() {
  mainWindow?.webContents.send("state:changed", getRuntimeState());
}

function pushLog(projectId, processId, stream, text) {
  const key = processKey(projectId, processId);
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!logBuffers.has(key)) logBuffers.set(key, []);
  const buffer = logBuffers.get(key);
  const procState = running.get(key);

  for (const line of lines) {
    const entry = {
      projectId,
      processId,
      stream,
      line,
      timestamp: new Date().toISOString()
    };
    buffer.push(entry);
    while (buffer.length > 2000) buffer.shift();
    if (procState) {
      procState.lastLog = line;
      if (stream === "stderr" || /error|failed|exception|traceback/i.test(line)) {
        procState.lastError = line;
      }
      const url = findUrl(line);
      if (url && !procState.detectedUrl) procState.detectedUrl = url;
    }
    mainWindow?.webContents.send("process:log", entry);
  }
  sendState();
}

function findUrl(line) {
  const urlMatch = String(line).match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\])(?::\d+)?[^\s)]*/i);
  if (urlMatch) return urlMatch[0].replace("0.0.0.0", "localhost");
  const portMatch = String(line).match(/(?:listening|ready|local|port).*?(\d{4,5})/i);
  if (portMatch) return `http://localhost:${portMatch[1]}`;
  return "";
}

async function parseEnvPort(folder) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(folder, name);
    if (!(await exists(file))) continue;
    const body = await fs.readFile(file, "utf8");
    const match = body.match(/^\s*PORT\s*=\s*([0-9]{2,5})\s*$/m);
    if (match) return Number(match[1]);
  }
  return null;
}

function shouldSkipScanDir(dirName) {
  const name = dirName.toLowerCase();
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "build" ||
    name === "docs" ||
    name === "cloud" ||
    name === "examples" ||
    name === "test" ||
    name === "tests" ||
    name === "pydeps" ||
    name === "__pycache__" ||
    name === ".venv" ||
    name === "venv" ||
    name.endsWith("-venv") ||
    name === "site-packages"
  );
}

async function collectCandidateDirs(root, maxDepth = 3) {
  const candidates = [];
  const seen = new Set();
  const markers = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "server.py",
    "server.js",
    "app.py",
    "main.py",
    "manage.py",
    "run_voice_clone_ui.bat",
    "run_voice_clone_api.bat",
    "run_voice_clone.bat",
    "run_project.bat",
    "start-n8n-local.ps1",
    "start-9router-hidden.ps1",
    "start.ps1"
  ];

  async function walk(folder, depth) {
    const normalized = path.normalize(folder).toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);

    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map((entry) => entry.name));
    if (markers.some((marker) => names.has(marker))) candidates.push(folder);
    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipScanDir(entry.name)) continue;
      await walk(path.join(folder, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return candidates;
}

async function readTextHead(filePath, maxBytes = 120000) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const result = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function detectPortFromFiles(folder) {
  const envPort = await parseEnvPort(folder);
  if (envPort) return envPort;

  const files = ["server.py", "app.py", "main.py", "manage.py", "server.js"];
  for (const fileName of files) {
    const filePath = path.join(folder, fileName);
    if (!(await exists(filePath))) continue;
    const body = await readTextHead(filePath);
    const patterns = [
      /PORT\s*=\s*(?:int\([^)]*["'](\d{2,5})["'][^)]*\)|["']?(\d{2,5})["']?)/i,
      /port\s*=\s*(?:int\([^)]*["'](\d{2,5})["'][^)]*\)|["']?(\d{2,5})["']?)/i,
      /ThreadingHTTPServer\(\([^)]*,\s*(\d{2,5})\)/i,
      /localhost:(\d{2,5})/i,
      /127\.0\.0\.1:(\d{2,5})/i,
      /listen_port\s*=\s*[^0-9]*(\d{2,5})/i,
      /PORT\s*\|\|\s*(\d{2,5})/i,
      /port\s*=\s*Number\([^)]*(\d{2,5})/i
    ];
    for (const pattern of patterns) {
      const match = body.match(pattern);
      const port = match && Number(match.slice(1).find(Boolean));
      if (port) return port;
    }
  }

  const scriptFiles = ["start-n8n-local.ps1", "start-9router-hidden.ps1", "start.ps1", "run_voice_clone_ui.bat", "run_voice_clone_api.bat"];
  for (const fileName of scriptFiles) {
    const filePath = path.join(folder, fileName);
    if (!(await exists(filePath))) continue;
    const body = await readTextHead(filePath);
    const match = body.match(/(?:PORT|N8N_PORT)\s*=\s*['"]?(\d{2,5})/i) || body.match(/localhost:(\d{2,5})/i) || body.match(/127\.0\.0\.1:(\d{2,5})/i);
    if (match) return Number(match[1]);
  }

  if (await exists(path.join(folder, "run_voice_clone_ui.bat"))) return 7861;
  if (await exists(path.join(folder, "run_voice_clone_api.bat"))) return 8002;

  const configFiles = [
    path.join(folder, "app", "config", "config.py"),
    path.join(folder, "config.py"),
    path.join(folder, "settings.py")
  ];
  for (const filePath of configFiles) {
    if (!(await exists(filePath))) continue;
    const body = await readTextHead(filePath);
    const match = body.match(/listen_port\s*=\s*[^0-9]*(\d{2,5})/i) || body.match(/PORT\s*=\s*[^0-9]*(\d{2,5})/i);
    if (match) return Number(match[1]);
  }

  return null;
}

async function contextRelatedPaths(folderPath) {
  const contextFile = path.join(folderPath, "CODEX_RESTORED_CONTEXT.md");
  if (!(await exists(contextFile))) return [];
  const body = await fs.readFile(contextFile, "utf8").catch(() => "");
  const matches = [...body.matchAll(/`([A-Z]:\\[^`]+)`/g)].map((match) => match[1]);
  const seen = new Set();
  const related = [];
  for (const item of matches) {
    const normalized = path.normalize(item).toLowerCase();
    if (seen.has(normalized) || normalized.includes(`${path.sep}.codex${path.sep}`.toLowerCase()) || !fssync.existsSync(item)) continue;
    seen.add(normalized);
    const candidates = await collectCandidateDirs(item, 1);
    if (candidates.length > 0) related.push(item);
  }
  return related;
}

function pythonCommandFor(folder) {
  const localPython = path.join(folder, "venv", "Scripts", "python.exe");
  if (fssync.existsSync(localPython)) return localPython;
  const parentPython = path.join(path.dirname(folder), "venv", "Scripts", "python.exe");
  if (fssync.existsSync(parentPython)) return parentPython;
  return "python";
}

function uniqueProcessId(project, base) {
  const taken = new Set(project.processes.map((proc) => proc.id));
  let id = makeId(base);
  let index = 2;
  while (taken.has(id)) id = `${makeId(base)}-${index++}`;
  return id;
}

function addScriptProcess(project, folderPath, scriptName, port, enabled = true) {
  const isPowerShell = scriptName.toLowerCase().endsWith(".ps1");
  const explicitNames = {
    "start-9router-hidden.ps1": "9router",
    "start-n8n-local.ps1": "n8n local",
    "run_voice_clone_ui.bat": "voice clone ui",
    "run_voice_clone_api.bat": "voice clone api"
  };
  const name = explicitNames[scriptName.toLowerCase()] || path.basename(scriptName, path.extname(scriptName)).replace(/^run[_-]/i, "").replace(/[_-]/g, " ");
  project.processes.push({
    id: uniqueProcessId(project, name),
    name,
    cwd: folderPath,
    command: isPowerShell ? "powershell" : "cmd",
    args: isPowerShell ? ["-ExecutionPolicy", "Bypass", "-File", scriptName] : ["/c", scriptName],
    env: {},
    url: port ? `http://localhost:${port}` : "",
    port: port || null,
    enabled
  });
}

async function addDetectedProcesses(project, folderPath) {
  const packagePath = path.join(folderPath, "package.json");
  const hasPackage = await exists(packagePath);
  const hasPnpm = await exists(path.join(folderPath, "pnpm-lock.yaml"));
  const hasYarn = await exists(path.join(folderPath, "yarn.lock"));
  const npmCommand = hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
  const fileNames = await fs.readdir(folderPath).catch(() => []);
  const hasVite = fileNames.some((name) => /^vite\.config\./.test(name));
  const hasNext = fileNames.some((name) => /^next\.config\./.test(name));
  const port = (await detectPortFromFiles(folderPath)) || (hasVite ? 5173 : hasNext ? 3000 : null);
  const url = port ? `http://localhost:${port}` : "";
  const relative = path.relative(project.path, folderPath);
  const labelPrefix = relative && relative !== "." ? path.basename(folderPath) : "";

  const preferredScripts = [];
  if (fssync.existsSync(path.join(folderPath, "run_voice_clone_ui.bat"))) preferredScripts.push("run_voice_clone_ui.bat");
  if (fssync.existsSync(path.join(folderPath, "run_voice_clone_api.bat"))) preferredScripts.push("run_voice_clone_api.bat");
  if (preferredScripts.length === 0 && fssync.existsSync(path.join(folderPath, "run_voice_clone.bat"))) preferredScripts.push("run_voice_clone.bat");
  if (fssync.existsSync(path.join(folderPath, "start-n8n-local.ps1"))) preferredScripts.push("start-n8n-local.ps1");
  if (fssync.existsSync(path.join(folderPath, "start-9router-hidden.ps1"))) preferredScripts.push("start-9router-hidden.ps1");
  if (preferredScripts.length === 0 && fssync.existsSync(path.join(folderPath, "start.ps1"))) preferredScripts.push("start.ps1");

  for (const scriptName of preferredScripts) {
    if (!fssync.existsSync(path.join(folderPath, scriptName))) continue;
    const scriptPort = scriptName === "run_voice_clone_ui.bat" ? 7861 : scriptName === "run_voice_clone_api.bat" ? 8002 : port;
    addScriptProcess(project, folderPath, scriptName, scriptPort, true);
  }

  if (hasPackage && preferredScripts.length === 0) {
    const pkg = await readJson(packagePath, {});
    const scripts = pkg.scripts || {};
    const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : "";
    if (scriptName) {
      const processName = labelPrefix || (scriptName === "dev" ? "frontend" : "app");
      project.processes.push({
        id: uniqueProcessId(project, processName),
        name: processName,
        cwd: folderPath,
        command: npmCommand,
        args: npmCommand === "npm" ? ["run", scriptName] : [scriptName],
        env: {},
        url,
        port,
        enabled: true
      });
    }
  }

  const composeFile = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
    .map((name) => path.join(folderPath, name))
    .find((file) => fssync.existsSync(file));
  if (composeFile) {
    project.processes.push({
      id: uniqueProcessId(project, labelPrefix || "compose"),
      name: labelPrefix ? `${labelPrefix} compose` : "docker compose",
      cwd: folderPath,
      command: "docker",
      args: ["compose", "up"],
      env: {},
      url,
      port,
      enabled: project.processes.length === 0
    });
  }

  const nodeEntry = ["server.js"].find((name) => fssync.existsSync(path.join(folderPath, name)));
  if (preferredScripts.length === 0 && !hasPackage && nodeEntry) {
    const nodePort = port || 3000;
    project.processes.push({
      id: uniqueProcessId(project, labelPrefix || path.basename(nodeEntry, ".js")),
      name: labelPrefix || path.basename(nodeEntry, ".js"),
      cwd: folderPath,
      command: "node",
      args: [nodeEntry],
      env: {},
      url: `http://localhost:${nodePort}`,
      port: nodePort,
      enabled: true
    });
  }

  const pythonEntry = ["server.py", "app.py", "main.py", "manage.py"].find((name) => fssync.existsSync(path.join(folderPath, name)));
  if (preferredScripts.length === 0 && pythonEntry) {
    const pythonPort = port || 8000;
    project.processes.push({
      id: uniqueProcessId(project, labelPrefix || path.basename(pythonEntry, ".py")),
      name: labelPrefix || path.basename(pythonEntry, ".py"),
      cwd: folderPath,
      command: pythonCommandFor(folderPath),
      args: [pythonEntry],
      env: {},
      url: `http://localhost:${pythonPort}`,
      port: pythonPort,
      enabled: true
    });
  }
}

async function detectProject(folderPath, options = {}) {
  const includeRelated = options.includeRelated !== false;
  const maxDepth = options.maxDepth ?? 3;
  const folderName = path.basename(folderPath);
  const project = {
    id: makeId(folderName),
    name: folderName,
    path: folderPath,
    autoDetected: true,
    detectionVersion: DETECTION_VERSION,
    processes: []
  };

  const relatedPaths = includeRelated ? await contextRelatedPaths(folderPath) : [];
  if (relatedPaths.length > 0) project.relatedPaths = relatedPaths;
  const scanRoots = [folderPath, ...relatedPaths];
  const scanned = new Set();
  for (const scanRoot of scanRoots) {
    const isRelatedRoot = path.normalize(scanRoot).toLowerCase() !== path.normalize(folderPath).toLowerCase();
    const candidateDirs = await collectCandidateDirs(scanRoot, isRelatedRoot ? 1 : maxDepth);
    for (const candidateDir of candidateDirs) {
      const normalized = path.normalize(candidateDir).toLowerCase();
      if (scanned.has(normalized)) continue;
      scanned.add(normalized);
      await addDetectedProcesses(project, candidateDir);
    }
  }

  if (project.processes.length === 0) {
    project.processes.push({
      id: "process",
      name: "process",
      cwd: folderPath,
      command: "",
      args: [],
      env: {},
      url: "",
      port: null,
      enabled: false
    });
  }

  return project;
}

async function getCodexWorkspaceCandidates() {
  const codexStatePath = path.join(os.homedir(), ".codex", ".codex-global-state.json");
  const state = await readJson(codexStatePath, null);
  if (!state || typeof state !== "object") return [];

  const labels = state["electron-workspace-root-labels"] || {};
  const labelByNormalizedPath = new Map(
    Object.entries(labels).map(([root, label]) => [path.normalize(root).toLowerCase(), label])
  );
  const roots = [];
  const addRoot = (root) => {
    if (typeof root !== "string" || !root.trim()) return;
    roots.push(root);
  };

  for (const root of state["project-order"] || []) addRoot(root);
  for (const root of state["electron-saved-workspace-roots"] || []) addRoot(root);
  for (const root of state["active-workspace-roots"] || []) addRoot(root);
  for (const root of Object.values(state["thread-workspace-root-hints"] || {})) addRoot(root);

  const seen = new Set();
  return roots
    .filter((root) => {
      const normalized = path.normalize(root).toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return fssync.existsSync(root);
    })
    .map((root) => ({
      path: root,
      label: labels[root] || labelByNormalizedPath.get(path.normalize(root).toLowerCase()) || "",
      source: "codex"
    }));
}

function filesystemRoots() {
  const roots = [
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Desktop")
  ];
  for (let code = 68; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (fssync.existsSync(drive)) roots.push(drive);
  }
  const seen = new Set();
  return roots.filter((root) => {
    const normalized = path.normalize(root).toLowerCase();
    if (seen.has(normalized) || !fssync.existsSync(root)) return false;
    seen.add(normalized);
    return true;
  });
}

async function findPortableProjectCandidates() {
  const candidates = [];
  const seen = new Set();
  const names = new Set(PORTABLE_PROJECT_NAMES.map((name) => name.toLowerCase()));

  for (const root of filesystemRoots()) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!names.has(entry.name.toLowerCase())) continue;
      const folder = path.join(root, entry.name);
      const normalized = path.normalize(folder).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push({
        path: folder,
        label: entry.name,
        source: "portable"
      });
    }
  }

  return candidates;
}

function uniqueProjectId(project) {
  const taken = new Set(config.projects.map((item) => item.id));
  let id = project.id;
  let index = 2;
  while (taken.has(id)) id = `${project.id}-${index++}`;
  return id;
}

function hasOnlyPlaceholderProcesses(project) {
  const processes = project?.processes || [];
  if (processes.length === 0) return true;
  return processes.every((proc) => !proc.command && proc.id === "process");
}

function shouldRefreshAutoDetectedProject(project) {
  return Boolean(project?.autoDetected) && project.detectionVersion !== DETECTION_VERSION;
}

function projectSearchNames(projectPath, explicitLabel) {
  const names = new Set();
  if (explicitLabel) names.add(explicitLabel.toLowerCase());
  if (projectPath) names.add(path.basename(projectPath).toLowerCase());
  return names;
}

function setsOverlap(left, right) {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
}

function mergeEnvironment(env) {
  if (!env || typeof env !== "object") return process.env;
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key && value !== undefined && value !== null) clean[key] = String(value);
  }
  return { ...process.env, ...clean };
}

async function startProcess(projectId, processId) {
  const project = getProject(projectId);
  const proc = getProcess(project, processId);
  if (!project || !proc) throw new Error("Process not found.");
  if (!proc.command) throw new Error("Process command is empty.");
  const key = processKey(projectId, processId);
  if (running.has(key)) return getRuntimeState();

  const child = spawn(proc.command, proc.args || [], {
    cwd: proc.cwd || project.path,
    env: mergeEnvironment(proc.env),
    shell: true,
    windowsHide: true
  });

  running.set(key, {
    child,
    startedAt: Date.now(),
    status: "running",
    detectedUrl: "",
    lastLog: "",
    lastError: ""
  });

  pushLog(projectId, processId, "system", `Started ${proc.command} ${(proc.args || []).join(" ")} (PID ${child.pid})`);
  child.stdout?.on("data", (chunk) => pushLog(projectId, processId, "stdout", chunk.toString()));
  child.stderr?.on("data", (chunk) => pushLog(projectId, processId, "stderr", chunk.toString()));
  child.on("error", (error) => pushLog(projectId, processId, "stderr", error.message));
  child.on("exit", (code, signal) => {
    running.delete(key);
    pushLog(projectId, processId, "system", `Stopped with code ${code ?? "null"} signal ${signal ?? "null"}`);
    sendState();
  });
  sendState();
  return getRuntimeState();
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function stopProcess(projectId, processId) {
  const key = processKey(projectId, processId);
  const state = running.get(key);
  if (!state) return getRuntimeState();
  pushLog(projectId, processId, "system", `Stopping PID ${state.child.pid}`);
  await killProcessTree(state.child.pid);
  running.delete(key);
  sendState();
  return getRuntimeState();
}

async function startProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found.");
  for (const proc of project.processes || []) {
    if (proc.enabled) await startProcess(projectId, proc.id);
  }
  return getRuntimeState();
}

async function stopProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found.");
  for (const proc of project.processes || []) {
    await stopProcess(projectId, proc.id);
  }
  return getRuntimeState();
}

async function autoScanProjects() {
  appLog("auto scan started");
  const codexCandidates = await getCodexWorkspaceCandidates();
  const portableCandidates = await findPortableProjectCandidates();
  appLog(`codex candidates: ${codexCandidates.length}`);
  const roots = [
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Desktop")
  ].filter((root) => fssync.existsSync(root));
  const candidates = [...codexCandidates];
  const markers = ["package.json", "pyproject.toml", "requirements.txt", "docker-compose.yml", "compose.yml"];
  const candidateKeys = new Set(candidates.map((item) => path.normalize(item.path).toLowerCase()));

  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(root, entry.name);
      const hasMarker = markers.some((marker) => fssync.existsSync(path.join(folder, marker)));
      const normalized = path.normalize(folder).toLowerCase();
      if (hasMarker && !candidateKeys.has(normalized)) {
        candidates.push({ path: folder, label: "", source: "scan" });
        candidateKeys.add(normalized);
      }
    }
  }

  for (const candidate of codexCandidates) {
    const relatedPaths = await contextRelatedPaths(candidate.path);
    for (const relatedPath of relatedPaths) {
      const normalized = path.normalize(relatedPath).toLowerCase();
      if (candidateKeys.has(normalized)) continue;
      candidates.push({
        path: relatedPath,
        label: path.basename(relatedPath),
        source: "related"
      });
      candidateKeys.add(normalized);
    }
  }

  for (const candidate of portableCandidates) {
    const normalized = path.normalize(candidate.path).toLowerCase();
    if (candidateKeys.has(normalized)) continue;
    candidates.push(candidate);
    candidateKeys.add(normalized);
  }

  let added = 0;
  let updated = 0;
  const knownPaths = new Set(config.projects.map((project) => path.normalize(project.path).toLowerCase()));
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate.path).toLowerCase();
    const names = projectSearchNames(candidate.path, candidate.label);
    const existing = config.projects.find((project) => {
      if (path.normalize(project.path).toLowerCase() === normalized) return true;
      if (!["portable", "related"].includes(candidate.source)) return false;
      return setsOverlap(projectSearchNames(project.path, project.name), names);
    });
    if (existing) {
      if (path.normalize(existing.path).toLowerCase() !== normalized && ["portable", "related"].includes(candidate.source)) {
        existing.path = candidate.path;
        updated += 1;
      }
      if (candidate.label && existing.name !== candidate.label) {
        existing.name = candidate.label;
        updated += 1;
      }
      if (candidate.source && existing.source !== candidate.source) {
        existing.source = candidate.source;
        updated += 1;
      }
      if (hasOnlyPlaceholderProcesses(existing) || shouldRefreshAutoDetectedProject(existing)) {
        const detected = await detectProject(candidate.path, {
          includeRelated: candidate.source !== "related",
          maxDepth: candidate.source === "related" ? 1 : 3
        });
        existing.processes = detected.processes;
        existing.relatedPaths = detected.relatedPaths;
        existing.detectionVersion = DETECTION_VERSION;
        updated += 1;
        appLog(`updated placeholder project: ${existing.name} -> ${existing.processes.length} process(es)`);
      }
      continue;
    }
    const project = await detectProject(candidate.path, {
      includeRelated: candidate.source !== "related",
      maxDepth: candidate.source === "related" ? 1 : 3
    });
    if (candidate.label) project.name = candidate.label;
    project.id = uniqueProjectId(project);
    project.source = candidate.source || "scan";
    config.projects.push(project);
    knownPaths.add(normalized);
    added += 1;
  }
  if (codexCandidates.length > 0) {
    const codexOrder = new Map(
      codexCandidates.map((candidate, index) => [path.normalize(candidate.path).toLowerCase(), index])
    );
    config.projects.sort((a, b) => {
      const aOrder = codexOrder.get(path.normalize(a.path).toLowerCase());
      const bOrder = codexOrder.get(path.normalize(b.path).toLowerCase());
      if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      return a.name.localeCompare(b.name);
    });
  }
  await saveConfig();
  appLog(`auto scan completed: added=${added}, updated=${updated}, projects=${config.projects.length}`);
  await refreshExternalRuntime();
  sendState();
  return { ...getRuntimeState(), added, updated };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  await loadConfig();
  createWindow();
  startExternalRuntimePolling();
  autoScanProjects().catch((error) => {
    appLog(`auto scan failed: ${error?.stack || error?.message || String(error)}`);
    mainWindow?.webContents.send("state:changed", getRuntimeState());
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", async () => {
  if (portScanTimer) clearInterval(portScanTimer);
  for (const [key, state] of running.entries()) {
    const [projectId, processId] = key.split(":");
    pushLog(projectId, processId, "system", `Stopping PID ${state.child.pid} before quit`);
    await killProcessTree(state.child.pid);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("projects:list", () => getRuntimeState());

ipcMain.handle("projects:add-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add project folder",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return getRuntimeState();
  const folder = result.filePaths[0];
  const known = config.projects.some((project) => path.normalize(project.path).toLowerCase() === path.normalize(folder).toLowerCase());
  if (!known) {
    const project = await detectProject(folder);
    project.id = uniqueProjectId(project);
    config.projects.push(project);
    await saveConfig();
  }
  sendState();
  return getRuntimeState();
});

ipcMain.handle("projects:auto-scan", autoScanProjects);

ipcMain.handle("projects:update", async (_event, project) => {
  const index = config.projects.findIndex((item) => item.id === project.id);
  if (index === -1) throw new Error("Project not found.");
  config.projects[index] = project;
  await saveConfig();
  await refreshExternalRuntime();
  sendState();
  return getRuntimeState();
});

ipcMain.handle("projects:remove", async (_event, projectId) => {
  await stopProject(projectId).catch(() => {});
  config.projects = config.projects.filter((project) => project.id !== projectId);
  await saveConfig();
  sendState();
  return getRuntimeState();
});

ipcMain.handle("project:start", (_event, projectId) => startProject(projectId));
ipcMain.handle("project:stop", (_event, projectId) => stopProject(projectId));
ipcMain.handle("project:restart", async (_event, projectId) => {
  await stopProject(projectId);
  return startProject(projectId);
});
ipcMain.handle("process:start", (_event, { projectId, processId }) => startProcess(projectId, processId));
ipcMain.handle("process:stop", (_event, { projectId, processId }) => stopProcess(projectId, processId));
ipcMain.handle("logs:get", (_event, { projectId, processId }) => logBuffers.get(processKey(projectId, processId)) || []);
ipcMain.handle("url:open", (_event, url) => {
  if (url) shell.openExternal(url);
});
