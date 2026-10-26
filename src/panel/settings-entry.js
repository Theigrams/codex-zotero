import { connect } from './host.js';
import { Settings } from './settings.js';

// Settings modals must never claim or retire a live reading panel.
async function main() {
  const host = await connect({ displayModes: ['inline', 'fullscreen'] });
  document.body.classList.add('settings-only');
  try {
    let prefs = (await host.call('prefs_get')).prefs;
    const settings = new Settings({ call: host.call, getPrefs: () => prefs, onChange: next => { prefs = next; },
      openUrl:url=>host.app?host.app.openLink({url}):window.open(url,'_blank','noopener') });
    settings.open();
    document.getElementById('message').hidden = true;
    document.getElementById('settingsClose').onclick = () => {
      settings.close();
      if (host.app) host.app.requestTeardown().catch(() => {});
    };
  } catch (e) {
    document.getElementById('message').hidden = false;
    document.getElementById('messageText').textContent = e.message;
  }
}
main();
