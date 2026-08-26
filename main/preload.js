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
  platform: process.platform,

  listInstallations: () => ipcRenderer.invoke("installations:list"),
  addInstallation: (name, address, type) => ipcRenderer.invoke("installations:add", { name, address, type }),
  updateInstallation: (id, name, address, type) => ipcRenderer.invoke("installations:update", { id, name, address, type }),
  removeInstallation: (id) => ipcRenderer.invoke("installations:remove", id),
  reorderInstallations: (orderedIds) => ipcRenderer.invoke("installations:reorder", orderedIds),
  checkReachable: (address) => ipcRenderer.invoke("installations:reachable", address),

  openTab: (payload) => ipcRenderer.invoke("tabs:open", payload),
  activateTab: (tabId) => ipcRenderer.invoke("tabs:activate", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("tabs:close", tabId),
  reorderTabs: (orderedIds) => ipcRenderer.invoke("tabs:reorder", orderedIds),
  restoreSession: () => ipcRenderer.invoke("session:restore"),

  trayState: () => ipcRenderer.invoke("tray:state"),
  setTray: (showTray, closeToTray) => ipcRenderer.invoke("tray:set", { showTray, closeToTray }),

  lockState: () => ipcRenderer.invoke("lock:state"),
  unlock: (pin) => ipcRenderer.invoke("lock:unlock", pin),
  lockNow: () => ipcRenderer.invoke("lock:lock"),
  setPin: (currentPin, pin) => ipcRenderer.invoke("pin:set", { currentPin, pin }),
  clearPin: (currentPin) => ipcRenderer.invoke("pin:clear", currentPin),

  listExtensions: () => ipcRenderer.invoke("extensions:list"),
  addExtension: () => ipcRenderer.invoke("extensions:add"),
  addExtensionFolder: () => ipcRenderer.invoke("extensions:add-folder"),
  removeExtension: (dir) => ipcRenderer.invoke("extensions:remove", dir),

  extensionActions: () => ipcRenderer.invoke("extensions:actions"),
  openExtensionPopup: (id, anchor) => ipcRenderer.invoke("extensions:popup", { id, anchor }),
  closeExtensionPopup: () => ipcRenderer.invoke("extensions:popup-close"),
  extensionMenu: (id) => ipcRenderer.invoke("extensions:menu", id),

  setOverlay: (open) => ipcRenderer.invoke("chrome:overlay", open),
  setSidebarVisible: (visible) => ipcRenderer.invoke("chrome:sidebar", visible),
  setBadge: (count, overlay, trayIcon) => ipcRenderer.invoke("chrome:badge", { count, overlay, trayIcon }),
  appIcon: () => ipcRenderer.invoke("chrome:app-icon"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),

  onNewChildTab: (handler) => on("tab:new-child", handler),
  onTabTitle: (handler) => on("tab:title", handler),
  onTabIcon: (handler) => on("tab:icon", handler),
  onTabFailed: (handler) => on("tab:failed", handler),
  onTabClosed: (handler) => on("tab:closed", handler),
  onInstallationIcon: (handler) => on("installation:icon", handler),
  onInstallationAddress: (handler) => on("installation:address", handler),
  onSidebarChanged: (handler) => on("sidebar:changed", handler),
  onAddInstallationRequested: (handler) => on("menu:add-installation", handler),
  onSettingsRequested: (handler) => on("menu:settings", handler),
  onLockChanged: (handler) => on("lock:changed", handler),
  onExtensionActions: (handler) => on("extensions:actions", handler),
  onExtensionPopupClosed: (handler) => on("extensions:popup-closed", handler),
  onUpdateAvailable: (handler) => on("update:available", handler),
  onUpdateNone: (handler) => on("update:none", handler),
});
