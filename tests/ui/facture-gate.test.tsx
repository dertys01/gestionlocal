import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Facture normalisée : le verrou à la caisse.
 *
 * Trois pièces, trois états vérifiés ici :
 *   • le reçu simple est TOUJOURS là et imprime SANS numéro (un reçu n'est
 *     pas une facture) ;
 *   • le bouton « Facture normalisée » n'existe que si le verrou est ouvert
 *     (Pro + IFU + connexion e-MECeF) ; fermé, un texte dit lequel des trois
 *     motive le refus ;
 *   • l'impression de facture porte le numéro, celle du reçu non.
 *
 * `useLiaisonMecef` est remplacé par une valeur pilotée par le test (le
 * hook lui-même ne fait que demander /api/mecef/status au serveur) ; la
 * logique qui compte — verrou → rendu → appel d'impression — est réelle.
 */
const { products, from, rpc, supabase, contexte, connexion, printReceipt } =
  vi.hoisted(() => {
    const produits = [
      { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500, stock_qty: 5, min_stock_level: 1 },
    ];
    const from = vi.fn();
    const rpc = vi.fn();
    const printReceipt = vi.fn();
    const contexte = {
      org: null as Record<string, unknown> | null,
      /** Numéro que « create_sale » attribue (null = plan non-Pro). */
      numero: 'FA-0007' as string | null,
    };
    const connexion = { branche: false };
    const supabase = {
      from,
      rpc,
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'jwt-test' } } }),
      },
    };
    return { products: produits, from, rpc, supabase, contexte, connexion, printReceipt };
  });

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    org: contexte.org,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/utils/print', () => ({ printReceipt }));
vi.mock('@/lib/hooks/useLiaisonMecef', () => ({
  useLiaisonMecef: () => connexion.branche,
}));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

/** Chaîne PostgREST chaînable, filtrée par table. */
function chaine(donnees: unknown[] = []) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) {
    q[m] = () => q;
  }
  q.then = (ok: unknown, ko: unknown) =>
    Promise.resolve({ data: donnees, error: null }).then(ok as never, ko as never);
  return q;
}

/** jsdom n'a pas toujours localStorage : stub défensif, comme en caisse. */
const sac = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => (sac.has(k) ? sac.get(k)! : null),
    setItem: (k: string, v: string) => { sac.set(k, v); },
    removeItem: (k: string) => { sac.delete(k); },
    clear: () => sac.clear(),
  },
  configurable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  sac.clear();
  // Boutique Pro avec IFU valide, connexion ouverte : état nominal, que
  // chaque test dégrade pour viser UN verrou.
  contexte.org = { id: 'org-1', name: 'Boutique Test', address: null, ifu: 'AB12345678901' };
  contexte.numero = 'FA-0007';
  connexion.branche = true;
  rpc.mockImplementation(async (nom: string) => {
    if (nom === 'create_sale') {
      return { data: { id: 'v9', total_amount: 1500, invoice_number: contexte.numero }, error: null };
    }
    return { data: [], error: null };
  });
  from.mockImplementation((table: string) => {
    if (table === 'sales') return chaine([{ id: 'v1', total_amount: 900 }]);
    if (table === 'sale_items') return chaine([{ product_id: 'riz', quantity: 1, unit_price: 900 }]);
    return chaine([]);
  });
});

const renderPOS = () =>
  render(<POSModule products={products as unknown as Product[]} onSaleComplete={vi.fn()} />);

/** Encaisse 1 RIZ : le reçu s'ouvre en fin de parcours. */
async function encaisser() {
  renderPOS();
  fireEvent.click(await screen.findByText('RIZ'));
  fireEvent.click(await screen.findByRole('button', { name: /Encaisser/ }));
  await screen.findByText('Vente enregistrée !');
}

const boutonFacture = () =>
  screen.queryByRole('button', { name: 'Facture normalisée' });

describe('Caisse — facture normalisée : le verrou', () => {
  it('verrou ouvert : le bouton facture normalise auprès de la DGI puis imprime', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        codeMECeFDGI: 'C'.repeat(24),
        qrCode: 'AAAA',
        nim: 'NIM-1',
        dateTime: '2026-10-12T10:00:00Z',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await encaisser();

      // Le verrou est ouvert (Pro + IFU + connexion) : le bouton existe.
      const bouton = await waitFor(() => {
        const b = boutonFacture();
        expect(b).not.toBeNull();
        return b!;
      });
      expect(screen.getByText('Imprimer le reçu')).toBeInTheDocument();

      // Le bouton facture interroge la route (qui relit la vente en base),
      // puis imprime la facture avec les éléments de sécurité de la DGI.
      fireEvent.click(bouton);
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/mecef/invoice',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      await waitFor(() =>
        expect(printReceipt).toHaveBeenCalledWith(
          expect.objectContaining({
            invoiceNumber: 'FA-0007',
            mecef: expect.objectContaining({ code: 'C'.repeat(24), nim: 'NIM-1' }),
          }),
        ),
      );

      // Le reçu, lui, ne porte JAMAIS le numéro : deux boutons, deux documents.
      fireEvent.click(screen.getByText('Imprimer le reçu'));
      expect(printReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceNumber: null }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sans IFU : le verrou dit d’aller dans Paramètres, le reçu reste', async () => {
    contexte.org = { id: 'org-1', name: 'Boutique Test', address: null, ifu: null };
    connexion.branche = true;

    await encaisser();

    expect(await screen.findByText(/Renseignez votre IFU/)).toBeInTheDocument();
    expect(boutonFacture()).toBeNull();
    // Le reçu simple n'est jamais bloqué : c'est l'article de l'énoncé.
    expect(screen.getByText('Imprimer le reçu')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Imprimer le reçu'));
    expect(printReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceNumber: null }),
    );
  });

  it('connexion fermée : le motif parle de la connexion, pas de l’IFU', async () => {
    connexion.branche = false;

    await encaisser();

    expect(await screen.findByText(/n'est pas encore ouverte/)).toBeInTheDocument();
    expect(screen.queryByText(/Paramètres > Boutique/)).toBeNull();
    expect(boutonFacture()).toBeNull();
    expect(screen.getByText('Imprimer le reçu')).toBeInTheDocument();
  });

  it('hors Pro (aucun numéro attribué) : le motif dit Plan Pro', async () => {
    contexte.numero = null;
    connexion.branche = true;

    await encaisser();

    expect(await screen.findByText('Facture normalisée (Plan Pro uniquement)')).toBeInTheDocument();
    expect(boutonFacture()).toBeNull();
    expect(screen.getByText('Imprimer le reçu')).toBeInTheDocument();
  });
});
