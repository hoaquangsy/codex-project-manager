import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Circle,
  ExternalLink,
  FolderPlus,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Square,
  Trash2
} from "lucide-react";

const api = window.projectManager;

function emptyState() {
  return { projects: [], running: {} };
}

function keyFor(projectId, processId) {
  return `${projectId}:${processId}`;
}

function splitArgs(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const matches = text.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

function joinArgs(args) {
  return Array.isArray(args) ? args.join(" ") : "";
}

function statusFor(project, running) {
  const processes = project?.processes || [];
  const enabled = processes.filter((item) => item.enabled);
  const active = processes.filter((item) => running[keyFor(project.id, item.id)]);
  if (active.length === 0) return { label: "Stopped", tone: "stopped" };
  if (enabled.length > 0 && active.length < enabled.length) return { label: "Partial", tone: "partial" };
  return { label: "Running", tone: "running" };
}

function formatUptime(startedAt) {
  if (!startedAt) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function createBlankProcess(project) {
  const index = (project.processes || []).length + 1;
  return {
    id: `process-${index}`,
    name: `process ${index}`,
    cwd: project.path,
    command: "",
    args: [],
    env: {},
    url: "",
    port: null,
    enabled: false
  };
}

function App() {
  const [state, setState] = useState(emptyState);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [selectedProcessId, setSelectedProcessId] = useState("");
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const projects = state.projects || [];
  const selectedProject = projects.find((project) => project.id === selectedId) || projects[0] || null;
  const selectedProcess = selectedProject?.processes?.find((item) => item.id === selectedProcessId) || selectedProject?.processes?.[0] || null;
  const selectedRuntime = selectedProject && selectedProcess ? state.running[keyFor(selectedProject.id, selectedProcess.id)] : null;

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(needle));
  }, [projects, query]);

  useEffect(() => {
    let mounted = true;
    api.listProjects().then((nextState) => {
      if (!mounted) return;
      setState(nextState);
      setSelectedId((current) => {
        if (nextState.projects?.some((project) => project.id === current)) return current;
        return nextState.projects?.[0]?.id || "";
      });
    });
    const offState = api.onStateChanged((nextState) => {
      setState(nextState);
      setSelectedId((current) => {
        if (nextState.projects?.some((project) => project.id === current)) return current;
        return nextState.projects?.[0]?.id || "";
      });
    });
    const offLog = api.onLog((entry) => {
      setLogs((current) => {
        if (entry.projectId !== selectedId || entry.processId !== selectedProcessId) return current;
        return [...current, entry].slice(-2000);
      });
    });
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      mounted = false;
      offState();
      offLog();
      window.clearInterval(interval);
    };
  }, [selectedId, selectedProcessId]);

  useEffect(() => {
    if (!selectedProject) return;
    setEditing(JSON.parse(JSON.stringify(selectedProject)));
    setSelectedProcessId((current) => {
      if (selectedProject.processes?.some((item) => item.id === current)) return current;
      return selectedProject.processes?.[0]?.id || "";
    });
  }, [selectedProject?.id, selectedProject?.detectionVersion]);

  useEffect(() => {
    if (!selectedProject || !selectedProcess) {
      setLogs([]);
      return;
    }
    api.getLogs(selectedProject.id, selectedProcess.id).then(setLogs);
  }, [selectedProject?.id, selectedProcess?.id]);

  async function runAction(label, action) {
    setBusy(label);
    setError("");
    try {
      const nextState = await action();
      if (nextState) setState(nextState);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  function updateEditingProcess(processId, patch) {
    setEditing((project) => ({
      ...project,
      processes: project.processes.map((proc) => (proc.id === processId ? { ...proc, ...patch } : proc))
    }));
  }

  function addProcess() {
    setEditing((project) => ({ ...project, processes: [...(project.processes || []), createBlankProcess(project)] }));
  }

  function removeProcess(processId) {
    setEditing((project) => ({ ...project, processes: project.processes.filter((proc) => proc.id !== processId) }));
  }

  function mainUrl(project) {
    const processes = project?.processes || [];
    const runtimeUrl = processes.map((proc) => state.running[keyFor(project.id, proc.id)]?.detectedUrl).find(Boolean);
    return runtimeUrl || processes.map((proc) => proc.url).find(Boolean) || "";
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={22} />
          <div>
            <h1>Project Manager</h1>
            <span>Codex dev servers</span>
          </div>
        </div>

        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" />
        </div>

        <div className="sidebar-actions">
          <button title="Add folder" onClick={() => runAction("add-folder", api.addFolder)}>
            <FolderPlus size={17} />
            Add
          </button>
          <button title="Auto scan" onClick={() => runAction("auto-scan", api.autoScan)}>
            <RefreshCw size={17} />
            Scan
          </button>
        </div>

        <div className="project-list">
          {filteredProjects.map((project) => {
            const status = statusFor(project, state.running);
            return (
              <button
                key={project.id}
                className={`project-item ${selectedProject?.id === project.id ? "active" : ""}`}
                onClick={() => setSelectedId(project.id)}
              >
                <span className={`dot ${status.tone}`} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
              </button>
            );
          })}
          {filteredProjects.length === 0 && <p className="empty">No projects yet. Add a folder or run scan.</p>}
        </div>
      </aside>

      <main className="workspace">
        {!selectedProject || !editing ? (
          <section className="empty-main">
            <FolderPlus size={42} />
            <h2>Add a project folder</h2>
            <p>Use Add or Scan to detect npm, Vite, Next, Docker Compose, and Python projects.</p>
          </section>
        ) : (
          <>
            <header className="topbar">
              <div>
                <div className="eyebrow">{selectedProject.path}</div>
                <h2>{selectedProject.name}</h2>
              </div>
              <div className="topbar-actions">
                <button title="Start project" onClick={() => runAction("start-project", () => api.startProject(selectedProject.id))}>
                  <Play size={17} />
                  Start
                </button>
                <button title="Stop project" onClick={() => runAction("stop-project", () => api.stopProject(selectedProject.id))}>
                  <Square size={17} />
                  Stop
                </button>
                <button title="Restart project" onClick={() => runAction("restart-project", () => api.restartProject(selectedProject.id))}>
                  <RotateCcw size={17} />
                  Restart
                </button>
              </div>
            </header>

            {error && <div className="error-banner">{error}</div>}

            <section className="status-grid">
              <Metric label="Status" value={statusFor(selectedProject, state.running).label} />
              <Metric label="Running" value={`${Object.keys(state.running).filter((key) => key.startsWith(`${selectedProject.id}:`)).length}/${selectedProject.processes.length}`} />
              <Metric label="Main URL" value={mainUrl(selectedProject) || "No URL detected"} />
              <Metric label="Busy" value={busy || "Ready"} />
            </section>

            <div className="content-grid">
              <section className="panel process-panel">
                <div className="panel-header">
                  <h3>Processes</h3>
                  <button className="icon-button" title="Add process" onClick={addProcess}>
                    <Plus size={17} />
                  </button>
                </div>

                <div className="process-list">
                  {editing.processes.map((proc) => {
                    const runtime = state.running[keyFor(editing.id, proc.id)];
                    return (
                      <button
                        key={proc.id}
                        className={`process-row ${selectedProcessId === proc.id ? "active" : ""}`}
                        onClick={() => setSelectedProcessId(proc.id)}
                      >
                        <Circle size={10} className={runtime ? "live" : "idle"} />
                        <span>
                          <strong>{proc.name}</strong>
                          <small>{proc.command || "No command"} {joinArgs(proc.args)}</small>
                        </span>
                        <em>{runtime ? `${runtime.status === "external" ? "External" : "PID"} ${runtime.pid}` : "Stopped"}</em>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="panel editor-panel">
                <div className="panel-header">
                  <h3>Process Editor</h3>
                  <div className="button-row">
                    <button title="Save project" onClick={() => runAction("save-project", () => api.updateProject(editing))}>
                      <Save size={16} />
                      Save
                    </button>
                    <button title="Remove project" className="danger" onClick={() => runAction("remove-project", () => api.removeProject(editing.id))}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <label>
                  Project name
                  <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
                </label>
                <label>
                  Project path
                  <input value={editing.path} onChange={(event) => setEditing({ ...editing, path: event.target.value })} />
                </label>

                {editing.processes
                  .filter((proc) => proc.id === selectedProcessId)
                  .map((proc) => {
                    const runtime = state.running[keyFor(editing.id, proc.id)];
                    return (
                      <div className="process-editor" key={proc.id}>
                        <div className="editor-actions">
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={Boolean(proc.enabled)}
                              onChange={(event) => updateEditingProcess(proc.id, { enabled: event.target.checked })}
                            />
                            Enabled
                          </label>
                          <button title="Start process" onClick={() => runAction("start-process", () => api.startProcess(editing.id, proc.id))}>
                            <Play size={16} />
                            Start
                          </button>
                          <button
                            title={runtime?.status === "external" ? "External process was not started by this app" : "Stop process"}
                            disabled={runtime?.status === "external"}
                            onClick={() => runAction("stop-process", () => api.stopProcess(editing.id, proc.id))}
                          >
                            <Square size={16} />
                            Stop
                          </button>
                          <button title="Remove process" className="danger" onClick={() => removeProcess(proc.id)}>
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <div className="form-grid">
                          <label>
                            Name
                            <input value={proc.name} onChange={(event) => updateEditingProcess(proc.id, { name: event.target.value })} />
                          </label>
                          <label>
                            ID
                            <input value={proc.id} onChange={(event) => updateEditingProcess(proc.id, { id: event.target.value })} />
                          </label>
                          <label>
                            Command
                            <input value={proc.command} onChange={(event) => updateEditingProcess(proc.id, { command: event.target.value })} />
                          </label>
                          <label>
                            Args
                            <input value={joinArgs(proc.args)} onChange={(event) => updateEditingProcess(proc.id, { args: splitArgs(event.target.value) })} />
                          </label>
                          <label className="wide">
                            CWD
                            <input value={proc.cwd} onChange={(event) => updateEditingProcess(proc.id, { cwd: event.target.value })} />
                          </label>
                          <label>
                            Port
                            <input
                              type="number"
                              value={proc.port || ""}
                              onChange={(event) => updateEditingProcess(proc.id, { port: event.target.value ? Number(event.target.value) : null })}
                            />
                          </label>
                          <label>
                            URL
                            <input value={proc.url || ""} onChange={(event) => updateEditingProcess(proc.id, { url: event.target.value })} />
                          </label>
                        </div>

                        <div className="runtime-strip">
                          <span>PID: {runtime?.pid || "-"}</span>
                          <span>{runtime?.status === "external" ? "Status: External" : `Uptime: ${formatUptime(runtime?.startedAt) || tick}`}</span>
                          <span>Detected: {runtime?.detectedUrl || proc.url || "No URL detected"}</span>
                        </div>
                      </div>
                    );
                  })}
              </section>

              <aside className="panel url-panel">
                <div className="panel-header">
                  <h3>Local URL</h3>
                  <button title="Open URL" disabled={!mainUrl(selectedProject)} onClick={() => api.openUrl(mainUrl(selectedProject))}>
                    <ExternalLink size={16} />
                    Open
                  </button>
                </div>
                <div className="url-display">{mainUrl(selectedProject) || "No URL detected"}</div>
                <div className="last-lines">
                  <h4>Last error</h4>
                  <p>{selectedRuntime?.lastError || "No errors captured."}</p>
                  <h4>Last log</h4>
                  <p>{selectedRuntime?.lastLog || "No log yet."}</p>
                </div>
              </aside>

              <section className="panel log-panel">
                <div className="panel-header">
                  <h3>Logs</h3>
                  <span>{selectedProcess?.name || "No process"}</span>
                </div>
                <div className="log-view">
                  {logs.length === 0 ? (
                    <p className="empty">No logs yet.</p>
                  ) : (
                    logs.map((entry, index) => (
                      <div key={`${entry.timestamp}-${index}`} className={`log-line ${entry.stream}`}>
                        <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                        <span>{entry.stream}</span>
                        <code>{entry.line}</code>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
