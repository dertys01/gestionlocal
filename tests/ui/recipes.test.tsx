import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Les recettes : ce qu'un plat coûte vraiment.
 *
 * Le test porte sur le calcul affiché et sur le refus d'une recette
 * circulaire — la contrainte qu'une clé étrangère ne peut pas exprimer.
 * L'écriture passe par add_recipe_ingredient(), pas par un INSERT direct.
 */

const { plats, ingredients, rpc, differes, acteur } = vi.hoisted(() => {
  const plats: unknown[] = [];
  const ingredients: unknown[] = [];
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  // Mode « recette en attente » : les réponses recipe_ingredients sont retenues
  // jusqu'à ce que le test les libère, pour observer l'écran entre le choix
  // d'un plat et le retour de sa recette.
  const differes = {
    actif: false,
    files: [] as Array<{ dish: string; finir: (v: unknown) => void }>,
  };
  // Rôle mutable : permet de tester le chemin « simple caissier » (lecture seule).
  const acteur = { canManage: true };
  return { plats, ingredients, rpc, differes, acteur };
});

const chaine = (donnees: unknown) => {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = () => c;
  c.order = () => c;
  c.then = (ok: (v: unknown) => unknown) => ok({ data: donnees, error: null });
  c.delete = () => ({ eq: async () => ({ error: null }) });
  return c;
};

// En mode différé, la chaîne des ingrédients ne se résout que quand le test y
// autorise — avec la recette du PLAT DEMANDÉ, pas une réponse globale : c'est
// ce qui permet d'envoyer la mauvaise réponse en retard et de vérifier qu'elle
// n'écrit rien.
const chaineDifferee = () => {
  const c: Record<string, unknown> = {};
  let dish = '';
  c.select = () => c;
  c.eq = (_col: string, valeur: string) => {
    dish = valeur;
    return c;
  };
  c.order = () => c;
  c.then = (ok: (v: unknown) => unknown) => {
    differes.files.push({ dish, finir: (v) => { void ok(v); } });
  };
  return c;
};

const supabase = {
  from: (table: string) =>
    table === 'recipe_costs'
      ? chaine(plats)
      : table === 'recipe_ingredients'
        ? (differes.actif ? chaineDifferee() : chaine(ingredients))
        : chaine([{ id: 'p1', name: 'Poulet braisé' }, { id: 'p2', name: 'Riz blanc' }]),
  rpc,
  auth: { getUser: vi.fn() },
};

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    canManageProducts: acteur.canManage,
    isEmployee: false,
    org: { domain: 'restaurant' },
  }),
}));

import { RecipesModule } from '@/components/restaurant/RecipesModule';

const PLAT = {
  id: 'p1',
  name: 'Poulet braisé',
  category: 'Plats',
  price_sell: 4500,
  stock_qty: 0,
  unit_cost: 165,
  margin: 4335,
  margin_pct: 96.3,
  ingredient_count: 2,
};

function definirPlats(...l: unknown[]) {
  plats.length = 0;
  plats.push(...l);
}

function definirIngredients(...l: unknown[]) {
  ingredients.length = 0;
  ingredients.push(...l);
}

describe('RecipesModule — le coût de revient d\'un plat', () => {
  it('invite à créer des produits quand le catalogue est vide', async () => {
    definirPlats();
    render(<RecipesModule />);
    await waitFor(() => {
      expect(screen.getByText(/Aucun plat à composer/i)).toBeInTheDocument();
    });
  });

  it('affiche le coût, la marge et le pourcentage du plat choisi', async () => {
    definirPlats(PLAT);
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });

    // 4 500 − 165 = 4 335, soit 96,3 %. C'est la marge RÉELLE : le prix
    // d'achat du plat (2 000) ne doit pas apparaître.
    await waitFor(() => expect(screen.getByText('165 F')).toBeInTheDocument());
    expect(screen.getByText('96.3 %')).toBeInTheDocument();
  });

  it('affiche un tiret quand le plat n\'a pas de recette', async () => {
    definirPlats({ ...PLAT, ingredient_count: 0, unit_cost: 2000, margin: 2500, margin_pct: 55.6 });
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });

    // Sans recette, il n'y a pas de coût de revient à afficher : le prix
    // d'achat du plat n'est PAS un coût de recette, et le montrer ferait
    // croire à une précision qui n'existe pas. Même la marge s'efface.
    await waitFor(() => expect(screen.getAllByText('-').length).toBeGreaterThan(0));
    expect(screen.queryByText('55.6 %')).not.toBeInTheDocument();
    expect(screen.queryByText('2 000 F')).not.toBeInTheDocument();
  });

  it('signale un ingrédient insuffisant pour une portion', async () => {
    definirPlats(PLAT);
    definirIngredients(
      {
        ingredient_id: 'p2',
        quantity: 0.3,
        ingredient: { name: 'Riz blanc', unit: 'kg', stock_qty: 50, price_buy: 400 },
      },
      {
        ingredient_id: 'p3',
        quantity: 1,
        ingredient: { name: 'Poulet fermier', unit: 'pce', stock_qty: 0, price_buy: 1500 },
      },
    );
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });

    await waitFor(() => expect(screen.getByText(/1 ingrédient ne suffit pas/i)).toBeInTheDocument());
    // Le patron doit savoir que la vente sera refusée, pas seulement qu'un
    // chiffre a bougé.
    expect(screen.getByText(/la vente de ce plat sera refusée/i)).toBeInTheDocument();
  });

  it('écrit les ingrédients par la fonction, pas par un INSERT direct', async () => {
    definirPlats(PLAT);
    definirIngredients();
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByLabelText(/Ingrédient à ajouter/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Ingrédient à ajouter/i), { target: { value: 'p2' } });
    fireEvent.change(screen.getByLabelText(/Quantité pour une portion/i), { target: { value: '0,3' } });
    // Deux boutons « Ajouter » coexistent (option et ingrédient) : le libellé
// exact lève l'ambiguïté.
    fireEvent.click(screen.getByRole('button', { name: "Ajouter l'ingrédient" }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('add_recipe_ingredient', {
      p_dish_id: 'p1',
      p_ingredient_id: 'p2',
      p_quantity: 0.3,
    }));
  });

  it('ne propose pas un ingrédient déjà dans la recette', async () => {
    definirPlats(PLAT);
    definirIngredients({
      ingredient_id: 'p2',
      quantity: 0.3,
      ingredient: { name: 'Riz blanc', unit: 'kg', stock_qty: 50, price_buy: 400 },
    });
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });

    const select = (await screen.findByLabelText(
      /Ingrédient à ajouter/i,
    )) as HTMLSelectElement;

    // « Riz blanc » est déjà composant : il ne reste que le sélecteur vide.
    // S'il y revenait, add_recipe_ingredient() répond au doublon par un
    // ON CONFLICT DO UPDATE et REMPLACE la quantité par celle du champ (« 1 »),
    // sans un mot — 0,3 kg de riz deviennent 1 kg, et le coût de revient, la
    // marge et la consommation du stock deviennent faux en deux clics.
    await waitFor(() => expect(select.options).toHaveLength(1));
    expect(select.options[0].text).toBe('Ingrédient…');
  });

  it('affiche l\'erreur quand la base refuse une recette circulaire', async () => {
    definirPlats(PLAT);
    definirIngredients();
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Cet ingrédient contient déjà ce plat : la recette formerait un cercle' },
    } as never);
    render(<RecipesModule />);

    await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByLabelText(/Ingrédient à ajouter/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Ingrédient à ajouter/i), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: "Ajouter l'ingrédient" }));

    await waitFor(() => expect(screen.getByText(/formerait un cercle/i)).toBeInTheDocument());
  });

  /**
   * Trouvé en recette navigateur le 06/10/2026.
   *
   * Changer de plat laissait la recette de l'ANCIEN plat affichée sous le titre
   * du nouveau tant que la requête n'était pas revenue — et, au premier choix,
   * « Aucun ingrédient. Sans recette… » s'affichait pendant le chargement,
   * comme si composer ne servait à rien. On vide avant de recharger, on annonce
   * le chargement, et une réponse qui arrive pour un plat quitté n'écrit rien.
   */
  it("ne montre ni l'ancienne recette ni « Aucun ingrédient » pendant le chargement", async () => {
    differes.actif = true;
    differes.files.length = 0;
    definirPlats(PLAT, { ...PLAT, id: 'p2', name: 'Riz gras' });
    try {
      render(<RecipesModule />);
      await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
      const selecteur = screen.getByLabelText(/Plat à composer/i);

      fireEvent.change(selecteur, { target: { value: 'p1' } });
      await waitFor(() => expect(screen.getByText(/Chargement de la recette/i)).toBeInTheDocument());
      // Le message du bug : jamais pendant le chargement.
      expect(screen.queryByText(/Aucun ingrédient/i)).toBeNull();
      await waitFor(() => expect(differes.files).toHaveLength(1));

      // On quitte le plat avant que sa recette n'arrive.
      fireEvent.change(selecteur, { target: { value: 'p2' } });
      await waitFor(() => expect(differes.files).toHaveLength(2));
      expect(differes.files[1].dish).toBe('p2');

      // La réponse périmée du plat quitté finit par arriver : elle ne doit
      // rien écrire sous le nouveau titre.
      differes.files[0].finir({
        data: [
          {
            ingredient_id: 'i1',
            quantity: 1,
            ingredient: { name: 'Oignon', unit: 'kg', stock_qty: 3, price_buy: 100 },
          },
        ],
        error: null,
      });
      await act(async () => {});
      expect(screen.queryByText('Oignon')).toBeNull();
      expect(screen.getByText(/Chargement de la recette/i)).toBeInTheDocument();

      // La bonne recette arrive : c'est elle, et elle seule, qui s'affiche.
      differes.files[1].finir({
        data: [
          {
            ingredient_id: 'i2',
            quantity: 2,
            ingredient: { name: 'Poisson fumé', unit: 'pce', stock_qty: 1, price_buy: 500 },
          },
        ],
        error: null,
      });
      await screen.findByText('Poisson fumé');
      expect(screen.queryByText('Oignon')).toBeNull();
      expect(screen.queryByText(/Chargement de la recette/i)).toBeNull();
    } finally {
      differes.actif = false;
      differes.files.length = 0;
    }
  });

  /**
   * Chemin « simple caissier » : la recette se consulte, elle ne se modifie pas.
   *
   * Le coût de revient reste affiché (c'est une information de service), mais
   * la gestion des options — qui écrit en base — disparaît. Le rôle vivait
   * dans le code sans test : une régression qui rouvrirait l'écriture à un
   * caissier serait passée inaperçue.
   */
  it("cache la gestion des options à un simple caissier (lecture seule)", async () => {
    acteur.canManage = false;
    definirPlats(PLAT);
    try {
      render(<RecipesModule />);
      await waitFor(() => expect(screen.getByLabelText(/Plat à composer/i)).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText(/Plat à composer/i), { target: { value: 'p1' } });

      // Le calcul reste : le caissier a le droit de savoir ce que coûte le plat.
      await waitFor(() => expect(screen.getByText('165 F')).toBeInTheDocument());
      // La carte d'écriture, elle, n'existe pas.
      expect(screen.queryByText(/Options de Poulet braisé/i)).toBeNull();
    } finally {
      acteur.canManage = true;
    }
  });
});