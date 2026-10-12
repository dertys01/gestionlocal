'use client';

import { useState } from 'react';
import { FlaskConical, X } from 'lucide-react';

/**
 * Bandeau « version de test ».
 *
 * Deux choses à dire aux premiers utilisateurs : que l'application est en
 * cours de mise au point, et où écrire. Masquable — un bandeau qu'on ne peut
 * pas retirer devient du bruit, et le bouton flottant reste là de toute façon.
 */

const CLE = 'beta:banner:vu';

export function BetaBanner({ onFeedback }: { onFeedback: () => void }) {
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(CLE) !== '1'; } catch { return true; }
  });

  if (!visible) return null;

  const fermer = () => {
    try { localStorage.setItem(CLE, '1'); } catch { /* stockage indisponible */ }
    setVisible(false);
  };

  return (
    <div className="mb-3 flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
      <FlaskConical className="h-4 w-4 shrink-0 mt-0.5" />
      <span className="flex-1">
        <strong>Version de test.</strong> L&apos;application se met au point avec vous : dites-nous ce
        qui bloque ou ce qui manque, on corrige vite.
      </span>
      <button
        onClick={onFeedback}
        className="shrink-0 rounded-md border border-indigo-300 px-2 py-1 text-xs font-medium hover:bg-indigo-100"
      >
        Donner mon avis
      </button>
      <button onClick={fermer} aria-label="Masquer le bandeau" className="shrink-0 text-indigo-400 hover:text-indigo-700">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
