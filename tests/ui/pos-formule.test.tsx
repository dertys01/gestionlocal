import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { matchMediaPour } from './setup';

/**
 * Caisse — vente d'une formule.
 *
 * Une formule ne s'ajoute pas d'un clic : ses composants (entrée, plat,
 * dessert, boisson) se choisissent d'abord, car c'est leur stock qui partira.
 * Ce fichier verrouille ce parcours côté caisse, en miroir de la Salle.
 */

const { state, supabase, saleRpc } = vi.hoisted(() => {
  const etat = { groupes: [] as unknown[] };
  const rpc = vi.fn(async () => ({ data: {}, error: null }));
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit', 'in', 'is', 'neq']) q[m] = () => q;
    q.then = (ok: unknown, ko: unknown) =>
      Promise.resolve({ data, error: null }).then(ok as never, ko as never);
    return q;
  };
  return {
    state: etat,
    saleRpc: rpc,
    supabase: {
      from: (t: string) => chain(t === 'formule_groups' ? etat.groupes : []),
      rpc,
      auth: { getUser: vi.fn() },
    },
  };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    loadingProducts: false,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

const produits = [
  { id: 'p1', name: 'Coca', sku: null, category: 'Boissons', price_buy: 500, price_sell: 1000, stock_qty: 10, min_stock_level: 1, unit: 'pce' },
  { id: 'f1', name: 'Formule maquis', sku: 'FOR', category: 'Formules', price_buy: 0, price_sell: 3000, stock_qty: 0, min_stock_level: 0, unit: 'pce', is_formule: true },
] as unknown as Product[];

const matchMediaLarge = window.matchMedia;
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMediaPour(1440) });
  vi.clearAllMocks();
  saleRpc.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMediaLarge });
});

const renderPOS = () => render(<POSModule products={produits} onSaleComplete={vi.fn()} />);

describe('POS — formules', () => {
  it('ouvre le sélecteur et ajoute la formule avec ses composants', async () => {
    state.groupes = [{
      id: 'g1', name: 'Plat', min_select: 1, max_select: 1, sort_order: 0,
      formule_group_items: [
        { product_id: 'p1', extra_price: 500, sort_order: 0, product: { name: 'Coca' } },
      ],
    }];
    renderPOS();

    // Un article normal s'ajoute d'un clic.
    fireEvent.click(screen.getByText('Coca'));

    // La formule, elle, ouvre le sélecteur.
    fireEvent.click(screen.getByText('Formule maquis'));
    await waitFor(() => expect(screen.getByText('Prix de la formule')).toBeInTheDocument());

    // Sans choix, l'ajout est bloqué ; après le choix, il passe.
    expect(screen.getByRole('button', { name: /Ajouter au panier/ })).toBeDisabled();
    const choix = screen.getAllByText('Coca');
    fireEvent.click(choix[choix.length - 1]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ajouter au panier/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Ajouter au panier/ }));

    // Le panier porte le composant choisi.
    await waitFor(() => expect(screen.getByText(/Plat : Coca/)).toBeInTheDocument());
  });
});
