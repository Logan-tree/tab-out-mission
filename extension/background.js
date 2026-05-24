/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

const MISSION_GROUP_COLOR = 'green';

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

async function flashActionBadge(text, color = '#3d7a4a') {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    setTimeout(updateBadge, 900);
  } catch {}
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
  refreshMissionFromGroup();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

chrome.action.onClicked.addListener(async (tab) => {
  await addTabToCurrentMission(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'add-current-tab-to-mission') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await addTabToCurrentMission(tab);
});

// ─── Mission state sync ───────────────────────────────────────────────────────
// When a tab is closed (Ctrl+W, etc.), keep the mission's tabUrls in sync
// with what's actually in the mission's chrome tab group. This way the new
// tab page reflects reality the next time it's opened.

// Returns the tab's real URL — falls back to pendingUrl while a fresh
// tab is still navigating (otherwise t.url is empty / "chrome://newtab/").
function effectiveTabUrl(t) {
  if (!t) return '';
  const placeholder =
    !t.url || t.url === 'chrome://newtab/' || t.url === 'about:blank';
  if (placeholder && t.pendingUrl) return t.pendingUrl;
  return t.url || '';
}

function isRealWebTab(tab) {
  const url = effectiveTabUrl(tab);
  return Boolean(url) &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://');
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter(id => id != null))];
}

async function getGroupWindowId(groupId) {
  if (groupId == null) return null;
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.windowId;
  } catch {
    return null;
  }
}

async function ensureMissionGroupForTab(mission, tab) {
  const missionTitle = (mission.name || '').trim();
  const knownGroupIds = uniqueIds([
    mission.tabGroupId,
    ...(Array.isArray(mission.tabGroupIds) ? mission.tabGroupIds : []),
  ]);

  let targetGroupId = null;
  const validGroupIds = [];
  for (const groupId of knownGroupIds) {
    const windowId = await getGroupWindowId(groupId);
    if (windowId == null) continue;
    validGroupIds.push(groupId);
    if (windowId === tab.windowId) targetGroupId = groupId;
  }

  if (targetGroupId != null) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: targetGroupId });
  } else {
    targetGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
    validGroupIds.push(targetGroupId);
  }

  await chrome.tabGroups.update(targetGroupId, {
    title: missionTitle,
    color: mission.color || MISSION_GROUP_COLOR,
  });

  mission.tabGroupIds = uniqueIds(validGroupIds);
  mission.tabGroupId = mission.tabGroupIds.includes(mission.tabGroupId)
    ? mission.tabGroupId
    : targetGroupId;
}

async function clearSourceNoteIfMissionStarted(mission) {
  if (!mission?.sourceNoteId || !mission.tabUrls || mission.tabUrls.length === 0) return;

  const { missionNotes = [] } = await chrome.storage.local.get('missionNotes');
  await chrome.storage.local.set({
    missionNotes: Array.isArray(missionNotes)
      ? missionNotes.filter(note => note.id !== mission.sourceNoteId)
      : [],
  });
  delete mission.sourceNoteId;
}

async function addTabToCurrentMission(tab) {
  try {
    if (!tab || !tab.id || !isRealWebTab(tab)) {
      await flashActionBadge('!');
      return;
    }

    const url = effectiveTabUrl(tab);
    const { currentMission = null } = await chrome.storage.local.get('currentMission');
    if (!currentMission || !(currentMission.name || '').trim()) {
      await flashActionBadge('!');
      return;
    }

    const mission = currentMission;

    if (!Array.isArray(mission.tabUrls)) mission.tabUrls = [];
    if (!mission.tabUrls.includes(url)) mission.tabUrls.push(url);

    await ensureMissionGroupForTab(mission, tab);
    await clearSourceNoteIfMissionStarted(mission);
    await chrome.storage.local.set({ currentMission: mission });
    await flashActionBadge('✓');
  } catch (err) {
    console.warn('[mission] add current tab failed:', err);
    await flashActionBadge('!');
  }
}

async function refreshMissionFromGroup() {
  try {
    const { currentMission } = await chrome.storage.local.get('currentMission');
    if (!currentMission) return;

    let groupTabs = [];
    const groupIds = uniqueIds([
      currentMission.tabGroupId,
      ...(Array.isArray(currentMission.tabGroupIds) ? currentMission.tabGroupIds : []),
    ]);
    const validGroupIds = [];
    for (const groupId of groupIds) {
      try {
        const tabs = await chrome.tabs.query({ groupId });
        groupTabs.push(...tabs);
        validGroupIds.push(groupId);
      } catch {}
    }

    if (groupIds.length > 0 && validGroupIds.length === 0) {
      currentMission.tabGroupId = null;
      currentMission.tabGroupIds = [];
      currentMission.tabUrls = [];
      await chrome.storage.local.set({ currentMission });
      return;
    }

    currentMission.tabGroupIds = validGroupIds;
    currentMission.tabGroupId = validGroupIds.includes(currentMission.tabGroupId)
      ? currentMission.tabGroupId
      : (validGroupIds[0] ?? null);

    if (groupTabs.length === 0) return;

    const urls = groupTabs.map(effectiveTabUrl).filter(Boolean);

    // If some tabs are still loading (no url yet, no pendingUrl), don't
    // overwrite — we'd lose entries. Wait for the next event.
    if (urls.length !== groupTabs.length && groupTabs.length > 0) return;

    // Only write back when the URL list actually changed — avoids
    // pointless storage writes on every tab close.
    const same =
      urls.length === currentMission.tabUrls.length &&
      urls.every(u => currentMission.tabUrls.includes(u));
    if (same) return;

    currentMission.tabUrls = urls;
    if (urls.length === 0) currentMission.tabGroupId = null;
    await chrome.storage.local.set({ currentMission });
  } catch (err) {
    console.warn('[mission] refresh failed:', err);
  }
}

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
