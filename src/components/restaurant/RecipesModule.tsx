'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChefHat, Loader2, Plus, Trash2, AlertTriangle } from 'lucide-react';

import { useSupabase } from '@/components/providers/SupabaseProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';

/**
 * Les recettes : ce qu'un plat coûte vraiment.
 *
 * Un patron n'achète pas du « poulet braisé », il achète du poulet, du riz et
 * de l'huile. Sans cette table, sa marge est une fiction. Avec elle, le coût
 * d'une portion est la somme de ses ingrédients — récursivement, donc un plat
 * peut contenir un autre plat.
 *
 * L'écriture passe par add_recipe_ingredient(), pas par un INSERT direct : la
 * fonction refuse une recette circulaire, ce qu'une contrainte SQL ne peut pas
 * voir. Le coût affiché vient de la base (product_cost), jamais d'un calcul ici.
 */

interface IngredientRow {
  ingredient_id: string;
  quantity: number;
  name: string;
  unit: string | null;
  stock_qty: number;
  price_buy: number | null;
}

interface RecetteRow {
  id: string;
  name: string;
  category: string | null;
  price_sell: number;
  stock_qty: number;
  unit_cost: number;
  margin: number;
  margin_pct: number | null;
  ingredient_count: number;
}

export function RecipesModule() {
  const { supabase, canManageProducts, ownerId } = useSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;

  const [plats, setPlats] = useState<RecetteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [lignes, setLignes] = useState<IngredientRow[]>([]);
  // Vrai entre le choix d'un plat et le retour de sa recette. Sans cet état,
  // « Aucun ingrédient » s'affiche pendant le chargement comme si le plat
  // n'avait jamais eu de recette — le patron croit alors que composer sert à
  // rien et s'en va.
  const [chargementLignes, setChargementLignes] = useState(false);
  // Miroir de `sel` consultable dans les callbacks : une requête partie pour un
  // plat qu'on a quitté en chemin ne doit rien écrire (ni lignes, ni options,
  // ni message d'erreur) sous le plat affiché.
  const selRef = useRef<string | null>(null);
  const [catalogue, setCatalogue] = useState<Array<{ id: string; name: string }>>([]);
  const [ajout, setAjout] = useState('');
  const [qte, setQte] = useState('1');
  const [busy, setBusy] = useState(false);

  // Carte : options du plat sélectionné.
  const [options, setOptions] = useState<Array<{ id: string; name: string; extra_price: number }>>([]);
  const [optionNom, setOptionNom] = useState('');
  const [optionPrix, setOptionPrix] = useState('0');

  const charger = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await client
      .from('recipe_costs')
      .select('id, name, category, price_sell, stock_qty, unit_cost, margin, margin_pct, ingredient_count')
      .order('name');
    setLoading(false);
    if (err) { setError(err.message); return; }
    setPlats((data ?? []) as RecetteRow[]);
  }, [client]);

  const chargerLignes = useCallback(async (platId: string) => {
    const { data, error: err } = await client
      .from('recipe_ingredients')
      // La relation est nommée EXPLICITEMENT : recipe_ingredients porte deux
      // clés étrangères vers products (le plat et l'ingrédient), et PostgREST
      // refuse de deviner (« more than one relationship was found »). Le nom
      // de la contrainte est donc écrit en clair — il fait partie du schéma.
      .select('ingredient_id, quantity, ingredient:products!recipe_ingredients_ingredient_id_fkey(name, unit, stock_qty, price_buy)')
      .eq('dish_id', platId);
    // Le plat a changé pendant la requête : ce résultat ne décrit plus rien de
    // ce qui est à l'écran (et l'erreur, non plus).
    if (selRef.current !== platId) return;
    if (err) { setError(err.message); return; }
    setLignes(
      ((data ?? []) as Array<{ ingredient_id: string; quantity: number; ingredient: Omit<IngredientRow, 'ingredient_id' | 'quantity'> | null }>)
        .map((l) => ({
          ingredient_id: l.ingredient_id,
          quantity: Number(l.quantity),
          name: l.ingredient?.name ?? 'Ingrédient',
          unit: l.ingredient?.unit ?? 'pce',
          stock_qty: Number(l.ingredient?.stock_qty ?? 0),
          price_buy: l.ingredient?.price_buy != null ? Number(l.ingredient.price_buy) : null,
        }))
    );
  }, [client]);

  useEffect(() => {
    const t = setTimeout(() => { void charger(); }, 0);
    return () => clearTimeout(t);
  }, [charger]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const { data } = await client.from('products').select('id, name').order('name');
      setCatalogue((data ?? []) as Array<{ id: string; name: string }>);
    }, 0);
    return () => clearTimeout(t);
  }, [client]);

  // Changer de plat recharge ses lignes ET ses options. Le setState est dans le
  // setTimeout, pas dans le corps de l'effet : synchrone, il provoquerait un
  // rendu en cascade (react-hooks/set-state-in-effect).
  useEffect(() => {
    const id = sel;
    const t = setTimeout(async () => {
      if (!id) {
        setLignes([]);
        setOptions([]);
        setChargementLignes(false);
        return;
      }
      await chargerLignes(id);
      const { data } = await client
        .from('product_modifiers')
        .select('id, name, extra_price')
        .eq('product_id', id)
        .order('name');
      // Plat quitté en vol : ni les options, ni la fin du chargement ne
      // concernent plus cet écran.
      if (selRef.current !== id) return;
      setOptions((data ?? []) as Array<{ id: string; name: string; extra_price: number }>);
      setChargementLignes(false);
    }, 0);
    return () => clearTimeout(t);
  }, [sel, chargerLignes, client]);

  const plat = plats.find((p) => p.id === sel) ?? null;

  // Le stock d'ingrédient qui manquerait pour UNE portion : c'est le vrai
  // signal d'un patron, bien avant que la vente ne refuse le plat.
  const ruptures = useMemo(
    () => lignes.filter((l) => l.stock_qty < l.quantity),
    [lignes]
  );

  /**
   * Ce qui peut encore entrer dans la recette.
   *
   * Les ingrédients DÉJÀ composants en sont retirés. Ils y figuraient, et
   * add_recipe_ingredient() répond à un doublon par un `ON CONFLICT DO UPDATE`
   * : choisir « Riz blanc » une seconde fois ne créait pas une deuxième ligne,
   * il REMPLAÇAIT la quantité de la première par celle du champ — « 1 » par
   * défaut — sans un mot. Le coût de revient, la marge affichée et la
   * consommation du stock suivaient, tous trois faux, en deux clics. Un plat à
   * 0,3 kg de riz pour une portion passait à 1 kg, et personne ne le voyait.
   */
  const disponibles = useMemo(() => {
    const pris = new Set(lignes.map((l) => l.ingredient_id));
    return catalogue.filter((c) => c.id !== sel && !pris.has(c.id));
  }, [catalogue, lignes, sel]);

  const ajouterOption = async () => {
    if (!sel || !optionNom.trim()) return;
    const prix = lireMontant(optionPrix) ?? 0;
    if (prix < 0) { setError('Le supplément ne peut pas être négatif.'); return; }
    setBusy(true);
    setError('');
    const { error: err } = await client.from('product_modifiers').insert({
      // owner_id vient du contexte, jamais d'une constante : la policy
      // « modifiers_write » le compare à get_business_owner_id(), et un id
      // codé en dur échouerait pour tout restaurant autre que le premier.
      owner_id: ownerId,
      product_id: sel,
      name: optionNom.trim(),
      extra_price: prix,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setOptionNom('');
    setOptionPrix('0');
    const { data } = await client
      .from('product_modifiers')
      .select('id, name, extra_price')
      .eq('product_id', sel)
      .order('name');
    setOptions((data ?? []) as Array<{ id: string; name: string; extra_price: number }>);
  };

  const retirerOption = async (id: string) => {
    setBusy(true);
    setError('');
    const { error: err } = await client.from('product_modifiers').delete().eq('id', id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setOptions((o) => o.filter((x) => x.id !== id));
  };

  const ajouter = async () => {
    if (!sel || !ajout) return;
    const n = lireMontant(qte) ?? 0;
    if (n <= 0) { setError('Quantité invalide.'); return; }
    setBusy(true);
    setError('');
    const { error: err } = await client.rpc('add_recipe_ingredient', {
      p_dish_id: sel,
      p_ingredient_id: ajout,
      p_quantity: n,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setAjout('');
    setQte('1');
    await Promise.all([chargerLignes(sel), charger()]);
  };

  const retirer = async (ingredientId: string) => {
    if (!sel) return;
    setBusy(true);
    setError('');
    const { error: err } = await client
      .from('recipe_ingredients')
      .delete()
      .eq('dish_id', sel)
      .eq('ingredient_id', ingredientId);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await Promise.all([chargerLignes(sel), charger()]);
  };

  const avecRecette = plats.filter((p) => p.ingredient_count > 0);
  const sansRecette = plats.filter((p) => p.ingredient_count === 0);

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* Choix du plat */}
      {/* L'état vide ne s'affiche QUE si le catalogue est réellement vide. Avec une
      erreur de chargement, il affichait « aucun plat à composer » — un message
      qui contredit la réalité et masque la panne. */}
      {plats.length === 0 && !loading && !error ? (
        <EmptyState
          icon={ChefHat}
          title="Aucun plat à composer"
          hint="Un plat se compose avec ses ingrédients et leurs quantités. Ajoutez d'abord le plat et ses ingrédients depuis l'onglet Stock, puis sa recette ici : c'est elle qui déduit le stock à la vente et calcule la marge du plat."
        />
      ) : (
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-3">
            <label htmlFor="recipe-dish" className="text-sm font-medium text-slate-700">
              Plat à composer
            </label>
            <select
              id="recipe-dish"
              value={sel ?? ''}
              onChange={(e) => {
                const id = e.target.value || null;
                // On vide AVANT de recharger : sinon les lignes du plat qu'on
                // quitte restent affichées sous le nouveau titre tant que la
                // requête n'est pas revenue.
                selRef.current = id;
                setLignes([]);
                setOptions([]);
                setChargementLignes(id !== null);
                setSel(id);
              }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Choisir un plat…</option>
              {[...avecRecette, ...sansRecette].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.ingredient_count > 0 ? ` (${p.ingredient_count} ingrédients)` : ' (sans recette)'}
                </option>
              ))}
            </select>

            {plat && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Prix</p>
                  <p className="font-semibold text-slate-800 text-sm">{formatCFA(plat.price_sell)}</p>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Coût portion</p>
                  <p className="font-semibold text-slate-800 text-sm">
                    {plat.ingredient_count > 0 ? formatCFA(plat.unit_cost) : '-'}
                  </p>
                </div>
                <div
                  className={`rounded-lg border p-2 ${
                    plat.margin_pct !== null && plat.margin_pct < 50
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-emerald-50 border-emerald-200'
                  }`}
                >
                  <p className="text-xs text-slate-500">Marge</p>
                  <p className="font-semibold text-slate-800 text-sm">
                    {plat.ingredient_count > 0 && plat.margin_pct !== null
                      ? `${plat.margin_pct} %`
                      : '-'}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ingrédients */}
      {plat && (
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">
              Ce qu&apos;il faut pour une portion de {plat.name}
            </h3>

            {lignes.length === 0 ? (
              chargementLignes ? (
                <p className="text-sm text-slate-500 py-2 text-center">
                  Chargement de la recette…
                </p>
              ) : (
                <p className="text-sm text-slate-500 py-2 text-center">
                  Aucun ingrédient. Sans recette, le coût affiché reste le prix
                  d&apos;achat du plat.
                </p>
              )
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {lignes.map((l) => {
                  const manque = l.stock_qty < l.quantity;
                  return (
                    <div key={l.ingredient_id} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-800 truncate">{l.name}</div>
                        <div className="text-xs text-slate-500">
                          {formatQty(l.quantity)} {l.unit} pour 1 portion · stock{' '}
                          {Number(l.stock_qty.toFixed(3))} {l.unit}
                        </div>
                      </div>
                      {manque && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-700">
                          <AlertTriangle className="h-3 w-3" /> pas assez
                        </span>
                      )}
                      {canManageProducts && (
                        <button
                          onClick={() => retirer(l.ingredient_id)}
                          disabled={busy}
                          aria-label={`Retirer ${l.name} de la recette`}
                          className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-50 shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {ruptures.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {/* Une seule chaîne, pas trois interpolations : un texte morcelé en nœuds
                texte est introuvable pour un lecteur d'écran et pour les
                tests, et l'accord « suffit / suffisent » mérite d'être écrit
                d'un trait. */}
                {`${ruptures.length} ingrédient${ruptures.length > 1 ? 's ne suffisent' : ' ne suffit'} pas pour une portion : la vente de ce plat sera refusée tant que le stock n'est pas réapprovisionné.`}
              </p>
            )}

            {canManageProducts && (
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="Ingrédient à ajouter"
                  value={ajout}
                  onChange={(e) => setAjout(e.target.value)}
                  className="flex-1 min-w-40 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Ingrédient…</option>
                  {disponibles.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <Input
                  value={qte}
                  onChange={(e) => setQte(e.target.value)}
                  aria-label="Quantité pour une portion"
                  placeholder="Qté"
                  className="w-24"
                />
                <Button
                  onClick={ajouter}
                  disabled={busy || !ajout}
                  className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Ajouter l&apos;ingrédient
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Carte : options du plat ── */}
      {plat && canManageProducts && (
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">
              Options de {plat.name}
            </h3>
            <p className="text-xs text-slate-500">
              « Bien cuit » ne coûte rien, « double portion » coûte 1 500 F. Le
              supplément part dans l&apos;addition et sur le ticket cuisine, sans
              prix dessus.
            </p>

            {options.length === 0 ? (
              <p className="text-sm text-slate-500 py-2 text-center">
                Aucune option. Sans option, le serveur cuisine ce qu&apos;il a
                fait la dernière fois.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {options.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800 truncate">{m.name}</div>
                      <div className="text-xs text-slate-500">
                        {Number(m.extra_price) > 0
                          ? `+ ${formatCFA(m.extra_price)}`
                          : 'sans supplément'}
                      </div>
                    </div>
                    <button
                      onClick={() => retirerOption(m.id)}
                      disabled={busy}
                      aria-label={`Retirer l'option ${m.name}`}
                      className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Input
                value={optionNom}
                onChange={(e) => setOptionNom(e.target.value)}
                placeholder="Nom (ex: Bien cuit)"
                aria-label="Nom de l'option"
                className="flex-1 min-w-36"
              />
              <Input
                value={optionPrix}
                onChange={(e) => setOptionPrix(e.target.value)}
                placeholder="Supplément"
                aria-label="Supplément de l'option"
                className="w-28"
              />
              <Button
                onClick={ajouterOption}
                disabled={busy || !optionNom.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Ajouter l&apos;option
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}