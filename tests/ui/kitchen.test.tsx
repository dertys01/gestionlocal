import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Écran cuisine (KDS).
 *
 * Montre ce qui est EN CUISINE (lignes « envoyées »), la plus ancienne en tête,
 * avec son temps d'attente. Un tap « Prêt » sort la ligne de l'écran (statut
 * « servi »). La RLS fait l'isolation.
 */

const h = vi.hoisted(() => {
  const state = {
    items: [] as unknown[],
    orders: [] as unknown[],
    tables: [] as unknown[],
    updates: [] as Array<Record<string, unknown>>,
  };
  const builder = (table: string) => {
    const ctx = { op: '', payload: null as unknown };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.in = () => b;
    b.order = () => b;
    b.update = (p: unknown) => { ctx.op = 'update'; ctx.payload = p; return b; };
    b.then = (ok: (v: unknown) => unknown) => {
      if (ctx.op === 'update') {
        state.updates.push(ctx.payload as Record<string, unknown>);
        return Promise.resolve({ error: null }).then(ok);
      }
      const data = table === 'restaurant_order_items' ? state.items
        : table === 'restaurant_orders' ? state.orders : state.tables;
      return Promise.resolve({ data, error: null }).then(ok);
    };
    return b;
  };
  const supabase = { from: (t: string) => builder(t) };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({ useSupabase: () => ({ supabase: h.supabase }) }));
vi.mock('@/lib/hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }));

import { KitchenDisplay } from '@/components/restaurant/KitchenDisplay';
import type { Product } from '@/types';

const PRODUITS = [{ id: 'p1', name: 'Attiéké poisson' }] as unknown as Product[];

const ligne = (over: Record<string, unknown> = {}) => ({
  id: 'i1', order_id: 'o1', quantity: 2, note: 'peu épicé', modifier: 'Double portion',
  sent_at: new Date(Date.now() - 25 * 60000).toISOString(), product_id: 'p1', ...over,
});

beforeEach(() => {
  h.state.items = [ligne()];
  h.state.orders = [{ id: 'o1', table_id: 't1', customer_name: null }];
  h.state.tables = [{ id: 't1', name: 'Table 3' }];
  h.state.updates = [];
});

describe('KitchenDisplay', () => {
  it('affiche la fiche avec table, quantité, option, note et attente', async () => {
    render(<KitchenDisplay products={PRODUITS} />);

    await waitFor(() => expect(screen.getByText('Table 3')).toBeInTheDocument());
    expect(screen.getByText('2×')).toBeInTheDocument();
    expect(screen.getByText('Attiéké poisson')).toBeInTheDocument();
    expect(screen.getByText('Double portion')).toBeInTheDocument();
    expect(screen.getByText('peu épicé')).toBeInTheDocument();
    expect(screen.getByText(/25 min/)).toBeInTheDocument();
  });

  it('« Prêt » sort la ligne de la cuisine (statut servi)', async () => {
    render(<KitchenDisplay products={PRODUITS} />);

    fireEvent.click(await screen.findByRole('button', { name: /Marquer prêt/i }));

    await waitFor(() => expect(h.state.updates).toContainEqual({ status: 'served' }));
  });

  it('état vide quand rien n’est en cuisine', async () => {
    h.state.items = [];
    render(<KitchenDisplay products={PRODUITS} />);

    await waitFor(() => expect(screen.getByText(/Rien en cuisine/)).toBeInTheDocument());
  });

  it('regroupe par commande (une fiche par table)', async () => {
    h.state.items = [
      ligne({ id: 'i1', order_id: 'o1', product_id: 'p1' }),
      ligne({ id: 'i2', order_id: 'o2', product_id: 'p1', quantity: 1, modifier: null, note: null }),
    ];
    h.state.orders = [
      { id: 'o1', table_id: 't1', customer_name: null },
      { id: 'o2', table_id: null, customer_name: 'M. Kponou' },
    ];
    render(<KitchenDisplay products={PRODUITS} />);

    await waitFor(() => expect(screen.getByText('Table 3')).toBeInTheDocument());
    expect(screen.getByText(/À emporter · M. Kponou/)).toBeInTheDocument();
  });
});
