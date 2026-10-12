import { describe, expect, it } from 'vitest';
import { ifuValide, peutDelivrerFacture } from '@/lib/mecef/gate';
import { emettreFacture, etatLiaison } from '@/lib/mecef';

/**
 * Facture normalisée (e-MECeF) — le verrou.
 *
 * Deux moitiés : un verdict PUR que caisse et Paramètres partagent, et un
 * module serveur qui refuse tant que la DGI n'a pas délivré ses accès.
 * Aucune des deux n'a besoin de réseau ici.
 */

describe('ifuValide', () => {
  it('accepte 13 caractères alphanumériques', () => {
    expect(ifuValide('A1B2C3D4E5F6G')).toBe(true);
    expect(ifuValide('  AB12345678901  ')).toBe(true);
  });

  it('refuse tout ce qui n’est pas 13 caractères', () => {
    expect(ifuValide('123456789012')).toBe(false);   // 12
    expect(ifuValide('12345678901234')).toBe(false); // 14
    expect(ifuValide('')).toBe(false);
    expect(ifuValide(null)).toBe(false);
    expect(ifuValide(undefined)).toBe(false);
    expect(ifuValide('123456789012 ')).toBe(false);  // espace non trimable dedans
  });

  it('refuse les caractères spéciaux', () => {
    expect(ifuValide('A1B2C3D4E5F6-')).toBe(false);
    expect(ifuValide('A1B2C3D4E5F6 ')).toBe(false);
  });
});

describe('peutDelivrerFacture', () => {
  const numero = 'FAC-2026-00042';
  const ifu = 'AB12345678901';

  it('tout réuni : délivrable, sans motif', () => {
    expect(peutDelivrerFacture({ numero, ifu, connexion: true }))
      .toEqual({ delivrable: true, motif: null });
  });

  it('hors Pro (pas de numéro) : verrou Plan Pro, quoi qu’il arrive', () => {
    const v = peutDelivrerFacture({ numero: null, ifu, connexion: true });
    expect(v.delivrable).toBe(false);
    expect(v.motif).toContain('Plan Pro');
    // Même avec IFU et connexion, sans numéro il n’y a pas de facture.
    expect(peutDelivrerFacture({ numero: null, ifu: null, connexion: false }).motif)
      .toContain('Plan Pro');
  });

  it('sans IFU : renseigner les Paramètres', () => {
    const v = peutDelivrerFacture({ numero, ifu: null, connexion: true });
    expect(v.delivrable).toBe(false);
    expect(v.motif).toContain('Paramètres > Boutique');
  });

  it('avec un IFU invalide : même verrou que sans IFU', () => {
    const v = peutDelivrerFacture({ numero, ifu: '123', connexion: true });
    expect(v.delivrable).toBe(false);
    expect(v.motif).toContain('Paramètres > Boutique');
  });

  it('IFU ok mais connexion fermée : le motif parle de la connexion, pas de l’IFU', () => {
    const v = peutDelivrerFacture({ numero, ifu, connexion: false });
    expect(v.delivrable).toBe(false);
    expect(v.motif).toContain('connexion');
    expect(v.motif).toContain('reçu reste disponible');
  });

  it('l’ordre des verrous est stable : Pro, puis IFU, puis connexion', () => {
    // Chaque cause est masquée par la précédente : le caissier ne voit
    // jamais « branchez la connexion » sur une boutique sans IFU.
    expect(peutDelivrerFacture({ numero: null, ifu: null, connexion: false }).motif)
      .toContain('Plan Pro');
    expect(peutDelivrerFacture({ numero, ifu: null, connexion: false }).motif)
      .toContain('Paramètres');
    expect(peutDelivrerFacture({ numero, ifu, connexion: false }).motif)
      .toContain('connexion');
  });
});

describe('etatLiaison (serveur)', () => {
  it('sans jeton DGI, la connexion reste fermée', () => {
    // Les appels sont écrits (APPELS_DGI = true) mais il manque le jeton :
    // la délivrance reste fermée, comme avant l'agrément.
    expect(etatLiaison({}).branche).toBe(false);
    expect(etatLiaison({}).motif).toContain('MECEF_TOKEN');
    expect(etatLiaison({ MECEF_TOKEN: '   ' }).branche).toBe(false);
  });

  it('avec un jeton, la connexion est ouverte', () => {
    const etat = etatLiaison({ MECEF_TOKEN: 'jeton-de-test' });
    expect(etat.branche).toBe(true);
    expect(etat.motif).toBe('');
  });

  it('le motif ne contient jamais le jeton en clair', () => {
    const etat = etatLiaison({ MECEF_TOKEN: 'jeton-secret-tres-long' });
    expect(etat.motif).not.toContain('jeton-secret-tres-long');
  });
});

describe('emettreFacture (verrou)', () => {
  const vente = {
    numero: 'FAC-2026-00042',
    ifu: 'AB12345678901',
    lignes: [{ name: 'Riz gras', unitPrice: 1500, quantity: 1 }],
    paiements: [{ method: 'cash' as const, amount: 1500 }],
  };

  it('sans jeton DGI, refuse : aucune facture de façade', async () => {
    await expect(emettreFacture(vente, {})).rejects.toThrow(/MECEF_TOKEN/);
  });
});
