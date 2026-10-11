import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Un PLAT se vend au comptoir même si son propre stock est à zéro.
 *
 * Trouvé en recette navigateur le 05/10/2026, sur un maquis neuf ouvert sur
 * Table 1 : deux attiékés poisson et deux poulets braisés. L'encaissement était
 * refusé — « Stock insuffisant pour « Attiéké poisson » (disponible : 0.000,
 * demandé : 2.000) ». Le stock du PLAT était contrôlé, alors qu'un plat ne se
 * stocke pas : sa disponibilité vient de ses INGRÉDIENTS. Le blocage venait de la
 * caisse, pas de la cuisine.
 *
 * Le correctif est en base (create_sale ne contrôle ni ne décrémente le stock
 * d'un produit qui a une recette) ET dans ce module : sans la même règle côté
 * client, la caisse affichait « Rupture de stock » sur chaque plat et refusait
 * de l'ajouter au panier. Aucun plat du catalogue d'exemple n'était donc
 * vendable — ni en salle, ni au comptoir.
 *
 * Ces tests verrouillent la règle côté client. Le refus pour ingrédient manquant
 * reste du ressort de la base, qui nomme l'ingrédient : voir la section 26b8 de
 * supabase/tests/migration.test.mjs.
 */

const { plats, rpc, supabase } = vi.hoisted(() => {
  // Deux produits à stock 0 : un PLAT (il a une recette) et un article tout
  // court. Ils ne doivent pas être traités de la même façon.
  const plats = [
    { id: 'riz-gras', name: 'Riz gras', category: 'Plats', price_buy: 0, price_sell: 2000, stock_qty: 0, min_stock_level: 0, unit: 'portion' },
    { id: 'huile', name: 'Huile végétale 1 L', category: 'Divers', price_buy: 900, price_sell: 1200, stock_qty: 0, min_stock_level: 2, unit: 'L' },
    { id: 'oignon', name: 'Oignon', category: 'Divers', price_buy: 350, price_sell: 700, stock_qty: 15, min_stock_level: 5, unit: 'kg' },
  ];
  const rpc = vi.fn();
  // Les plats connus du restaurant : une seule requête, au montage.
  const dishes = new Set(['riz-gras']);
  const supabase = {
    from: (t: string) => {
      if (t === 'recipe_ingredients') {
        return {
          select: async () => ({
            data: [...dishes].map((dish_id) => ({ dish_id })),
            error: null,
          }),
        };
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

const CATALOGUE = plats as unknown as Product[];

/** La tuile « Riz gras » du catalogue — le même nom apparaît aussi dans le panier. */
const tuileRizGras = () => screen.getAllByRole('button', { name: /Riz gras/ })[0];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: [], error: null });
});

describe('POS — un plat n\'a pas de stock', () => {
  it('ne marque pas « Rupture de stock » sur un plat', async () => {
    render(<POSModule products={CATALOGUE} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    // La ligne du plat annonce sa recette, pas un stock de 0 pce.
    expect(screen.getAllByText('Recette').length).toBeGreaterThan(0);
  });

  it('laisse ajouter un plat à son panier', async () => {
    render(<POSModule products={CATALOGUE} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    fireEvent.click(tuileRizGras());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Encaisser 2\s?000 F/ })).toBeInTheDocument(),
    );
  });

  it('laisse composer plusieurs portions du même plat', async () => {
    render(<POSModule products={CATALOGUE} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Riz gras')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Riz gras'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Encaisser 2\s?000 F/ })).toBeInTheDocument(),
    );
    // Un deuxième clic ne peut pas être ignoré à cause d'un plafond à 0.
    // C'est la TUILE du catalogue qu'on reclique, pas le nom dans le panier.
    fireEvent.click(tuileRizGras());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Encaisser 4\s?000 F/ })).toBeInTheDocument(),
    );
  });

  it('refuse toujours un article SANS recette qui est à zéro', async () => {
    render(<POSModule products={CATALOGUE} onSaleComplete={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Huile végétale 1 L')).toBeInTheDocument());
    expect(screen.getAllByText('Rupture de stock').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Huile végétale 1 L'));
    await waitFor(() =>
      expect(screen.getByText(/est en rupture de stock/i)).toBeInTheDocument(),
    );
  });
});