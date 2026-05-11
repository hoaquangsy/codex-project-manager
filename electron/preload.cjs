const { contextBridge, ipcRenderer } = require("electron");

const api = {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  addFolder: () => ipcRenderer.invoke("projects:add-folder"),
  autoScan: () => ipcRenderer.invoke("projects:auto-scan"),
  updateProject: (project) => ipcRenderer.invoke("projects:update", project),
  removeProject: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
  startProject: (projectId) => ipcRenderer.invoke("project:start", projectId),
  stopProject: (projectId) => ipcRenderer.invoke("project:stop", projectId),
  restartProject: (projectId) => ipcRenderer.invoke("project:restart", projectId),
  startProcess: (projectId, processId) => ipcRenderer.invoke("process:start", { projectId, processId }),
  stopProcess: (projectId, processId) => ipcRenderer.invoke("process:stop", { projectId, processId }),
  getLogs: (projectId, processId) => ipcRenderer.invoke("logs:get", { projectId, processId }),
  openUrl: (url) => ipcRenderer.invoke("url:open", url),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("process:log", listener);
    return () => ipcRenderer.removeListener("process:log", listener);
  }
};

contextBridge.exposeInMainWorld("projectManager", api);
