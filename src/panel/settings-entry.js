import { connect } from './host.js';
import { Settings } from './settings.js';

// Settings modals must never claim or retire a live reading panel.
async function main() {
  const host = await connect();
  document.body.classList.add('settings-only');
  try {
    let prefs = (await host.call('prefs_get')).prefs;
    const settings = new Settings({ call: host.call, getPrefs: () => prefs, onChange: next => { prefs = next; } });
    settings.open();
    document.getElementById('message').hidden = true;
    document.getElementById('settingsClose').onclick = () => {
      if (host.app) host.app.requestTeardown().catch(() => {});
      else settings.close();
    };
  } catch (e) {
    document.getElementById('message').hidden = false;
    document.getElementById('messageText').textContent = e.message;
  }
}
main();
