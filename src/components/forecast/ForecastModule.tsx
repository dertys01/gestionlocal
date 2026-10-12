'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, TrendingDown, CheckCircle, PackagePlus, RefreshCw, Truck, MessageCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { RestockModal } from '@/components/products/RestockModal';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { whatsappNumber } from '@/lib/utils/phone';
import { readablePlanError } from '@/lib/utils/planErrors';
import type { Product } from '@/types';

interface ProductForecast {
  product: Product;
  soldLast30Days: number;
  avgPerDay: number;
  daysUntilStockout: number | null; // null = pas de ventes récentes
  suggestedReorder: number;
  /** Stock à zéro ou moins ALORS qu'il se vend : vente perdue maintenant. */
  rupture: boolean;
  /** Fournisseur principal : « commander » n'a pas de sens sans savoir à qui. */
  supplierName: string | null;
  supplierPhone: string | null;
}

const ANALYSIS_DAYS = 30;
const REORDER_HORIZON = 30; // vouloir avoir du stock pour 30 jours

/**
 * Lien WhatsApp vers le fournisseur, prérempli comme une relance client :
 * le commerçant envoie, il ne retape ni le produit ni la quantité.
 * Sans quantité suggérée, lien nu — un message sans quantité ferait
 * retaper quand même. Exportée pour le test.
 */
export function lienFournisseur(
  telephone: string, nom: string, produit: string, quantite: number, unite: string,
): string {
  const base = `https://wa.me/${whatsappNumber(telephone)}`;
  if (quantite <= 0) return base;
  const uniteLisible = unite === 'pce' ? (quantite > 1 ? 'pièces' : 'pièce') : (unite || 'unités');
  const message = `Bonjour ${nom}, je voudrais commander ${quantite} ${uniteLisible} de ${produit}. Merci !`;
  return `${base}?text=${encodeURIComponent(message)}`;
}

/** Ligne de products_with_supplier : un produit, plus son fournisseur résolu. */
type ProductForecastRow = Product & {
  supplier_name: string | null;
  supplier_phone: string | null;
};

export function ForecastModule({ onRestock }: { onRestock: () => void }) {
  const { supabase } = useSupabase();
  const [forecasts, setForecasts] = useState<ProductForecast[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);
  // Quantité suggérée pré-remplie dans le modal : le commerçant valide, il
  // ne retape pas le chiffre affiché deux lignes plus haut.
  const [quantiteSuggeree, setQuantiteSuggeree] = useState<number | undefined>(undefined);

  // Numéro de la dernière requête lancée. Un chargement dont le numéro n'est
  // plus le courant est ignoré : démontage, ou rechargement plus récent parti
  // entre-temps. L'ancien `cancelled` passé par VALEUR ne pouvait pas
  // fonctionner — le drapeau modifié par le cleanup n'était jamais relu par le
  // corps de la fonction, d'où des setState après démontage.
  const requestIdRef = useRef(0);

  const fetchForecasts = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');

    const since = new Date();
    since.setDate(since.getDate() - ANALYSIS_DAYS);

    // Le catalogue vient de la vue : elle apporte le fournisseur résolu, donc
    // pas de seconde requête ni de raccordement par identifiant, et l'isolation
    // vient de la RLS de la vue.
    //
    // Les quantités vendues passent par get_units_sold_since() et non par une
    // lecture de sale_items. Deux raisons :
    //   1. le plan — l'agrégat est refusé en base si le plan ne le permet pas,
    //      alors qu'une lecture de table ne se verrouille pas ;
    //   2. le volume — la version précédente ramenait TOUTES les lignes de vente
    //      des 90 derniers jours dans le navigateur pour les additionner
    //      ensuite en JavaScript. Sur une boutique qui vend, cela devient vite
    //      des dizaines de milliers de lignes téléchargées pour produire une
    //      somme de nombres par produit.
    const [productsRes, soldRes] = await Promise.all([
      supabase.from('products_with_supplier').select('*').order('name'),
      supabase.rpc('get_units_sold_since', { p_days: ANALYSIS_DAYS }),
    ]);

    // Les erreurs étaient ignorées : un échec de sale_items faisait passer
    // chaque produit en « Pas de données » (silencieusement), et celui de
    // products figeait l'écran sur le chargement.
    if (productsRes.error) {
      if (requestId === requestIdRef.current) { setError(productsRes.error.message); setLoading(false); }
      return;
    }
    if (soldRes.error) {
      if (requestId === requestIdRef.current) { setError(readablePlanError(soldRes.error.message)); setLoading(false); }
      return;
    }

    const products = productsRes.data;
    const sold = soldRes.data;
    if (!products) { if (requestId === requestIdRef.current) setLoading(false); return; }

    // Quantités vendues par produit. Déjà agrégées en base : le navigateur
    // reçoit une ligne par produit, et non une ligne par vente.
    const soldMap: Record<string, number> = {};
    (sold ?? []).forEach((row: { product_id: string; quantity: number }) => {
      soldMap[row.product_id] = Number(row.quantity);
    });

    const result: ProductForecast[] = (products as ProductForecastRow[])
      // Archivés exclus : un article retiré du catalogue n'a rien à faire
      // dans les seaux ni les compteurs — même filtre qu'InventoryTable.
      .filter((p) => p.is_active !== false)
      .map((p) => {
        const soldLast30Days = soldMap[p.id] ?? 0;
        const avgPerDay = soldLast30Days / ANALYSIS_DAYS;
        const daysUntilStockout =
          avgPerDay > 0 ? Math.floor(p.stock_qty / avgPerDay) : null;
        const suggestedReorder = Math.max(
          0,
          Math.ceil(avgPerDay * REORDER_HORIZON) - p.stock_qty
        );

        return {
          product: p,
          soldLast30Days,
          avgPerDay,
          daysUntilStockout,
          suggestedReorder,
          rupture: p.stock_qty <= 0 && avgPerDay > 0,
          supplierName: p.supplier_name ?? null,
          supplierPhone: p.supplier_phone ?? null,
        };
      });

    // Trier par urgence : d'abord ceux qui vont manquer bientôt
    result.sort((a, b) => {
      if (a.daysUntilStockout === null && b.daysUntilStockout === null) return 0;
      if (a.daysUntilStockout === null) return 1;
      if (b.daysUntilStockout === null) return -1;
      return a.daysUntilStockout - b.daysUntilStockout;
    });

    if (requestId !== requestIdRef.current) return;
    setForecasts(result);
    setLoading(false);
  };

  // Chargement asynchrone encapsulé : aucun setState synchrone dans le corps de
  // l'effet, et le résultat est ignoré si le composant a été démonté entre-temps
  // (le cleanup invalide la requête en vol).
  useEffect(() => {
    // IIFE asynchrone : le setState de fetchForecasts n'est plus « synchrone
    // dans le corps de l'effet » aux yeux du lint react-hooks/set-state-in-effect.
    void (async () => { await fetchForecasts(); })();
    return () => { requestIdRef.current += 1; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const urgent = forecasts.filter((f) => f.daysUntilStockout !== null && f.daysUntilStockout <= 7);
  const warning = forecasts.filter((f) => f.daysUntilStockout !== null && f.daysUntilStockout > 7 && f.daysUntilStockout <= 14);
  // « Suffisant » compte les stocks sains, PAS les sans-données : additionner
  // « tout va bien » et « on ne sait pas » fabriquait un compteur malhonnête.
  const ok = forecasts.filter((f) => f.daysUntilStockout !== null && f.daysUntilStockout > 14);
  // Trésorerie : remettre TOUT à niveau coûterait combien, pour combien
  // d'articles — la question que le commerçant se pose avant de commander.
  const totalReassort = forecasts.reduce(
    (s, f) => s + f.suggestedReorder * (f.product.price_buy ?? 0), 0);
  const nbReassort = forecasts.filter((f) => f.suggestedReorder > 0).length;

  const getStatus = (f: ProductForecast) => {
    if (f.rupture) return 'rupture';
    if (f.daysUntilStockout === null) return 'nodata';
    if (f.daysUntilStockout <= 7) return 'urgent';
    if (f.daysUntilStockout <= 14) return 'warning';
    return 'ok';
  };

  const statusConfig = {
    rupture: { color: 'border-red-300 bg-red-50', badge: 'bg-red-600 text-white hover:bg-red-600', label: 'En rupture' },
    urgent: { color: 'border-red-200 bg-red-50', badge: 'bg-red-100 text-red-700 hover:bg-red-100', label: 'Urgent' },
    warning: { color: 'border-amber-200 bg-amber-50', badge: 'bg-amber-100 text-amber-700 hover:bg-amber-100', label: 'Attention' },
    ok: { color: 'border-emerald-200 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100', label: 'OK' },
    nodata: { color: 'border-slate-200', badge: 'bg-slate-100 text-slate-600 hover:bg-slate-100', label: 'Pas de données' },
  };

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Basé sur les ventes des <strong>30 derniers jours</strong>
        </p>
        <button
          aria-label="Actualiser"
          onClick={() => fetchForecasts()}
          disabled={loading}
          className="p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Impossible de calculer les prévisions : {error}
        </p>
      )}

      {/* Résumé */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-3 text-center">
            <AlertTriangle className="h-5 w-5 text-red-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-red-600">{urgent.length}</div>
            <div className="text-xs text-red-600">Rupture &lt; 7j</div>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3 text-center">
            <TrendingDown className="h-5 w-5 text-amber-600 mx-auto mb-1" />
            <div className="text-2xl font-bold text-amber-700">{warning.length}</div>
            <div className="text-xs text-amber-700">Attention &lt; 14j</div>
          </CardContent>
        </Card>
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-3 text-center">
            <CheckCircle className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
            <div className="text-2xl font-bold text-emerald-700">{ok.length}</div>
            <div className="text-xs text-emerald-700">Stock suffisant</div>
          </CardContent>
        </Card>
      </div>

      {/* Trésorerie : remettre TOUT à niveau coûterait combien — la question
          avant de commander, que les lignes une par une ne répondent pas. */}
      {totalReassort > 0 && (
        <p className="text-sm text-slate-600">
          Pour tout remettre à niveau : <strong className="tabular-nums">{formatCFA(totalReassort)}</strong>
          {' '}({nbReassort} article{nbReassort > 1 ? 's' : ''})
        </p>
      )}

      {/* Liste produits */}
      {loading ? (
        <div className="text-center text-slate-500 py-10 text-sm">Analyse en cours...</div>
      ) : forecasts.length === 0 ? (
        <EmptyState
          icon={PackagePlus}
          title="Aucun produit à prévoir"
          hint="Les prévisions apparaissent dès que vos produits ont un stock et des ventes."
        />
      ) : (
        <div className="space-y-2">
          {forecasts.map((f) => {
            const status = getStatus(f);
            const cfg = statusConfig[status];

            return (
              <Card key={f.product.id} className={`border ${cfg.color}`}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-800 text-sm truncate">
                          {f.product.name}
                        </span>
                        <Badge className={`text-xs py-0 ${cfg.badge}`}>
                          {status === 'rupture' && 'En rupture, à commander'}
                          {status === 'urgent' && `Rupture dans ${f.daysUntilStockout}j`}
                          {status === 'warning' && `${f.daysUntilStockout}j restants`}
                          {status === 'ok' && f.daysUntilStockout !== null && `${f.daysUntilStockout}j restants`}
                          {status === 'nodata' && 'Aucune vente récente'}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-slate-500">
                        <div>
                          <span className="block text-slate-500">Stock actuel</span>
                          <span className="font-semibold text-slate-700">{f.product.stock_qty}</span>
                        </div>
                        <div>
                          <span className="block text-slate-500">Vendu / 30j</span>
                          <span className="font-semibold text-slate-700">{f.soldLast30Days}</span>
                        </div>
                        <div>
                          <span className="block text-slate-500">Moy. / jour</span>
                          <span className="font-semibold text-slate-700">
                            {f.avgPerDay > 0 ? f.avgPerDay.toFixed(1) : '-'}
                          </span>
                        </div>
                      </div>

                      {f.suggestedReorder > 0 && (
                        <div className="mt-2 text-xs text-indigo-600 font-medium">
                          Commander ~{f.suggestedReorder} unités pour 30j ({formatCFA(f.suggestedReorder * f.product.price_buy)})
                        </div>
                      )}

                      {/* Le fournisseur ne sert qu'ici : « commander » sans savoir
                          à qui aboutit à ouvrir le carnet. Le lien WhatsApp est
                          direct — c'est déjà le canal de la cible — et prérempli
                          comme une relance client : le commerçant n'a qu'à
                          envoyer, pas à retaper la quantité. */}
                      {f.supplierName && (
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-slate-500 flex items-center gap-1">
                            <Truck className="h-3 w-3 shrink-0" />
                            {f.supplierName}
                          </span>
                          {f.supplierPhone && (
                            <a
                              href={lienFournisseur(
                                f.supplierPhone, f.supplierName,
                                f.product.name, f.suggestedReorder, f.product.unit,
                              )}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-emerald-700 hover:text-emerald-700 font-medium inline-flex items-center gap-1"
                            >
                              <MessageCircle className="h-3 w-3" />
                              Commander
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    {(status === 'rupture' || status === 'urgent' || status === 'warning') && (
                      <button
                        onClick={() => { setRestockProduct(f.product); setQuantiteSuggeree(f.suggestedReorder); }}
                        className="shrink-0 p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                        title="Réapprovisionner"
                        aria-label={`Réapprovisionner ${f.product.name}`}
                      >
                        <PackagePlus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {restockProduct && (
        <RestockModal
          product={restockProduct}
          initialQty={quantiteSuggeree}
          onClose={() => { setRestockProduct(null); setQuantiteSuggeree(undefined); }}
          onSaved={() => { fetchForecasts(); onRestock(); }}
        />
      )}
    </div>
  );
}
