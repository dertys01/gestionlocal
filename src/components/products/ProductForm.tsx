'use client';

import { useState, useEffect } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { SupplierSelect } from '@/components/products/SupplierSelect';
import { logActivity } from '@/lib/utils/activity';
import { canAddProduct, PLAN_LIMITS, PLAN_LABELS } from '@/lib/utils/plans';
import { fieldExamples } from '@/lib/starterCatalog';
import { lireMontant } from '@/lib/utils/nombres';
import type { Product } from '@/types';

interface ProductFormProps {
  product?: Product | null;
  onClose: () => void;
  onSaved: () => void;
  currentProductCount?: number;
}

/**
 * Unités proposées. La liste reste ouverte côté formulaire (saisie libre) :
 * les unités d'un marché ne sont pas prévisibles, et « calabash » ou
 * « tine » doivent pouvoir être saisis.
 */
const UNITES = ['pce', 'kg', 'g', 'L', 'sachet', 'botte', 'panier', 'tablette'];

export function ProductForm({ product, onClose, onSaved, currentProductCount = 0 }: ProductFormProps) {
  const { supabase, ownerId, actorName, plan, org } = useSupabase();
  // Les exemples des champs suivent le domaine : « Samsung Galaxy A05 » dans un
  // maquis est une faute de goût qui se voit, et qui se répète à chaque fiche.
  const exemples = fieldExamples(org?.domain);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    // Le builder est un thenable sans .catch() : on enveloppe en async/await.
    // Sans gestion d'erreur, un rejet réseau devenait une unhandled rejection.
    const loadCategories = async () => {
      const { data, error } = await supabase
        .from('products')
        .select('category')
        .not('category', 'is', null);

      if (error) {
        // Non bloquant : le champ catégorie reste saisissable librement.
        console.error('[ProductForm] chargement des catégories', error.message);
        return;
      }
      // Un Set sur les chaînes brutes ne suffit pas : « smartphones » et
      // « smartphones » (espace final) sont deux clés différentes, et la
      // pastille se retrouvait affichée deux fois, identique à l'œil. La
      // comparaison ignore la casse et les espaces de bord, et c'est la
      // version ASSOUPLIE qui est retenue — « sms » garde son orthographe.
      const parCle = new Map<string, string>();
      for (const p of data ?? []) {
        const brut = (p.category ?? '').trim();
        if (!brut) continue;
        const cle = brut.toLocaleLowerCase('fr');
        if (!parCle.has(cle)) parCle.set(cle, brut);
      }
      setCategories([...parCle.values()].sort((a, b) => a.localeCompare(b, 'fr')));
    };

    loadCategories();
  }, [supabase]);

  // Initialisé une seule fois depuis `product` : le modal est monté à chaque
  // ouverture (page.tsx le rend conditionnellement), donc pas besoin de
  // resynchroniser via un effet — ce qui évitait un setState en cascade et
  // la brief|display d'un formulaire vide avant remplissage.
  const [form, setForm] = useState(() => ({
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    category: product?.category ?? '',
    price_buy: product ? String(product.price_buy) : '',
    price_sell: product ? String(product.price_sell) : '',
    stock_qty: product ? String(product.stock_qty) : '',
    min_stock_level: product ? String(product.min_stock_level) : '5',
    supplier_id: product?.supplier_id ?? null,
    unit: product?.unit ?? 'pce',
    is_formule: product?.is_formule ?? false,
  }));

  const set = (key: string, value: string | null) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.name || !form.price_sell) {
      setError('Le nom et le prix de vente sont obligatoires.');
      return;
    }

    // Vérification limite de plan (uniquement pour les nouveaux produits).
    // Les limites viennent de PLAN_LIMITS : elles étaient recopiées en dur ici
    // (`plan === 'free' ? 30 : 200`), ce qui donnait 200 pour le plan Pro qui
    // n'en a pas.
    if (!product && !canAddProduct(plan, currentProductCount)) {
      const max = PLAN_LIMITS[plan].products;
      setError(
        max === Infinity
          ? 'Limite atteinte.'
          : `Limite atteinte. Votre plan ${PLAN_LABELS[plan]} autorise au maximum ${max} produits. Passez au plan supérieur dans Paramètres.`
      );
      return;
    }

    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !ownerId) {
        setError('Session expirée, reconnectez-vous.');
        return;
      }

      const priceBuy = lireMontant(form.price_buy);
      const priceSell = lireMontant(form.price_sell);
      const stockQty = lireMontant(form.stock_qty);
      const minStock = lireMontant(form.min_stock_level);
      // 1,5 kg de riz est une quantité valide : lireMontant accepte la virgule.

      if (priceBuy === null || priceSell === null || stockQty === null || minStock === null) {
        setError('Montant ou quantité invalide.');
        return;
      }
      if (priceBuy < 0 || priceSell < 0 || stockQty < 0 || minStock < 0) {
        setError('Les prix et quantités doivent être positifs.');
        return;
      }

      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        // trim() : « smartphones » et « smartphones » doivent rester le même
        // rayon. Sans ça, la saisie ajoute une catégorie à un espace près de
        // l'existante, et les filtres de la caisse en affichent deux.
        category: form.category.trim() || null,
        price_buy: priceBuy,
        price_sell: priceSell,
        stock_qty: stockQty,
        min_stock_level: minStock,
        // null explicite : sans cela, retirer le fournisseur d'un article ne
        // detachait rien, la colonne gardait l'ancienne valeur.
        supplier_id: form.supplier_id,
        unit: form.unit.trim() || 'pce',
        is_formule: form.is_formule,
      };

      let err;
      if (product) {
        ({ error: err } = await supabase.from('products').update(payload).eq('id', product.id));
      } else {
        ({ error: err } = await supabase.from('products').insert({ ...payload, user_id: ownerId }));
      }

      if (err) { setError(err.message); return; }

      // Le produit EST écrit : on ferme d'abord, on journalise ensuite. Le
      // journal est best-effort — son échec (réseau, RLS) ne doit pas laisser
      // la fenêtre ouverte sur un produit pourtant enregistré, ce qui ferait
      // re-cliquer l'utilisateur et recréerait la fiche.
      onSaved();
      onClose();
      void logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: product ? 'product_edit' : 'product_add',
        description: product
          ? `Produit modifié : ${payload.name}`
          : `Nouveau produit : ${payload.name} (${payload.price_sell} F)`,
      }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h2 className="font-bold text-slate-800">
            {product ? 'Modifier le produit' : 'Nouveau produit'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600" aria-label="Fermer">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Formulaire */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Nom */}
          <div className="space-y-1">
            <label htmlFor="pf-nom" className="text-sm font-medium text-slate-700">
              Nom du produit *
            </label>
            <Input
              id="pf-nom"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={`Ex: ${exemples.product}`}
              required
            />
          </div>

          {/* SKU */}
          <div className="space-y-1">
            <label htmlFor="pf-sku" className="text-sm font-medium text-slate-700">
              SKU / Code-barres
            </label>
            <Input
              id="pf-sku"
              value={form.sku}
              onChange={(e) => set('sku', e.target.value)}
              placeholder={`Ex: ${exemples.sku}`}
              className="font-mono"
            />
          </div>

          {/* Catégorie */}
          <div className="space-y-1">
            <label htmlFor="pf-categorie" className="text-sm font-medium text-slate-700">
              Catégorie
              <span className="text-slate-500 font-normal ml-1">(existante ou nouvelle)</span>
            </label>
            <input
              id="pf-categorie"
              list="categories-list"
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder={`Ex: ${exemples.category}`}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <datalist id="categories-list">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set('category', c)}
                    className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                      form.category === c
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'border-slate-200 text-slate-500 hover:border-indigo-400'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Fournisseur */}
          <div className="space-y-1">
            <label htmlFor="pf-fournisseur" className="text-sm font-medium text-slate-700">
              Fournisseur
              <span className="text-slate-500 font-normal ml-1">(facultatif)</span>
            </label>
            <SupplierSelect
              id="pf-fournisseur"
              value={form.supplier_id}
              onChange={(id) => set('supplier_id', id)}
            />
          </div>

          {/* Prix */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="pf-prix-achat" className="text-sm font-medium text-slate-700">
                Prix achat (F)
              </label>
              <Input
                id="pf-prix-achat"
                type="number"
                value={form.price_buy}
                onChange={(e) => set('price_buy', e.target.value)}
                placeholder="0"
                min="0"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="pf-prix-vente" className="text-sm font-medium text-slate-700">
                Prix vente (F) *
              </label>
              <Input
                id="pf-prix-vente"
                type="number"
                value={form.price_sell}
                onChange={(e) => set('price_sell', e.target.value)}
                placeholder="0"
                min="0"
                required
              />
            </div>
          </div>

          {/* Unité — affichage seulement, mais indispensable : sans elle
              l'écran affiche « 1,5 » et le commerçant ne sait pas de quoi. */}
          <div className="space-y-1">
            <label id="unit-label" className="text-sm font-medium text-slate-700">
              Unité de vente
              <span className="text-slate-500 font-normal ml-1">
                (le stock et les quantités s&apos;expriment dans cette unité)
              </span>
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="unit-label">
              {UNITES.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => set('unit', u)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    form.unit === u
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 text-slate-500 hover:border-indigo-400'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>

          {/* Formule : menu composé */}
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.is_formule}
              onChange={(e) => setForm((prev) => ({ ...prev, is_formule: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-700">Formule (menu composé)</span>
              <span className="block text-xs text-slate-500">
                Entrée + plat + dessert + boisson à prix fixe. Les choix se composent dans l&apos;onglet Formules ; le stock part des composants.
              </span>
            </span>
          </label>

          {/* Stock */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="pf-stock" className="text-sm font-medium text-slate-700">
                Stock initial{form.unit !== 'pce' && ` (${form.unit})`}
              </label>
              <Input
                id="pf-stock"
                type="number"
                inputMode="decimal"
                step="any"
                value={form.stock_qty}
                onChange={(e) => set('stock_qty', e.target.value)}
                placeholder="0"
                min="0"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="pf-seuil" className="text-sm font-medium text-slate-700">
                Stock min. alerte
              </label>
              <Input
                id="pf-seuil"
                type="number"
                inputMode="decimal"
                step="any"
                value={form.min_stock_level}
                onChange={(e) => set('min_stock_level', e.target.value)}
                placeholder="5"
                min="0"
              />
            </div>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold gap-2"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Enregistrement...</>
            ) : (
              <><Save className="h-4 w-4" /> {product ? 'Enregistrer' : 'Ajouter le produit'}</>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
