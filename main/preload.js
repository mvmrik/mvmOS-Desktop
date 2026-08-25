"use strict";

// The chrome renderer gets exactly these calls and nothing else - no Node, no
// direct ipcRenderer.

const { contextBridge, ipcRenderer } = require("electron");

const SIDEBAR_WIDTH = 260;

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("api", {
  sidebarWidth: SIDEBAR_WIDTH,

  listInstallations: () => ipcRenderer.invoke("installations:list"),
  addInstallation: (name, address) => ipcRenderer.invoke("installations:add", { name, address }),
  updateInstallation: (id, name, address) => ipcRenderer.invoke("installations:update", { id, name, address }),
  removeInstallation: (id) => ipcRenderer.invoke("installations:remove", id),
  reorderInstallations: (orderedIds) => ipcRenderer.invoke("installations:reorder", orderedIds),
  checkReachable: (address) => ipcRenderer.invoke("installations:reachable", address),

  openTab: (payload) => ipcRenderer.invoke("tabs:open", payload),
  activateTab: (tabId) => ipcRenderer.invoke("tabs:activate", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("tabs:close", tabId),

  setOverlay: (open) => ipcRenderer.invoke("chrome:overlay", open),
  setSidebarVisible: (visible) => ipcRenderer.invoke("chrome:sidebar", visible),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),

  onNewChildTab: (handler) => on("tab:new-child", handler),
  onTabTitle: (handler) => on("tab:title", handler),
  onTabFailed: (handler) => on("tab:failed", handler),
  onTabClosed: (handler) => on("tab:closed", handler),
  onSidebarChanged: (handler) => on("sidebar:changed", handler),
  onAddInstallationRequested: (handler) => on("menu:add-installation", handler),
});
