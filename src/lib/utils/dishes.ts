/**
 * Les plats d'un restaurant, pour que la caisse ne les confonde pas avec des
 * articles.
 *
 * Le problème : un produit qui a une RECETTE est un plat. Un plat ne se stocke
 * pas — sa disponibilité vient de ses ingrédients, et c'est
 * `sale_items_consume_recipe` (base) qui refuse la vente si l'un d'eux manque,
 * en nommant l'ingrédient manquant. Or la caisse affichait « Rupture de stock »
 * pour tout plat, parce que le stock propre d'un plat est 0, sa valeur
 * naturelle. Un maquis ne pouvait donc rien servir au comptoir : les plats de
 * son propre catalogue d'exemple étaient tous bloqués.
 *
 * La règle est donc, des deux côtés, la même : un plat n'a pas de stock propre.
 * Ce module ne fait qu'apporter au client l'information que la base applique
 * déjà — la liste des produits qui ont une recette.
 *
 * Une seule requête, au montage. Les recettes changent rarement et un client qui
 * vient d'ajouter une recette voit le plat concerné Sellable dès l'écran suivant.
 */

/**
 * Le client Supabase n'a qu'une méthode utile ici : `from()` puis `select()`.
 * On ne veut pas dépendre du type exact du client (il change selon la version),
 * seulement de ce contrat minimal.
 */
type Fromable = {
  from: (table: string) => {
    select: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/** Identifiants des produits qui sont des plats, pour un tenant donné. */
export async function loadDishIds(db: Fromable): Promise<Set<string>> {
  return chargerIds(db, 'dish_id');
}

/**
 * Une catégorie qui désigne des ingrédients (« Ingrédients », « Ingrédient »,
 * « ingredient », accentué ou non). Le commerçant range ses ingrédients dans
 * une catégorie : c'est le signal qu'il donne, en plus de l'usage réel dans une
 * recette.
 */
export function categorieEstIngredient(category: string | null | undefined): boolean {
  const c = (category ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /ingredient/i.test(c);
}

/**
 * Une catégorie qui désigne des plats (« Plats », « Plat du jour », « Plats
 * composés »). C'est le signal que donne le patron au moment où il crée la
 * fiche, avant même la recette : c'est donc là qu'il faut lui rappeler qu'une
 * recette se saisit avec le plat.
 */
export function categorieEstPlat(category: string | null | undefined): boolean {
  const c = (category ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // « Plats », « Plat du jour », « Plats composés » ; pas « Plateaux », qui
  // contient les mêmes lettres sans être un plat.
  return /\bplats?\b/i.test(c);
}

/**
 * Un produit doit-il figurer au menu de VENTE (caisse, salle) ?
 *
 *   • un PLAT (produit avec recette) se vend toujours — c'est le menu ;
 *   • un INGRÉDIENT (utilisé dans une recette, ou rangé dans une catégorie
 *     d'ingrédients) ne se vend pas : il vit dans le Stock ;
 *   • tout le reste (boissons, articles divers) se vend.
 *
 * Le cas « à la fois plat et ingrédient » est tranché en faveur du plat : on ne
 * masque pas un plat qu'un autre plat réutilise.
 */
export function estVendableAuMenu(
  produit: { id: string; category?: string | null },
  dishIds: Set<string>,
  ingredientIds: Set<string>,
): boolean {
  if (dishIds.has(produit.id)) return true;
  if (ingredientIds.has(produit.id)) return false;
  return !categorieEstIngredient(produit.category);
}

/**
 * Identifiants des produits utilisés comme INGRÉDIENT dans une recette.
 *
 * Un ingrédient n'est pas un article de vente : il vit dans le Stock, pas dans
 * le menu de la caisse ni de la salle. On le masque des surfaces de vente (mais
 * un produit à la fois plat ET ingrédient reste vendable : on ne masque que les
 * ingrédients qui ne sont pas aussi des plats — voir les appelants).
 */
export async function loadIngredientIds(db: Fromable): Promise<Set<string>> {
  return chargerIds(db, 'ingredient_id');
}

async function chargerIds(db: Fromable, colonne: 'dish_id' | 'ingredient_id'): Promise<Set<string>> {
  try {
    const { data, error } = await db.from('recipe_ingredients').select(colonne);

    if (error) {
      // Un restaurant sans table de recettes n'est pas une erreur : le module
      // Recettes peut lui-même être absent de l'organisation. On rend un ensemble
      // vide et la caisse se comporte alors comme un commerce.
      return new Set();
    }

    const ids = new Set<string>();
    for (const row of (data ?? []) as Array<Record<string, string | null>>) {
      const v = row[colonne];
      if (v) ids.add(v);
    }
    return ids;
  } catch {
    // La liste est un CONFORT, pas une condition de vente. Si elle ne peut pas
    // être lue, la caisse vend quand même — au pire un ingrédient réapparaît.
    return new Set();
  }
}