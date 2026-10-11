import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Caisse : les INGRÉDIENTS ne sont pas des articles de vente.
 *
 * Un ingrédient (produit utilisé dans une recette) vit dans le Stock, pas au
 * menu de la caisse. Un plat (produit avec recette) reste vendable même à stock
 * 0. Le caissier qui cherche « riz » ne doit pas se voir proposer le riz cru.
 */

const { plats, rpc, supabase } = vi.hoisted(() => {
  const plats = [
    { id: 'plat1', name: 'Riz gras', category: 'Plats', price_buy: 0, price_sell: 1500, stock_qty: 0, min_stock_level: 0, unit: 'pce', is_active: true },
    { id: 'ing1', name: 'Riz cru (kg)', category: 'Ingrédients', price_buy: 500, price_sell: 700, stock_qty: 50, min_stock_level: 5, unit: 'pce', is_active: true },
    // Catégorie « Ingrédients » SANS être encore utilisé dans une recette :
    // c'est le signal du commerçant, il doit suffire.
    { id: 'ing2', name: 'Poulet cru (kg)', category: 'Ingrédients', price_buy: 2500, price_sell: 3000, stock_qty: 10, min_stock_level: 2, unit: 'pce', is_active: true },
    { id: 'boisson', name: 'Sucrerie', category: 'Boissons', price_buy: 400, price_sell: 600, stock_qty: 30, min_stock_level: 5, unit: 'pce', is_active: true },
  ];
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  const supabase = {
    from: (t: string) => {
      if (t === 'recipe_ingredients') {
        // Une recette : plat1 est un plat, ing1 est son ingrédient.
        return { select: async () => ({ data: [{ dish_id: 'plat1', ingredient_id: 'ing1' }], error: null }) };
      }
      return { select: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) };
    },
    rpc,
    auth: { getUser: vi.fn() },
  };
  return { plats, rpc, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    org: null,
  }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe('Caisse — les ingrédients ne sont pas au menu', () => {
  it('affiche le plat et masque son ingrédient', async () => {
    render(<POSModule products={plats as unknown as Product[]} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    // Le plat (recette) est vendable même à stock 0.
    expect(screen.getByText('Recette')).toBeInTheDocument();
    // L'ingrédient n'apparaît pas dans la caisse.
    expect(screen.queryByText('Riz cru (kg)')).toBeNull();
  });

  it('masque aussi un produit rangé dans la catégorie « Ingrédients » (même sans recette)', async () => {
    render(<POSModule products={plats as unknown as Product[]} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    // Boisson : article de vente normal, il reste.
    expect(screen.getByText('Sucrerie')).toBeInTheDocument();
    // Ingrédient par catégorie, jamais utilisé en recette : masqué quand même.
    expect(screen.queryByText('Poulet cru (kg)')).toBeNull();
  });

  it('ne propose pas la catégorie « Ingrédients » dans les filtres', async () => {
    render(<POSModule products={plats as unknown as Product[]} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    // La barre de filtres ne liste que les catégories présentes au menu.
    expect(screen.queryByRole('button', { name: 'Ingrédients' })).toBeNull();
  });
});
