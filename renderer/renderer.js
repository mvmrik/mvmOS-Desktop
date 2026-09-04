"use strict";

let installations = [];
let tabs = [];
let activeTabId = null;
let sidebarVisible = true;
let statusRetryHandler = null;

// Which installations currently have their open buttons revealed. Kept outside
// the render pass because renderSidebar() rebuilds the list from scratch.
const revealedActions = new Set();

/** The message out of an IPC rejection, without the plumbing around it. */
function cleanError(e) {
  if (!e || !e.message) return String(e);
  return e.message.replace(/^Error invoking remote method '[^']*': Error: /, "");
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

/* ------------------------------------------------------------------ status */

function setStatus(text, retry = null) {
  // A transient message - connecting, a failed load - takes over the content
  // area, so the home page underneath it has to step aside.
  window.api.hideHome();
  $("status-text").textContent = text;
  statusRetryHandler = retry;
  $("status-retry-btn").classList.toggle("hidden", !retry);
  $("status-panel").classList.remove("hidden");
}

function clearStatus() {
  $("status-panel").classList.add("hidden");
  statusRetryHandler = null;
  window.api.hideHome();
}

/** The idle state: no tab open, nothing pending - the mvmOS home page shows instead. */
function showDefaultStatus() {
  statusRetryHandler = null;
  $("status-panel").classList.add("hidden");
  window.api.showHome();
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

// One dialog serves both adding and editing; `editingId` decides which. Which
// kind is being added is fixed by which "+" button opened the dialog, since
// there is one per kind rather than a select inside it - `editingType` is
// what submitInstallationForm() reads when it saves.
let editingId = null;
let editingType = "mvmos";

const TYPE_HINTS = {
  mvmos: "Opens the desktop and the public page of an mvmOS installation. Links to other sites go to your browser.",
  site: "Any website, opened in one tab that browses freely, the way a browser window would.",
};

const TYPE_LABELS = {
  mvmos: "mvmOS installation",
  site: "Website",
};

async function openInstallationModal(installation = null, fixedType = "mvmos") {
  editingId = installation ? installation.id : null;
  editingType = installation && installation.type === "site" ? "site" : (fixedType === "site" ? "site" : "mvmos");
  $("installation-modal-title").textContent = `${installation ? "Edit" : "Add"} ${TYPE_LABELS[editingType]}`;
  $("modal-submit-btn").textContent = installation ? "Save" : "Add";
  $("modal-name").value = installation ? installation.name : "";
  $("modal-address").value = installation ? installation.address : "";
  $("modal-type-hint").textContent = TYPE_HINTS[editingType] || "";
  $("modal-remove-btn").classList.toggle("hidden", !installation);
  $("modal-error").classList.add("hidden");
  await showModal("installation-modal");
  $("modal-address").focus();
}

/* -------------------------------------------------------------------- tabs */

function findTopLevelTab(installationId, kind) {
  return tabs.find((t) => t.installationId === installationId && t.kind === kind && !t.parentId);
}

/*
 * The flat list, re-laid so every tab is followed by its own children. Moving a
 * tab only swaps it with the sibling next to it; this is what keeps the subtree
 * underneath it from being left behind.
 */
function flattenTabOrder(list) {
  const out = [];
  const visit = (parentId) => {
    for (const tab of list) {
      if ((tab.parentId || null) !== parentId) continue;
      out.push(tab);
      visit(tab.id);
    }
  };
  visit(null);
  for (const tab of list) if (!out.includes(tab)) out.push(tab);
  return out;
}

function siblingsOf(tab) {
  return tabs.filter(
    (t) => t.installationId === tab.installationId && (t.parentId || null) === (tab.parentId || null),
  );
}

async function moveTab(tabId, delta) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const siblings = siblingsOf(tab);
  const index = siblings.indexOf(tab);
  const target = index + delta;
  if (target < 0 || target >= siblings.length) return;

  const other = siblings[target];
  const a = tabs.indexOf(tab);
  const b = tabs.indexOf(other);
  tabs[a] = other;
  tabs[b] = tab;
  tabs = flattenTabOrder(tabs);
  renderSidebar();
  // The main process writes the session file in its own order, so it has to be
  // told, or the tabs come back in the old one on the next start.
  await window.api.reorderTabs(tabs.map((t) => t.id));
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
  // The main process clears this too once it sees the tab is both active and
  // focused, but doing it here as well means the badge does not sit stale for
  // one IPC round trip after the click that was clearly meant to read it.
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) tab.unread = 0;
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
    showDefaultStatus();
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
      const { installation, tabsClosed } = await window.api.updateInstallation(editingId, name, address, editingType);
      const index = installations.findIndex((i) => i.id === editingId);
      if (index !== -1) installations[index] = installation;
      if (tabsClosed) {
        forgetTabs(new Set(tabs.filter((t) => t.installationId === editingId).map((t) => t.id)));
      }
    } else {
      installations.push(await window.api.addInstallation(name, address, editingType));
    }
    await hideModal("installation-modal");
    renderApp();
  } catch (e) {
    errorEl.textContent = cleanError(e);
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

/*
 * The sidebar is not a flat list of installations: every mvmOS installation is
 * a block of its own, and all the plain websites share one "Websites" block,
 * which sits where the first of them does. Moving things around therefore
 * happens in terms of these units, and the flat order is derived back from them
 * when it is saved.
 */
const WEBSITES_UNIT = "__websites__";

/*
 * The Websites block is always present, even with nothing in it yet: it is
 * the only place in the sidebar a website can be added from, so an install
 * with no websites still needs it there to add the first one.
 */
function sidebarUnits() {
  const sites = installations.filter((i) => i.type === "site");
  const units = [];
  let websitesPlaced = false;
  for (const installation of installations) {
    if (installation.type === "site") {
      if (websitesPlaced) continue;
      websitesPlaced = true;
      units.push({ id: WEBSITES_UNIT, kind: "websites", sites });
      continue;
    }
    units.push({ id: installation.id, kind: "installation", installation });
  }
  if (!websitesPlaced) units.push({ id: WEBSITES_UNIT, kind: "websites", sites });
  return units;
}

async function applyUnitOrder(units) {
  const ordered = [];
  for (const unit of units) {
    if (unit.kind === "websites") ordered.push(...unit.sites);
    else ordered.push(unit.installation);
  }
  installations = ordered;
  await persistOrder();
}

async function moveUnit(unitId, delta) {
  const units = sidebarUnits();
  const index = units.findIndex((u) => u.id === unitId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= units.length) return;
  const [unit] = units.splice(index, 1);
  units.splice(target, 0, unit);
  await applyUnitOrder(units);
}

/** Moves one website within the Websites block, leaving the blocks themselves alone. */
async function moveWebsite(id, delta) {
  const units = sidebarUnits();
  const group = units.find((u) => u.kind === "websites");
  if (!group) return;
  const sites = [...group.sites];
  const index = sites.findIndex((i) => i.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= sites.length) return;
  const [site] = sites.splice(index, 1);
  sites.splice(target, 0, site);
  group.sites = sites;
  await applyUnitOrder(units);
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

/** The "+" that replaces the Websites group's old count - always visible, unlike the row actions. */
function makeGroupAddButton(onClick, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-add-btn";
  btn.textContent = "+";
  btn.title = title;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
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

/*
 * An mvmOS app announces itself with an emoji in front of its title ("✅ Tasks"),
 * and that emoji is the only thing that tells one app of an installation apart
 * from another - every page of the installation serves the same favicon. So the
 * emoji becomes the row's icon and is taken out of the label, and a favicon that
 * is merely the installation's own is left off rather than repeated down the
 * whole tab tree.
 */
const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*/u;

function splitEmoji(title) {
  const match = LEADING_EMOJI.exec(title || "");
  if (!match) return { emoji: null, label: title };
  const rest = title.slice(match[0].length).trim();
  return rest ? { emoji: match[1], label: rest } : { emoji: null, label: title };
}

function makeEmojiIcon(emoji) {
  const span = document.createElement("span");
  span.className = "emoji-icon";
  span.textContent = emoji;
  return span;
}

/*
 * A favicon of the page's own wins; the emoji is what an mvmOS app has instead
 * of one, since every page of an installation serves the same icon and that one
 * is dropped here as a repeat. Returns the emoji it used, so the label can have
 * it taken out - and keeps it in the label when the favicon was shown instead.
 */
function makeTabIcon(tab, emoji, installation) {
  if (tab.icon && (!installation || tab.icon !== installation.icon)) {
    return { node: makeSiteIcon(tab.icon, tab.title), usedEmoji: false };
  }
  if (emoji) return { node: makeEmojiIcon(emoji), usedEmoji: true };
  return { node: null, usedEmoji: false };
}

function makeBadge(count) {
  const badgeEl = document.createElement("span");
  badgeEl.className = "tab-badge";
  badgeEl.textContent = String(count);
  return badgeEl;
}

// Kept in lockstep with the main process's own isMuted() via installation:mute
// pushes, so the badge total and the tray/dock icon agree with what the row
// shows without either side having to ask the other.
function isMuted(installation) {
  if (!installation) return false;
  const until = installation.muteUntil;
  if (until === "forever") return true;
  return typeof until === "number" && Date.now() < until;
}

function makeMuteIndicator() {
  const el = document.createElement("span");
  el.className = "mute-indicator";
  el.title = "Muted";
  el.textContent = "🔕";
  return el;
}

/*
 * Right-clicking a sidebar row - rather than a page's own content, which has
 * its own menu built in the main process - offers muting and, when the row has
 * an open tab, reloading it.
 */
function attachRowContextMenu(row, installationId, tabId) {
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.api.showRowContextMenu(installationId, tabId || null);
  });
}

/*
 * Up/down for a row that has somewhere to go. `move` gets the direction; the
 * buttons are only added when there is more than one row to shuffle.
 */
function appendMoveButtons(row, { index, total, move }) {
  if (total < 2) return;
  row.appendChild(makeIconButton({ label: "▲", title: "Move up", onClick: () => move(-1), disabled: index === 0 }));
  row.appendChild(makeIconButton({ label: "▼", title: "Move down", onClick: () => move(1), disabled: index === total - 1 }));
}

function renderTabRow(tab, depth, installation) {
  const wrapper = document.createElement("div");
  wrapper.className = "tab-row-wrapper";

  const row = document.createElement("div");
  row.className = "tab-row" + (tab.id === activeTabId ? " active" : "");
  row.style.paddingLeft = `${12 + depth * 16}px`;
  // The whole row, not just the text: clicking the padding at either end used
  // to highlight the row and then do nothing.
  row.addEventListener("click", () => switchToTab(tab.id));
  attachRowContextMenu(row, tab.installationId, tab.id);

  const { label: withoutBadge, badge: titleBadge } = parseBadge(tab.title);
  const { emoji, label: withoutEmoji } = splitEmoji(withoutBadge);

  const icon = makeTabIcon(tab, emoji, installation);
  if (icon.node) row.appendChild(icon.node);

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = icon.usedEmoji ? withoutEmoji : withoutBadge;
  row.appendChild(label);

  // Some sites put the count in <title> (Gmail-style); sites that instead only
  // fire a Notification (Element, most chat apps) are counted by the main
  // process and arrive on tab.unread - whichever one actually has something to
  // say wins.
  const badge = Math.max(titleBadge || 0, tab.unread || 0);
  if (isMuted(installation)) row.appendChild(makeMuteIndicator());
  else if (badge > 0) row.appendChild(makeBadge(badge));

  const siblings = siblingsOf(tab);
  appendMoveButtons(row, {
    index: siblings.indexOf(tab),
    total: siblings.length,
    move: (delta) => moveTab(tab.id, delta),
  });
  row.appendChild(
    makeIconButton({ label: "×", title: "Close tab", className: "remove", onClick: () => closeTabUi(tab.id) }),
  );

  wrapper.appendChild(row);
  for (const child of tabs.filter((t) => t.parentId === tab.id)) {
    wrapper.appendChild(renderTabRow(child, depth + 1, installation));
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

function renderInstallationBlock(installation, index, total) {
  const block = document.createElement("div");
  block.className = "installation-block";
  block.dataset.unit = installation.id;
  block.draggable = true;

  const header = document.createElement("div");
  header.className = "installation-header";
  header.title = installation.address;

  header.appendChild(makeSiteIcon(installation.icon, installation.name));

  const nameSpan = document.createElement("span");
  nameSpan.className = "installation-name";
  nameSpan.textContent = installation.name;
  header.appendChild(nameSpan);

  appendMoveButtons(header, { index, total, move: (delta) => moveUnit(installation.id, delta) });
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
  block.appendChild(actions);

  const topLevelTabs = tabs.filter((t) => t.installationId === installation.id && !t.parentId);
  if (topLevelTabs.length) {
    const tabTree = document.createElement("div");
    tabTree.className = "tab-tree";
    for (const tab of topLevelTabs) tabTree.appendChild(renderTabRow(tab, 0, installation));
    block.appendChild(tabTree);
  }

  return block;
}

/* --------------------------------------------------------------- websites */

// Which sidebar groups the user has folded away. Outside the render pass for
// the same reason the revealed actions are.
const collapsedGroups = new Set();

/*
 * A website is one page, so giving each of them a block with a name, an "Open"
 * button and a single tab underneath said the same thing three times. They all
 * live in one block instead, one row each, and the row is the tab.
 */
function renderWebsiteRow(site, index, total) {
  const wrapper = document.createElement("div");
  wrapper.className = "tab-row-wrapper";

  const rootTab = tabs.find((t) => t.installationId === site.id && !t.parentId);
  const row = document.createElement("div");
  row.className = "tab-row" + (rootTab && rootTab.id === activeTabId ? " active" : "");
  row.title = site.address;
  row.addEventListener("click", () => openOrSwitch(site.id, "site"));
  attachRowContextMenu(row, site.id, rootTab ? rootTab.id : null);

  row.appendChild(makeSiteIcon(site.icon, site.name));

  const label = document.createElement("span");
  label.className = "tab-label";
  // The site keeps the name it was added under: a messenger rewrites its own
  // title with whatever conversation is open, which makes for a restless list.
  label.textContent = site.name;
  row.appendChild(label);

  const muted = isMuted(site);
  if (muted) row.appendChild(makeMuteIndicator());
  else if (rootTab) {
    const { badge: titleBadge } = parseBadge(rootTab.title || "");
    const badge = Math.max(titleBadge || 0, rootTab.unread || 0);
    if (badge > 0) row.appendChild(makeBadge(badge));
  }

  appendMoveButtons(row, { index, total, move: (delta) => moveWebsite(site.id, delta) });
  row.appendChild(
    makeIconButton({ label: "✎", title: "Edit website", onClick: () => openInstallationModal(site) }),
  );
  if (rootTab) {
    row.appendChild(
      makeIconButton({ label: "×", title: "Close tab", className: "remove", onClick: () => closeTabUi(rootTab.id) }),
    );
  }

  wrapper.appendChild(row);
  if (rootTab) {
    for (const child of tabs.filter((t) => t.parentId === rootTab.id)) {
      wrapper.appendChild(renderTabRow(child, 1, site));
    }
  }
  return wrapper;
}

function renderWebsitesGroup(sites, index, total) {
  const block = document.createElement("div");
  block.className = "installation-block";
  block.dataset.unit = WEBSITES_UNIT;
  block.draggable = true;

  const collapsed = collapsedGroups.has(WEBSITES_UNIT);
  if (collapsed) block.classList.add("collapsed");

  const header = document.createElement("div");
  header.className = "installation-header";

  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.textContent = "▾";
  header.appendChild(chevron);

  const nameSpan = document.createElement("span");
  nameSpan.className = "installation-name";
  nameSpan.textContent = "Websites";
  header.appendChild(nameSpan);

  header.appendChild(makeGroupAddButton(() => openInstallationModal(null, "site"), "Add website"));

  appendMoveButtons(header, { index, total, move: (delta) => moveUnit(WEBSITES_UNIT, delta) });

  header.addEventListener("click", () => {
    if (collapsed) collapsedGroups.delete(WEBSITES_UNIT);
    else collapsedGroups.add(WEBSITES_UNIT);
    renderSidebar();
  });
  block.appendChild(header);

  const tabTree = document.createElement("div");
  tabTree.className = "tab-tree";
  sites.forEach((site, siteIndex) => {
    tabTree.appendChild(renderWebsiteRow(site, siteIndex, sites.length));
  });
  block.appendChild(tabTree);

  return block;
}

function renderSidebar() {
  const container = $("installation-list");
  container.innerHTML = "";
  const units = sidebarUnits();
  units.forEach((unit, index) => {
    container.appendChild(
      unit.kind === "websites"
        ? renderWebsitesGroup(unit.sites, index, units.length)
        : renderInstallationBlock(unit.installation, index, units.length),
    );
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

/*
 * Where there is a tray, the count goes on a whole icon rather than on a badge
 * laid over one: the app draws that icon itself, which is the point of it - on
 * Linux the panels are free to ignore the count the app reports and several do,
 * and on Windows a window closed into the tray has no taskbar button left for
 * an overlay to sit on. It is drawn whether or not the setting has the tray
 * showing, since only the main process knows that and the drawing is a canvas
 * the count changed anyway.
 */
const TRAY_PLATFORM = window.api.platform === "linux" || window.api.platform === "win32";

let appIcon = null;
let appIconAsked = false;

function loadAppIcon() {
  if (appIconAsked) return;
  appIconAsked = true;
  window.api.appIcon().then((dataUrl) => {
    if (!dataUrl) return;
    const image = new Image();
    image.onload = () => {
      appIcon = image;
      // The count was sent without an icon while this was loading.
      lastBadgeCount = -1;
      updateAppBadge();
    };
    image.src = dataUrl;
  });
}

function drawTrayIcon(count) {
  if (!appIcon) return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(appIcon, 0, 0, size, size);

  const text = count > 99 ? "99+" : String(count);
  const radius = 20;
  const centre = size - radius - 1;
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#ff3b30";
  ctx.fill();
  // The icon underneath is unknown and may be red itself.
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${text.length > 2 ? 18 : 27}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, centre, centre + 1);
  return canvas.toDataURL("image/png");
}

// The unread counts the open pages report - either in their own titles, or,
// for pages that only ever fire a Notification (see tab.unread), from there.
function updateAppBadge() {
  let total = 0;
  for (const tab of tabs) {
    if (isMuted(installations.find((i) => i.id === tab.installationId))) continue;
    const { badge: titleBadge } = parseBadge(tab.title || "");
    total += Math.max(titleBadge || 0, tab.unread || 0);
  }
  if (TRAY_PLATFORM) loadAppIcon();
  if (total === lastBadgeCount) return;
  lastBadgeCount = total;
  const overlay = total > 0 && window.api.platform === "win32" ? drawBadgeOverlay(total) : null;
  const trayIcon = total > 0 && TRAY_PLATFORM ? drawTrayIcon(total) : null;
  window.api.setBadge(total, overlay, trayIcon);
}

function renderApp() {
  renderSidebar();
  if (!activeTabId) showDefaultStatus();
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
    draggedId = block.dataset.unit;
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
    if (!block || block.dataset.unit === draggedId) return;
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
    if (!block || block.dataset.unit === movedId) return;

    const rect = block.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const units = sidebarUnits();
    const from = units.findIndex((u) => u.id === movedId);
    if (from === -1) return;
    const [unit] = units.splice(from, 1);
    let to = units.findIndex((u) => u.id === block.dataset.unit);
    if (to === -1) to = units.length - 1;
    units.splice(after ? to + 1 : to, 0, unit);
    await applyUnitOrder(units);
  });

  list.addEventListener("dragend", () => {
    draggedId = null;
    clearDropMarkers();
    for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
  });
}

/* ------------------------------------------------------------------- lock */

let isLocked = false;

function showLockScreen(show) {
  isLocked = show;
  $("lock-screen").classList.toggle("hidden", !show);
  $("lock-error").classList.add("hidden");
  if (show) {
    $("lock-pin").value = "";
    $("lock-pin").focus();
  }
}

async function submitUnlock(event) {
  event.preventDefault();
  const ok = await window.api.unlock($("lock-pin").value);
  if (ok) {
    showLockScreen(false);
    return;
  }
  $("lock-error").classList.remove("hidden");
  $("lock-pin").value = "";
  $("lock-pin").focus();
}

/*
 * The padlock in the sidebar header. A lock with no PIN behind it would be a
 * door with no key, so until one is set the button says so and leads to where
 * it is set; `hasPin` is settled before this is first called.
 */
function renderLockButton() {
  $("lock-now-btn").title = hasPin ? "Lock now" : "Lock now — set a PIN first";
}

async function lockFromHeader() {
  if (!hasPin) {
    await openSettings();
    $("pin-new").focus();
    return;
  }
  await window.api.lockNow();
}

/* ------------------------------------------------------------- auto-lock */

// >= 1h: "5h30m". Under an hour: whole minutes, "15m". Under a minute: real
// seconds, "20s" - the three granularities the user actually cares about, in
// decreasing order of how precisely they need to be shown.
function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h${minutes}m`;
  }
  if (totalSeconds >= 60) return `${Math.floor(totalSeconds / 60)}m`;
  return `${totalSeconds}s`;
}

let lockDeadline = null;
let countdownTimer = null;

function updateCountdownDisplay() {
  const el = $("lock-countdown");
  if (!lockDeadline) {
    el.classList.add("hidden");
    return;
  }
  const remaining = lockDeadline - Date.now();
  if (remaining <= 0) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = formatCountdown(remaining);
  el.classList.remove("hidden");
}

/** `deadline` is an epoch ms from the main process, or null while auto-lock is off. */
function setLockDeadline(deadline) {
  lockDeadline = typeof deadline === "number" ? deadline : null;
  updateCountdownDisplay();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = lockDeadline ? setInterval(updateCountdownDisplay, 1000) : null;
}

/* --------------------------------------------------------------- settings */

let hasPin = false;
let autoLockState = { lockTimeoutMinutes: 0, lockResetOnActivity: true };

function renderPinSection() {
  $("pin-status").textContent = hasPin
    ? "A PIN is set. The app asks for it every time it starts."
    : "No PIN. Set one and the app will ask for it on every start; leave it empty and it never does.";
  $("pin-current-label").classList.toggle("hidden", !hasPin);
  $("pin-new-label").textContent = hasPin ? "New PIN" : "PIN";
  $("pin-save-btn").textContent = hasPin ? "Change PIN" : "Set PIN";
  $("pin-remove-btn").classList.toggle("hidden", !hasPin);
  $("pin-lock-btn").classList.toggle("hidden", !hasPin);
  $("pin-error").classList.add("hidden");
  $("pin-current").value = "";
  $("pin-new").value = "";
  renderLockButton();
  renderAutoLockSection();
}

/*
 * 0 means off, and only means anything with a PIN behind it - so the fields
 * are simply disabled without one, rather than refusing to save a value that
 * would otherwise just sit there unused.
 */
function renderAutoLockSection() {
  $("lock-timeout-minutes").disabled = !hasPin;
  $("lock-reset-activity").disabled = !hasPin;
  $("lock-timeout-minutes").value = autoLockState.lockTimeoutMinutes || 0;
  $("lock-reset-activity").checked = autoLockState.lockResetOnActivity !== false;
  $("lock-timeout-hint").textContent = hasPin
    ? "0 means never. Off: locks exactly this many minutes after unlocking, whatever you do meanwhile. On: locks only after this many minutes with no activity in the app."
    : "Set a PIN first.";
}

async function saveAutoLockSettings() {
  const minutes = Math.max(0, parseInt($("lock-timeout-minutes").value, 10) || 0);
  const resetOnActivity = $("lock-reset-activity").checked;
  autoLockState = await window.api.setLockTimeout(minutes, resetOnActivity);
  renderAutoLockSection();
}

/* ------------------------------------------------------------------- tray */

/*
 * Two switches rather than one, because they answer different questions: where
 * the app is seen, and what the window's close button does. The second needs
 * the first - a window closed away with no icon left behind it could not be
 * got back - so it is held off until there is an icon to close into.
 */
let trayState = { supported: false, showTray: true, closeToTray: false };

function renderTraySection() {
  $("tray-section").classList.toggle("hidden", !trayState.supported);
  if (!trayState.supported) return;
  $("tray-show").checked = trayState.showTray;
  $("tray-close").checked = trayState.closeToTray;
  $("tray-close").disabled = !trayState.showTray;
  $("tray-show-hint").textContent =
    window.api.platform === "linux"
      ? "Unread counts show on it. Without it they are only in the window title and the sidebar, since a Linux panel is free to ignore the count the app reports."
      : "Unread counts show on it as well as on the taskbar button.";
}

async function saveTraySettings() {
  trayState = await window.api.setTray($("tray-show").checked, $("tray-close").checked);
  renderTraySection();
}

/* -------------------------------------------------------- extension bar */

/*
 * The buttons a browser would put in its toolbar. The list comes from the main
 * process, which knows what actually loaded; clicking one asks it to hang the
 * extension's popup under the button, so the anchor travels with the click.
 */
let extensionActions = [];
let openExtensionId = null;

function extensionInitials(name) {
  const words = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0]).join("").toUpperCase() || "?";
}

function renderExtensionBar() {
  const bar = $("extension-bar");
  bar.innerHTML = "";
  bar.classList.toggle("hidden", extensionActions.length === 0);
  if (!extensionActions.length) return;

  for (const action of extensionActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "extension-btn";
    button.title = action.title || action.name;
    button.classList.toggle("open", action.id === openExtensionId);

    if (action.icon) {
      const img = document.createElement("img");
      img.src = action.icon;
      img.alt = "";
      button.appendChild(img);
    } else {
      button.textContent = extensionInitials(action.name);
    }

    button.addEventListener("click", async () => {
      // The main process places the popup in window coordinates, which is what
      // getBoundingClientRect gives us: the chrome fills the whole window.
      const rect = button.getBoundingClientRect();
      const anchorRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const wasOpen = openExtensionId === action.id;
      const opened = await window.api.openExtensionPopup(action.id, anchorRect);
      openExtensionId = opened && !wasOpen ? action.id : null;
      renderExtensionBar();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      window.api.extensionMenu(action.id);
    });
    bar.appendChild(button);
  }
}

function setExtensionActions(actions) {
  extensionActions = Array.isArray(actions) ? actions : [];
  if (!extensionActions.some((action) => action.id === openExtensionId)) openExtensionId = null;
  renderExtensionBar();
}

function renderExtensions(list) {
  const container = $("extension-list");
  container.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "form-hint";
    empty.textContent = "None loaded.";
    container.appendChild(empty);
    return;
  }
  for (const extension of list) {
    const row = document.createElement("div");
    row.className = "extension-row";

    const text = document.createElement("div");
    text.className = "extension-text";
    const name = document.createElement("strong");
    name.textContent = extension.version ? `${extension.name} ${extension.version}` : extension.name;
    text.appendChild(name);
    const detail = document.createElement("span");
    detail.className = extension.error ? "extension-error" : "";
    // A folder we unpacked ourselves is an implementation detail; the path
    // only matters for one the user picked and may want to update in place.
    detail.textContent = extension.error || (extension.managed ? "Added from a file" : extension.path);
    text.appendChild(detail);
    row.appendChild(text);

    row.appendChild(
      makeIconButton({
        label: "×",
        title: "Remove extension",
        className: "remove",
        onClick: async () => applyExtensionResult(await window.api.removeExtension(extension.path)),
      }),
    );
    container.appendChild(row);
  }
}

/*
 * Adding and removing both answer with the whole list plus, if something went
 * wrong with one folder, the reason - the list is still worth showing.
 */
function applyExtensionResult(result) {
  const list = Array.isArray(result) ? result : result.list;
  renderExtensions(list);
  $("extension-note").textContent =
    (result && result.message) || "Extensions load at startup; a new one is live in tabs you open or reload from now on.";
}

async function openSettings() {
  const state = await window.api.lockState();
  hasPin = state.hasPin;
  autoLockState = { lockTimeoutMinutes: state.lockTimeoutMinutes, lockResetOnActivity: state.lockResetOnActivity };
  renderPinSection();
  trayState = await window.api.trayState();
  renderTraySection();
  applyExtensionResult(await window.api.listExtensions());
  await showModal("settings-modal");
}

async function submitPinForm(event) {
  event.preventDefault();
  const errorEl = $("pin-error");
  errorEl.classList.add("hidden");
  try {
    const result = await window.api.setPin($("pin-current").value, $("pin-new").value);
    hasPin = result.hasPin;
    renderPinSection();
    $("pin-status").textContent = "PIN saved.";
  } catch (e) {
    errorEl.textContent = cleanError(e);
    errorEl.classList.remove("hidden");
  }
}

async function removePin() {
  const errorEl = $("pin-error");
  errorEl.classList.add("hidden");
  try {
    const result = await window.api.clearPin($("pin-current").value);
    hasPin = result.hasPin;
    renderPinSection();
    $("pin-status").textContent = "PIN removed.";
  } catch (e) {
    errorEl.textContent = cleanError(e);
    errorEl.classList.remove("hidden");
  }
}

/* ----------------------------------------------------------------- wiring */

function wireHandlers() {
  $("status-retry-btn").addEventListener("click", () => statusRetryHandler && statusRetryHandler());

  $("add-installation-btn").addEventListener("click", () => openInstallationModal(null, "mvmos"));
  $("hide-sidebar-btn").addEventListener("click", () => window.api.setSidebarVisible(false));
  $("modal-cancel-btn").addEventListener("click", () => hideModal("installation-modal"));
  $("installation-form").addEventListener("submit", submitInstallationForm);
  $("modal-remove-btn").addEventListener("click", async () => {
    const installation = installations.find((i) => i.id === editingId);
    if (!installation) return;
    await hideModal("installation-modal");
    await handleRemoveInstallation(installation);
  });

  $("settings-close-btn").addEventListener("click", () => hideModal("settings-modal"));
  $("pin-form").addEventListener("submit", submitPinForm);
  $("pin-remove-btn").addEventListener("click", removePin);
  $("pin-lock-btn").addEventListener("click", async () => {
    await hideModal("settings-modal");
    await window.api.lockNow();
  });
  $("extension-add-btn").addEventListener("click", async () => {
    applyExtensionResult(await window.api.addExtension());
  });
  $("extension-folder-btn").addEventListener("click", async () => {
    applyExtensionResult(await window.api.addExtensionFolder());
  });

  $("tray-show").addEventListener("change", saveTraySettings);
  $("tray-close").addEventListener("change", saveTraySettings);

  $("lock-timeout-minutes").addEventListener("change", saveAutoLockSettings);
  $("lock-reset-activity").addEventListener("change", saveAutoLockSettings);

  $("lock-now-btn").addEventListener("click", lockFromHeader);
  $("site-link-btn").addEventListener("click", () => window.api.openExternal("https://mvmos.org"));

  $("lock-form").addEventListener("submit", submitUnlock);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Escape must not dismiss the lock screen; it is the one overlay that is
    // not the user's to close.
    if (isLocked) return;
    if (openExtensionId) window.api.closeExtensionPopup();
    if (!$("installation-modal").classList.contains("hidden")) hideModal("installation-modal");
    else if (!$("settings-modal").classList.contains("hidden")) hideModal("settings-modal");
    else if (!$("confirm-modal").classList.contains("hidden")) $("confirm-cancel-btn").click();
  });

  wireDragAndDrop();

  window.api.onAddInstallationRequested(() => openInstallationModal(null, "mvmos"));
  window.api.onAddWebsiteRequested(() => openInstallationModal(null, "site"));
  window.api.onSettingsRequested(() => openSettings());
  window.api.onExtensionActions((actions) => setExtensionActions(actions));
  window.api.onExtensionPopupClosed(() => {
    openExtensionId = null;
    renderExtensionBar();
  });
  window.api.onLockChanged((value) => showLockScreen(value));
  window.api.onLockDeadline((deadline) => setLockDeadline(deadline));

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

  window.api.onInstallationMute(({ id, muteUntil }) => {
    const installation = installations.find((i) => i.id === id);
    if (!installation) return;
    if (muteUntil) installation.muteUntil = muteUntil;
    else delete installation.muteUntil;
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

  // Pages that never put a count in <title> (Element, most chat apps) still
  // show up here - see tab-preload.js and the main process's tab:notification
  // handler, which count the page's own Notification calls instead.
  window.api.onTabUnread(({ tabId, count }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.unread = count;
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

  // Before anything is drawn: a locked app must not flash its sidebar on the
  // way to the PIN prompt.
  const lockState = await window.api.lockState();
  hasPin = lockState.hasPin;
  renderLockButton();
  setLockDeadline(lockState.deadline);
  if (lockState.locked) showLockScreen(true);

  setExtensionActions(await window.api.extensionActions());

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
