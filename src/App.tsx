import { stripBio } from '../shared/bio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobInfo, Leaflet, Recipe, RecipeRequest, RecipesResponse } from '../shared/types';
import { api, loadLastRecipes, LoginError, useCart, useOffers, useSavedRecipes, useSettings, useShoppingList, useStores, useSyncReload, useTrip, write } from './store';
import { shortChain } from './format';
import { CookView, type GenState } from './views/Cook';
import { ShoppingView } from './views/Shopping';
import { SettingsView } from './views/Settings';
import { ListContext } from './actions';
import { OffersView } from './views/Offers';
import { MarketsView } from './views/Markets';
import { RecipeDetail } from './views/RecipeDetail';
import { LeafletView } from './views/LeafletView';

interface PendingJob {
  id: string;
  replaceId?: string;
}
const PENDING_KEY = 'recipeJob';
function readPending(): PendingJob | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null');
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}
function savePending(p: PendingJob | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* Speicher gesperrt – egal */
  }
}

type Tab = 'kochen' | 'angebote' | 'einkauf' | 'maerkte' | 'einstellungen';

export default function App() {
  const [settings, updateSettings] = useSettings();
  const [trip, setTrip] = useTrip();
  const [tab, setTab] = useState<Tab>(() => (settings.plz && settings.chains.length ? 'kochen' : 'maerkte'));

  // Aktive PLZ und Märkte: unterwegs die Reiseauswahl, sonst die Standard-Märkte
  const plz = trip?.plz ?? settings.plz;
  const baseChains = trip?.chains ?? settings.chains;
  const markets = trip?.markets ?? settings.markets ?? [];
  // Heute abgewählte Märkte (nur für diese Sitzung)
  const [skipToday, setSkipToday] = useState<string[]>([]);
  const activeChains = baseChains.filter((c) => !skipToday.includes(c));

  const offers = useOffers(plz || null, markets);
  const cart = useCart();
  const saved = useSavedRecipes();
  const [replacing, setReplacing] = useState<string | null>(null);
  const shopping = useShoppingList();
  const stores = useStores(plz || null);
  const [wishes, setWishes] = useState('');
  const [gen, setGen] = useState<GenState>({ loading: false, error: null, loginExpired: false, startedAt: 0 });
  const [results, setResults] = useState<RecipesResponse | null>(() => loadLastRecipes());
  useSyncReload(['lastRecipes'], () => setResults(loadLastRecipes()));
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [leaflet, setLeaflet] = useState<{ chain: string; leaflets: Leaflet[] } | null>(null);

  // Android-Zurück-Taste schließt Rezept- und Prospektansicht
  useEffect(() => {
    const onPop = () => {
      setDetail(null);
      setLeaflet(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openDetail = useCallback((r: Recipe) => {
    history.pushState({ detail: r.id }, '');
    setDetail(r);
    window.scrollTo(0, 0);
  }, []);
  const closeDetail = useCallback(() => history.back(), []);
  const openLeaflet = useCallback((chain: string, leaflets: Leaflet[]) => {
    history.pushState({ leaflet: chain }, '');
    setLeaflet({ chain, leaflets });
    window.scrollTo(0, 0);
  }, []);

  // Märkte sind eingerichtet; ob heute welche ausgewählt sind, prüft der Knopf
  const ready = !!plz && baseChains.length > 0;

  // Rezepte baut der Server im Hintergrund (Warteschlange). Die App legt nur den Auftrag an und holt das
  // Ergebnis ab – sofort, nach 5 Minuten oder nach Tagen. Die Auftrags-ID merkt sich der Browser.
  const [pending, setPending] = useState<PendingJob | null>(() => readPending());
  const [doneJobs, setDoneJobs] = useState<JobInfo[]>([]);
  // Schon abgeholte Aufträge: das Löschen auf dem Server ist evtl. noch nicht durch, wenn die Liste neu geladen wird
  const handledRef = useRef(new Set<string>());
  const resultsRef = useRef(results);
  resultsRef.current = results;

  const applyResult = useCallback((data: RecipesResponse, replaceId?: string) => {
    const cur = resultsRef.current;
    let next = data;
    if (replaceId) {
      // Nur das eine Rezept austauschen, Rest bleibt
      if (!cur || !data.recipes[0] || !cur.recipes.some((r) => r.id === replaceId)) return;
      const recipes = cur.recipes.map((r) => (r.id === replaceId ? data.recipes[0] : r)).sort((a, b) => a.perPortion - b.perPortion);
      next = { ...cur, recipes };
    }
    setResults(next);
    write('lastRecipes', next);
  }, []);

  const clearPending = useCallback(() => {
    savePending(null);
    setPending(null);
    setReplacing(null);
    setGen((g) => ({ ...g, loading: false }));
  }, []);

  // Auftrag abfragen, solange er läuft (auch nach dem Wiedereinschalten des Handys)
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api<{ job: JobInfo; result?: RecipesResponse }>(`/api/recipes/jobs/${pending.id}`);
        if (stop) return;
        if (r.job.status === 'done' && r.result) {
          handledRef.current.add(pending.id);
          applyResult(r.result, pending.replaceId);
          clearPending();
          void api(`/api/recipes/jobs/${pending.id}`, { method: 'DELETE' }).catch(() => undefined);
        } else if (r.job.status === 'failed') {
          handledRef.current.add(pending.id);
          setGen((g) => ({ ...g, error: r.job.error ?? 'Das Bauen der Rezepte ist fehlgeschlagen.' }));
          clearPending();
          void api(`/api/recipes/jobs/${pending.id}`, { method: 'DELETE' }).catch(() => undefined);
        } else if (pending.replaceId) setReplacing(pending.replaceId);
        else setGen((g) => (g.loading && g.startedAt === Date.parse(r.job.createdAt) ? g : { ...g, loading: true, error: null, startedAt: Date.parse(r.job.createdAt) }));
      } catch (e) {
        if (e instanceof LoginError) {
          setGen((g) => ({ ...g, error: e.message, loginExpired: true }));
          clearPending();
        } else if (e instanceof Error && /nicht gefunden/.test(e.message)) {
          clearPending(); // Auftrag gibt es nicht mehr (abgeholt oder abgelaufen)
        }
        // sonst: kurz keine Verbindung – beim nächsten Mal nochmal versuchen
      }
    };
    void tick();
    const t = window.setInterval(tick, 3000);
    const vis = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [pending?.id, pending?.replaceId, applyResult, clearPending]);

  // Fertige (oder von einem anderen Gerät gestartete) Aufträge finden
  const refreshJobs = useCallback(async () => {
    try {
      const { jobs } = await api<{ jobs: JobInfo[] }>('/api/recipes/jobs');
      const running = jobs.find((j) => j.status === 'queued' || j.status === 'running');
      if (running && !readPending()) {
        const p = { id: running.id, replaceId: running.replaceId };
        savePending(p);
        setPending(p);
      }
      setDoneJobs(jobs.filter((j) => (j.status === 'done' || j.status === 'failed') && j.id !== readPending()?.id && !handledRef.current.has(j.id)));
    } catch {
      /* offline oder abgemeldet – egal */
    }
  }, []);
  useEffect(() => {
    void refreshJobs();
    const vis = () => document.visibilityState === 'visible' && void refreshJobs();
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [refreshJobs, pending?.id]);

  const collectJob = useCallback(
    async (id: string, discard?: boolean) => {
      handledRef.current.add(id);
      try {
        if (!discard) {
          const r = await api<{ job: JobInfo; result?: RecipesResponse }>(`/api/recipes/jobs/${id}`);
          if (r.result) applyResult(r.result, r.job.replaceId);
        }
        await api(`/api/recipes/jobs/${id}`, { method: 'DELETE' });
      } catch (e) {
        setGen((g) => ({ ...g, error: e instanceof Error ? e.message : String(e) }));
      }
      setDoneJobs((l) => l.filter((j) => j.id !== id));
    },
    [applyResult],
  );

  const generate = useCallback(async (replaceId?: string) => {
    if (!ready || activeChains.length === 0 || gen.loading || replacing || pending) return;
    if (replaceId) setReplacing(replaceId);
    else setGen({ loading: true, error: null, loginExpired: false, startedAt: Date.now() });
    try {
      const body: RecipeRequest = {
        plz,
        chains: activeChains,
        markets,
        diet: settings.diet,
        persons: settings.persons,
        days: settings.days,
        maxMinutes: settings.maxMinutes,
        cart: cart.cart.map((o) => o.id),
        cartMode: settings.cartMode,
        wishes,
        dislikes: settings.dislikes ?? [],
        fast: settings.fast,
        replace: replaceId ? { avoidTitles: (results?.recipes ?? []).map((r) => r.title) } : undefined,
        replaceId,
      };
      const { job } = await api<{ job: JobInfo }>('/api/recipes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const p = { id: job.id, replaceId };
      savePending(p);
      setPending(p);
    } catch (e) {
      setReplacing(null);
      setGen((g) => ({ ...g, loading: false, error: e instanceof Error ? e.message : String(e), loginExpired: e instanceof LoginError }));
    }
  }, [ready, gen.loading, replacing, pending, plz, activeChains, markets, settings, cart.cart, wishes, results]);

  const toggleDislike = useCallback(
    (raw: string) => {
      const name = stripBio(raw);
      const d = settings.dislikes ?? [];
      const same = (x: string) => stripBio(x).toLowerCase() === name.toLowerCase();
      updateSettings({ dislikes: d.some(same) ? d.filter((x) => !same(x)) : [...d, name] });
    },
    [settings.dislikes, updateSettings],
  );

  const chainCounts = useMemo(() => {
    const m = new Map<string, number>();
    offers.data?.chains.forEach((c) => m.set(c.name, c.count));
    return m;
  }, [offers.data]);

  const listActions = { toggleListOffer: shopping.toggleOffer, isOnList: shopping.hasOffer };

  if (detail)
    return (
      <RecipeDetail
        recipe={detail}
        onBack={closeDetail}
        onList={() => shopping.toggleRecipe(detail)}
        onListNow={shopping.has(detail)}
        saved={saved.isSaved(detail)}
        onSave={() => saved.toggle(detail)}
        dislikes={settings.dislikes ?? []}
        onDislike={toggleDislike}
        have={shopping.have[detail.id] ?? []}
        onHave={(name) => shopping.toggleHave(detail.id, name)}
      />
    );
  if (leaflet)
    return (
      <ListContext.Provider value={listActions}>
      <LeafletView
        chain={leaflet.chain}
        leaflets={leaflet.leaflets}
        offers={(offers.data?.offers ?? []).filter((o) => o.chain === leaflet.chain)}
        onBack={closeDetail}
        onToggleCart={cart.toggle}
        inCart={cart.ids}
      />
      </ListContext.Provider>
    );

  return (
    <ListContext.Provider value={listActions}>
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <h1 className="brand">Angebotsküche</h1>
          {plz && (
            <button className="plz-pill" onClick={() => setTab('maerkte')} aria-label="Märkte und PLZ ändern">
              {trip ? 'Unterwegs' : 'Zuhause'} · {plz}
            </button>
          )}
          <button className={`gear ${tab === 'einstellungen' ? 'on' : ''}`} onClick={() => setTab('einstellungen')} aria-label="Einstellungen">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>
        {baseChains.length > 0 && (
          <div className="chain-row" role="group" aria-label="Heute einkaufen bei">
            {baseChains.map((c) => {
              const on = !skipToday.includes(c);
              return (
                <button
                  key={c}
                  className={`chain-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setSkipToday((s) => (on ? [...s, c] : s.filter((x) => x !== c)))}
                >
                  {shortChain(c)}
                  {chainCounts.has(c) && <span className="count">{chainCounts.get(c)}</span>}
                </button>
              );
            })}
            {trip && (
              <button className="chain-chip trip-end" onClick={() => setTrip(null)}>
                Zurück nach Hause
              </button>
            )}
          </div>
        )}
      </header>

      <main className="content">
        {tab === 'kochen' && (
          <CookView
            settings={settings}
            updateSettings={updateSettings}
            cart={cart.cart}
            removeFromCart={cart.remove}
            clearCart={cart.clear}
            cartRemoved={cart.removed}
            dismissCartRemoved={cart.dismissRemoved}
            wishes={wishes}
            setWishes={setWishes}
            gen={gen}
            onGenerate={() => generate()}
            onReplace={(id) => generate(id)}
            doneJobs={doneJobs}
            onCollect={collectJob}
            replacing={replacing}
            saved={saved.saved}
            isSaved={saved.isSaved}
            onSave={saved.toggle}
            baseChains={baseChains}
            activeChains={activeChains}
            setActiveChains={(list) => setSkipToday(baseChains.filter((c) => !list.includes(c)))}
            results={results}
            onOpen={openDetail}
            onList={shopping.toggleRecipe}
            isOnList={shopping.has}
            ready={ready}
            goToMarkets={() => setTab('maerkte')}
            goToOffers={() => setTab('angebote')}
          />
        )}
        {tab === 'angebote' && (
          <OffersView
            offers={offers.data?.offers ?? []}
            chains={activeChains}
            loading={offers.loading}
            error={offers.error}
            onReload={offers.reload}
            fetchedAt={offers.data?.fetchedAt}
            notes={offers.data?.notes ?? []}
            plz={plz}
            markets={markets}
            onOpenLeaflet={openLeaflet}
            onToggleCart={cart.toggle}
            inCart={cart.ids}
            hasPlz={!!plz}
            goToMarkets={() => setTab('maerkte')}
          />
        )}
        {tab === 'einkauf' && (
          <ShoppingView
            recipes={shopping.recipes}
            singles={shopping.offers}
            have={shopping.have}
            removeSingle={shopping.toggleOffer}
            checked={shopping.checked}
            toggleItem={shopping.toggleItem}
            removeRecipe={shopping.toggleRecipe}
            clear={shopping.clear}
            onOpen={openDetail}
            stores={stores}
            goToCook={() => setTab('kochen')}
          />
        )}
        {tab === 'einstellungen' && <SettingsView settings={settings} markets={markets} onToggleDislike={toggleDislike} />}
        {tab === 'maerkte' && (
          <MarketsView
            settings={settings}
            updateSettings={updateSettings}
            trip={trip}
            setTrip={(t) => {
              setTrip(t);
              setSkipToday([]);
            }}
            onDone={() => setTab('kochen')}
            stores={stores}
            onToggleDislike={toggleDislike}
          />
        )}
      </main>

      {cart.cart.length > 0 && tab !== 'kochen' && (
        <button className="cart-bar" onClick={() => setTab('kochen')}>
          <span className="cart-bar-count">{cart.cart.length}</span>
          <span className="cart-bar-names">{cart.cart.map((o) => o.name).join(', ')}</span>
          <span className="cart-bar-go">Zum Korb</span>
        </button>
      )}

      <nav className="tabbar" aria-label="Bereiche">
        <TabButton id="kochen" tab={tab} setTab={setTab} label="Kochen" icon={<PotIcon />} />
        <TabButton id="angebote" tab={tab} setTab={setTab} label="Angebote" icon={<TagIcon />} />
        <TabButton
          id="einkauf"
          tab={tab}
          setTab={setTab}
          label="Einkauf"
          icon={<ListIcon />}
          badge={shopping.recipes.length + shopping.offers.length || undefined}
        />
        <TabButton id="maerkte" tab={tab} setTab={setTab} label="Märkte" icon={<PinIcon />} />
      </nav>
    </div>
    </ListContext.Provider>
  );
}

function TabButton(props: { id: Tab; tab: Tab; setTab: (t: Tab) => void; label: string; icon: JSX.Element; badge?: number }) {
  const active = props.id === props.tab;
  return (
    <button
      className={`tab ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        props.setTab(props.id);
        window.scrollTo(0, 0);
      }}
    >
      {props.icon}
      {props.badge ? <span className="tab-badge">{props.badge}</span> : null}
      <span>{props.label}</span>
    </button>
  );
}

const PotIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 11h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z M2 11h2 M20 11h2 M9 7c0-1.5 1-2 1-3 M14 7c0-1.5 1-2 1-3" />
  </svg>
);
const TagIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 12V4h8l10 10-8 8z" />
    <circle cx="7.5" cy="8.5" r="1.5" />
  </svg>
);
const ListIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2" />
  </svg>
);
const PinIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
    <circle cx="12" cy="9" r="2.5" />
  </svg>
);
