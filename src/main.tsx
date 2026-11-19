import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './apple.css';
import { applyDesign, storedDesign } from './design';
import { registerSW } from 'virtual:pwa-register';
import { startSync } from './sync';

// Neue Versionen sofort übernehmen: die Seite lädt neu, sobald ein Update bereitliegt.
// Beim Zurückkehren in die App wird nach Updates gesucht.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => void updateSW(true),
  onRegisteredSW: (_url, reg) => {
    if (!reg) return;
    const check = () => void reg.update().catch(() => undefined);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(check, 30 * 60_000);
  },
});

applyDesign(storedDesign());
// Safari kann echte iOS-Schalter (<input type=checkbox switch>); sonst zeichnet das CSS einen nach
if ('switch' in HTMLInputElement.prototype) document.documentElement.classList.add('native-switch');
startSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
