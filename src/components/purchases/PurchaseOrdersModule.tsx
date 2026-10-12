'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Trash2, Loader2, Check, X, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';
import type { Product } from '@/types';

interface Commande {
  id: string;
  supplier_name: string | null;
  status: 'ordered' | 'received' | 'cancelled';
  note: string | null;
  created_at: string;
  received_at: string | null;
}
interface Ligne { product_id: string; product_name: string; quantity: number; unit_cost: number }
interface Fournisseur { id: string; name: string }

const STATUT: Record<Commande['status'], { label: string; classe: string }> = {
  ordered:   { label: 'En attente', classe: 'bg-amber-100 text-amber-700' },
  received:  { label: 'Reçue',      classe: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Annulée',    classe: 'bg-slate-100 text-slate-500' },
};

/**
 * Bons de commande fournisseur.
 *
 * Créer une commande ne touche PAS au stock : c'est la RÉCEPTION qui fait
 * entrer les articles (receive_purchase_order). Voir
 * supabase/migration_purchase_orders.sql.
 */
export function PurchaseOrdersModule({ products }: { products: Product[] }) {
  const { supabase, canManageProducts } = useSupabase();
  const [commandes, setCommandes] = useState<Commande[]>([]);
  const [lignesParCommande, setLignesParCommande] = useState<Record<string, Ligne[]>>({});
  const [fournisseurs, setFournisseurs] = useState<Fournisseur[]>([]);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [formOuvert, setFormOuvert] = useState(false);

  // Formulaire de création
  const [fournisseur, setFournisseur] = useState('');
  const [note, setNote] = useState('');
  const [lignes, setLignes] = useState<{ product_id: string; qty: string; cost: string }[]>([
    { product_id: '', qty: '', cost: '' },
  ]);

  const produitsActifs = useMemo(() => products.filter((p) => p.is_active !== false), [products]);

  const load = useCallback(async () => {
    setLoading(true);
    const [ord, sup] = await Promise.all([
      supabase.from('purchase_orders').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('suppliers').select('id, name').order('name'),
    ]);
    if (ord.error) setErreur(ord.error.message);
    const liste = (ord.data as Commande[]) ?? [];
    setCommandes(liste);
    setFournisseurs((sup.data as Fournisseur[]) ?? []);

    if (liste.length > 0) {
      const { data: items } = await supabase
        .from('purchase_order_items')
        .select('order_id, product_id, product_name, quantity, unit_cost')
        .in('order_id', liste.map((o) => o.id));
      const par: Record<string, Ligne[]> = {};
      for (const it of (items as (Ligne & { order_id: string })[]) ?? []) {
        (par[it.order_id] ??= []).push(it);
      }
      setLignesParCommande(par);
    } else {
      setLignesParCommande({});
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const ajouterLigne = () => setLignes((l) => [...l, { product_id: '', qty: '', cost: '' }]);
  const majLigne = (i: number, champ: 'product_id' | 'qty' | 'cost', valeur: string) =>
    setLignes((l) => l.map((x, j) => (j === i ? { ...x, [champ]: valeur } : x)));
  const retirerLigne = (i: number) => setLignes((l) => l.filter((_, j) => j !== i));

  const creer = async () => {
    setErreur('');
    const items = lignes
      .filter((l) => l.product_id && (lireMontant(l.qty) ?? 0) > 0)
      .map((l) => ({
        product_id: l.product_id,
        quantity: lireMontant(l.qty) ?? 0,
        unit_cost: lireMontant(l.cost) ?? 0,
      }));
    if (items.length === 0) { setErreur('Ajoutez au moins une ligne avec un produit et une quantité.'); return; }

    setEnCours('creation');
    try {
      const { error } = await supabase.rpc('create_purchase_order', {
        p_supplier_id: fournisseur || null,
        p_items: items,
        p_note: note.trim() || null,
      });
      if (error) throw new Error(error.message);
      setFournisseur(''); setNote(''); setLignes([{ product_id: '', qty: '', cost: '' }]);
      setFormOuvert(false);
      await load();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Création impossible.');
    } finally {
      setEnCours(null);
    }
  };

  const agir = async (id: string, fn: 'receive_purchase_order' | 'cancel_purchase_order') => {
    setEnCours(id);
    setErreur('');
    try {
      const { error } = await supabase.rpc(fn, { p_order_id: id });
      if (error) throw new Error(error.message);
      await load();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Action impossible.');
    } finally {
      setEnCours(null);
    }
  };

  const total = (l: Ligne[]) => l.reduce((s, x) => s + Number(x.quantity) * Number(x.unit_cost), 0);

  return (
    <Card className="border-slate-200">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-indigo-600 shrink-0" />
          <h3 className="font-semibold text-slate-800 text-sm">Commandes fournisseur</h3>
          {canManageProducts && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto gap-1.5"
              onClick={() => setFormOuvert((v) => !v)}
            >
              <Plus className="h-3.5 w-3.5" /> Nouvelle commande
            </Button>
          )}
        </div>

        {erreur && <p className="text-xs text-red-600">{erreur}</p>}

        {/* Formulaire */}
        {formOuvert && canManageProducts && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={fournisseur}
                onChange={(e) => setFournisseur(e.target.value)}
                aria-label="Fournisseur"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <option value="">Fournisseur (facultatif)</option>
                {fournisseurs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (facultatif)"
                aria-label="Note de commande"
                className="flex-1 bg-white"
              />
            </div>

            {lignes.map((l, i) => (
              <div key={i} className="flex flex-col sm:flex-row gap-2 items-stretch">
                <select
                  value={l.product_id}
                  onChange={(e) => majLigne(i, 'product_id', e.target.value)}
                  aria-label={`Produit ligne ${i + 1}`}
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Produit</option>
                  {produitsActifs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <Input value={l.qty} onChange={(e) => majLigne(i, 'qty', e.target.value)}
                  inputMode="decimal" placeholder="Qté" aria-label={`Quantité ligne ${i + 1}`} className="sm:w-20 bg-white" />
                <Input value={l.cost} onChange={(e) => majLigne(i, 'cost', e.target.value)}
                  inputMode="decimal" placeholder="Coût U." aria-label={`Coût unitaire ligne ${i + 1}`} className="sm:w-24 bg-white" />
                {lignes.length > 1 && (
                  <button type="button" onClick={() => retirerLigne(i)} aria-label={`Retirer la ligne ${i + 1}`}
                    className="p-2 text-slate-400 hover:text-red-600 self-center">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={ajouterLigne} className="gap-1.5 text-slate-600">
                <Plus className="h-3.5 w-3.5" /> Ajouter une ligne
              </Button>
              <Button size="sm" onClick={creer} disabled={enCours === 'creation'} className="ml-auto gap-1.5 bg-indigo-600 hover:bg-indigo-700">
                {enCours === 'creation' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Créer la commande
              </Button>
            </div>
          </div>
        )}

        {/* Liste */}
        {loading ? (
          <p className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…</p>
        ) : commandes.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="Aucune commande"
            hint="Préparez une commande fournisseur : les articles entreront en stock à la réception."
            className="py-4"
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {commandes.map((c) => {
              const l = lignesParCommande[c.id] ?? [];
              const st = STATUT[c.status];
              return (
                <li key={c.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">
                      {c.supplier_name ?? 'Sans fournisseur'}
                    </span>
                    <Badge className={`${st.classe} border-0 text-[11px]`}>{st.label}</Badge>
                    <span className="ml-auto text-sm font-semibold text-slate-700 tabular-nums">
                      {formatCFA(total(l))}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {new Date(c.created_at).toLocaleDateString('fr-FR')} · {l.length} ligne{l.length > 1 ? 's' : ''}
                    {c.note ? ` · ${c.note}` : ''}
                  </div>
                  {c.status === 'ordered' && canManageProducts && (
                    <div className="flex gap-2 mt-1.5">
                      <Button size="sm" variant="outline" className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                        onClick={() => agir(c.id, 'receive_purchase_order')} disabled={enCours === c.id}>
                        {enCours === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Réceptionner
                      </Button>
                      <Button size="sm" variant="ghost" className="gap-1.5 text-slate-500"
                        onClick={() => agir(c.id, 'cancel_purchase_order')} disabled={enCours === c.id}>
                        <X className="h-3.5 w-3.5" /> Annuler
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
