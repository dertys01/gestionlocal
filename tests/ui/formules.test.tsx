import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Onglet Formules : composer un menu (groupes + choix).
 *
 * On verrouille le parcours de composition : créer une formule (produit
 * is_formule), lui ajouter un groupe (« Plat »), puis un article dans ce
 * groupe. Le sélecteur de vente et la consommation de stock sont couverts
 * ailleurs (Salle, Caisse, tests SQL).
 */

const h = vi.hoisted(() => {
  const state = {
    produits: [] as Array<Record<string, unknown>>,
    groupes: [] as Array<Record<string, unknown>>,
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  };
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    let cols = '';
    q.select = (c: string) => { cols = c; return q; };
    for (const m of ['eq', 'neq', 'order', 'limit', 'in', 'is', 'not']) q[m] = () => q;
    q.then = (ok: unknown, ko: unknown) => {
      let data: unknown[] = [];
      if (table === 'products') {
        // Deux lectures : la liste des formules (colonnes avec price_sell) et
        // le catalogue des composants possibles (id, name, is_formule).
        data = cols.includes('price_sell')
          ? state.produits.filter((p) => p.is_formule)
          : state.produits;
      } else if (table === 'formule_groups') {
        data = state.groupes;
      }
      return Promise.resolve({ data, error: null }).then(ok as never, ko as never);
    };
    q.insert = (payload: Record<string, unknown>) => {
      state.inserts.push({ table, payload });
      if (table === 'products') {
        state.produits.push({ id: 'new-1', is_active: true, ...payload });
      } else if (table === 'formule_groups') {
        state.groupes.push({ id: 'g-new', ...payload, formule_group_items: [] });
      } else if (table === 'formule_group_items') {
        const g = state.groupes.find((x) => x.id === payload.group_id);
        if (g) (g.formule_group_items as unknown[]).push({ id: 'i-new', ...payload, product: { name: 'Poulet braisé' } });
      }
      return {
        select: () => ({ single: async () => ({ data: { id: 'new-1' }, error: null }) }),
        then: (ok: unknown) => Promise.resolve({ error: null }).then(ok as never),
      };
    };
    q.delete = () => ({ eq: () => ({ then: (ok: unknown) => Promise.resolve({ error: null }).then(ok as never) }) });
    return q;
  };
  const supabase = { from: (t: string) => chain(t) };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
  }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

import { FormulesModule } from '@/components/restaurant/FormulesModule';

beforeEach(() => {
  h.state.produits = [
    { id: 'f1', name: 'Formule maquis', price_sell: 3000, category: 'Formules', is_formule: true, is_active: true },
    { id: 'p1', name: 'Poulet braisé', price_sell: 2500, category: 'Plats', is_formule: false, is_active: true },
  ];
  h.state.groupes = [];
  h.state.inserts = [];
});

describe('FormulesModule — composition', () => {
  it('crée une formule, un groupe et un article', async () => {
    render(<FormulesModule />);

    // La formule existante est listée et sélectionnée d'office.
    await waitFor(() => expect(screen.getAllByText('Formule maquis').length).toBeGreaterThan(0));

    // Créer une nouvelle formule (produit is_formule).
    fireEvent.change(screen.getByLabelText('Nom de la nouvelle formule'), { target: { value: 'Formule midi' } });
    fireEvent.change(screen.getByLabelText('Prix de la nouvelle formule'), { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Formule' }));
    await waitFor(() =>
      expect(h.state.inserts.some((i) =>
        i.table === 'products' && i.payload.is_formule === true && i.payload.name === 'Formule midi',
      )).toBe(true),
    );

    // Ajouter un groupe « Plat ».
    fireEvent.change(screen.getByLabelText('Nom du groupe'), { target: { value: 'Plat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Groupe' }));
    await waitFor(() =>
      expect(h.state.inserts.some((i) => i.table === 'formule_groups' && i.payload.name === 'Plat')).toBe(true),
    );

    // Ajouter un article dans ce groupe.
    const select = await screen.findByLabelText('Article à ajouter à Plat');
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Article' }));
    await waitFor(() =>
      expect(h.state.inserts.some((i) =>
        i.table === 'formule_group_items' && i.payload.product_id === 'p1',
      )).toBe(true),
    );
  });
});
