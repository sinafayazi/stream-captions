const DEFAULTS = { enabled: false, language: 'english', model: 'Xenova/whisper-tiny', task: 'transcribe', position: 'bottom-center' };

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'), language: $('language'), model: $('model'), position: $('position'),
  controls: $('controls'), notice: $('notice'), noticeText: $('notice-text'), noticeAction: $('notice-action'),
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => null);
}

// Sites listed in the manifest always have the content script; everything else
// is opt-in via an optional host permission the user grants per-origin.
const escRx = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// Chrome match pattern -> RegExp. Note `*.kick.com` matches the apex domain too,
// so it can't be a plain `*` -> `.*` substitution.
function patternToRegex(pattern) {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const [, scheme, host, path] = m;
  const hostRx = host === '*' ? '[^/]+'
    : host.startsWith('*.') ? '(?:[^/]+\\.)?' + escRx(host.slice(2))
    : escRx(host);
  return new RegExp(`^${scheme === '*' ? 'https?' : scheme}://${hostRx}${escRx(path).replace(/\*/g, '.*')}$`);
}

function isBuiltInSite(url) {
  return chrome.runtime.getManifest().content_scripts[0].matches
    .some((p) => patternToRegex(p)?.test(url));
}

function showNotice(text, actionLabel, onAction) {
  els.noticeText.textContent = text;
  els.notice.classList.remove('hidden');
  els.controls.classList.add('disabled');
  if (actionLabel) {
    els.noticeAction.textContent = actionLabel;
    els.noticeAction.classList.remove('hidden');
    els.noticeAction.onclick = onAction;
  } else {
    els.noticeAction.classList.add('hidden');
  }
}

function hideNotice() {
  els.notice.classList.add('hidden');
  els.controls.classList.remove('disabled');
}

// Load shared settings (language/model/position) into the UI.
chrome.storage.sync.get(DEFAULTS, (s) => {
  els.language.value = s.language;
  els.model.value = s.model;
  els.position.value = s.position;
});

// Inject the overlay into a tab we've just been granted access to, and register
// it persistently so it keeps working on that site after a reload.
async function injectInto(tab) {
  const origin = new URL(tab.url).origin + '/*';
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content/overlay.css'] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/overlay.js'] });
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'sc-' + new URL(tab.url).hostname,
      matches: [origin],
      js: ['src/content/overlay.js'],
      css: ['src/content/overlay.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } catch {
    // Already registered for this host — fine.
  }
}

async function enableOnThisSite(tab) {
  const origin = new URL(tab.url).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return;
  await injectInto(tab);
  hideNotice();
  els.enabled.checked = true;
  send(tab.id, { type: 'toggle', enabled: true });
}

// Captions are per-tab: reflect THIS tab's on/off state, not a global setting.
(async () => {
  const tab = await activeTab();
  if (!tab || !tab.url) return;

  const res = await send(tab.id, { type: 'status' });
  if (res) {
    els.enabled.checked = !!res.enabled;
    return;
  }

  // No content script on this tab — work out why and offer the fix.
  if (!/^https?:/.test(tab.url)) {
    showNotice('Stream Captions can’t run on this page.');
  } else if (isBuiltInSite(tab.url)) {
    showNotice('Reload this page to start captions.', 'Reload', async () => {
      await chrome.tabs.reload(tab.id);
      window.close();
    });
  } else {
    const host = new URL(tab.url).hostname;
    showNotice(`Captions aren’t enabled on ${host} yet.`, 'Enable on this site', () => enableOnThisSite(tab));
  }
})();

els.enabled.addEventListener('change', async () => {
  const enabled = els.enabled.checked;
  const tab = await activeTab();
  if (tab) send(tab.id, { type: 'toggle', enabled }); // toggles only this tab
});

async function pushConfig() {
  const config = {
    language: els.language.value,
    model: els.model.value,
    task: 'transcribe',
    position: els.position.value,
  };
  await chrome.storage.sync.set(config);
  const tab = await activeTab();
  if (tab) send(tab.id, { type: 'config', config });
}

els.language.addEventListener('change', pushConfig);
els.position.addEventListener('change', pushConfig); // applies live
els.model.addEventListener('change', pushConfig); // reloads the engine on the fly
