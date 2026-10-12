import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Un service worker doit pouvoir être mis à jour au chargement :
        // un /sw.js figé en cache retarderait tout déploiement d'une
        // correction de sa stratégie de cache (P2).
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Source maps activées : les erreurs arrivent avec les vrais noms de
  // fichiers et numéros de ligne, au lieu de « a3f2.js:1:48231 ». Un envoi
  // qui échoue (jeton absent, droits insuffisants, réseau) ne doit JAMAIS
  // faire échouer un déploiement : d'où errorHandler, qui journalise et
  // laisse le build continuer. Sans jeton, le plugin saute l'envoi de lui-même.
  sourcemaps: { disable: false },
  errorHandler: (err) => {
    console.warn('[sentry] source maps non envoyées :', err.message);
  },
});
