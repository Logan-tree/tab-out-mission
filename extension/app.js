/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

let tabOutDupeCleanupInProgress = false;

/**
 * autoCloseTabOutDupes()
 *
 * If more than one Tab Out page exists, automatically keep the active
 * Tab Out page and close the extras before the dashboard renders.
 */
async function autoCloseTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  if (tabOutTabs.length <= 1 || tabOutDupeCleanupInProgress) return false;

  tabOutDupeCleanupInProgress = true;
  try {
    await closeTabOutDupes();
    return true;
  } finally {
    tabOutDupeCleanupInProgress = false;
  }
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   CURRENT MISSION — chrome.storage.local + chrome.tabGroups

   The mission is the user's declared current task. Tabs assigned to
   it are tracked by URL (so they survive a browser restart) AND
   placed into a native chrome tab group, which gives them a colored
   label in the browser tab bar.

   Storage shape under the "currentMission" key:
   {
     name:       "Try OpenAI Codex",
     tabUrls:    ["https://...", ...],
     tabGroupId: 12,          // chrome tab group id (current session only)
     color:      "orange",
     createdAt:  "2026-04-25T..."
   }
   `null` when no mission is active.
   ---------------------------------------------------------------- */

const MISSION_GROUP_COLOR = 'orange';

/**
 * effectiveTabUrl(t)
 *
 * For a freshly-created or in-flight tab, `t.url` can be empty or the
 * "chrome://newtab/" placeholder until the navigation commits. The
 * actual target is in `t.pendingUrl`. This helper returns whichever
 * is the real URL.
 */
function effectiveTabUrl(t) {
  if (!t) return '';
  const placeholder =
    !t.url || t.url === 'chrome://newtab/' || t.url === 'about:blank';
  if (placeholder && t.pendingUrl) return t.pendingUrl;
  return t.url || '';
}

// True only for "real web" URLs eligible to live inside a mission.
// Filters out the dashboard itself, chrome internals, etc. — otherwise
// the dashboard tab can get sucked into the mission group and then
// `findTabsByUrls` would target it for closure on save/end.
function isMissionableUrl(url) {
  if (!url) return false;
  return !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://');
}

async function getCurrentMission() {
  const { currentMission = null } = await chrome.storage.local.get('currentMission');
  return currentMission;
}

async function setCurrentMission(mission) {
  await chrome.storage.local.set({ currentMission: mission });
}

async function clearCurrentMission() {
  await chrome.storage.local.remove('currentMission');
}

function makeQuickNote(text) {
  return {
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    text: text || '',
    createdAt: new Date().toISOString(),
  };
}

async function getMissionNotes() {
  const { missionNotes = null, missionNote = '' } =
    await chrome.storage.local.get(['missionNotes', 'missionNote']);

  if (Array.isArray(missionNotes)) return missionNotes;

  const migrated = missionNote.trim() ? [makeQuickNote(missionNote.trim())] : [];
  await chrome.storage.local.set({ missionNotes: migrated });
  await chrome.storage.local.remove('missionNote');
  return migrated;
}

async function setMissionNotes(notes) {
  await chrome.storage.local.set({ missionNotes: notes || [] });
}

async function updateMissionNote(id, text) {
  const notes = await getMissionNotes();
  const note = notes.find(n => n.id === id);
  if (!note) return;
  note.text = text;
  note.updatedAt = new Date().toISOString();
  await setMissionNotes(notes);
}

async function addMissionNote(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const notes = await getMissionNotes();
  const note = makeQuickNote(trimmed);
  notes.push(note);
  await setMissionNotes(notes);
  return note;
}

async function deleteMissionNote(id) {
  const notes = await getMissionNotes();
  await setMissionNotes(notes.filter(n => n.id !== id));
}

async function promoteMissionNoteToTitle(id) {
  const notes = await getMissionNotes();
  const note = notes.find(n => n.id === id);
  const title = note ? note.text.trim() : '';
  if (!title) return null;

  const mission = await getCurrentMission();
  if (mission && mission.tabUrls && mission.tabUrls.length > 0) {
    await saveMissionForLater();
  }

  await setCurrentMission({
    name:       title,
    tabUrls:    [],
    tabGroupId: null,
    tabGroupIds: [],
    sourceNoteId: id,
    color:      MISSION_GROUP_COLOR,
    createdAt:  new Date().toISOString(),
  });
  return title;
}

async function clearSourceNoteIfMissionStarted(mission) {
  if (!mission || !mission.sourceNoteId || !mission.tabUrls || mission.tabUrls.length === 0) {
    return mission;
  }

  await deleteMissionNote(mission.sourceNoteId);
  delete mission.sourceNoteId;
  await setCurrentMission(mission);
  return mission;
}

/**
 * findTabsByUrls(urls)
 *
 * Returns all chrome tabs whose URL matches any URL in the given list.
 */
async function findTabsByUrls(urls) {
  if (!urls || urls.length === 0) return [];
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  return allTabs.filter(t => {
    const u = effectiveTabUrl(t);
    return urlSet.has(u) && isMissionableUrl(u);
  });
}

function mergeUrls(...urlLists) {
  const seen = new Set();
  const merged = [];
  for (const urls of urlLists) {
    for (const url of urls || []) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push(url);
    }
  }
  return merged;
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter(id => id != null))];
}

/**
 * ensureMissionGroup(mission, tabIds)
 *
 * Make sure the given tab IDs belong to the mission's chrome tab group.
 * If the group doesn't exist yet, create it and apply the mission's
 * title + color. Returns the (possibly new) groupId.
 *
 * Chrome tab groups cannot span windows, so a mission may have one
 * browser group per window. They all share the mission title and color.
 */
async function ensureMissionGroup(mission, tabIds) {
  if (!tabIds || tabIds.length === 0) return mission.tabGroupId || null;

  const targetIds = new Set(tabIds);
  const allTabs = await chrome.tabs.query({});
  const tabsByWindow = {};
  for (const tab of allTabs) {
    if (!targetIds.has(tab.id)) continue;
    if (!tabsByWindow[tab.windowId]) tabsByWindow[tab.windowId] = [];
    tabsByWindow[tab.windowId].push(tab.id);
  }

  const knownGroupIds = [
    mission.tabGroupId,
    ...(Array.isArray(mission.tabGroupIds) ? mission.tabGroupIds : []),
  ].filter(id => id != null);

  // Verify existing group is still valid
  const groupsByWindow = {};
  for (const id of knownGroupIds) {
    try {
      const group = await chrome.tabGroups.get(id);
      groupsByWindow[group.windowId] = group.id;
    } catch {}
  }

  const groupIds = uniqueIds(Object.values(groupsByWindow));
  try {
    for (const [windowId, ids] of Object.entries(tabsByWindow)) {
      let groupId = groupsByWindow[windowId];
      if (groupId != null) {
        await chrome.tabs.group({ tabIds: ids, groupId });
        await chrome.tabGroups.update(groupId, {
          title: mission.name || 'Mission',
          color: mission.color || MISSION_GROUP_COLOR,
        });
      } else {
        groupId = await chrome.tabs.group({ tabIds: ids });
        await chrome.tabGroups.update(groupId, {
          title: mission.name || 'Mission',
          color: mission.color || MISSION_GROUP_COLOR,
        });
      }
      if (!groupIds.includes(groupId)) groupIds.push(groupId);
    }
    if (groupIds.length > 0) {
      mission.tabGroupIds = uniqueIds(groupIds);
      return groupIds.includes(mission.tabGroupId) ? mission.tabGroupId : groupIds[0];
    } else {
      mission.tabGroupIds = uniqueIds(Object.values(groupsByWindow));
    }
  } catch (err) {
    // Cross-window grouping or transient errors — tabs are still tracked by URL
    console.warn('[mission] could not group tabs:', err);
  }

  return mission.tabGroupId || null;
}

async function ungroupTabs(tabIds) {
  if (!tabIds || tabIds.length === 0) return;
  try { await chrome.tabs.ungroup(tabIds); }
  catch (err) { console.warn('[mission] ungroup failed:', err); }
}

/**
 * addTabToMission(url)
 *
 * Adds a tab (by URL) to the current mission. Creates a fresh
 * unnamed mission if none exists — caller is responsible for
 * prompting the user for a name.
 */
async function addTabToMission(url) {
  let mission = await getCurrentMission();
  if (!mission) {
    mission = {
      name:       '',
      tabUrls:    [],
      tabGroupId: null,
      color:      MISSION_GROUP_COLOR,
      createdAt:  new Date().toISOString(),
    };
  }

  const hadTabs = mission.tabUrls.length > 0;
  if (!mission.tabUrls.includes(url)) mission.tabUrls.push(url);

  // Find live tab(s) and group them
  const matching = await findTabsByUrls([url]);
  if (matching.length > 0) {
    mission.tabGroupId = await ensureMissionGroup(mission, matching.map(t => t.id));
  }

  // Sync URLs from the group (so navigations within the group stay tracked)
  if (mission.tabGroupId != null) {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: mission.tabGroupId });
      const groupUrls = groupTabs.map(effectiveTabUrl).filter(isMissionableUrl);
      if (groupUrls.length > 0) mission.tabUrls = mergeUrls(mission.tabUrls, groupUrls);
    } catch {}
  }

  if (!hadTabs && mission.tabUrls.length > 0 && mission.sourceNoteId) {
    await clearSourceNoteIfMissionStarted(mission);
  }

  await setCurrentMission(mission);
  await clearSourceNoteIfMissionStarted(mission);
  return mission;
}

/**
 * removeTabFromMission(url)
 *
 * Drops a URL from the mission. Matching tabs are ungrouped (still
 * open, just back in the wild).
 */
async function removeTabFromMission(url) {
  const mission = await getCurrentMission();
  if (!mission) return null;

  mission.tabUrls = mission.tabUrls.filter(u => u !== url);

  const matching = await findTabsByUrls([url]);
  if (matching.length > 0) await ungroupTabs(matching.map(t => t.id));

  await setCurrentMission(mission);
  await clearSourceNoteIfMissionStarted(mission);
  return mission;
}

/**
 * renameMission(name)
 *
 * Updates the mission name and the tab group title in the bar.
 */
async function renameMission(name) {
  const mission = await getCurrentMission();
  if (!mission) return;
  mission.name = name;
  const groupIds = uniqueIds([
    mission.tabGroupId,
    ...(Array.isArray(mission.tabGroupIds) ? mission.tabGroupIds : []),
  ]);
  for (const groupId of groupIds) {
    try { await chrome.tabGroups.update(groupId, { title: name || 'Mission' }); }
    catch {}
  }
  await setCurrentMission(mission);
}

/**
 * endMissionUngroup() — ends the mission and releases tabs
 * (still open, just no longer grouped or highlighted).
 */
async function endMissionUngroup() {
  const mission = await getCurrentMission();
  if (!mission) return;
  const tabs = await findTabsByUrls(mission.tabUrls);
  if (tabs.length > 0) await ungroupTabs(tabs.map(t => t.id));
  await clearCurrentMission();
}

/**
 * endMissionCloseAll() — ends the mission and closes every tab in it.
 */
async function endMissionCloseAll() {
  const mission = await getCurrentMission();
  if (!mission) return;
  const tabs = await findTabsByUrls(mission.tabUrls);
  if (tabs.length > 0) await chrome.tabs.remove(tabs.map(t => t.id));
  await clearCurrentMission();
}

/**
 * completeCurrentMission()
 *
 * Archives the active mission into a local completion log, closes its
 * tabs, and clears the active mission slot.
 */
async function completeCurrentMission() {
  const mission = await getCurrentMission();
  if (!mission || !mission.tabUrls || mission.tabUrls.length === 0) return null;

  const completedAt = new Date().toISOString();
  const tabs = await findTabsByUrls(mission.tabUrls);
  const liveTabsByUrl = {};
  for (const tab of tabs) liveTabsByUrl[effectiveTabUrl(tab)] = tab;

  const completedMission = {
    id:          Date.now().toString(),
    name:        mission.name || 'Untitled mission',
    tabUrls:     [...mission.tabUrls],
    tabs:        mission.tabUrls.map(url => {
      const tab = liveTabsByUrl[url];
      let domain = '';
      try { domain = new URL(url).hostname; } catch {}
      const rawTitle = tab ? (tab.title || '') : '';
      const title = rawTitle
        ? cleanTitle(smartTitle(stripTitleNoise(rawTitle), url), '')
        : (domain || url);
      return { title, domain, url };
    }),
    color:       mission.color || MISSION_GROUP_COLOR,
    createdAt:   mission.createdAt || completedAt,
    completedAt,
  };

  const { completedMissions = [] } = await chrome.storage.local.get('completedMissions');
  completedMissions.push(completedMission);
  completedMissions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  await chrome.storage.local.set({ completedMissions: completedMissions.slice(0, 200) });

  if (tabs.length > 0) await chrome.tabs.remove(tabs.map(t => t.id));
  await clearCurrentMission();

  return completedMission;
}

/**
 * saveMissionForLater()
 *
 * Parks the current mission as a "saved mission" in the sidebar:
 * records its name + URLs, closes its open tabs, and clears the
 * active slot. Used when switching tasks — the mission can be
 * restored later without losing the URL list.
 */
async function saveMissionForLater() {
  const mission = await getCurrentMission();
  if (!mission || !mission.tabUrls || mission.tabUrls.length === 0) return;

  const { savedMissions = [] } = await chrome.storage.local.get('savedMissions');
  savedMissions.push({
    id:       Date.now().toString(),
    name:     mission.name || 'Untitled mission',
    tabUrls:  [...mission.tabUrls],
    color:    mission.color || MISSION_GROUP_COLOR,
    savedAt:  new Date().toISOString(),
  });
  await chrome.storage.local.set({ savedMissions });

  // Close every tab that's part of the mission
  const tabs = await findTabsByUrls(mission.tabUrls);
  if (tabs.length > 0) await chrome.tabs.remove(tabs.map(t => t.id));

  await clearCurrentMission();
}

async function getSavedMissions() {
  const { savedMissions = [] } = await chrome.storage.local.get('savedMissions');
  return savedMissions;
}

async function getCompletedMissions() {
  const { completedMissions = [] } = await chrome.storage.local.get('completedMissions');
  return completedMissions;
}

async function dismissSavedMission(id) {
  const saved = await getSavedMissions();
  const remaining = saved.filter(m => m.id !== id);
  await chrome.storage.local.set({ savedMissions: remaining });
}

/**
 * restoreSavedMission(id)
 *
 * Re-opens the saved mission's tabs and makes it the active mission.
 * If there's already an active mission, it's saved-for-later first
 * (so users can quickly switch back and forth).
 */
async function restoreSavedMission(id) {
  const saved = await getSavedMissions();
  const target = saved.find(m => m.id === id);
  if (!target) return;

  // Park the active mission first (if any). saveMissionForLater appends
  // it to savedMissions; we re-read storage at the end before dropping
  // the target, so that parked entry is preserved.
  const current = await getCurrentMission();
  if (current && current.tabUrls && current.tabUrls.length > 0) {
    await saveMissionForLater();
  }

  // Re-open every URL
  const tabIds = [];
  for (const url of target.tabUrls) {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabIds.push(tab.id);
    } catch (err) {
      console.warn('[mission] could not reopen', url, err);
    }
  }

  // Make it the active mission and group the new tabs
  const newMission = {
    name:       target.name,
    tabUrls:    [...target.tabUrls],
    tabGroupId: null,
    color:      target.color || MISSION_GROUP_COLOR,
    createdAt:  new Date().toISOString(),
  };
  if (tabIds.length > 0) {
    newMission.tabGroupId = await ensureMissionGroup(newMission, tabIds);
  }
  await setCurrentMission(newMission);

  // Only after restore succeeds — drop the saved entry. Any throw above
  // leaves it in the sidebar so the user can retry. Re-read because
  // saveMissionForLater may have appended the parked current.
  const latest = await getSavedMissions();
  await chrome.storage.local.set({
    savedMissions: latest.filter(m => m.id !== id),
  });
}

/**
 * syncMissionWithOpenTabs()
 *
 * Reconciles the persisted mission with what's actually open right now:
 * - If the chrome tab group still exists, its contents are the source
 *   of truth (covers navigations within mission tabs).
 * - Otherwise, we fall back to the stored tabUrls and try to re-create
 *   the group from any matching open tabs.
 * Called early in the dashboard render.
 */
async function syncMissionWithOpenTabs() {
  const mission = await getCurrentMission();
  if (!mission) return null;

  let groupTabs = [];
  const groupIds = uniqueIds([
    mission.tabGroupId,
    ...(Array.isArray(mission.tabGroupIds) ? mission.tabGroupIds : []),
  ]);
  const validGroupIds = [];
  for (const groupId of groupIds) {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      groupTabs.push(...tabs);
      validGroupIds.push(groupId);
    } catch {}
  }
  mission.tabGroupIds = validGroupIds;
  mission.tabGroupId = validGroupIds.includes(mission.tabGroupId)
    ? mission.tabGroupId
    : (validGroupIds[0] ?? null);

  if (groupTabs.length > 0) {
    const rawUrls = groupTabs.map(effectiveTabUrl).filter(Boolean);
    // Only overwrite if we got URLs for every tab. Otherwise the tabs
    // are still loading (pendingUrl unavailable for some) and we'd
    // lose data. Keep the existing tabUrls in that case.
    if (rawUrls.length === groupTabs.length) {
      const newUrls = rawUrls.filter(isMissionableUrl);
      const liveTabs = await findTabsByUrls(mission.tabUrls);
      const liveUrlSet = new Set(liveTabs.map(effectiveTabUrl).filter(Boolean));
      mission.tabUrls = mergeUrls(
        mission.tabUrls.filter(url => liveUrlSet.has(url) && isMissionableUrl(url)),
        newUrls
      );
    }
  } else {
    // Group is gone (browser restart, etc.) — try to rebuild from stored URLs
    const tabs = await findTabsByUrls(mission.tabUrls);
    if (tabs.length > 0) {
      mission.tabGroupId = await ensureMissionGroup(mission, tabs.map(t => t.id));
      mission.tabUrls = mergeUrls(mission.tabUrls, tabs.map(effectiveTabUrl).filter(isMissionableUrl));
    } else {
      mission.tabGroupId = null;
      mission.tabGroupIds = [];
      // tabUrls stays — survives even if Chrome didn't restore the tabs
    }
  }

  await setCurrentMission(mission);
  await clearSourceNoteIfMissionStarted(mission);
  return mission;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
let closeAudioContext = null;

function playCloseSound() {
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;

    if (!closeAudioContext || closeAudioContext.state === 'closed') {
      closeAudioContext = new AudioCtor();
    }

    const ctx = closeAudioContext;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

function celebrateMissionComplete(sourceEl) {
  const rect = sourceEl?.getBoundingClientRect?.() ||
    document.querySelector('.mission-active')?.getBoundingClientRect();

  if (!rect) {
    shootConfetti(window.innerWidth / 2, window.innerHeight / 3);
    return;
  }

  const y = rect.top + Math.min(rect.height * 0.45, 120);
  shootConfetti(rect.left + rect.width * 0.25, y);
  setTimeout(() => shootConfetti(rect.left + rect.width * 0.5, y - 12), 90);
  setTimeout(() => shootConfetti(rect.left + rect.width * 0.75, y), 180);
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  const now = new Date();
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  }) + ` (${getYearCountdown(now)})`;
}

function getYearCountdown(now = new Date()) {
  const endOfYear = new Date(now.getFullYear() + 1, 0, 1);
  const totalHours = Math.max(0, Math.ceil((endOfYear - now) / (1000 * 60 * 60)));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h left`;
}

function getTimeDisplay() {
  return new Date().toLocaleTimeString('en-GB', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function renderHeaderTime() {
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  const timeEl     = document.getElementById('timeDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  if (timeEl)     timeEl.textContent     = getTimeDisplay();
  renderTimeMorse();
}

function getIsoWeekday(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function getDayOfYear(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

function getDaysInYear(date = new Date()) {
  const year = date.getFullYear();
  return new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
}

function getMorseColor(index, total, current) {
  if (index <= current) {
    const gray = Math.max(38, 142 - (current - index) * 3);
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const progress = (index - current) / Math.max(1, total - current);
  const r = Math.round(115 - progress * 28);
  const g = Math.round(102 - progress * 51);
  const b = Math.round(150 + progress * 13);
  return `rgb(${r}, ${g}, ${b})`;
}

function buildMorseMarks(total, current, mode) {
  let html = '';
  for (let i = 1; i <= total; i++) {
    const isCurrent = i === current;
    const isDash = mode === 'week'
      ? i <= 5
      : (i % 7 === 1 || i === current);
    const classes = [
      'morse-mark',
      isDash ? 'morse-dash' : 'morse-dot',
      i < current ? 'is-past' : '',
      isCurrent ? 'is-current' : '',
    ].filter(Boolean).join(' ');
    html += `<span class="${classes}" style="--morse-color:${getMorseColor(i, total, current)}" title="${mode === 'week' ? `Day ${i} of 7` : `Day ${i} of ${total}`}"></span>`;
  }
  return html;
}

let morseRenderedKey = '';

function renderTimeMorse() {
  const weekEl = document.getElementById('morseWeek');
  const yearEl = document.getElementById('morseYear');
  if (!weekEl || !yearEl) return;

  const now = new Date();
  const weekday = getIsoWeekday(now);
  const dayOfYear = getDayOfYear(now);
  const daysInYear = getDaysInYear(now);
  const renderKey = `${now.getFullYear()}-${weekday}-${dayOfYear}-${daysInYear}`;
  if (renderKey === morseRenderedKey) return;
  morseRenderedKey = renderKey;

  weekEl.innerHTML = buildMorseMarks(7, weekday, 'week');
  yearEl.innerHTML = buildMorseMarks(daysInYear, dayOfYear, 'year');
}

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  check:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>`,
  arrowUp: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19.5v-15m0 0-6.75 6.75M12 4.5l6.75 6.75" /></svg>`,
  arrowDown: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

/* URLs that are part of the active mission. Refreshed each render and
   used by renderDomainCard to highlight matching chips. */
let missionUrlSet = new Set();


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. Automatic cleanup now runs
 * before render, so this banner is only a fallback if cleanup did not
 * complete for some reason.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const missionClass = missionUrlSet.has(tab.url) ? ' is-mission-tab' : '';
    const chipClass = (count > 1 ? ' chip-has-dupes' : '') + missionClass;
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-add-mission" data-action="add-to-mission" data-tab-url="${safeUrl}" title="Add to mission (⌘⇧M from current tab)">
          ${ICONS.arrowUp}
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const missionClass = missionUrlSet.has(tab.url) ? ' is-mission-tab' : '';
    const chipClass = (count > 1 ? ' chip-has-dupes' : '') + missionClass;
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-add-mission" data-action="add-to-mission" data-tab-url="${safeUrl}" title="Add to mission (⌘⇧M from current tab)">
          ${ICONS.arrowUp}
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   CURRENT MISSION — Render the section above Open Tabs
   ---------------------------------------------------------------- */

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMissionNotes(notes) {
  const noteItems = notes.map((note, i) => {
    const idx = String(i + 1).padStart(2, '0');
    return `
      <div class="mission-note-item" data-note-id="${note.id}">
        <span class="note-idx">${idx}</span>
        <input class="mission-note-item-input" data-note-id="${note.id}" type="text" value="${escapeHtml(note.text)}" placeholder="Idea..." spellcheck="true">
        <div class="mission-note-actions">
          <button class="mission-note-action mission-note-promote" data-action="promote-mission-note" data-note-id="${note.id}" title="Promote to mission title">${ICONS.arrowUp}</button>
          <button class="mission-note-action mission-note-delete" data-action="delete-mission-note" data-note-id="${note.id}" title="Delete idea">${ICONS.close}</button>
        </div>
      </div>`;
  }).join('');

  const newIdx = String(notes.length + 1).padStart(2, '0');
  const itemLabel = `${notes.length} ${notes.length === 1 ? 'item' : 'items'}`;

  return `
    <div class="notes-block">
      <div class="notes-section-header">
        <button class="notes-section-label" id="notesToggleBtn" type="button" title="Click to collapse / expand notes" aria-label="Toggle notes section">
          Quick Notes<span class="notes-toggle-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="notes-section-line"></div>
        <span class="notes-section-meta">${itemLabel}</span>
      </div>

      <div class="mission-note">
        <div class="quick-notes-pane">
          <div class="mission-note-list">
            ${noteItems}
            <div class="mission-note-new-row">
              <span class="note-idx">${newIdx}</span>
              <input class="mission-note-new-input" id="missionNoteNewInput" type="text" placeholder="new note…" spellcheck="true">
              <span class="new-enter-icon" aria-hidden="true">↵</span>
            </div>
          </div>
          <span class="status-pill status-pill-floating" id="missionNoteStatus"></span>
        </div>

      </div>
    </div>`;
}

/**
 * renderMissionSection()
 *
 * Two visual states:
 *   - No mission:    a dashed drop-zone inviting the first drag.
 *   - Active mission: a card with header (name + Ungroup/Close all)
 *                     and a grid of mission tab cards.
 * If the mission has no name yet (the moment after first drop), we
 * show an auto-focused inline input for naming.
 */
async function renderMissionSection() {
  const section = document.getElementById('missionSection');
  if (!section) return;

  let mission = await getCurrentMission();
  mission = await clearSourceNoteIfMissionStarted(mission);
  const notes = await getMissionNotes();
  const noteHtml = renderMissionNotes(notes);

  // Quick notes live in their own container — keep mission board and notes
  // visually separate even though they share the same `notes` data.
  const notesContainer = document.getElementById('quickNotesSection');
  if (notesContainer) notesContainer.innerHTML = noteHtml;

  // Focus mode: when there's an active mission, dim other sections; mission
  // wins the spotlight unless another focus-target is hovered/focused.
  document.body.classList.toggle('has-active-mission', !!mission);

  if (!mission) {
    // Show the editorial section header even in the empty state so the
    // title sits at the same level as "№ 06 SAVED MISSIONS" on the right.
    section.innerHTML = `
      <div class="mission-section-header">
        <span class="mission-label">Mission</span>
        <div class="mission-section-line"></div>
        <span class="mission-count">0 tabs</span>
      </div>
      <div class="mission-block mission-block-empty" data-mission-drop>
        <div class="mission-empty">
          <div class="mission-empty-title">Drag a tab here to start a mission</div>
          <div class="mission-empty-hint">It'll get a colored label in your tab bar so you can find it again.</div>
        </div>
      </div>`;
    return;
  }

  // Active mission — render header + tab grid
  const tabUrls = mission.tabUrls || [];
  const liveTabsByUrl = {};
  for (const t of openTabs) liveTabsByUrl[t.url] = t;

  const missionTabCards = tabUrls.map(url => {
    const tab   = liveTabsByUrl[url];
    const title = tab
      ? cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '')
      : url;
    let domain = '';
    try { domain = new URL(url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    const safeUrl    = url.replace(/"/g, '&quot;');
    const safeTitle  = (title || '').replace(/"/g, '&quot;');
    return `<div class="mission-tab" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="mission-tab-text">${escapeHtml(title)}</span>
      <div class="mission-tab-actions">
        <button class="mission-tab-action mission-tab-ungroup" data-action="remove-from-mission" data-tab-url="${safeUrl}" title="Ungroup — release this tab back to Open Tabs">
          ${ICONS.arrowDown}
        </button>
        <button class="mission-tab-action mission-tab-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="mission-tab-action mission-tab-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  const isUnnamed = !mission.name;
  // Variant A · Nuri: title row (label + count) is rendered OUTSIDE the
  // purple slab so it lives at page level, aligned with other section
  // headers like "№ 06 SAVED MISSIONS" on the right column.
  const nameMarkup = isUnnamed
    ? `<input type="text" class="mission-name-input" id="missionNameInput" placeholder="Name this mission… Enter">`
    : `<span class="mission-name" data-action="edit-mission-name">${escapeHtml(mission.name)}</span>`;
  const tabCountMarkup = isUnnamed
    ? ''
    : `<span class="mission-count">${tabUrls.length} tab${tabUrls.length !== 1 ? 's' : ''}</span>`;

  section.innerHTML = `
    <div class="mission-section-header">
      <span class="mission-label">Mission</span>
      <div class="mission-section-line"></div>
      ${tabCountMarkup}
    </div>
    <div class="mission-active" data-mission-drop>
      <div class="mission-header">
        <div class="mission-header-left">${nameMarkup}</div>
        <div class="mission-controls">
          <button class="action-btn complete-mission" data-action="complete-mission" title="Mark this mission complete and close its tabs">${ICONS.check} Done</button>
          <button class="action-btn save-tabs" data-action="save-mission-for-later" title="Save this mission for later — closes its tabs and parks it in the sidebar so you can restore it">Save for later</button>
          <button class="action-btn" data-action="end-mission-ungroup" title="Release these tabs back to the open tabs section">Ungroup</button>
          <button class="action-btn close-tabs" data-action="end-mission-close-all" title="Close all mission tabs">Close all</button>
        </div>
      </div>
      <div class="mission-tabs">
        ${missionTabCards}
        <div class="mission-add-hint">Drag a tab here to add</div>
      </div>
    </div>`;

  // Auto-focus the naming input when it appears
  const input = document.getElementById('missionNameInput');
  if (input) {
    input.focus();
    input.select();
  }
}


/* ----------------------------------------------------------------
   SAVED MISSIONS — Render the sidebar of parked missions
   ---------------------------------------------------------------- */

function renderSavedMissionItem(mission) {
  const tabCount = (mission.tabUrls || []).length;
  const ago      = timeAgo(mission.savedAt);
  return `
    <div class="saved-mission-item" data-mission-id="${mission.id}">
      <div class="saved-mission-info">
        <button class="saved-mission-title" data-action="restore-mission" data-mission-id="${mission.id}" title="Restore this mission">${escapeHtml(mission.name)}</button>
        <div class="saved-mission-meta">
          <span>${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="saved-mission-dismiss" data-action="dismiss-saved-mission" data-mission-id="${mission.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function renderCompletedMissionItem(mission) {
  const tabCount = (mission.tabUrls || []).length;
  const completedAt = mission.completedAt ? new Date(mission.completedAt) : null;
  const time = completedAt
    ? completedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';
  const tabDetails = (mission.tabs && mission.tabs.length > 0)
    ? mission.tabs
    : (mission.tabUrls || []).map(url => {
        let domain = '';
        try { domain = new URL(url).hostname; } catch {}
        return { title: domain || url, domain, url };
      });
  const detailItems = tabDetails.map(tab => `
    <li class="completed-tab-item">
      <span class="completed-tab-title">${escapeHtml(tab.title || tab.domain || tab.url || 'Untitled tab')}</span>
      ${tab.domain ? `<span class="completed-tab-domain">${escapeHtml(tab.domain)}</span>` : ''}
    </li>`).join('');

  return `
    <div class="completed-mission-item" data-mission-id="${mission.id}">
      <div class="completed-check">${ICONS.check}</div>
      <div class="saved-mission-info">
        <div class="saved-mission-title completed-mission-title">${escapeHtml(mission.name || 'Untitled mission')}</div>
        <div class="saved-mission-meta">
          <span>${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
          <span>${time}</span>
        </div>
        ${detailItems ? `
          <details class="completed-mission-details">
            <summary>Show tabs</summary>
            <ul class="completed-tab-list">${detailItems}</ul>
          </details>
        ` : ''}
      </div>
    </div>`;
}

const SAVED_MISSIONS_COLLAPSED_KEY = 'savedMissionsCollapsed';
const COMPLETED_COLLAPSED_KEY = 'completedTodayCollapsed';

async function renderSavedMissionsColumn() {
  const column = document.getElementById('savedMissionsColumn');
  if (!column) return;

  const saved = await getSavedMissions();
  const completed = await getCompletedMissions();
  const today = new Date();
  const completedToday = completed.filter(m =>
    m.completedAt && isSameLocalDay(new Date(m.completedAt), today)
  );

  if (saved.length === 0 && completedToday.length === 0) {
    column.style.display = 'none';
    column.innerHTML = '';
    return;
  }

  // Newest first
  const sorted = [...saved].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  const completedSorted = [...completedToday]
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  const savedCollapsedStored = await chrome.storage.local.get(SAVED_MISSIONS_COLLAPSED_KEY);
  const savedCollapsed = !!savedCollapsedStored[SAVED_MISSIONS_COLLAPSED_KEY]; // default expanded

  // Completed-today defaults to collapsed (so finished work doesn't fight
  // for attention with active "Saved missions"). The user can toggle to
  // expand; the explicit state persists in chrome.storage.local.
  const collapsedStored = await chrome.storage.local.get(COMPLETED_COLLAPSED_KEY);
  const completedCollapsed = collapsedStored[COMPLETED_COLLAPSED_KEY] !== false; // default true

  column.style.display = 'block';
  column.innerHTML = `
    ${saved.length > 0 ? `
      <div class="saved-missions-section ${savedCollapsed ? 'is-collapsed' : ''}">
        <div class="section-header saved-missions-header">
          <button class="saved-missions-toggle" id="savedMissionsToggleBtn" type="button" title="Click to collapse / expand">
            Saved missions<span class="saved-missions-toggle-chevron" aria-hidden="true">▾</span>
          </button>
          <div class="section-line"></div>
          <div class="section-count">${saved.length}</div>
        </div>
        <div class="saved-missions-list">
          ${sorted.map(renderSavedMissionItem).join('')}
        </div>
      </div>
    ` : ''}
    ${completedSorted.length > 0 ? `
      <div class="completed-missions-section ${completedCollapsed ? 'is-collapsed' : ''}">
        <div class="section-header completed-missions-header">
          <button class="completed-toggle" id="completedToggleBtn" type="button" title="Click to collapse / expand">
            Completed today<span class="completed-toggle-chevron" aria-hidden="true">▾</span>
          </button>
          <div class="section-line"></div>
          <div class="section-count">${completedSorted.length}</div>
        </div>
        <div class="completed-missions-list">
          ${completedSorted.map(renderCompletedMissionItem).join('')}
        </div>
      </div>
    ` : ''}`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  renderHeaderTime();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  await autoCloseTabOutDupes();
  const realTabs = getRealTabs();

  // --- Reconcile the persisted mission with what's actually open,
  //     then update the highlight set used by domain-card chips.
  const mission = await syncMissionWithOpenTabs();
  missionUrlSet = new Set(mission ? mission.tabUrls : []);

  // Render the mission row (active mission + saved missions sidebar)
  await renderMissionSection();
  await renderSavedMissionsColumn();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Remove a tab from the current mission ----
  if (action === 'remove-from-mission') {
    e.stopPropagation(); // don't bubble to the mission tab's focus-tab
    const url = actionEl.dataset.tabUrl;
    if (!url) return;
    await removeTabFromMission(url);
    await renderDashboard();
    return;
  }

  // ---- Add an open tab directly to the active mission ----
  if (action === 'add-to-mission') {
    e.stopPropagation(); // don't trigger parent chip focus
    const url = actionEl.dataset.tabUrl;
    if (!url) return;
    await addTabToMission(url);
    await renderDashboard();
    setTimeout(() => document.getElementById('missionNameInput')?.focus(), 50);
    showToast('Added to mission');
    return;
  }

  // ---- Save the whole active mission to the sidebar ----
  if (action === 'save-mission-for-later') {
    const mission = await getCurrentMission();
    const count   = mission ? mission.tabUrls.length : 0;
    if (count === 0) {
      showToast('Nothing to save');
      return;
    }
    await saveMissionForLater();
    await renderDashboard();
    showToast(`Mission saved (${count} tab${count !== 1 ? 's' : ''})`);
    return;
  }

  // ---- Mark the active mission complete, close its tabs, and log it ----
  if (action === 'complete-mission') {
    const mission = await getCurrentMission();
    const count   = mission ? mission.tabUrls.length : 0;
    if (count === 0) {
      showToast('Nothing to complete');
      return;
    }

    playCloseSound();
    celebrateMissionComplete(actionEl.closest('.mission-active') || actionEl);
    const completed = await completeCurrentMission();
    await renderDashboard();
    showToast(`${completed.name} completed`);
    return;
  }

  // ---- Promote a quick note into a new active mission title ----
  if (action === 'promote-mission-note') {
    e.stopPropagation();
    const id = actionEl.dataset.noteId;
    if (!id) return;
    const input = actionEl.closest('.mission-note-item')?.querySelector('.mission-note-item-input');
    if (input) await updateMissionNote(id, input.value);
    const title = await promoteMissionNoteToTitle(id);
    await renderDashboard();
    showToast(title ? 'New mission started' : 'Add a note first');
    return;
  }

  // ---- Delete a quick note ----
  if (action === 'delete-mission-note') {
    e.stopPropagation();
    const id = actionEl.dataset.noteId;
    if (!id) return;
    await deleteMissionNote(id);
    await renderMissionSection();
    return;
  }

  // ---- Restore a saved mission as the active mission ----
  if (action === 'restore-mission') {
    const id = actionEl.dataset.missionId;
    if (!id) return;
    await restoreSavedMission(id);
    await renderDashboard();
    showToast('Mission restored');
    return;
  }

  // ---- Dismiss a saved mission permanently ----
  if (action === 'dismiss-saved-mission') {
    e.stopPropagation();
    const id = actionEl.dataset.missionId;
    if (!id) return;

    const item = actionEl.closest('.saved-mission-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(async () => {
        await dismissSavedMission(id);
        await renderSavedMissionsColumn();
      }, 250);
    } else {
      await dismissSavedMission(id);
      await renderSavedMissionsColumn();
    }
    return;
  }

  // ---- End the mission, releasing tabs (ungroup) ----
  if (action === 'end-mission-ungroup') {
    await endMissionUngroup();
    await renderDashboard();
    showToast('Mission ended — tabs released');
    return;
  }

  // ---- End the mission, closing every tab in it ----
  if (action === 'end-mission-close-all') {
    const mission = await getCurrentMission();
    const count   = mission ? mission.tabUrls.length : 0;
    if (count > 0 && !confirm(`Close all ${count} mission tab${count !== 1 ? 's' : ''}?`)) return;
    playCloseSound();
    await endMissionCloseAll();
    await renderDashboard();
    showToast('Mission complete. Tabs closed.');
    return;
  }

  // ---- Click the mission name to rename it ----
  if (action === 'edit-mission-name') {
    const span    = actionEl;
    const current = span.textContent;
    const input   = document.createElement('input');
    input.type      = 'text';
    input.id        = 'missionNameInput';
    input.className = 'mission-name-input';
    input.value     = current;
    span.replaceWith(input);
    input.focus();
    input.select();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    playCloseSound();
    await closeTabOutDupes();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    playCloseSound();

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    playCloseSound();

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // If this URL was part of the mission, drop it from mission state too.
    // (background.js's onRemoved listener also does this, but doing it here
    // synchronously avoids a race when we re-render the mission section.)
    const mission = await getCurrentMission();
    const wasMissionTab = mission && mission.tabUrls.includes(tabUrl);
    if (wasMissionTab) await removeTabFromMission(tabUrl);

    // Animate the source UI element out (chip in domain card OR mission tab card)
    const sourceEl = actionEl.closest('.page-chip') || actionEl.closest('.mission-tab');
    if (sourceEl) {
      sourceEl.style.transition = 'opacity 0.2s, transform 0.2s';
      sourceEl.style.opacity    = '0';
      sourceEl.style.transform  = 'scale(0.8)';
      setTimeout(() => sourceEl.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    if (wasMissionTab) {
      // Wait for the fade-out before re-rendering, so the user sees the animation
      setTimeout(() => renderMissionSection(), 220);
    }
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    playCloseSound();

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) animateCardOut(card);

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    playCloseSound();
    await closeDuplicateTabs(urls, true);

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    playCloseSound();
    await closeTabsByUrls(allUrls);

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.classList.contains('mission-note-item-input')) {
    scheduleMissionNoteSave(e.target.dataset.noteId, e.target.value);
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

const missionNoteSaveTimers = new Map();

function scheduleMissionNoteSave(id, value) {
  const status = document.getElementById('missionNoteStatus');
  if (status) status.textContent = 'Saving';

  if (missionNoteSaveTimers.has(id)) clearTimeout(missionNoteSaveTimers.get(id));
  missionNoteSaveTimers.set(id, setTimeout(async () => {
    await updateMissionNote(id, value);
    missionNoteSaveTimers.delete(id);
    const currentStatus = document.getElementById('missionNoteStatus');
    if (currentStatus) {
      currentStatus.textContent = 'Saved';
      setTimeout(() => {
        if (currentStatus.textContent === 'Saved') currentStatus.textContent = '';
      }, 1200);
    }
  }, 350));
}

function isTextEntryTarget(target) {
  return target && (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}

let textCompositionInProgress = false;
let ignoreNextTopSearchSubmit = false;

function isComposingText(e) {
  return Boolean(e.isComposing || e.keyCode === 229 || textCompositionInProgress);
}

document.addEventListener('compositionstart', () => {
  textCompositionInProgress = true;
}, true);

document.addEventListener('compositionend', () => {
  setTimeout(() => {
    textCompositionInProgress = false;
  }, 0);
}, true);

function focusSearchBox() {
  const searchInput = document.getElementById('topSearchInput');
  if (!searchInput) return false;
  searchInput.focus();
  searchInput.select?.();
  return true;
}

function getSearchTarget(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;

  const looksLikeUrl =
    value.includes('.') ||
    value.startsWith('localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(value);

  if (looksLikeUrl && !/\s/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

document.getElementById('topSearchForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (ignoreNextTopSearchSubmit) {
    ignoreNextTopSearchSubmit = false;
    return;
  }

  const target = getSearchTarget(document.getElementById('topSearchInput')?.value);
  if (target) window.location.href = target;
});

document.addEventListener('keydown', async (e) => {
  if (e.target.id === 'topSearchInput' && e.key === 'Enter' && isComposingText(e)) {
    ignoreNextTopSearchSubmit = true;
    setTimeout(() => {
      ignoreNextTopSearchSubmit = false;
    }, 150);
    return;
  }

  if (
    e.key === '/' &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !isTextEntryTarget(e.target)
  ) {
    if (focusSearchBox()) e.preventDefault();
    return;
  }

  if (e.target.id !== 'missionNoteNewInput') return;

  if (e.key === 'Enter') {
    if (isComposingText(e)) return;
    e.preventDefault();
    const note = await addMissionNote(e.target.value);
    if (!note) return;
    await renderMissionSection();
    document.getElementById('missionNoteNewInput')?.focus();
  }
});


// ─── Drag and drop: drop a chip onto the mission section to add it ───────────

document.addEventListener('dragstart', (e) => {
  const chip = e.target.closest('.page-chip');
  if (!chip) return;
  const url = chip.dataset.tabUrl;
  if (!url) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', url);
  chip.classList.add('dragging');
  // Highlight the drop zone for the duration of the drag
  document.getElementById('missionSection')?.classList.add('drop-active');
});

document.addEventListener('dragend', (e) => {
  const chip = e.target.closest('.page-chip');
  if (chip) chip.classList.remove('dragging');
  document.getElementById('missionSection')?.classList.remove('drop-active');
});

function isMissionDropArea(target) {
  return Boolean(target.closest('#missionSection'));
}

document.addEventListener('dragover', (e) => {
  if (!isMissionDropArea(e.target)) return;
  e.preventDefault();             // required to allow drop
  e.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', async (e) => {
  if (!isMissionDropArea(e.target)) return;
  e.preventDefault();
  const url = e.dataTransfer.getData('text/plain');
  if (!url) return;
  await addTabToMission(url);
  await renderDashboard();
  // If the mission needed naming, the input is now in the DOM — focus it.
  setTimeout(() => document.getElementById('missionNameInput')?.focus(), 50);
});

// ─── Refresh the mission card when its tabs finish loading ──────────────────
// After Restore (or any chrome.tabs.create), tabs initially have empty titles
// and pendingUrl placeholders. As each one loads, chrome.tabs.onUpdated fires
// with the real title — we re-render so the mission card shows real names
// instead of the URL fallback.

let _missionRenderTimer = null;
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only care about events that change what we render
  if (!changeInfo.title && !changeInfo.url && changeInfo.status !== 'complete') return;
  if (_missionRenderTimer) clearTimeout(_missionRenderTimer);
  _missionRenderTimer = setTimeout(async () => {
    await fetchOpenTabs();
    const m = await syncMissionWithOpenTabs();
    missionUrlSet = new Set(m ? m.tabUrls : []);
    await renderMissionSection();
  }, 350);
});

// ─── Mission name input: Enter saves, Escape cancels, blur saves ────────────

document.addEventListener('keydown', async (e) => {
  if (e.target.id !== 'missionNameInput') return;
  if (e.key === 'Enter') {
    if (isComposingText(e)) return;
    e.preventDefault();
    // Empty input → default to "Untitled" so the mission becomes operable
    // (otherwise isUnnamed=true keeps stealing focus back to the name field).
    const name = e.target.value.trim() || 'Untitled';
    await renameMission(name);
    await renderMissionSection();
  } else if (e.key === 'Escape') {
    e.target.blur();
  }
});

// Save on blur — capture phase because blur doesn't bubble
document.addEventListener('blur', async (e) => {
  if (e.target.id !== 'missionNameInput') return;
  const name = e.target.value.trim() || 'Untitled';
  await renameMission(name);
  await renderMissionSection();
}, true);


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */

// One-shot sanitize: strip non-missionable URLs (dashboard, chrome://, etc.)
// from any mission tabUrls in storage, and eject the dashboard tab itself
// if it got physically grouped into a mission group.
async function sanitizeMissionUrls() {
  try {
    const stored = await chrome.storage.local.get([
      'currentMission', 'savedMissions', 'completedMissions',
    ]);

    const sanitizeList = (arr) => {
      if (!Array.isArray(arr)) return false;
      let dirty = false;
      for (const m of arr) {
        if (!Array.isArray(m?.tabUrls)) continue;
        const cleaned = m.tabUrls.filter(isMissionableUrl);
        if (cleaned.length !== m.tabUrls.length) {
          m.tabUrls = cleaned;
          dirty = true;
        }
      }
      return dirty;
    };

    if (stored.currentMission && Array.isArray(stored.currentMission.tabUrls)) {
      const cleaned = stored.currentMission.tabUrls.filter(isMissionableUrl);
      if (cleaned.length !== stored.currentMission.tabUrls.length) {
        stored.currentMission.tabUrls = cleaned;
        await chrome.storage.local.set({ currentMission: stored.currentMission });
      }
    }
    if (sanitizeList(stored.savedMissions)) {
      await chrome.storage.local.set({ savedMissions: stored.savedMissions });
    }
    if (sanitizeList(stored.completedMissions)) {
      await chrome.storage.local.set({ completedMissions: stored.completedMissions });
    }

    // Eject any dashboard tab that got physically pulled into a tab group.
    const dashboardUrl = chrome.runtime.getURL('index.html');
    const dashboardTabs = await chrome.tabs.query({ url: dashboardUrl });
    const grouped = dashboardTabs.filter(t => t.groupId != null && t.groupId > -1);
    if (grouped.length > 0) {
      try { await chrome.tabs.ungroup(grouped.map(t => t.id)); } catch {}
    }
  } catch (err) {
    console.warn('[mission] sanitize failed:', err);
  }
}

(async () => {
  await sanitizeMissionUrls();
  renderDashboard();
})();
renderHeaderTime();
setInterval(renderHeaderTime, 1000);



(async () => {
  // Notes section collapse — persisted via chrome.storage.local.
  const NOTES_COLLAPSED_KEY = 'notesCollapsed';
  const stored = await chrome.storage.local.get(NOTES_COLLAPSED_KEY);
  document.body.classList.toggle('notes-collapsed', !!stored[NOTES_COLLAPSED_KEY]);

  // Delegated listener — the toggle button gets re-rendered each time the
  // mission section refreshes, so binding once on the stable container.
  const notesHost = document.getElementById('quickNotesSection');
  if (notesHost) {
    notesHost.addEventListener('click', async (e) => {
      const btn = e.target.closest('#notesToggleBtn');
      if (!btn) return;
      const next = !document.body.classList.contains('notes-collapsed');
      document.body.classList.toggle('notes-collapsed', next);
      await chrome.storage.local.set({ [NOTES_COLLAPSED_KEY]: next });
      btn.blur();
    });
  }

  // Saved / completed mission collapse toggles on the saved-missions sidebar.
  const savedHost = document.getElementById('savedMissionsColumn');
  if (savedHost) {
    savedHost.addEventListener('click', async (e) => {
      const savedBtn = e.target.closest('#savedMissionsToggleBtn');
      if (savedBtn) {
        const section = savedBtn.closest('.saved-missions-section');
        if (!section) return;
        const willCollapse = !section.classList.contains('is-collapsed');
        section.classList.toggle('is-collapsed', willCollapse);
        await chrome.storage.local.set({ [SAVED_MISSIONS_COLLAPSED_KEY]: willCollapse });
        savedBtn.blur();
        return;
      }

      const btn = e.target.closest('#completedToggleBtn');
      if (!btn) return;
      const section = btn.closest('.completed-missions-section');
      if (!section) return;
      const willCollapse = !section.classList.contains('is-collapsed');
      section.classList.toggle('is-collapsed', willCollapse);
      await chrome.storage.local.set({ [COMPLETED_COLLAPSED_KEY]: willCollapse });
      btn.blur();
    });
  }
})();
