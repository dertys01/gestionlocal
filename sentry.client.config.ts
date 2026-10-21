import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,
  environment: process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === 'production',
  // Bruit connu de supabase-js : le verrou d'authentification (navigator.locks)
  // volé par un second appel concurrent. Bénin, mais il noie les vraies
  // erreurs (voir supabase/supabase-js#2013). La montée de version le supprime
  // par défaut ; ce filtre reste le filet pour les onglets restés ouverts sur
  // l'ancien bundle.
  ignoreErrors: [
    /Lock broken by another request with the 'steal' option/i,
    /Acquiring an exclusive Navigator LockManager lock/i,
  ],
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
});
