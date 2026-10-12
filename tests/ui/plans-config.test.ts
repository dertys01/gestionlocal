import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMULES_TEST } from './formules.fixture';

/**
 * NEXT_PUBLIC_PLANS_CONFIG — le mécanisme des formules.
 *
 * Le dépôt public ne contient que ce mécanisme : prix et quotas viennent
 * d'une variable d'environnement. Trois comportements sont à verrouiller :
 *   1. la variable lue produit les limites et les prix affichés ;
 *   2. la variable absente donne « illimité partout, prix — » (l'app reste
 *      utilisable et ne devine rien) ;
 *   3. une variable illisible tombe dans le même repli — un JSON cassé ne
 *      doit pas planter le bundle au chargement.
 *
 * Chaque scénario réimporte le module à froid (`vi.resetModules`) : les
 * valeurs sont lues au chargement du module, une valeur en cache mentirait.
 */
const VAR = 'NEXT_PUBLIC_PLANS_CONFIG';

async function plansFrais(env?: string) {
  vi.resetModules();
  if (env === undefined) delete process.env[VAR];
  else process.env[VAR] = env;
  return import('@/lib/utils/plans');
}

beforeEach(() => {
  process.env[VAR] = JSON.stringify(FORMULES_TEST);
});

afterEach(() => {
  process.env[VAR] = JSON.stringify(FORMULES_TEST);
});

describe('formules — configuration externe', () => {
  it('lit limites et prix dans la variable', async () => {
    const plans = await plansFrais(JSON.stringify(FORMULES_TEST));

    expect(plans.PLAN_LIMITS.free.products).toBe(FORMULES_TEST.quotas.free.products);
    expect(plans.PLAN_LIMITS.free.employees).toBe(0);
    expect(plans.PLAN_LIMITS.free.salesHistoryDays).toBe(30);
    // null = illimité, jamais un grand nombre écrit dans le code.
    expect(plans.PLAN_LIMITS.starter.products).toBe(Infinity);
    expect(plans.PLAN_LIMITS.pro.salesHistoryDays).toBe(Infinity);

    // Le gratuit ne bouge pas : c'est la seule valeur tarifaire fixe.
    expect(plans.prixMensuelLabel('free')).toBe('Gratuit');
    expect(plans.prixAAnnuelLabel('free')).toBeNull();
    // Les autres viennent de la variable, formatées en FCFA.
    expect(plans.prixMensuelLabel('starter')).toMatch(/1\s?000\s?F \/ mois/);
    expect(plans.prixAAnnuelLabel('pro')).toMatch(/20\s?000\s?F \/ an/);
  });

  it('sans variable : illimité partout, prix « - », jamais un chiffre inventé', async () => {
    const plans = await plansFrais(undefined);

    expect(plans.PLAN_LIMITS.free.products).toBe(Infinity);
    expect(plans.PLAN_LIMITS.free.employees).toBe(Infinity);
    expect(plans.PLAN_LIMITS.free.salesHistoryDays).toBe(Infinity);
    expect(plans.prixMensuelLabel('starter')).toBe('-');
    expect(plans.prixAAnnuelLabel('pro')).toBeNull();
    // Les verrous de fonctionnalité, eux, ne sont pas des valeurs :
    // ils restent ceux de require_feature(), configuration ou non.
    expect(plans.PLAN_LIMITS.free.reports).toBe(false);
    expect(plans.PLAN_LIMITS.starter.reports).toBe(true);
  });

  it('un JSON cassé tombe dans le même repli au lieu de planter', async () => {
    const plans = await plansFrais('{pas du json');

    expect(plans.PLAN_LIMITS.pro.products).toBe(Infinity);
    expect(plans.prixMensuelLabel('pro')).toBe('-');
  });

  it('un quota négatif est une faute de saisie, pas une offre : illimité', async () => {
    const plans = await plansFrais(
      JSON.stringify({ quotas: { free: { products: -5, employees: -1, historyDays: -30 } } })
    );

    expect(plans.PLAN_LIMITS.free.products).toBe(Infinity);
    expect(plans.PLAN_LIMITS.free.employees).toBe(Infinity);
    expect(plans.PLAN_LIMITS.free.salesHistoryDays).toBe(Infinity);
  });

  it('les lignes d’affichage parlent comme un humain', async () => {
    const plans = await plansFrais(JSON.stringify(FORMULES_TEST));

    expect(plans.lignesQuotas('free')).toEqual(['50 produits', 'Aucun employé', 'Historique 30 jours']);
    expect(plans.lignesQuotas('starter')).toEqual(['Produits illimités', '3 employés', 'Historique illimité']);
    expect(plans.lignesQuotas('pro')).toEqual(['Produits illimités', 'Employés illimités', 'Historique illimité']);
  });
});

describe('plan effectif — l’essai traduit en plan utile', () => {
  it('essai futur sur boutique gratuite → starter, comme current_org_plan()', async () => {
    const plans = await plansFrais(JSON.stringify(FORMULES_TEST));
    const fin = new Date(Date.now() + 86400000).toISOString();

    expect(plans.essaiActif('free', fin)).toBe(true);
    expect(plans.planEffectif('free', fin)).toBe('starter');
  });

  it('expiré, jamais posé, ou boutique payante → le plan brut, sans exception', async () => {
    const plans = await plansFrais(JSON.stringify(FORMULES_TEST));
    const passe = new Date(Date.now() - 86400000).toISOString();
    const futur = new Date(Date.now() + 86400000).toISOString();

    expect(plans.planEffectif('free', passe)).toBe('free');
    expect(plans.planEffectif('free', null)).toBe('free');
    expect(plans.planEffectif('free', undefined)).toBe('free');
    // Une fin d'essai résiduelle sur une boutique qui PAIE ne la fait pas
    // régresser : c'est le paiement qui commande.
    expect(plans.essaiActif('pro', futur)).toBe(false);
    expect(plans.planEffectif('pro', futur)).toBe('pro');
    expect(plans.planEffectif('starter', futur)).toBe('starter');
  });
});
