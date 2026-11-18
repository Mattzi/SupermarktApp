/** "Bio Porree", "Porree (bio)", "Bio-Porree" → "Porree": Bio-Variante zählt als dieselbe Zutat */
export const stripBio = (name: string) => {
  const s = name
    .replace(/\(\s*bio\s*\)/gi, ' ')
    .replace(/\bbio[-\s]+/gi, ' ')
    .replace(/[-\s]+bio\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 3 ? s : name.trim();
};
