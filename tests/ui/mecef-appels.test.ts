import { describe, expect, it, vi } from 'vitest';
import { MecefClient, MecefError } from '@/lib/mecef/client';
import { construireFacture, modePaiementMecef, GROUPE_TAXATION_DEFAUT } from '@/lib/mecef/invoice';

/**
 * Couche d'appels e-MECeF — mapping de la vente et client HTTP.
 *
 * Ces tests tournent SANS réseau : `fetch` est injecté. Ils verrouillent la
 * forme exacte envoyée à la DGI (soumission puis confirmation) et le fait
 * qu'aucune erreur ne parte en clair.
 */

const reponse = (status: number, corps: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corps),
  }) as unknown as Response;

describe('construireFacture', () => {
  const base = {
    numero: 'FAC-2026-00042',
    ifu: 'AB12345678901',
    lignes: [
      { name: 'Riz gras', unitPrice: 1500, quantity: 2, listPrice: 1500 },
      { name: 'Coca', unitPrice: 800, quantity: 1, listPrice: 1000 },
    ],
    paiements: [{ method: 'cash' as const, amount: 3800 }],
  };

  it('mappe les lignes, la remise et le groupe de taxation par défaut', () => {
    const f = construireFacture(base);
    expect(f.type).toBe('FV');
    expect(f.ifu).toBe('AB12345678901');
    expect(f.reference).toBe('FAC-2026-00042');
    expect(f.items).toHaveLength(2);
    expect(f.items[0]).toMatchObject({ name: 'Riz gras', price: 1500, quantity: 2, taxGroup: GROUPE_TAXATION_DEFAUT });
    // Coca : catalogue 1000, facturé 800 → remise 200.
    expect(f.items[1]).toMatchObject({ name: 'Coca', price: 800, discount: 200 });
    // Pas de remise quand le prix catalogue égale le prix facturé.
    expect(f.items[0].discount).toBeUndefined();
  });

  it('traduit les moyens de paiement et omet le client s’il est inconnu', () => {
    const f = construireFacture(base);
    expect(f.payment).toEqual([{ name: 'ESPECES', amount: 3800 }]);
    expect(f.client).toBeUndefined();
    expect(modePaiementMecef('momo')).toBe('MOBILEMONEY');
    expect(modePaiementMecef('credit')).toBe('CREDIT');
  });

  it('ajoute le client et l’opérateur quand ils sont connus', () => {
    const f = construireFacture({ ...base, clientName: 'Awa', clientIfu: 'CD12345678901', operateur: 'Jacques' });
    expect(f.client).toEqual({ ifu: 'CD12345678901', name: 'Awa' });
    expect(f.operator).toEqual({ name: 'Jacques' });
  });

  it('refuse une facture sans article (la DGI la refuserait aussi)', () => {
    expect(() => construireFacture({ ...base, lignes: [] })).toThrow(/au moins un article/);
    expect(() => construireFacture({ ...base, lignes: [{ name: 'x', unitPrice: 100, quantity: 0 }] })).toThrow();
  });
});

describe('MecefClient', () => {
  const cfg = { baseUrl: 'https://dgi.test/api/', token: 'jeton-abc' };

  it('soumet puis confirme, et renvoie les éléments de sécurité', async () => {
    const appels: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      appels.push({ url, init });
      if (init.method === 'POST') return reponse(200, { uid: 'u-1', total: 3800 });
      return reponse(200, { codeMECeFDGI: 'C'.repeat(24), qrCode: 'AAAA', nim: 'NIM-1', dateTime: '2026-10-12T10:00:00Z' });
    });

    const client = new MecefClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.normalizeInvoice({
      ifu: 'AB12345678901', type: 'FV',
      items: [{ name: 'Riz gras', price: 1500, quantity: 2, taxGroup: 'B' }],
      payment: [{ name: 'ESPECES', amount: 3000 }],
    });

    expect(res.invoice.uid).toBe('u-1');
    expect(res.security.codeMECeFDGI).toHaveLength(24);
    // Base URL sans slash final + chemins exacts, jeton en Bearer.
    expect(appels[0].url).toBe('https://dgi.test/api/invoice');
    expect(appels[0].init.method).toBe('POST');
    expect(appels[1].url).toBe('https://dgi.test/api/invoice/u-1/confirm');
    expect(appels[1].init.method).toBe('PUT');
    expect((appels[0].init.headers as Record<string, string>).Authorization).toBe('Bearer jeton-abc');
  });

  it('remonte le code et la description de la DGI', async () => {
    const fetchImpl = vi.fn(async () => reponse(400, { code: '8', description: 'La facture doit contenir des articles' }));
    const client = new MecefClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.createInvoice({ ifu: 'AB12345678901', type: 'FV', items: [], payment: [] }))
      .rejects.toMatchObject({ code: '8', description: 'La facture doit contenir des articles' });
  });

  it('un réseau coupé devient une erreur claire, jamais un crash brut', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const client = new MecefClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getStatus()).rejects.toBeInstanceOf(MecefError);
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
