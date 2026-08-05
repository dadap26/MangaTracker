const input = document.getElementById('apiUrlInput');
const saveBtn = document.getElementById('saveBtn');
const msg = document.getElementById('msg');

async function load() {
  const { apiUrl } = await chrome.storage.local.get('apiUrl');
  if (apiUrl) input.value = apiUrl;
}

saveBtn.addEventListener('click', async () => {
  const url = input.value.trim();
  if (!url) {
    msg.textContent = 'Paste your Web App URL first.';
    msg.style.color = '#FF6B6B';
    return;
  }

  await chrome.storage.local.set({ apiUrl: url });
  msg.style.color = '#4ECDC4';
  msg.textContent = 'Saved. Refreshing…';

  await chrome.runtime.sendMessage({ type: 'REFRESH_NOW' });
  msg.textContent = 'Saved and refreshed ✓';
});

load();
