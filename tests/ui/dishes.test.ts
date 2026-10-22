import { describe, expect, it } from 'vitest';

/**
 * Les catégories décident de deux choses très concrètes : un ingrédient ne
 * figure pas au menu de vente, et un plat sans recette doit être signalé au
 * moment où on le crée. Une règle trop large ferait disparaître un article du
 * menu, ou afficherait un rappel sur les recettes à un commerce qui vend des
 * plateaux.
 */

import { categorieEstIngredient, categorieEstPlat } from '@/lib/utils/dishes';

describe('catégories du restaurant', () => {
  it('reconnaît les plats sans confondre les plateaux', () => {
    expect(categorieEstPlat('Plats')).toBe(true);
    expect(categorieEstPlat('plat')).toBe(true);
    expect(categorieEstPlat('Plat du jour')).toBe(true);
    expect(categorieEstPlat('Plats composés')).toBe(true);
    expect(categorieEstPlat('Menu / Plats')).toBe(true);

    expect(categorieEstPlat('Plateaux')).toBe(false);
    expect(categorieEstPlat('Boissons')).toBe(false);
    expect(categorieEstPlat('')).toBe(false);
    expect(categorieEstPlat(null)).toBe(false);
    expect(categorieEstPlat(undefined)).toBe(false);
  });

  it('reconnaît les ingrédients accentués ou non', () => {
    expect(categorieEstIngredient('Ingrédients')).toBe(true);
    expect(categorieEstIngredient('ingredient')).toBe(true);
    expect(categorieEstIngredient('Ingrédient frais')).toBe(true);
    expect(categorieEstIngredient('Plats')).toBe(false);
    expect(categorieEstIngredient(null)).toBe(false);
  });
});
