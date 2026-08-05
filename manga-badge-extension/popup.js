const content = document.getElementById('content');
const lastFetchedEl = document.getElementById('lastFetched');
const refreshBtn = document.getElementById('refreshBtn');
const optionsLink = document.getElementById('optionsLink');

let currentData = null; // last-loaded { counts, lists }
let currentSignature = ''; // fingerprint of which titles currently have new chapters
let dotDismissed = false;
let currentView = 'grid'; // 'grid' | status key

const STATUS_META = {
  ongoing:   { label: 'Ongoing',   cls: 'ongoing' },
  onHold:    { label: 'On Hold',   cls: 'hold' },
  completed: { label: 'Completed', cls: 'completed' },
  dropped:   { label: 'Dropped',   cls: 'dropped' }
};

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// A fingerprint of exactly which titles have a new chapter, and at what
// chapter number. Used so a dismissed dot only comes back once something
// *actually* changes (a new title gets a new chapter, or an existing one
// advances again) rather than reappearing on every routine refresh.
function computeSignature(lists) {
  const parts = [];
  Object.values(lists || {}).forEach(list => {
    list.forEach(m => {
      if (m.hasNew) parts.push(`${m.title}::${m.latest}`);
    });
  });
  return parts.sort().join('|');
}

function renderSetup() {
  content.innerHTML = `
    <div class="setup">
      <p>Point this at your Manga Tracker Web App URL to start seeing counts here.</p>
      <button id="setupBtn">Open Settings</button>
    </div>`;
  document.getElementById('setupBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function renderErrorState(message) {
  content.innerHTML = `
    <div class="state">
      <p class="err">Couldn't load your library.</p>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function renderGrid() {
  currentView = 'grid';
  const { counts } = currentData;

  const tile = (key) => {
    const meta = STATUS_META[key];
    return `
      <button class="stat ${meta.cls}" data-status="${key}">
        <div class="num">${counts[key]}</div>
        <div class="lbl">${meta.label}</div>
      </button>`;
  };

  const showDot = counts.newUpdates > 0 && !dotDismissed;
  const dot = showDot
    ? `<button class="notif-dot" id="notifDot" title="${counts.newUpdates} new chapter${counts.newUpdates === 1 ? '' : 's'} — click to dismiss">${counts.newUpdates}</button>`
    : '';

  content.innerHTML = `
    <div class="stats">
      ${tile('ongoing')}${tile('onHold')}${tile('completed')}${tile('dropped')}
      ${dot}
    </div>`;

  content.querySelectorAll('.stat').forEach(el => {
    el.addEventListener('click', () => renderList(el.dataset.status));
  });

  const dotEl = document.getElementById('notifDot');
  if (dotEl) {
    dotEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      dotDismissed = true;
      await chrome.storage.local.set({ dismissedNewSignature: currentSignature });
      dotEl.remove();
    });
  }
}

function renderList(statusKey) {
  currentView = statusKey;
  const meta = STATUS_META[statusKey];
  const list = currentData.lists[statusKey] || [];

  let html = `
    <div class="list-header">
      <button class="back-btn" id="backBtn">‹</button>
      <span class="list-title">${meta.label}</span>
      <span class="list-count">${list.length} title${list.length === 1 ? '' : 's'}</span>
    </div>`;

  if (list.length === 0) {
    html += `<div class="empty-list">Nothing here yet.</div>`;
  } else {
    html += '<div class="item-list">';
    list.forEach(m => {
      const chapterText = m.hasNew
        ? `${m.current || 0} → ${m.latest}`
        : `Ch. ${m.current || 0}`;
      html += `
        <a class="item ${m.hasNew ? 'has-new' : ''}" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">
          <span class="t">${escapeHtml(m.title)}</span>
          <span class="ch">${chapterText}</span>
        </a>`;
    });
    html += '</div>';
  }

  content.innerHTML = html;
  document.getElementById('backBtn').addEventListener('click', renderGrid);
}

async function load() {
  const { apiUrl, mangaData, dismissedNewSignature } = await chrome.storage.local.get(
    ['apiUrl', 'mangaData', 'dismissedNewSignature']
  );

  if (!apiUrl) {
    renderSetup();
    lastFetchedEl.textContent = '';
    return;
  }

  if (!mangaData) {
    // First run before background has fetched anything yet
    return;
  }

  if (mangaData.error && !mangaData.counts) {
    renderErrorState(mangaData.error);
  } else if (mangaData.counts) {
    currentData = mangaData;
    currentSignature = computeSignature(mangaData.lists);
    dotDismissed = currentSignature !== '' && currentSignature === dismissedNewSignature;

    // Preserve whichever view was open across a refresh
    if (currentView === 'grid') renderGrid();
    else renderList(currentView);
  }

  lastFetchedEl.textContent = mangaData.lastFetched
    ? `Updated ${formatRelativeTime(mangaData.lastFetched)}`
    : '';
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await chrome.runtime.sendMessage({ type: 'REFRESH_NOW' });
  await load();
  refreshBtn.classList.remove('spinning');
});

load();
