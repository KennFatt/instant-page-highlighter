const MODE_KEY = 'modeEnabled';

async function getModeEnabled() {
  const stored = await chrome.storage.local.get(MODE_KEY);
  return Boolean(stored[MODE_KEY]);
}

async function setBadge(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({
    color: enabled ? '#16a34a' : '#64748b',
  });
}

async function syncBadgeFromStorage() {
  const enabled = await getModeEnabled();
  await setBadge(enabled);
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(MODE_KEY);
  if (typeof stored[MODE_KEY] !== 'boolean') {
    await chrome.storage.local.set({ [MODE_KEY]: false });
  }
  await syncBadgeFromStorage();
});

chrome.runtime.onStartup.addListener(syncBadgeFromStorage);

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes[MODE_KEY]) {
    await setBadge(Boolean(changes[MODE_KEY].newValue));
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const current = await getModeEnabled();
  const next = !current;
  await chrome.storage.local.set({ [MODE_KEY]: next });
  await setBadge(next);

  if (tab.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'MODE_CHANGED',
        enabled: next,
      });
    } catch (error) {
      // Some browser-owned pages do not allow content scripts.
    }
  }
});
