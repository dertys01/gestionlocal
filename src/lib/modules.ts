/**
 * Domaines d'activité : ce que l'application montre, et rien d'autre.
 *
 * Un même socle sert un commerce de détail (caisse comptoir) et un restaurant
 * (salle, tables, commande ouverte). On ne construit pas deux applications :
 * on choisit à l'inscription, et l'interface se limite aux modules du domaine.
 *
 * Règle d'or : un module d'un autre domaine n'est pas rendu — pas « masqué ».
 * Un `if (isRestaurant)` spreadé dans chaque écran ferait renaître le
 * fourre-tout qu'on veut éviter ; ici la liste des modules est l'unique
 * endroit qui décide.
 *
 * Le domaine n'est PAS une question de droits : RLS, plans, limites de
 * produits et tunnel Stripe sont identiques pour les deux. Il ne décide que
 * de l'affichage, ce qui rend la bascule (Réglages) sans risque.
 */

import type { Tab } from '@/types';

export type Domain = 'retail' | 'restaurant';

/**
 * Onglets communs : ils servent les deux activités, inchangés.
 *
 * `settings` en fait partie, et pour une raison qui n'est pas évidente :
 * l'écran des réglages n'appartient ni au commerce ni au restaurant. La garde
 * de `page.tsx` — « un onglet hors domaine retombe sur le premier module du
 * domaine » — rejette tout onglet absent de cette liste. Sans `settings` ici,
 * le bouton Paramètres de la barre latérale changeait l'onglet… et la même
 * passe de rendu le remettait sur Accueil. L'écran était rendu dans le code et
 * inatteignable à la souris.
 *
 * C'est aussi là que se trouve la bascule de domaine : un écran inaccessible
 * rendrait le choix de l'activité définitif, alors qu'il est censé être
 * réversible.
 */
const COMMUN: Tab[] = [
  'dashboard', 'pos', 'inventory', 'sales', 'debts', 'reports', 'team', 'settings',
];

/** Modules propres au commerce : le prévisionnel. */
const RETAIL_ONLY: Tab[] = ['forecast'];

/**
 * Modules propres à la restauration.
 *
 * `floor` = la salle et la commande ouverte (Sprint 13). Cuisine et recettes
 * arrivent aux sprints 14 et 15 : la liste existe pour qu'un module de plus
 * soit une ligne, pas une refonte.
 */
const RESTAURANT_ONLY: Tab[] = ['floor', 'kitchen', 'recipes', 'formules'];

export const DOMAIN_MODULES: Record<Domain, Tab[]> = {
  retail: [...COMMUN, ...RETAIL_ONLY],
  restaurant: [...COMMUN, ...RESTAURANT_ONLY],
};

export const DOMAIN_LABELS: Record<Domain, string> = {
  retail: 'Commerce / Boutique',
  restaurant: 'Restaurant / Maquis',
};

export const DOMAIN_DESCRIPTIONS: Record<Domain, string> = {
  retail: 'Caisse comptoir, stock, ventes, dettes et rapports.',
  restaurant:
    'Caisse comptoir, stock, ventes et rapports, plus la salle, les tables, le ticket cuisine et les recettes.',
};

/** Domaine inconnu (colonne absente, valeur exotique) → commerce. */
export function normalizeDomain(raw: unknown): Domain {
  return raw === 'restaurant' ? 'restaurant' : 'retail';
}

/**
 * Mode d'affichage : 'beginner' ne montre que l'essentiel, 'full' tout.
 *
 * Il se combine au domaine, il ne le remplace pas : un maquis en mode simple
 * garde sa Salle, une épicerie en mode simple n'en a jamais eu.
 */
export type UiMode = 'beginner' | 'full';

/**
 * Mode inconnu → complet. C'est le choix qui ne retire rien : une boutique
 * déjà en service dont la colonne n'est pas encore migrée ne doit pas voir
 * ses Rapports disparaître.
 */
export function normalizeUiMode(raw: unknown): UiMode {
  return raw === 'beginner' ? 'beginner' : 'full';
}

/**
 * Modules retirés en mode simple : ce qui sert à piloter, pas à vendre ni à
 * récupérer son argent. Les dépenses et la rentabilité vivent dans Rapports.
 * Les réglages restent : c'est là que se trouve le retour au mode complet.
 */
const MASQUES_EN_MODE_SIMPLE: Tab[] = ['reports', 'forecast', 'team', 'recipes', 'formules'];

/** Modules rendus pour un domaine. Toujours une copie : l'appelant peut trier. */
export function getEnabledModules(domain: unknown, uiMode: unknown = 'full'): Tab[] {
  const modules = DOMAIN_MODULES[normalizeDomain(domain)];
  if (normalizeUiMode(uiMode) === 'full') return [...modules];
  return modules.filter((t) => !MASQUES_EN_MODE_SIMPLE.includes(t));
}

/**
 * Un onglet appartient-il au domaine ?
 *
 * Sert aux deux fois : filtrer la navigation, ET interdire qu'un onglet
 * d'un autre domaine s'affiche parce qu'un lien pointait dessus. `Tab`
 * acceptant des valeurs arbitraires, une simple absence dans la liste ne
 * protège rien si le rendu ne la consulte pas.
 */
export function isModuleEnabled(domain: unknown, tab: Tab, uiMode: unknown = 'full'): boolean {
  return getEnabledModules(domain, uiMode).includes(tab);
}

/**
 * Onglet de repli quand l'onglet demandé n'appartient pas au domaine : le
 * premier module du domaine, jamais `undefined`.
 */
export function fallbackTab(domain: unknown, uiMode: unknown = 'full'): Tab {
  return getEnabledModules(domain, uiMode)[0];
}