"use strict";

/*
 * Runs inside the find bar: the bar only talks to the main process. Not
 * "find": window.find is a built-in of every page, contextBridge refuses to
 * replace it, and the bar's script then stops before it focuses or searches.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("findBar", {
  search: (text, forward, next) => ipcRenderer.send("find:search", { text, forward, next }),
  close: () => ipcRenderer.send("find:close"),
  onResult: (handler) => ipcRenderer.on("find:result", (_event, result) => handler(result)),
  onOpen: (handler) => ipcRenderer.on("find:open", () => handler()),
});
