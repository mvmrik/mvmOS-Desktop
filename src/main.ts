import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  activateTab,
  addInstallation,
  checkReachable,
  closeTab,
  getInstallations,
  openTab,
  removeInstallation,
  syncLayout,
} from "./api";
import type { Bounds, Installation, TabInfo, TabKind } from "./types";

const EMPTY_STATE_DEFAULT = "Select or open an installation from the sidebar.";

let installations: Installation[] = [];
let tabs: TabInfo[] = [];
let activeTabId: string | null = null;
let offlineRetryHandler: (() => void) | null = null;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

// The width the sidebar strip is asked for. The sidebar itself is `width: 100%`
// of the chrome webview, so this is the only place the number lives.
const SIDEBAR_WIDTH = 260;

// Bounds are computed from the OS window's own size rather than measured via
// getBoundingClientRect(): the chrome webview's own viewport IS just the
// sidebar strip, so measuring anything in it can never describe the tab area.
async function computeLayoutBounds(): Promise<{
  sidebar: Bounds;
  content: Bounds;
  chromeFull: boolean;
}> {
  const win = getCurrentWindow();
  const scaleFactor = await win.scaleFactor();
  const size = (await win.innerSize()).toLogical(scaleFactor);
  // While onboarding is up there are no tabs and the card is wider than the
  // strip, so the chrome takes the whole window instead.
  const chromeFull = $("shell").classList.contains("hidden");
  const sidebarWidth = chromeFull ? size.width : SIDEBAR_WIDTH;
  return {
    sidebar: { x: 0, y: 0, width: sidebarWidth, height: size.height },
    content: {
      x: sidebarWidth,
      y: 0,
      width: Math.max(size.width - sidebarWidth, 0),
      height: size.height,
    },
    chromeFull,
  };
}

async function getContentBounds(): Promise<Bounds> {
  return (await computeLayoutBounds()).content;
}

// Keeps the chrome (main) webview and the active tab's webview from overlapping.
async function syncChromeLayout() {
  const { sidebar, content, chromeFull } = await computeLayoutBounds();
  await syncLayout(sidebar, content, chromeFull);
}

let resizeScheduled = false;
function scheduleResize() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(async () => {
    resizeScheduled = false;
    await syncChromeLayout();
  });
}

function showEmptyState(message = EMPTY_STATE_DEFAULT) {
  $("offline-panel").classList.add("hidden");
  offlineRetryHandler = null;
  $("empty-state-text").textContent = message;
  $("empty-state").classList.remove("hidden");
}

function hideEmptyState() {
  $("empty-state").classList.add("hidden");
}

function showOfflinePanel(installation: Installation, retry: () => void) {
  hideEmptyState();
  $("offline-message").textContent = `Could not reach "${installation.name}" (${installation.address}). Make sure the server is running and reachable.`;
  $("offline-panel").classList.remove("hidden");
  offlineRetryHandler = retry;
}

function hideOfflinePanel() {
  $("offline-panel").classList.add("hidden");
  offlineRetryHandler = null;
}

function findTopLevelTab(installationId: string, kind: TabKind): TabInfo | undefined {
  return tabs.find((t) => t.installationId === installationId && t.kind === kind && !t.parentId);
}

function collectWithDescendants(tabId: string): Set<string> {
  const ids = new Set([tabId]);
  let added = true;
  while (added) {
    added = false;
    for (const t of tabs) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        added = true;
      }
    }
  }
  return ids;
}

async function switchToTab(tabId: string) {
  const bounds = await getContentBounds();
  await activateTab(tabId, bounds);
  activeTabId = tabId;
  hideEmptyState();
  hideOfflinePanel();
  renderSidebar();
}

async function requestOpenTab(
  installationId: string,
  kind: TabKind,
  parentId: string | null,
  url: string | null,
) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) return;

  hideOfflinePanel();
  showEmptyState("Connecting…");

  const reachable = await checkReachable(installation.address);
  if (!reachable) {
    showOfflinePanel(installation, () => requestOpenTab(installationId, kind, parentId, url));
    return;
  }

  const bounds = await getContentBounds();
  const tab = await openTab(installationId, kind, parentId, bounds, url);
  tabs.push(tab);
  await switchToTab(tab.id);
}

async function openOrSwitch(installationId: string, kind: TabKind) {
  const existing = findTopLevelTab(installationId, kind);
  if (existing) {
    await switchToTab(existing.id);
    return;
  }
  await requestOpenTab(installationId, kind, null, null);
}

async function closeTabUi(tabId: string) {
  await closeTab(tabId);
  const removed = collectWithDescendants(tabId);
  tabs = tabs.filter((t) => !removed.has(t.id));
  if (activeTabId && removed.has(activeTabId)) {
    activeTabId = null;
    showEmptyState();
  }
  renderSidebar();
}

async function handleRemoveInstallation(id: string) {
  const installation = installations.find((i) => i.id === id);
  if (!installation) return;
  const confirmed = confirm(`Remove installation "${installation.name}"? This will close all its open tabs.`);
  if (!confirmed) return;

  await removeInstallation(id);
  installations = installations.filter((i) => i.id !== id);
  const removedTabIds = new Set(tabs.filter((t) => t.installationId === id).map((t) => t.id));
  if (activeTabId && removedTabIds.has(activeTabId)) {
    activeTabId = null;
  }
  tabs = tabs.filter((t) => t.installationId !== id);
  renderApp();
}

function makeActionButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "installation-action-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderTabRow(tab: TabInfo, depth: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "tab-row-wrapper";

  const row = document.createElement("div");
  row.className = "tab-row" + (tab.id === activeTabId ? " active" : "");
  row.style.paddingLeft = `${12 + depth * 16}px`;

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.title;
  label.addEventListener("click", () => switchToTab(tab.id));
  row.appendChild(label);

  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn subtle tab-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close tab";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTabUi(tab.id);
  });
  row.appendChild(closeBtn);

  wrapper.appendChild(row);

  for (const child of tabs.filter((t) => t.parentId === tab.id)) {
    wrapper.appendChild(renderTabRow(child, depth + 1));
  }

  return wrapper;
}

function renderInstallationBlock(installation: Installation): HTMLElement {
  const block = document.createElement("div");
  block.className = "installation-block";

  const header = document.createElement("div");
  header.className = "installation-header";

  const nameSpan = document.createElement("span");
  nameSpan.className = "installation-name";
  nameSpan.textContent = installation.name;
  header.appendChild(nameSpan);

  const removeBtn = document.createElement("button");
  removeBtn.className = "icon-btn subtle";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove installation";
  removeBtn.addEventListener("click", () => handleRemoveInstallation(installation.id));
  header.appendChild(removeBtn);

  block.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "installation-actions";
  actions.appendChild(makeActionButton("Desktop", () => openOrSwitch(installation.id, "desktop")));
  actions.appendChild(makeActionButton("Apps Hub", () => openOrSwitch(installation.id, "apphub")));
  block.appendChild(actions);

  const topLevelTabs = tabs.filter((t) => t.installationId === installation.id && !t.parentId);
  if (topLevelTabs.length) {
    const tabTree = document.createElement("div");
    tabTree.className = "tab-tree";
    for (const tab of topLevelTabs) {
      tabTree.appendChild(renderTabRow(tab, 0));
    }
    block.appendChild(tabTree);
  }

  return block;
}

function renderSidebar() {
  const container = $("installation-list");
  container.innerHTML = "";
  for (const installation of installations) {
    container.appendChild(renderInstallationBlock(installation));
  }
}

function renderApp() {
  const onboardingEl = $("onboarding");
  const shellEl = $("shell");
  if (installations.length === 0) {
    onboardingEl.classList.remove("hidden");
    shellEl.classList.add("hidden");
    scheduleResize();
    return;
  }
  onboardingEl.classList.add("hidden");
  shellEl.classList.remove("hidden");
  renderSidebar();
  if (!activeTabId) {
    showEmptyState();
  }
  scheduleResize();
}

async function submitAddInstallation(
  name: string,
  address: string,
  errorEl: HTMLElement,
): Promise<Installation | null> {
  errorEl.classList.add("hidden");
  try {
    const installation = await addInstallation(name, address);
    installations.push(installation);
    renderApp();
    return installation;
  } catch (e) {
    errorEl.textContent = String(e);
    errorEl.classList.remove("hidden");
    return null;
  }
}

function wireStaticHandlers() {
  $("offline-retry-btn").addEventListener("click", () => offlineRetryHandler?.());

  $("onboarding-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (document.getElementById("onboarding-name") as HTMLInputElement).value;
    const address = (document.getElementById("onboarding-address") as HTMLInputElement).value;
    await submitAddInstallation(name, address, $("onboarding-error"));
  });

  $("add-installation-btn").addEventListener("click", () => {
    $("add-installation-modal").classList.remove("hidden");
  });

  $("modal-cancel-btn").addEventListener("click", () => {
    $("add-installation-modal").classList.add("hidden");
  });

  $("add-installation-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("modal-name") as HTMLInputElement;
    const addressInput = document.getElementById("modal-address") as HTMLInputElement;
    const installation = await submitAddInstallation(nameInput.value, addressInput.value, $("modal-error"));
    if (installation) {
      $("add-installation-modal").classList.add("hidden");
      nameInput.value = "";
      addressInput.value = "";
    }
  });

  window.addEventListener("resize", scheduleResize);

  listen<{ parentId: string; url: string }>("mvmos://new-child-tab", async (event) => {
    const { parentId, url } = event.payload;
    const parent = tabs.find((t) => t.id === parentId);
    if (!parent) return;
    const kind: TabKind = url.includes("/pub/apphub") ? "apphub" : "desktop";
    await requestOpenTab(parent.installationId, kind, parentId, url);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  wireStaticHandlers();
  installations = await getInstallations();
  renderApp();
});
