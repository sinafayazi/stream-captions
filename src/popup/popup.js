const DEFAULTS = { enabled: false, language: 'auto', model: 'Xenova/whisper-base', task: 'transcribe' };

const $ = (id) => document.getElementById(id);
const els = { enabled: $('enabled'), language: $('language'), model: $('model'), task: $('task') };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// Load saved settings into the UI.
chrome.storage.sync.get(DEFAULTS, (s) => {
  els.enabled.checked = s.enabled;
  els.language.value = s.language;
  els.model.value = s.model;
  els.task.value = s.task;
});

els.enabled.addEventListener('change', async () => {
  const enabled = els.enabled.checked;
  await chrome.storage.sync.set({ enabled });
  const tab = await activeTab();
  if (tab) send(tab.id, { type: 'toggle', enabled });
});

async function pushConfig() {
  const config = { language: els.language.value, model: els.model.value, task: els.task.value };
  await chrome.storage.sync.set(config);
  const tab = await activeTab();
  if (tab) send(tab.id, { type: 'config', config });
}

els.language.addEventListener('change', pushConfig);
els.task.addEventListener('change', pushConfig);
els.model.addEventListener('change', pushConfig); // takes effect after tab reload
