import type { Settings } from '../store';
import { AppInfo, SyncInfo } from './AppInfo';
import { CostInfo, Dislikes, ProspektInfo } from './Markets';

/** Einstellungen: Mag ich nicht, eingelesene Prospekte, KI-Kosten, App-Version */
export function SettingsView(p: { settings: Settings; updateSettings: (s: Partial<Settings>) => void; markets: number[]; onToggleDislike: (n: string) => void }) {
  const design = p.settings.design ?? 'klassisch';
  return (
    <>
      <h2 className="section-title title-dup">Einstellungen</h2>
      <section className="card">
        <h2>Aussehen</h2>
        <p className="muted small">Der Apple-Look folgt automatisch dem hellen oder dunklen Modus deines Geräts.</p>
        <div className="segmented two" role="radiogroup" aria-label="Aussehen">
          {(['klassisch', 'apple'] as const).map((d) => (
            <button key={d} role="radio" aria-checked={design === d} className={design === d ? 'on' : ''} onClick={() => p.updateSettings({ design: d })}>
              {d === 'klassisch' ? 'Klassisch' : 'Apple'}
            </button>
          ))}
        </div>
      </section>
      <Dislikes list={p.settings.dislikes ?? []} toggle={p.onToggleDislike} />
      <ProspektInfo markets={p.markets} />
      <CostInfo />
      <SyncInfo />
      <AppInfo />
    </>
  );
}
