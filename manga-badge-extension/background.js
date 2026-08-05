/* ============ Manga Tracker Badge — background service worker ============ */

const ALARM_NAME = 'mangaRefresh';
const REFRESH_MINUTES = 15;

const BADGE_COLOR = '#4ECDC4'; // teal, matches app palette — always this color now

/* Same normalization the frontend uses, so counts always match what
   you'd see in the app itself. */
function statusLabel(status) {
  return (status || 'Unsorted').toString().trim() || 'Unsorted';
}

function computeCounts(mangaList) {
  const counts = {
    ongoing: 0,      // Status = Reading
    onHold: 0,
    completed: 0,
    dropped: 0,
    newUpdates: 0,       // Latest Chapter > Current Chapter, across all statuses
    newOngoing: 0        // same, but scoped to Ongoing (Reading) only — used for the badge
  };

  const lists = { ongoing: [], onHold: [], completed: [], dropped: [] };
  const statusKeyMap = { 'reading': 'ongoing', 'on hold': 'onHold', 'completed': 'completed', 'dropped': 'dropped' };

  mangaList.forEach(m => {
    const status = statusLabel(m['Status']).toLowerCase();
    const key = statusKeyMap[status];

    const cur = parseFloat(m['Current Chapter']) || 0;
    const latest = parseFloat(m['Latest Chapter']) || 0;
    const hasNew = latest > 0 && latest > cur;
    if (hasNew) {
      counts.newUpdates++;
      if (key === 'ongoing') counts.newOngoing++;
    }

    if (key) {
      counts[key]++;
      lists[key].push({
        title: m['Title'] || 'Untitled',
        current: cur,
        latest: latest,
        url: m['URL'] || '',
        hasNew
      });
    }
  });

  Object.values(lists).forEach(list =>
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  );

  return { counts, lists };
}

async function updateBadge(counts) {
  // Badge now shows how many Ongoing (Reading) manga have a new chapter
  // waiting — not your total Ongoing count. Blank when none are new.
  const text = counts.newOngoing > 0 ? String(counts.newOngoing) : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

async function refreshData() {
  const { apiUrl } = await chrome.storage.local.get('apiUrl');

  if (!apiUrl) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  try {
    const res = await fetch(apiUrl, {
      method: 'get',
      redirect: 'follow',
      cache: 'no-store',
      // Force a fully anonymous request. Without this, host_permissions
      // makes the extension attach your Google account cookies, which can
      // get misrouted through the wrong signed-in account (u/1 vs u/0)
      // and land on a generic "not found" page instead of the public
      // Web App output — even though the deployment itself is public.
      credentials: 'omit'
    });

    // Diagnostics: visible in the extension's service worker console
    // (chrome://extensions -> this extension -> "Inspect views: service worker").
    console.log('[manga-badge] requested:', apiUrl);
    console.log('[manga-badge] final URL after redirects:', res.url);
    console.log('[manga-badge] status:', res.status, res.statusText);
    console.log('[manga-badge] redirected:', res.redirected);

    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => '');
      console.log('[manga-badge] response body preview:', bodyPreview.slice(0, 300));
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Unknown API error');

    const { counts, lists } = computeCounts(json.data || []);

    await chrome.storage.local.set({
      mangaData: { counts, lists, lastFetched: Date.now(), error: null }
    });
    await updateBadge(counts);
  } catch (err) {
    await chrome.storage.local.set({
      mangaData: {
        counts: null,
        lists: null,
        lastFetched: Date.now(),
        error: err.message
      }
    });
    // Keep the last-known badge rather than clearing it on a transient error
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_MINUTES });
  refreshData();
});

chrome.runtime.onStartup.addListener(() => {
  refreshData();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshData();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'REFRESH_NOW') {
    refreshData().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
});
