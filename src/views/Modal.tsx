import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Bildschirmfüllendes Overlay als echter modaler <dialog>: Fokus bleibt drin, Esc und Zurück-Geste schließen ihn.
    Hängt per Portal direkt an <body>, damit er nicht in einem <label> o. Ä. steckt (Klicks würden sonst Häkchen umschalten). */
export function Modal(p: { className: string; label: string; onClose: () => void; closeOnAnyClick?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // Kein close() beim Aufräumen: ein entfernter Dialog verlässt die oberste Ebene von selbst,
    // und ein verspätetes close-Ereignis würde ihn sonst gleich wieder schließen
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={p.className}
      aria-label={p.label}
      onClose={p.onClose}
      onClick={(e) => {
        e.stopPropagation();
        if (p.closeOnAnyClick || e.target === e.currentTarget) p.onClose();
      }}
    >
      {p.children}
    </dialog>,
    document.body,
  );
}
