"use strict";

const STATUS_DEFAULT = "Select or open an installation from the sidebar.";

let installations = [];
let tabs = [];
let activeTabId = null;
let sidebarVisible = true;
let statusRetryHandler = null;

// Which installations currently have their open buttons revealed. Kept outside
// the render pass because renderSidebar() rebuilds the list from scratch.
const revealedActions = new Set();

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

/* ------------------------------------------------------------------ status */

function setStatus(text, retry = null) {
  $("status-text").textContent = text;
  statusRetryHandler = retry;
  $("status-retry-btn").classList.toggle("hidden", !retry);
  $("status-panel").classList.remove("hidden");
}

function clearStatus() {
  $("status-panel").classList.add("hidden");
  statusRetryHandler = null;
}

/* ------------------------------------------------------------------ modals */

// While any dialog is up the active tab is detached in the main process, so the
// dialog is centred on the whole window rather than hidden behind the page.
let openModals = 0;

async function showModal(id) {
  openModals += 1;
  if (openModals === 1) await window.api.setOverlay(true);
  $(id).classList.remove("hidden");
}

async function hideModal(id) {
  $(id).classList.add("hidden");
  openModals = Math.max(openModals - 1, 0);
  if (openModals === 0) await window.api.setOverlay(false);
}

function confirmDialog({ title, message, okLabel = "Remove" }) {
  return new Promise((resolve) => {
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    const okBtn = $("confirm-ok-btn");
    const cancelBtn = $("confirm-cancel-btn");
    okBtn.textContent = okLabel;

    const finish = async (result) => {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      await hideModal("confirm-modal");
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    showModal("confirm-modal");
  });
}

// One dialog serves both adding and editing; `editingId` decides which.
let editingId = null;

const TYPE_HINTS = {
  mvmos: "Opens the desktop and the public page of an mvmOS installation. Links to other sites go to your browser.",
  site: "Any website, opened in one tab that browses freely, the way a browser window would.",
};

function updateTypeHint() {
  $("modal-type-hint").textContent = TYPE_HINTS[$("modal-type").value] || "";
}

async function openInstallationModal(installation = null) {
  editingId = installation ? installation.id : null;
  $("installation-modal-title").textContent = installation ? "Edit installation" : "Add installation";
  $("modal-submit-btn").textContent = installation ? "Save" : "Add";
  $("modal-name").value = installation ? installation.name : "";
  $("modal-address").value = installation ? installation.address : "";
  $("modal-type").value = installation && installation.type === "site" ? "site" : "mvmos";
  updateTypeHint();
  $("modal-error").classList.add("hidden");
  await showModal("installation-modal");
  $("modal-address").focus();
}

/* -------------------------------------------------------------------- tabs */

function findTopLevelTab(installationId, kind) {
  return tabs.find((t) => t.installationId === installationId && t.kind === kind && !t.parentId);
}

function collectWithDescendants(tabId) {
  const ids = new Set([tabId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tabs) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return ids;
}

async function switchToTab(tabId) {
  await window.api.activateTab(tabId);
  activeTabId = tabId;
  clearStatus();
  renderSidebar();
}

async function requestOpenTab(installationId, kind, parentId, url) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) return;

  setStatus("Connecting…");
  const reachable = await window.api.checkReachable(installation.address);
  if (!reachable) {
    setStatus(
      `Could not reach "${installation.name}" (${installation.address}). Make sure the server is running and reachable.`,
      () => requestOpenTab(installationId, kind, parentId, url),
    );
    return;
  }

  const tab = await window.api.openTab({ installationId, kind, parentId, url });
  tabs.push(tab);
  await switchToTab(tab.id);
}

async function openOrSwitch(installationId, kind) {
  const existing = findTopLevelTab(installationId, kind);
  if (existing) {
    await switchToTab(existing.id);
    return;
  }
  await requestOpenTab(installationId, kind, null, null);
}

function forgetTabs(removedIds) {
  tabs = tabs.filter((t) => !removedIds.has(t.id));
  if (activeTabId && removedIds.has(activeTabId)) {
    activeTabId = null;
    setStatus(STATUS_DEFAULT);
  }
}

async function closeTabUi(tabId) {
  const closed = tabs.find((t) => t.id === tabId);
  const wasActive = activeTabId === tabId || collectWithDescendants(tabId).has(activeTabId);
  await window.api.closeTab(tabId);
  forgetTabs(collectWithDescendants(tabId));

  /*
   * Closing the visible tab should fall back to another open one - preferably a
   * tab of the same installation - instead of dropping the user on the empty
   * placeholder while other tabs are still open.
   */
  if (wasActive && tabs.length) {
    const sameInstallation = [...tabs].reverse().find((t) => closed && t.installationId === closed.installationId);
    await switchToTab((sameInstallation || tabs[tabs.length - 1]).id);
    return;
  }
  renderSidebar();
}

/* ----------------------------------------------------------- installations */

async function handleRemoveInstallation(installation) {
  const confirmed = await confirmDialog({
    title: "Remove installation",
    message: `Remove "${installation.name}"? This closes all of its open tabs. The installation itself is not touched.`,
    okLabel: "Remove",
  });
  if (!confirmed) return;

  installations = await window.api.removeInstallation(installation.id);
  forgetTabs(new Set(tabs.filter((t) => t.installationId === installation.id).map((t) => t.id)));
  renderApp();
}

async function submitInstallationForm(event) {
  event.preventDefault();
  const errorEl = $("modal-error");
  const submitBtn = $("modal-submit-btn");
  const name = $("modal-name").value;
  const address = $("modal-address").value;

  errorEl.classList.add("hidden");
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";

  try {
    if (editingId) {
      const { installation, tabsClosed } = await window.api.updateInstallation(editingId, name, address, $("modal-type").value);
      const index = installations.findIndex((i) => i.id === editingId);
      if (index !== -1) installations[index] = installation;
      if (tabsClosed) {
        forgetTabs(new Set(tabs.filter((t) => t.installationId === editingId).map((t) => t.id)));
      }
    } else {
      installations.push(await window.api.addInstallation(name, address, $("modal-type").value));
    }
    await hideModal("installation-modal");
    renderApp();
  } catch (e) {
    errorEl.textContent = e && e.message ? e.message.replace(/^Error invoking remote method '[^']*': Error: /, "") : String(e);
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

async function persistOrder() {
  installations = await window.api.reorderInstallations(installations.map((i) => i.id));
  renderSidebar();
}

async function moveInstallation(id, delta) {
  const index = installations.findIndex((i) => i.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= installations.length) return;
  const [item] = installations.splice(index, 1);
  installations.splice(target, 0, item);
  await persistOrder();
}

/* ------------------------------------------------------------------ render */

// A page can flag an unread count in its own <title>, e.g. "(5) Inbox" - that
// count is shown as a badge instead of as part of the label text.
function parseBadge(title) {
  const match = title.match(/\((\d+)\)/);
  if (!match || match.index === undefined) return { label: title, badge: null };
  const label = (title.slice(0, match.index) + title.slice(match.index + match[0].length)).trim();
  return { label: label || title, badge: parseInt(match[1], 10) };
}

/*
 * The icon of a site, or a letter tile when it has none. Icons arrive as data
 * URLs from the main process: the chrome renderer has no network of its own.
 */
function makeSiteIcon(icon, label) {
  if (icon) {
    const img = document.createElement("img");
    img.className = "site-icon";
    img.src = icon;
    img.alt = "";
    return img;
  }
  const fallback = document.createElement("span");
  fallback.className = "site-icon-fallback";
  fallback.textContent = (label || "?").trim().charAt(0) || "?";
  return fallback;
}

function makeIconButton({ label, title, className, onClick, disabled = false }) {
  const btn = document.createElement("button");
  btn.className = `icon-btn subtle ${className || ""}`.trim();
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function renderTabRow(tab, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tab-row-wrapper";

  const row = document.createElement("div");
  row.className = "tab-row" + (tab.id === activeTabId ? " active" : "");
  row.style.paddingLeft = `${12 + depth * 16}px`;

  const { label: labelText, badge } = parseBadge(tab.title);

  row.appendChild(makeSiteIcon(tab.icon, tab.installationName || labelText));

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = labelText;
  label.addEventListener("click", () => switchToTab(tab.id));
  row.appendChild(label);

  if (badge !== null && badge > 0) {
    const badgeEl = document.createElement("span");
    badgeEl.className = "tab-badge";
    badgeEl.textContent = String(badge);
    row.appendChild(badgeEl);
  }

  row.appendChild(
    makeIconButton({ label: "×", title: "Close tab", className: "remove", onClick: () => closeTabUi(tab.id) }),
  );

  wrapper.appendChild(row);
  for (const child of tabs.filter((t) => t.parentId === tab.id)) {
    wrapper.appendChild(renderTabRow(child, depth + 1));
  }
  return wrapper;
}

function makeActionButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "installation-action-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderInstallationBlock(installation, index) {
  const block = document.createElement("div");
  block.className = "installation-block";
  block.dataset.id = installation.id;
  block.draggable = true;

  const header = document.createElement("div");
  header.className = "installation-header";
  header.title = installation.address;

  header.appendChild(makeSiteIcon(installation.icon, installation.name));

  const nameSpan = document.createElement("span");
  nameSpan.className = "installation-name";
  nameSpan.textContent = installation.name;
  header.appendChild(nameSpan);

  header.appendChild(
    makeIconButton({
      label: "▲",
      title: "Move up",
      onClick: () => moveInstallation(installation.id, -1),
      disabled: index === 0,
    }),
  );
  header.appendChild(
    makeIconButton({
      label: "▼",
      title: "Move down",
      onClick: () => moveInstallation(installation.id, 1),
      disabled: index === installations.length - 1,
    }),
  );
  header.appendChild(
    makeIconButton({ label: "✎", title: "Edit installation", onClick: () => openInstallationModal(installation) }),
  );
  header.appendChild(
    makeIconButton({
      label: "×",
      title: "Remove installation",
      className: "remove",
      onClick: () => handleRemoveInstallation(installation),
    }),
  );

  if (revealedActions.has(installation.id)) block.classList.add("actions-visible");
  header.addEventListener("click", () => {
    const revealed = revealedActions.has(installation.id);
    if (revealed) revealedActions.delete(installation.id);
    else revealedActions.add(installation.id);
    block.classList.toggle("actions-visible", !revealed);
  });
  block.appendChild(header);

  const hideActions = () => {
    revealedActions.delete(installation.id);
    block.classList.remove("actions-visible");
  };

  const actions = document.createElement("div");
  actions.className = "installation-actions";
  // A plain website has one page to open; an mvmOS installation has two.
  if (installation.type === "site") {
    actions.appendChild(
      makeActionButton("Open", () => {
        hideActions();
        openOrSwitch(installation.id, "site");
      }),
    );
  } else {
    actions.appendChild(
      makeActionButton("mvmOS Desktop", () => {
        hideActions();
        openOrSwitch(installation.id, "desktop");
      }),
    );
    actions.appendChild(
      makeActionButton("mvmOS Public", () => {
        hideActions();
        openOrSwitch(installation.id, "apphub");
      }),
    );
  }
  block.appendChild(actions);

  const topLevelTabs = tabs.filter((t) => t.installationId === installation.id && !t.parentId);
  if (topLevelTabs.length) {
    const tabTree = document.createElement("div");
    tabTree.className = "tab-tree";
    for (const tab of topLevelTabs) tabTree.appendChild(renderTabRow(tab, 0));
    block.appendChild(tabTree);
  }

  return block;
}

function renderSidebar() {
  const container = $("installation-list");
  container.innerHTML = "";
  installations.forEach((installation, index) => {
    container.appendChild(renderInstallationBlock(installation, index));
  });
  updateAppBadge();
}

/* ------------------------------------------------------------------- badge */

let lastBadgeCount = -1;

/*
 * Windows puts a picture over the taskbar icon rather than a number, and the
 * main process has no canvas to draw one on - so the badge is drawn here and
 * sent across as a data URL. macOS and Linux only need the number itself.
 */
function drawBadgeOverlay(count) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ff3b30";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  const text = count > 99 ? "99+" : String(count);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${text.length > 2 ? 14 : 20}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  return canvas.toDataURL("image/png");
}

// The unread counts the open pages report in their own titles, added up.
function updateAppBadge() {
  let total = 0;
  for (const tab of tabs) {
    const { badge } = parseBadge(tab.title || "");
    if (badge && badge > 0) total += badge;
  }
  if (total === lastBadgeCount) return;
  lastBadgeCount = total;
  const overlay = total > 0 && window.api.platform === "win32" ? drawBadgeOverlay(total) : null;
  window.api.setBadge(total, overlay);
}

function renderApp() {
  const onboardingEl = $("onboarding");
  const shellEl = $("shell");
  if (installations.length === 0) {
    onboardingEl.classList.remove("hidden");
    shellEl.classList.add("hidden");
    return;
  }
  onboardingEl.classList.add("hidden");
  shellEl.classList.remove("hidden");
  renderSidebar();
  if (!activeTabId) setStatus(STATUS_DEFAULT);
}

/* ------------------------------------------------------------------ update */

let dismissedUpdate = null;

function showUpdateBanner({ version, url }) {
  if (dismissedUpdate === version) return;
  $("update-title").textContent = "Update available";
  $("update-message").textContent = `Version ${version} is ready to download.`;
  $("update-download-btn").classList.remove("hidden");
  $("update-download-btn").onclick = () => window.api.openExternal(url);
  $("update-dismiss-btn").onclick = () => {
    dismissedUpdate = version;
    $("update-banner").classList.add("hidden");
  };
  $("update-banner").classList.remove("hidden");
}

// Only ever shown for a check the user asked for: silence is the right answer
// for the one that runs on its own at startup.
function showUpToDateBanner(version) {
  $("update-title").textContent = "Up to date";
  $("update-message").textContent = `Version ${version} is the newest release.`;
  $("update-download-btn").classList.add("hidden");
  $("update-dismiss-btn").onclick = () => $("update-banner").classList.add("hidden");
  $("update-banner").classList.remove("hidden");
  setTimeout(() => {
    if ($("update-title").textContent === "Up to date") $("update-banner").classList.add("hidden");
  }, 6000);
}

/* ---------------------------------------------------------- drag to reorder */

let draggedId = null;

function clearDropMarkers() {
  for (const el of document.querySelectorAll(".installation-block")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

function wireDragAndDrop() {
  const list = $("installation-list");

  list.addEventListener("dragstart", (event) => {
    const block = event.target.closest(".installation-block");
    if (!block) return;
    draggedId = block.dataset.id;
    block.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox-style requirement that some data is set for the drag to start.
    event.dataTransfer.setData("text/plain", draggedId);
  });

  list.addEventListener("dragover", (event) => {
    if (!draggedId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const block = event.target.closest(".installation-block");
    if (!block || block.dataset.id === draggedId) return;
    const rect = block.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    clearDropMarkers();
    block.classList.add(after ? "drop-after" : "drop-before");
  });

  list.addEventListener("drop", async (event) => {
    if (!draggedId) return;
    event.preventDefault();
    const block = event.target.closest(".installation-block");
    const movedId = draggedId;
    draggedId = null;
    clearDropMarkers();
    if (!block || block.dataset.id === movedId) return;

    const rect = block.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const from = installations.findIndex((i) => i.id === movedId);
    if (from === -1) return;
    const [item] = installations.splice(from, 1);
    let to = installations.findIndex((i) => i.id === block.dataset.id);
    if (to === -1) to = installations.length - 1;
    installations.splice(after ? to + 1 : to, 0, item);
    await persistOrder();
  });

  list.addEventListener("dragend", () => {
    draggedId = null;
    clearDropMarkers();
    for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
  });
}

/* ----------------------------------------------------------------- wiring */

function wireHandlers() {
  $("status-retry-btn").addEventListener("click", () => statusRetryHandler && statusRetryHandler());

  $("onboarding-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("onboarding-error");
    const submitBtn = event.target.querySelector('button[type="submit"]');
    errorEl.classList.add("hidden");
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Checking…";
    try {
      installations.push(
        await window.api.addInstallation(
          $("onboarding-name").value,
          $("onboarding-address").value,
          $("onboarding-type").value,
        ),
      );
      $("onboarding-name").value = "";
      $("onboarding-address").value = "";
      renderApp();
    } catch (e) {
      errorEl.textContent = e && e.message
        ? e.message.replace(/^Error invoking remote method '[^']*': Error: /, "")
        : String(e);
      errorEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  $("modal-type").addEventListener("change", updateTypeHint);
  $("add-installation-btn").addEventListener("click", () => openInstallationModal(null));
  $("hide-sidebar-btn").addEventListener("click", () => window.api.setSidebarVisible(false));
  $("modal-cancel-btn").addEventListener("click", () => hideModal("installation-modal"));
  $("installation-form").addEventListener("submit", submitInstallationForm);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("installation-modal").classList.contains("hidden")) hideModal("installation-modal");
    else if (!$("confirm-modal").classList.contains("hidden")) $("confirm-cancel-btn").click();
  });

  wireDragAndDrop();

  window.api.onAddInstallationRequested(() => openInstallationModal(null));

  window.api.onSidebarChanged((visible) => {
    sidebarVisible = visible;
    $("shell").classList.toggle("sidebar-hidden", !visible);
  });

  window.api.onNewChildTab(async ({ parentId, url }) => {
    const parent = tabs.find((t) => t.id === parentId);
    if (!parent) return;
    const kind = parent.kind === "site"
      ? "site"
      : (url.includes("/pub/apphub") ? "apphub" : "desktop");
    await requestOpenTab(parent.installationId, kind, parentId, url);
  });

  window.api.onTabIcon(({ tabId, icon }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !icon) return;
    tab.icon = icon;
    renderSidebar();
  });

  window.api.onInstallationIcon(({ id, icon }) => {
    const installation = installations.find((i) => i.id === id);
    if (!installation || !icon) return;
    installation.icon = icon;
    renderSidebar();
  });

  window.api.onInstallationAddress(({ id, address }) => {
    const installation = installations.find((i) => i.id === id);
    if (!installation || !address) return;
    installation.address = address;
    renderSidebar();
  });

  window.api.onUpdateAvailable(showUpdateBanner);
  window.api.onUpdateNone(({ version }) => showUpToDateBanner(version));

  window.api.onTabTitle(({ tabId, title }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !title) return;
    tab.title = title;
    renderSidebar();
  });

  window.api.onTabFailed(({ tabId, message }) => {
    if (tabId !== activeTabId) return;
    const tab = tabs.find((t) => t.id === tabId);
    setStatus(`"${tab ? tab.title : "This page"}" could not be loaded: ${message}`);
  });

  // Closing a tab from the page's own context menu happens in the main process.
  window.api.onTabClosed((tabId) => {
    forgetTabs(collectWithDescendants(tabId));
    renderSidebar();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  wireHandlers();
  installations = await window.api.listInstallations();
  renderApp();

  /*
   * The main process re-opens whatever was on screen last time and hands back
   * the tabs it created, already laid out and with one of them active - the
   * sidebar only has to catch up with it.
   */
  const restored = await window.api.restoreSession();
  if (restored && restored.tabs.length) {
    tabs = restored.tabs;
    activeTabId = restored.activeTabId;
    if (activeTabId) clearStatus();
    renderSidebar();
  }
});
