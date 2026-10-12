'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, PackageX, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { readablePlanError } from '@/lib/utils/planErrors';
import { toCSV, downloadCSV } from '@/lib/utils/export';
import { isFeatureAllowed } from '@/lib/utils/plans';

/** Ligne de product_profitability (vue SQL, cf. migration_profitability.sql). */
interface ProfitRow {
  id: string;
  name: string;
  category: string | null;
  unit_cost: number;
  unit_price: number;
  stock_qty: number;
  units_sold: number;
  revenue: number;
  cost_of_goods: number;
  gross_profit: number;
  margin_pct: number | null;
  /** Prix moyen réellement encaissé (diffère du catalogue si marchandage). */
  avg_sold_price: number | null;
  /** Total concédé sur ce produit, en FCFA. */
  discount_given: number | null;
  /** Unités vendues sous le prix d'achat. */
  units_sold_at_loss: number | null;
}

export function ProfitabilityModule() {
  const { supabase, plan } = useSupabase();
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      // Fonction SECURITY INVOKER : l'isolation multi-tenant est assurée par
      // la RLS de products, pas par un filtre manuel dans la requête. Le plan
      // est vérifié en base : le cadenas du menu ne l'est pas.
      const { data, error: err } = await supabase.rpc('get_product_profitability');

      if (err) throw new Error(readablePlanError(err.message));
      const list = (data as ProfitRow[]) ?? [];
      setRows([...list].sort((a, b) => Number(b.gross_profit) - Number(a.gross_profit)));
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Totaux calculés sur les lignes réellement chargées.
  const revenue = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const cogs = rows.reduce((s, r) => s + Number(r.cost_of_goods ?? 0), 0);
  const profit = revenue - cogs;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  const neverSold = rows.filter((r) => Number(r.units_sold) === 0 && Number(r.stock_qty) > 0);
  // Capital immobilisé en rayon sur les produits jamais vendus.
  const tiedUpCapital = neverSold.reduce(
    (s, r) => s + Number(r.unit_cost) * Number(r.stock_qty), 0
  );
  //dont le coût d'achat n'a jamais été renseigné : la marge affichée serait fausse.
  const missingCost = rows.filter((r) => Number(r.unit_cost) === 0 && Number(r.revenue) > 0);

  if (error) {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
        <p className="font-medium">Module de rentabilité indisponible</p>
        <p className="text-xs mt-1">{error}</p>
        <p className="text-xs mt-2">
          La fonction <code>get_product_profitability()</code> n&apos;existe pas encore. Appliquez{' '}
          <code>supabase/migration_profitability.sql</code> dans l&apos;éditeur SQL.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Combien vous gagnez <strong>réellement</strong> sur ce que vous vendez
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

      {/* Synthèse */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <TrendingUp className="h-3.5 w-3.5" /> Chiffre d&apos;affaires
            </div>
            <div className="text-lg font-bold text-slate-800">{formatCFA(revenue)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <TrendingDown className="h-3.5 w-3.5" /> Coût des marchandises
            </div>
            <div className="text-lg font-bold text-slate-800">{formatCFA(cogs)}</div>
          </CardContent>
        </Card>
        {/* Les classes doivent apparaître en toutes lettres : Tailwind scanne
            les sources et ne génère jamais `border-${...}-200`. Interpolées,
            les deux variantes n'étaient tout simplement pas compilées — la
            carte perdait sa bordure et son fond. */}
        <Card className={profit >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}>
          <CardContent className="p-4">
            <div className={`flex items-center gap-2 text-xs mb-1 ${profit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
              <TrendingUp className="h-3.5 w-3.5" /> Marge brute
            </div>
            <div className={`text-lg font-bold ${profit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {formatCFA(profit)}
            </div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-slate-500 text-xs mb-1">Taux de marge</div>
            <div className={`text-lg font-bold ${marginPct >= 20 ? 'text-emerald-700' : 'text-amber-700'}`}>
              {marginPct.toFixed(1)} %
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {marginPct >= 20 ? 'correct' : 'faible pour ce type de commerce'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Avertissements */}
      {missingCost.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            {missingCost.length} produit{missingCost.length > 1 ? 's' : ''} sans prix d&apos;achat
          </div>
          <p className="text-xs mt-1">
            Leur marge est comptée comme 100 % : {missingCost.map((r) => r.name).join(', ')}.{' '}
            Renseignez le prix d&apos;achat pour une marge fiable.
          </p>
        </div>
      )}

      {neverSold.length > 0 && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
          <div className="flex items-center gap-2 font-medium text-slate-700">
            <PackageX className="h-4 w-4" />
            {neverSold.length} produit{neverSold.length > 1 ? 's' : ''} jamais vendu{neverSold.length > 1 ? 's' : ''}
          </div>
          <p className="text-xs mt-1">
            Immobilisés en rayon : {tiedUpCapital > 0
              ? formatCFA(tiedUpCapital)
              : 'montant inconnu (prix d’achat non renseigné)'}
            {neverSold.length <= 8 ? `: ${neverSold.map((r) => r.name).join(', ')}` : ''}
          </p>
        </div>
      )}

      {/* Détail par produit */}
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-700">Détail par produit</h3>
            {isFeatureAllowed(plan, 'exportCsv') && rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = toCSV(
                    rows.map((r) => ({
                      produit: r.name,
                      categorie: r.category ?? '',
                      'prix achat': r.unit_cost,
                      'prix vente catalogue': r.unit_price,
                      // Prix moyen réellement encaissé : la différence avec le
                      // catalogue est ce que la vente au rabais a coûté.
                      'prix moyen encaisse': r.avg_sold_price ?? '',
                      'remise accordee': r.discount_given ?? 0,
                      'unites vendues': r.units_sold,
                      'unites vendues a perte': r.units_sold_at_loss ?? 0,
                      'CA': r.revenue,
                      'cout marchandises': r.cost_of_goods,
                      'marge brute': r.gross_profit,
                      'taux marge %': r.margin_pct ?? '',
                      stock: r.stock_qty,
                    })),
                    [
                      { key: 'produit', label: 'Produit' },
                      { key: 'categorie', label: 'Catégorie' },
                      { key: 'prix achat', label: 'Prix achat (F)' },
                      { key: 'prix vente catalogue', label: 'Prix vente catalogue (F)' },
                      { key: 'prix moyen encaisse', label: 'Prix moyen encaissé (F)' },
                      { key: 'remise accordee', label: 'Remise accordée (F)' },
                      { key: 'unites vendues', label: 'Unités vendues' },
                      { key: 'unites vendues a perte', label: 'Unités vendues à perte' },
                      { key: 'CA', label: 'CA (F)' },
                      { key: 'cout marchandises', label: 'Coût marchandises (F)' },
                      { key: 'marge brute', label: 'Marge brute (F)' },
                      { key: 'taux marge %', label: 'Taux marge (%)' },
                      { key: 'stock', label: 'Stock' },
                    ]
                  );
                  downloadCSV(csv, `rentabilite-${new Date().toISOString().slice(0, 10)}.csv`);
                }}
                className="gap-2 border-slate-200"
              >
                CSV
              </Button>
            )}
          </div>

          {loading ? (
            <div className="text-center text-slate-500 py-8 text-sm">Chargement...</div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={PackageX}
              title="Aucun produit à analyser"
              hint="Ajoutez vos coûts d’achat et enregistrez des ventes : la marge par produit s’affichera ici."
              className="py-6"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="pb-2 font-medium">Produit</th>
                    <th className="pb-2 font-medium text-right">Achat</th>
                    <th className="pb-2 font-medium text-right">Vente</th>
                    <th className="pb-2 font-medium text-right">Vendus</th>
                    <th className="pb-2 font-medium text-right">CA</th>
                    <th className="pb-2 font-medium text-right">Marge</th>
                    <th className="pb-2 font-medium text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pct = r.margin_pct == null ? null : Number(r.margin_pct);
                    const isLoss = pct !== null && pct < 10;
                    const isNoCost = Number(r.unit_cost) === 0 && Number(r.revenue) > 0;
                    // Prix moyen réellement encaissé vs prix catalogue. Écart non
                    // nul = marchandage sur ce produit.
                    const avg = r.avg_sold_price == null ? null : Number(r.avg_sold_price);
                    const remise = Number(r.discount_given ?? 0);
                    const aPerte = Number(r.units_sold_at_loss ?? 0);
                    return (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-slate-700 truncate max-w-[10rem]">{r.name}</div>
                          {r.category && (
                            <div className="text-xs text-slate-500">{r.category}</div>
                          )}
                          {aPerte > 0 && (
                            <div className="text-[11px] text-red-600 mt-0.5">
                              {aPerte} vendu(s) à perte
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right text-slate-500 tabular-nums">
                          {Number(r.unit_cost) > 0 ? formatCFA(r.unit_cost) : '-'}
                        </td>
                        <td className="py-2 text-right text-slate-500 tabular-nums">
                          {formatCFA(r.unit_price)}
                          {avg !== null && Math.abs(avg - Number(r.unit_price)) >= 1 && (
                            <div className="text-[11px] text-amber-700">
                              moyen {formatCFA(avg)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right text-slate-500 tabular-nums">
                          {r.units_sold}
                          {remise > 0 && (
                            <div className="text-[11px] text-amber-700">
                              −{formatCFA(remise)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right text-slate-700 tabular-nums font-medium">
                          {formatCFA(r.revenue)}
                        </td>
                        <td className={`py-2 text-right tabular-nums font-medium ${
                          isLoss ? 'text-red-600' : 'text-emerald-700'
                        }`}>
                          {isNoCost ? '-' : formatCFA(r.gross_profit)}
                        </td>
                        <td className={`py-2 text-right tabular-nums ${
                          isNoCost ? 'text-slate-500' : isLoss ? 'text-red-600' : 'text-emerald-700'
                        }`}>
                          {pct === null ? '-' : `${pct.toFixed(0)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500 mt-3">
            La marge est calculée avec le prix d&apos;achat enregistré au moment de chaque vente. Un
            produit vendu à perte (marge &lt; 10 %) apparaît en rouge.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
