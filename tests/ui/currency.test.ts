import { describe, it, expect } from 'vitest';
import { formatCFA, formatQty } from '@/lib/utils/currency';

/** Normalise les espaces (fine insécable U+202F) pour comparer des chaînes. */
const n = (s: string) => s.replace(/\s+/g, ' ');

describe('formatCFA', () => {
  it('formate un montant en FCFA', () => {
    expect(n(formatCFA(1500))).toBe('1 500 F');
  });

  it('rend « - » pour un montant non fini (jamais « NaN F »)', () => {
    expect(formatCFA(NaN)).toBe('-');
    expect(formatCFA(Infinity)).toBe('-');
  });
});

describe('formatQty', () => {
  it('garde la virgule locale et borne les décimales', () => {
    expect(n(formatQty(1.5))).toBe('1,5');
    expect(n(formatQty(2))).toBe('2');
  });
});
