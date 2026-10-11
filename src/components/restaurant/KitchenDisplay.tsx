'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChefHat, Loader2, RefreshCw, Clock, Check, Flame } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';
import { formatQty } from '@/lib/utils/currency';
import type { Product } from '@/types';

interface LigneCuisine {
  id: string;
  order_id: string;
  product_name: string;
  quantity: number;
  note: string | null;
  modifier: string | null;
  sent_at: string | null;
  table_name: string | null;
  customer_name: string | null;
}

/** Une fiche = une commande (une table, ou un à-emporter). */
interface Fiche {
  orderId: string;
  titre: string;
  envoyeA: string | null;
  lignes: LigneCuisine[];
}

const minutesDepuis = (iso: string | null) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)) : null;

/**
 * Écran cuisine (KDS).
 *
 * Le papier du ticket cuisine ne sert qu'une fois : si le cuisinier le perd ou
 * si la commande change, il n'a plus rien. Cet écran montre ce qui est EN
 * CUISINE (lignes « envoyées »), la plus ancienne en tête, avec son temps
 * d'attente — c'est ce qui dit au cuisinier quoi faire d'abord. Un tap sur
 * « Prêt » sort la ligne de l'écran ; la salle voit alors « servi ».
 *
 * La RLS fait l'isolation : chaque boutique ne voit que ses lignes.
 */
export function KitchenDisplay({ products }: { products: Product[] }) {
  const { supabase } = useSupabase();
  const [lignes, setLignes] = useState<LigneCuisine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Tic d'horloge : les minutes d'attente avancent toutes seules.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: items, error: e1 } = await supabase
        .from('restaurant_order_items')
        .select('id, order_id, quantity, note, modifier, sent_at, product_id')
        .eq('status', 'sent')
        .order('sent_at', { ascending: true });
      if (e1) throw new Error(e1.message);

      const list = (items ?? []) as Array<{
        id: string; order_id: string; quantity: number; note: string | null;
        modifier: string | null; sent_at: string | null; product_id: string;
      }>;
      const orderIds = [...new Set(list.map((l) => l.order_id))];

      let ords: Array<{ id: string; table_id: string | null; customer_name: string | null }> = [];
      let tbls: Array<{ id: string; name: string }> = [];
      if (orderIds.length > 0) {
        const { data: o } = await supabase
          .from('restaurant_orders').select('id, table_id, customer_name').in('id', orderIds);
        ords = (o ?? []) as typeof ords;
        const tableIds = [...new Set(ords.map((x) => x.table_id).filter((x): x is string => !!x))];
        if (tableIds.length > 0) {
          const { data: t } = await supabase.from('restaurant_tables').select('id, name').in('id', tableIds);
          tbls = (t ?? []) as typeof tbls;
        }
      }

      const nomProduit = new Map(products.map((p) => [p.id, p.name]));
      const parOrdre = new Map(ords.map((o) => [o.id, o]));
      const parTable = new Map(tbls.map((t) => [t.id, t.name]));

      setLignes(list.map((l) => {
        const o = parOrdre.get(l.order_id);
        return {
          id: l.id,
          order_id: l.order_id,
          product_name: nomProduit.get(l.product_id) ?? 'Produit',
          quantity: Number(l.quantity),
          note: l.note,
          modifier: l.modifier,
          sent_at: l.sent_at,
          table_name: o?.table_id ? (parTable.get(o.table_id) ?? null) : null,
          customer_name: o?.customer_name ?? null,
        };
      }));
    } catch (e) {
      setError((e as Error).message);
      setLignes([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, products]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh(['restaurant_order_items'], load);

  const marquerPret = async (ligneId: string) => {
    setBusyId(ligneId);
    setError('');
    const { error: err } = await supabase
      .from('restaurant_order_items')
      .update({ status: 'served' })
      .eq('id', ligneId);
    setBusyId(null);
    if (err) { setError(err.message); return; }
    await load();
  };

  const toutPret = async (fiche: Fiche) => {
    setBusyId(fiche.orderId);
    setError('');
    const ids = fiche.lignes.map((l) => l.id);
    const { error: err } = await supabase
      .from('restaurant_order_items')
      .update({ status: 'served' })
      .in('id', ids);
    setBusyId(null);
    if (err) { setError(err.message); return; }
    await load();
  };

  const fiches = useMemo<Fiche[]>(() => {
    const parOrdre = new Map<string, Fiche>();
    for (const l of lignes) {
      let f = parOrdre.get(l.order_id);
      if (!f) {
        f = {
          orderId: l.order_id,
          titre: l.table_name ?? `À emporter${l.customer_name ? ` · ${l.customer_name}` : ''}`,
          envoyeA: l.sent_at,
          lignes: [],
        };
        parOrdre.set(l.order_id, f);
      }
      f.lignes.push(l);
      // Le plus ancien envoyé donne l'attente de la fiche.
      if (l.sent_at && (!f.envoyeA || l.sent_at < f.envoyeA)) f.envoyeA = l.sent_at;
    }
    return [...parOrdre.values()];
  }, [lignes]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <ChefHat className="h-4 w-4 text-indigo-600" />
          Ce qui est en cuisine — la plus ancienne commande en tête.
        </p>
        <button
          aria-label="Actualiser"
          onClick={load}
          disabled={loading}
          className="p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {loading && lignes.length === 0 ? (
        <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p>
      ) : fiches.length === 0 ? (
        <EmptyState
          icon={Flame}
          title="Rien en cuisine"
          hint="Les plats envoyés depuis la Salle apparaîtront ici, du plus ancien au plus récent."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fiches.map((f) => {
            const min = minutesDepuis(f.envoyeA);
            const enRetard = min !== null && min >= 20;
            return (
              <Card key={f.orderId} className={`border-2 ${enRetard ? 'border-red-300' : 'border-slate-200'}`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-slate-800 text-sm truncate">{f.titre}</h3>
                    {min !== null && (
                      <span className={`shrink-0 inline-flex items-center gap-1 text-xs tabular-nums ${enRetard ? 'text-red-600 font-bold' : 'text-slate-500'}`}>
                        <Clock className="h-3.5 w-3.5" /> {min} min
                      </span>
                    )}
                  </div>

                  <ul className="space-y-1.5">
                    {f.lignes.map((l) => (
                      <li key={l.id} className="flex items-start gap-2">
                        <span className="shrink-0 font-bold text-slate-800 tabular-nums">{formatQty(l.quantity)}×</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-slate-700 truncate">{l.product_name}</span>
                          {l.modifier && <span className="block text-[11px] text-indigo-700">{l.modifier}</span>}
                          {l.note && <span className="block text-[11px] text-amber-700">{l.note}</span>}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => marquerPret(l.id)}
                          disabled={busyId === l.id || busyId === f.orderId}
                          className="shrink-0 gap-1 h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          aria-label={`Marquer prêt : ${l.product_name}`}
                        >
                          {busyId === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Prêt
                        </Button>
                      </li>
                    ))}
                  </ul>

                  {f.lignes.length > 1 && (
                    <Button
                      size="sm"
                      onClick={() => toutPret(f)}
                      disabled={busyId === f.orderId}
                      className="w-full gap-1.5 bg-emerald-700 hover:bg-emerald-800"
                    >
                      {busyId === f.orderId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Tout est prêt
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
