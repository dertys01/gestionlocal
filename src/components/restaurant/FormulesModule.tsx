'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Loader2, Layers, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';
import { logActivity } from '@/lib/utils/activity';

interface Formule {
  id: string;
  name: string;
  price_sell: number;
  category: string | null;
}

interface ChoixLigne {
  id: string;
  product_id: string;
  extra_price: number;
  name: string;
}

interface GroupeLigne {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  choix: ChoixLigne[];
}

interface ProduitLeger {
  id: string;
  name: string;
  is_formule: boolean;
}

/**
 * Onglet Formules : composer un menu (entrée + plat + dessert + boisson).
 *
 * Une formule est un produit marqué `is_formule`. On y définit des GROUPES
 * (« Entrée », « Plat »…) et, dans chaque groupe, les CHOIX proposés au client
 * avec un supplément éventuel. La vente se fait ensuite en Salle (ou en Caisse)
 * par le sélecteur, et le stock part des composants choisis.
 */
export function FormulesModule() {
  const { supabase, canManageProducts, ownerId, actorName, user } = useSupabase();
  const [formules, setFormules] = useState<Formule[]>([]);
  const [produits, setProduits] = useState<ProduitLeger[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [groupes, setGroupes] = useState<GroupeLigne[]>([]);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Nouvelle formule
  const [nom, setNom] = useState('');
  const [prix, setPrix] = useState('');
  // Nouveau groupe
  const [groupeNom, setGroupeNom] = useState('');
  const [groupeMin, setGroupeMin] = useState('1');
  const [groupeMax, setGroupeMax] = useState('1');
  // Nouveau choix
  const [choixProduit, setChoixProduit] = useState('');
  const [choixExtra, setChoixExtra] = useState('0');

  const chargerFormules = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('products')
      .select('id, name, price_sell, category')
      .eq('is_formule', true)
      .eq('is_active', true)
      .order('name');
    if (err) { setError(err.message); return; }
    const list = (data ?? []) as Formule[];
    setFormules(list);
    setSel((prev) => (prev && list.some((f) => f.id === prev) ? prev : (list[0]?.id ?? null)));
  }, [supabase]);

  const chargerProduits = useCallback(async () => {
    const { data } = await supabase
      .from('products')
      .select('id, name, is_formule')
      .eq('is_active', true)
      .order('name');
    // Un composant ne peut pas être une formule : pas de formules imbriquées.
    setProduits(((data ?? []) as ProduitLeger[]).filter((p) => !p.is_formule));
  }, [supabase]);

  useEffect(() => {
    // Le setState est différé d'un tour (setTimeout 0) : le corps d'un effet
    // doit rester synchrone, comme dans RecipesModule.
    const t = setTimeout(async () => {
      setChargement(true);
      await Promise.all([chargerFormules(), chargerProduits()]);
      setChargement(false);
    }, 0);
    return () => clearTimeout(t);
  }, [chargerFormules, chargerProduits]);

  const chargerGroupes = useCallback(async (formuleId: string) => {
    const { data, error: err } = await supabase
      .from('formule_groups')
      .select('id, name, min_select, max_select, sort_order, formule_group_items(id, product_id, extra_price, product:products(name))')
      .eq('formule_id', formuleId)
      .order('sort_order');
    if (err) { setError(err.message); return; }
    const gs: GroupeLigne[] = ((data ?? []) as Array<Record<string, unknown>>).map((g) => ({
      id: g.id as string,
      name: g.name as string,
      min_select: Number(g.min_select ?? 1),
      max_select: Number(g.max_select ?? 1),
      choix: ((g.formule_group_items ?? []) as Array<Record<string, unknown>>)
        .map((it) => ({
          id: it.id as string,
          product_id: it.product_id as string,
          extra_price: Number(it.extra_price ?? 0),
          name: ((it.product ?? {}) as Record<string, unknown>).name as string ?? 'Article',
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    }));
    setGroupes(gs);
  }, [supabase]);

  useEffect(() => {
    const id = sel;
    if (!id) return;
    const t = setTimeout(() => { void chargerGroupes(id); }, 0);
    return () => clearTimeout(t);
  }, [sel, chargerGroupes]);

  const formule = useMemo(() => formules.find((f) => f.id === sel) ?? null, [formules, sel]);

  const creerFormule = async () => {
    if (!nom.trim()) { setError('Donnez un nom à la formule.'); return; }
    const p = lireMontant(prix);
    if (p === null || p <= 0) { setError('Le prix de la formule doit être supérieur à zéro.'); return; }
    setBusy(true);
    setError('');
    const { data, error: err } = await supabase
      .from('products')
      .insert({ user_id: ownerId, name: nom.trim(), price_sell: p, stock_qty: 0, is_formule: true })
      .select('id')
      .single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    setNom(''); setPrix('');
    await chargerFormules();
    if (data?.id) setSel(data.id);
    void logActivity({
      ownerId: ownerId ?? '', actorId: user?.id ?? '', actorEmail: user?.email ?? '', actorName,
      action: 'formule_add', description: `Formule créée : ${nom.trim()} (${formatCFA(p)})`,
    }).catch(() => {});
  };

  const ajouterGroupe = async () => {
    if (!sel || !groupeNom.trim()) return;
    const mn = lireMontant(groupeMin) ?? 1;
    const mx = lireMontant(groupeMax) ?? 1;
    if (mn < 0 || mx < 1 || mn > mx) { setError('Bornes du groupe invalides (min ≤ max, max ≥ 1).'); return; }
    setBusy(true); setError('');
    const { error: err } = await supabase.from('formule_groups').insert({
      owner_id: ownerId,
      formule_id: sel,
      name: groupeNom.trim(),
      min_select: mn,
      max_select: mx,
    });
    setBusy(false);
    if (err) { setError(err.code === '23505' ? `Un groupe « ${groupeNom.trim()} » existe déjà.` : err.message); return; }
    setGroupeNom(''); setGroupeMin('1'); setGroupeMax('1');
    await chargerGroupes(sel);
  };

  const supprimerGroupe = async (id: string) => {
    if (!sel) return;
    setBusy(true); setError('');
    const { error: err } = await supabase.from('formule_groups').delete().eq('id', id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await chargerGroupes(sel);
  };

  const ajouterChoix = async (groupId: string) => {
    if (!choixProduit) { setError('Choisissez un article à proposer.'); return; }
    const extra = lireMontant(choixExtra) ?? 0;
    setBusy(true); setError('');
    const { error: err } = await supabase.from('formule_group_items').insert({
      group_id: groupId,
      product_id: choixProduit,
      extra_price: extra,
    });
    setBusy(false);
    if (err) { setError(err.code === '23505' ? 'Cet article est déjà dans le groupe.' : err.message); return; }
    setChoixProduit(''); setChoixExtra('0');
    if (sel) await chargerGroupes(sel);
  };

  const supprimerChoix = async (id: string) => {
    if (!sel) return;
    setBusy(true); setError('');
    const { error: err } = await supabase.from('formule_group_items').delete().eq('id', id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await chargerGroupes(sel);
  };

  if (chargement) {
    return (
      <p className="text-sm text-slate-500 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Chargement des formules…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Liste des formules + création */}
        <Card>
          <CardContent className="p-4 space-y-3">
            {canManageProducts && (
              <div className="space-y-2 pb-3 border-b border-slate-100">
                <Input
                  value={nom}
                  onChange={(e) => setNom(e.target.value)}
                  placeholder="Nom — ex: Formule maquis"
                  aria-label="Nom de la nouvelle formule"
                />
                <div className="flex gap-2">
                  <Input
                    value={prix}
                    onChange={(e) => setPrix(e.target.value)}
                    placeholder="Prix F"
                    inputMode="decimal"
                    aria-label="Prix de la nouvelle formule"
                    className="w-24"
                  />
                  <Button
                    onClick={() => void creerFormule()}
                    disabled={busy || !nom.trim()}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 gap-1.5"
                  >
                    <Plus className="h-4 w-4" /> Formule
                  </Button>
                </div>
              </div>
            )}

            {formules.length === 0 ? (
              <p className="text-xs text-slate-500">
                Aucune formule. Créez-en une, ou cochez « Formule » sur une fiche produit.
              </p>
            ) : (
              <ul className="space-y-1">
                {formules.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => setSel(f.id)}
                      aria-current={f.id === sel}
                      className={`w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        f.id === sel ? 'bg-indigo-50 text-indigo-700 font-medium' : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <span className="min-w-0 flex items-center gap-2">
                        <Layers className="h-4 w-4 shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </span>
                      <span className="text-xs text-slate-500 shrink-0 flex items-center gap-1">
                        {formatCFA(f.price_sell)}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Composition */}
        <Card>
          <CardContent className="p-4 space-y-4">
            {!formule ? (
              <p className="text-sm text-slate-500">Choisissez une formule à composer.</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold text-slate-800">{formule.name}</h3>
                  <span className="text-sm text-slate-600">{formatCFA(formule.price_sell)}</span>
                </div>

                {canManageProducts && (
                  <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                    <p className="text-xs font-medium text-slate-600">Ajouter un groupe</p>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        value={groupeNom}
                        onChange={(e) => setGroupeNom(e.target.value)}
                        placeholder="Entrée, Plat, Dessert, Boisson…"
                        aria-label="Nom du groupe"
                        className="flex-1 min-w-[160px]"
                      />
                      <Input
                        value={groupeMin}
                        onChange={(e) => setGroupeMin(e.target.value)}
                        inputMode="numeric"
                        aria-label="Minimum à choisir"
                        className="w-20"
                        placeholder="min"
                      />
                      <Input
                        value={groupeMax}
                        onChange={(e) => setGroupeMax(e.target.value)}
                        inputMode="numeric"
                        aria-label="Maximum à choisir"
                        className="w-20"
                        placeholder="max"
                      />
                      <Button
                        onClick={() => void ajouterGroupe()}
                        disabled={busy || !groupeNom.trim()}
                        variant="outline"
                        className="gap-1.5"
                      >
                        <Plus className="h-4 w-4" /> Groupe
                      </Button>
                    </div>
                  </div>
                )}

                {groupes.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Aucun groupe. Ajoutez « Entrée », « Plat », etc., puis les articles de chaque groupe.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {groupes.map((g) => (
                      <div key={g.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-700">
                            {g.name}
                            <span className="text-xs text-slate-500 font-normal ml-2">
                              {g.min_select === g.max_select
                                ? `${g.min_select} au choix`
                                : `${g.min_select} à ${g.max_select}`}
                            </span>
                          </span>
                          {canManageProducts && (
                            <button
                              onClick={() => void supprimerGroupe(g.id)}
                              disabled={busy}
                              aria-label={`Supprimer le groupe ${g.name}`}
                              className="text-slate-400 hover:text-red-500"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>

                        <ul className="flex flex-wrap gap-1.5">
                          {g.choix.map((c) => (
                            <li
                              key={c.id}
                              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600"
                            >
                              {c.name}
                              {c.extra_price !== 0 && (
                                <span className="text-slate-400">
                                  {c.extra_price > 0 ? `+${formatCFA(c.extra_price)}` : `−${formatCFA(Math.abs(c.extra_price))}`}
                                </span>
                              )}
                              {canManageProducts && (
                                <button
                                  onClick={() => void supprimerChoix(c.id)}
                                  disabled={busy}
                                  aria-label={`Retirer ${c.name} de ${g.name}`}
                                  className="text-slate-400 hover:text-red-500"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </li>
                          ))}
                          {g.choix.length === 0 && (
                            <li className="text-xs text-slate-400">Aucun article dans ce groupe.</li>
                          )}
                        </ul>

                        {canManageProducts && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <select
                              value={choixProduit}
                              onChange={(e) => setChoixProduit(e.target.value)}
                              aria-label={`Article à ajouter à ${g.name}`}
                              className="flex-1 min-w-[160px] rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-white"
                            >
                              <option value="">Choisir un article…</option>
                              {produits.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                            <Input
                              value={choixExtra}
                              onChange={(e) => setChoixExtra(e.target.value)}
                              inputMode="decimal"
                              aria-label={`Supplément pour ${g.name}`}
                              className="w-24"
                              placeholder="+0"
                            />
                            <Button
                              onClick={() => void ajouterChoix(g.id)}
                              disabled={busy || !choixProduit}
                              variant="outline"
                              size="sm"
                              className="gap-1.5"
                            >
                              <Plus className="h-4 w-4" /> Article
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
