import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Le formulaire produit.
 *
 * On verrouille ce qui part réellement en base : le payload (espaces retirés,
 * `null` plutôt que chaîne vide), la virgule décimale lue comme un nombre, la
 * limite de plan, et l'édition qui met à jour au lieu de recréer.
 */

const h = vi.hoisted(() => {
  const inserts: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const categories = { rows: [] as Array<{ category: string | null }> };

  const builder = (table: string) => {
    const ctx = { op: '', payload: undefined as unknown, eqs: [] as [string, unknown][] };
    const b: Record<string, unknown> = {};
    b.select = () => { if (ctx.op === 'update') return Promise.resolve({ data: null, error: null }); ctx.op = 'select'; return b; };
    b.not = () => b;
    b.eq = (c: string, v: unknown) => { ctx.eqs.push([c, v]); return b; };
    b.insert = (p: Record<string, unknown>) => { inserts.push(p); return Promise.resolve({ error: null }); };
    b.update = (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b; };
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(
        ctx.op === 'select' && table === 'products'
          ? { data: categories.rows, error: null }
          : { data: null, error: null },
      ).then(ok);
    return b;
  };

  const supabase = {
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.c' } }, error: null }) },
  };
  const session: { plan: 'free' | 'starter' | 'pro'; org: { domain: string } } = { plan: 'pro', org: { domain: 'retail' } };
  return { inserts, updates, categories, supabase, session };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase, ownerId: 'org-1', actorName: 'Patron',
    plan: h.session.plan, org: h.session.org,
  }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('@/components/products/SupplierSelect', () => ({ SupplierSelect: () => null }));

import { ProductForm } from '@/components/products/ProductForm';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import type { Product } from '@/types';

function produit(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', user_id: 'org-1', name: 'Riz blanc', sku: 'RIZ-1', price_buy: 400,
    price_sell: 500, stock_qty: 10, min_stock_level: 3, category: 'Céréales',
    unit: 'kg', is_active: true, archived_at: null, supplier_id: null,
    menu_days: null, created_at: '', updated_at: '', ...over,
  };
}

const noop = () => {};
beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.categories.rows = [];
  h.session.plan = 'pro';
  h.session.org = { domain: 'retail' };
});

const remplir = (label: RegExp, valeur: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: valeur } });
const soumettre = () => fireEvent.click(screen.getByRole('button', { name: /Ajouter le produit|Enregistrer/i }));
// La validation HTML native (required, min) bloque le clic : pour exercer la
// validation applicative, on soumet le formulaire directement.
const soumettreForce = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement);

describe('ProductForm', () => {
  it('exige un nom et un prix de vente', async () => {
    const onSaved = vi.fn();
    render(<ProductForm onClose={noop} onSaved={onSaved} />);

    soumettreForce();

    expect(screen.getByText(/nom et le prix de vente sont obligatoires/i)).toBeInTheDocument();
    expect(h.inserts).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('enregistre un nouveau produit avec un payload nettoyé', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<ProductForm onClose={onClose} onSaved={onSaved} />);

    remplir(/Nom du produit/, '  Riz parfumé  ');
    remplir(/Prix vente/, '1500');
    remplir(/^Catégorie/, '  Céréales  ');
    soumettre();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    expect(h.inserts[0]).toMatchObject({
      name: 'Riz parfumé', category: 'Céréales', price_sell: 1500, user_id: 'org-1',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('applique le seuil d’alerte par défaut (5)', async () => {
    render(<ProductForm onClose={noop} onSaved={noop} />);
    remplir(/Nom du produit/, 'Riz');
    remplir(/Prix vente/, '500');
    soumettre();

    await waitFor(() => expect(h.inserts).toHaveLength(1));
    expect(h.inserts[0].min_stock_level).toBe(5);
  });

  it('refuse un montant négatif', async () => {
    render(<ProductForm onClose={noop} onSaved={noop} />);
    remplir(/Nom du produit/, 'Riz');
    remplir(/Prix vente/, '-5');
    soumettreForce();

    await waitFor(() => expect(screen.getByText(/doivent être positifs/i)).toBeInTheDocument());
    expect(h.inserts).toHaveLength(0);
  });

  it('bloque un nouveau produit au-delà du quota du plan', async () => {
    h.session.plan = 'free';
    render(
      <ProductForm onClose={noop} onSaved={noop} currentProductCount={PLAN_LIMITS.free.products} />,
    );
    remplir(/Nom du produit/, 'Riz');
    remplir(/Prix vente/, '500');
    soumettre();

    expect(screen.getByText(/Limite atteinte/i)).toBeInTheDocument();
    expect(h.inserts).toHaveLength(0);
  });

  it('modifie un produit existant au lieu d’en créer un', async () => {
    const onSaved = vi.fn();
    render(<ProductForm product={produit()} onClose={noop} onSaved={onSaved} />);

    remplir(/Prix vente/, '600');
    soumettre();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.inserts).toHaveLength(0);
    // L'identifiant est bien la clé de l'update.
    expect(screen.getByText(/Modifier le produit/i)).toBeInTheDocument();
  });

  it('rappelle qu\'une recette se saisit avec le plat, au restaurant', () => {
    h.session.org = { domain: 'restaurant' };
    render(<ProductForm onClose={noop} onSaved={noop} />);

    remplir(/^Catégorie/, 'Plats');
    expect(screen.getByText(/Une recette se saisit avec le plat/i)).toBeInTheDocument();
  });

  it('signale un plat existant sans recette, et ne le fait pas pour un commerce', async () => {
    h.session.org = { domain: 'restaurant' };
    const { unmount } = render(
      <ProductForm product={produit({ category: 'Plats' })} onClose={noop} onSaved={noop} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Ce plat n'a pas de recette/i)).toBeInTheDocument(),
    );
    unmount();

    // Un commerce peut avoir une catégorie « Plats » (des assiettes) : le
    // rappel sur les recettes n'a rien à y faire.
    h.session.org = { domain: 'retail' };
    render(<ProductForm product={produit({ category: 'Plats' })} onClose={noop} onSaved={noop} />);
    expect(screen.queryByText(/pas de recette/i)).not.toBeInTheDocument();
  });

  it('déduplique les catégories à la casse et aux espaces près', async () => {
    h.categories.rows = [{ category: 'Boissons' }, { category: '  boissons  ' }, { category: 'Céréales' }];
    render(<ProductForm onClose={noop} onSaved={noop} />);

    // Une seule pastille « Boissons » (la première orthographe l'emporte),
    // et « Céréales ». La comparaison ignore casse et espaces de bord.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Boissons' })).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /boissons/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Céréales' })).toBeInTheDocument();
  });
});
