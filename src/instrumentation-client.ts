// Next.js 16 / Sentry 10 : le chargement client passe par ce fichier, pas par
// sentry.client.config.ts (qui n'est plus importé automatiquement) — sans lui
// aucune erreur navigateur ne remontait.
import * as Sentry from '@sentry/nextjs';
import '../sentry.client.config';

// Instrumentation des navigations : sans ce hook, Sentry ne rattache pas les
// erreurs au changement de page (traces de navigation incomplètes). C'est
// l'« ACTION REQUIRED » que le build rappelait à chaque déploiement.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
