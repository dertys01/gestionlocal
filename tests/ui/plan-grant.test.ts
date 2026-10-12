import { describe, expect, it } from 'vitest';
import { calculerGrant, joursValides, JOURS_MAX } from '@/lib/utils/plan-grant';

/**
 * Accord de plan (outil éditeur). Fonction pure : on vérifie l'échéance
 * posée et le retour au gratuit, sans base ni réseau.
 */

describe('calculerGrant', () => {
  const t0 = new Date('2026-10-12T00:00:00Z');

  it('accorde un plan payant avec une échéance à N jours', () => {
    const g = calculerGrant('pro', 90, t0);
    expect(g.plan).toBe('pro');
    expect(g.plan_valid_until).toBe(new Date(t0.getTime() + 90 * 86_400_000).toISOString());
  });

  it('« free », durée nulle ou absente : retour au gratuit, sans échéance', () => {
    expect(calculerGrant('free', 90, t0)).toEqual({ plan: 'free', plan_valid_until: null });
    expect(calculerGrant('pro', null, t0)).toEqual({ plan: 'free', plan_valid_until: null });
    expect(calculerGrant('starter', 0, t0)).toEqual({ plan: 'free', plan_valid_until: null });
  });
});

describe('joursValides', () => {
  it('accepte 1 à 3650 entiers, refuse le reste', () => {
    expect(joursValides(1)).toBe(true);
    expect(joursValides(JOURS_MAX)).toBe(true);
    expect(joursValides(0)).toBe(false);
    expect(joursValides(3651)).toBe(false);
    expect(joursValides(1.5)).toBe(false);
    expect(joursValides(null)).toBe(false);
    expect(joursValides('90')).toBe(false);
  });
});
