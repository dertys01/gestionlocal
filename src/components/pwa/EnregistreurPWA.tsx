'use client';

import { useEffect } from 'react';

// Import à effet de bord : `invite.ts` branche l'écoute de
// `beforeinstallprompt` au chargement du module. Il doit vivre ici, dans la
// coquille montée par le layout, donc sur TOUTES les routes.
//
// Sans lui, seul le tableau de bord chargeait le module. Un utilisateur qui
// arrivait directement sur /connexion ou /register (adresse en favori, lien
// partagé) laissait passer l'événement, que le navigateur n'émet qu'une fois
// par chargement de page : après connexion, la bannière « Installer » n'avait
// plus d'invitation à afficher. Elle avait disparu.
import '@/lib/pwa/invite';

/**
 * Enregistre le service worker (P2/P7).
 *
 * Le service worker met en cache les fichiers statiques de Next ET la coquille
 * de navigation (le HTML des pages), ce qui permet de rouvrir l'application
 * sans réseau. Les DONNÉES (ventes, stock, dettes) passent toujours par le
 * réseau ; leur repli hors-ligne vit ailleurs (file IndexedDB des ventes,
 * cache catalogue — voir src/lib/offline/).
 *
 * Rien en développement : un service worker actif en local fige les
 * ressources et brouille les recettes.
 */
export function EnregistreurPWA() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .catch(() => {
        // Un service worker qui échoue ne doit jamais gêner l'application.
      });
  }, []);
  return null;
}
