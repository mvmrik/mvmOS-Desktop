"use strict";

/* Runs inside the find bar: the bar only talks to the main process. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("find", {
  search: (text, forward, next) => ipcRenderer.send("find:search", { text, forward, next }),
  close: () => ipcRenderer.send("find:close"),
  onResult: (handler) => ipcRenderer.on("find:result", (_event, result) => handler(result)),
  onOpen: (handler) => ipcRenderer.on("find:open", () => handler()),
});
