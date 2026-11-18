// Zwei Designs: "klassisch" (grün, Barlow) und "apple" (System-Look nach den Apple-Richtlinien, folgt dem System-Theme).
export type Design = 'klassisch' | 'apple';

const COLORS = { light: '#F2F2F7', dark: '#000000' };
const CLASSIC_COLOR = '#2E5E3E';

/** Setzt das Design am <html>-Element und passt die Farbe der Systemleiste (Handy-Statusleiste) an */
export function applyDesign(design: Design | undefined) {
  const apple = design === 'apple';
  const root = document.documentElement;
  if (apple) root.dataset.design = 'apple';
  else delete root.dataset.design;

  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  metas.forEach((m) => m.dataset.managed !== '1' && m.remove());
  document.querySelectorAll('meta[name="theme-color"][data-managed="1"]').forEach((m) => m.remove());
  const add = (content: string, media?: string) => {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = content;
    if (media) m.media = media;
    m.dataset.managed = '1';
    document.head.appendChild(m);
  };
  if (apple) {
    add(COLORS.light, '(prefers-color-scheme: light)');
    add(COLORS.dark, '(prefers-color-scheme: dark)');
  } else add(CLASSIC_COLOR);
}

/** Gespeichertes Design aus den Einstellungen lesen (vor dem ersten Zeichnen, damit nichts aufblitzt) */
export function storedDesign(): Design | undefined {
  try {
    const s = JSON.parse(localStorage.getItem('settings') ?? 'null');
    return s?.design === 'apple' ? 'apple' : 'klassisch';
  } catch {
    return undefined;
  }
}
