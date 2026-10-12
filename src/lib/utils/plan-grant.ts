/**
 * Accord d'un plan à une boutique (outil éditeur, bêta).
 *
 * Fonction pure : elle calcule ce qu'il faut écrire dans `organizations`
 * pour donner un plan pendant N jours. On se sert de `plan_valid_until` — la
 * même colonne que les périodes prépayées — donc `current_org_plan()` rend le
 * plan tant que l'échéance est future, puis retombe sur « free » tout seul.
 * Aucun cron, aucune ligne à nettoyer à la main.
 */

export type PlanAccordable = 'free' | 'starter' | 'pro';

export interface GrantPlan {
  plan: PlanAccordable;
  /** Fin de la période accordée (ISO), ou null pour un retour au gratuit. */
  plan_valid_until: string | null;
}

/** Bornes de la durée accordée : 1 jour à 10 ans. */
export const JOURS_MIN = 1;
export const JOURS_MAX = 3650;

export function joursValides(jours: unknown): jours is number {
  return typeof jours === 'number' && Number.isInteger(jours) && jours >= JOURS_MIN && jours <= JOURS_MAX;
}

export function calculerGrant(
  plan: PlanAccordable,
  jours: number | null,
  maintenant: Date = new Date(),
): GrantPlan {
  if (plan === 'free' || jours === null || jours <= 0) {
    return { plan: 'free', plan_valid_until: null };
  }
  const fin = new Date(maintenant.getTime() + jours * 86_400_000);
  return { plan, plan_valid_until: fin.toISOString() };
}
