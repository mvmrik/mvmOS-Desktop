import { invoke } from "@tauri-apps/api/core";
import type { Bounds, Installation, TabInfo, TabKind } from "./types";

export function getInstallations(): Promise<Installation[]> {
  return invoke("get_installations");
}

export function addInstallation(name: string, address: string): Promise<Installation> {
  return invoke("add_installation", { name, address });
}

export function removeInstallation(id: string): Promise<void> {
  return invoke("remove_installation", { id });
}

export function checkReachable(address: string): Promise<boolean> {
  return invoke("check_reachable", { address });
}

export function openTab(
  installationId: string,
  kind: TabKind,
  parentId: string | null,
  bounds: Bounds,
  url: string | null = null,
): Promise<TabInfo> {
  return invoke("open_tab", { installationId, kind, parentId, bounds, url });
}

export function activateTab(tabId: string, bounds: Bounds): Promise<void> {
  return invoke("activate_tab", { tabId, bounds });
}

export function syncLayout(sidebar: Bounds, content: Bounds, chromeFull: boolean): Promise<void> {
  return invoke("sync_layout", { sidebar, content, chromeFull });
}

export function closeTab(tabId: string): Promise<void> {
  return invoke("close_tab", { tabId });
}
