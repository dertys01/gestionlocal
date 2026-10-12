import type { Plan, PlanLimits } from '@/types';
import { formatCFA } from '@/lib/utils/currency';

/**
 * Formules freemium — le mécanisme est ici, les VALEURS ailleurs.
 *
 * Le dépôt GitHub est public : un prix, un plafond ou un nombre d'utilisateurs
 * écrit dans ce fichier serait la stratégie tarifaire entière, publiée et
 * archivée dans l'historique git. Le dépôt ne contient donc que le mécanisme ;
 * les valeurs vivent dans `NEXT_PUBLIC_PLANS_CONFIG` (`.env.local` en local,
 * le tableau de bord du déploiement en production — `.env.local.example`
 * documente la forme, jamais les chiffres).
 *
 * Forme de la variable (JSON) :
 *   { "quotas":  { "free":    { "products": …, "employees": …, "historyDays": … },
 *                  "starter": { … }, "pro": { … } },
 *     "prices":  { "starter": { "monthly": …, "yearly": … }, "pro": { … } } }
 *
 * Une valeur `null` veut dire « illimité ». Toute variable absente ou
 * illisible donne « illimité partout, prix affichés — » : sans configuration,
 * l'application reste utilisable et ne vend rien, plutôt que de servir des
 * chiffres inventés. La base de données n'est pas dans ce raisonnement —
 * `plan_config` (scripts/sync-plan-config.mjs) y porte les mêmes quotas, et
 * c'est elle qui tranche. Voir migration_plan_config.sql.
 *
 * Les BOOLEANÉENS (exportCsv, reports, forecast) ne sont pas des valeurs
 * commerciales mais la traduction du verrou `require_feature()` de la base :
 * mêmes seuils en base et en écran, lus dans migration_plan_gate.sql.
 */

interface QuotasBruts {
  products: number | null;
  employees: number | null;
  historyDays: number | null;
}

interface PrixBruts {
  monthly: number | null;
  yearly: number | null;
}

interface Formules {
  quotas: Partial<Record<Plan, Partial<QuotasBruts>>>;
  prices: Partial<Record<'starter' | 'pro', Partial<PrixBruts>>>;
}

function lireFormules(): Formules | null {
  // Écrit littéralement : Next.js ne remplace que les accès textuels à
  // process.env.NEXT_PUBLIC_* au build. Un accès dynamique laisserait la
  // variable hors du bundle.
  const brut = process.env.NEXT_PUBLIC_PLANS_CONFIG;
  if (!brut) return null;
  try {
    const v = JSON.parse(brut) as Formules;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const FORMULES = lireFormules();

/** `null` (absent du JSON) → illimité. Un négatif est un bug de saisie, pas une offre. */
function quota(plan: Plan, cle: keyof QuotasBruts): number {
  const n = FORMULES?.quotas?.[plan]?.[cle];
  if (n === null || n === undefined) return Infinity;
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return Math.floor(n);
}

function prix(plan: 'starter' | 'pro'): PrixBruts {
  const p = FORMULES?.prices?.[plan];
  return {
    monthly: typeof p?.monthly === 'number' && p.monthly >= 0 ? p.monthly : null,
    yearly: typeof p?.yearly === 'number' && p.yearly >= 0 ? p.yearly : null,
  };
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    products: quota('free', 'products'),
    employees: quota('free', 'employees'),
    salesHistoryDays: quota('free', 'historyDays'),
    exportCsv: false,
    reports: false,
    forecast: false,
  },
  starter: {
    products: quota('starter', 'products'),
    employees: quota('starter', 'employees'),
    salesHistoryDays: quota('starter', 'historyDays'),
    exportCsv: true,
    reports: true,
    forecast: false,
  },
  pro: {
    products: quota('pro', 'products'),
    employees: quota('pro', 'employees'),
    salesHistoryDays: quota('pro', 'historyDays'),
    exportCsv: true,
    reports: true,
    forecast: true,
  },
};

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Gratuit',
  starter: 'Starter',
  pro: 'Pro',
};

/**
 * Prix affichables. Le plan gratuit est gratuit partout et pour toujours :
 * c'est la seule valeur tarifaire qui n'a pas besoin de vivre dehors.
 * Les autres : `null` = variable absente → « — », jamais un chiffre deviné.
 */
export const PLAN_PRICES: Record<Plan, { monthly: number | null; yearly: number | null }> = {
  free: { monthly: 0, yearly: 0 },
  starter: prix('starter'),
  pro: prix('pro'),
};

/** « … F / mois », « — » sans configuration, « Gratuit » pour le gratuit. */
export function prixMensuelLabel(plan: Plan): string {
  if (plan === 'free') return PLAN_LABELS.free;
  const m = PLAN_PRICES[plan].monthly;
  return m === null ? '-' : `${formatCFA(m)} / mois`;
}

/** « … F / an », ou null (gratuit, ou pas d'annuel configuré). */
export function prixAAnnuelLabel(plan: Plan): string | null {
  if (plan === 'free') return null;
  const y = PLAN_PRICES[plan].yearly;
  return y === null ? null : `${formatCFA(y)} / an`;
}

/**
 * Les trois lignes de quotas, pour l'affichage d'un plan.
 * Plafond absent → « illimité » : c'est la signification de `null` dans la
 * configuration, et une absence de configuration ne doit pas se lire comme
 * une offre gratuite particulière mais comme rien du tout.
 */
export function lignesQuotas(plan: Plan): string[] {
  const l = PLAN_LIMITS[plan];
  const produits =
    l.products === Infinity ? 'Produits illimités'
    : `${l.products} produit${l.products > 1 ? 's' : ''}`;
  const employes =
    l.employees === Infinity ? 'Employés illimités'
    : l.employees === 0 ? 'Aucun employé'
    : `${l.employees} employé${l.employees > 1 ? 's' : ''}`;
  const historique =
    l.salesHistoryDays === Infinity ? 'Historique illimité'
    : `Historique ${l.salesHistoryDays} jour${l.salesHistoryDays > 1 ? 's' : ''}`;
  return [produits, employes, historique];
}

export function getLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * Un essai est actif quand la boutique est encore gratuite ET que sa fin est
 * dans le futur. Une boutique payante qui aurait une fin d'essai résiduelle
 * n'est pas « en essai » : c'est le paiement qui commande.
 *
 * Miroir exact de current_org_plan() en base — les deux doivent penser pareil,
 * sinon l'écran dirait Starter et la base refuserait (ou l'inverse).
 */
export function essaiActif(plan: Plan, trialEndsAt?: string | null): boolean {
  if (plan !== 'free' || !trialEndsAt) return false;
  return new Date(trialEndsAt).getTime() > Date.now();
}

/**
 * Le plan que l'écran doit afficher et verrouiller.
 *
 * Miroir exact de current_org_plan() en base — les deux doivent penser
 * pareil, sinon l'écran dirait Starter et la base refuserait (ou l'inverse) :
 *   • période prépayée écoulée (plan brut payant + échéance passée) → free ;
 *   • essai Starter actif (plan brut gratuit + fin d'essai future) → starter ;
 *   • sinon, le plan brut.
 * Les deux premiers cas sont exclusifs par construction : l'essai ne naît
 * que sur un plan brut gratuit, l'échéance ne regarde que les plans payants.
 */
export function planEffectif(
  plan: Plan,
  trialEndsAt?: string | null,
  planValidUntil?: string | null,
): Plan {
  if (plan !== 'free' && planValidUntil && new Date(planValidUntil).getTime() <= Date.now()) {
    return 'free';
  }
  return essaiActif(plan, trialEndsAt) ? 'starter' : plan;
}

/** Plans achetables par période prépayée — le gratuit ne se « paie » pas. */
export type PlanPayant = 'starter' | 'pro';

/** Durées vendues en Mobile Money : trois, arrêtées par l'évaluation (1/3/12). */
export type DureePeriode = 1 | 3 | 12;

/**
 * Montant d'une période prépayée, en FCFA — l'unique endroit qui transforme
 * un prix de la configuration en montant de commande. 12 mois : le prix
 * annuel s'il existe, sinon 12 mensualités ; 3 mois : trois mensualités.
 *
 * `null` = prix non configuré. L'appelant REFUSE alors la vente : on ne vend
 * jamais un montant inventé, et une configuration absente ne produit ni
 * commande ni chiffre.
 */
export function montantPeriode(plan: PlanPayant, mois: DureePeriode): number | null {
  const p = PLAN_PRICES[plan];
  if (mois === 12) {
    if (p.yearly !== null) return p.yearly;
    return p.monthly === null ? null : p.monthly * 12;
  }
  if (p.monthly === null) return null;
  return p.monthly * mois;
}

export function canAddProduct(plan: Plan, currentCount: number): boolean {
  return currentCount < PLAN_LIMITS[plan].products;
}

export function canAddEmployee(plan: Plan, currentCount: number): boolean {
  return currentCount < PLAN_LIMITS[plan].employees;
}

export function isFeatureAllowed(plan: Plan, feature: keyof Pick<PlanLimits, 'exportCsv' | 'reports' | 'forecast'>): boolean {
  return PLAN_LIMITS[plan][feature];
}

export function getUpgradeMessage(plan: Plan, feature: string): string {
  const next: Record<Plan, Plan | null> = { free: 'starter', starter: 'pro', pro: null };
  const nextPlan = next[plan];
  if (!nextPlan) return '';
  return `${feature} nécessite le plan ${PLAN_LABELS[nextPlan]}. Passez au plan supérieur pour y accéder.`;
}
