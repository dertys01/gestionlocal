'use client';

import { useState, useMemo, useEffect } from 'react';
import { Search, CheckCircle, AlertTriangle, RotateCcw, Save, Loader2, ScanBarcode } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { logActivity } from '@/lib/utils/activity';
import { lireMontant } from '@/lib/utils/nombres';
import type { Product } from '@/types';

interface InventoryCountProps {
  products: Product[];
  onComplete: () => void;
}

interface CountEntry {
  product: Product;
  counted: number | '';
}

export function InventoryCount({ products, onComplete }: InventoryCountProps) {
  const { supabase, ownerId, actorName } = useSupabase();
  const [entries, setEntries] = useState<CountEntry[]>(
    products.map((p) => ({ product: p, counted: '' }))
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // entries était initialisé une seule fois depuis props : un refresh en cours
  // d'inventaire laissait des lignes obsolètes, et handleSave écrivait alors
  // des stock_before / stock_after faux. On resynchronise donc à chaque nouveau
  // tableau `products` (motif React officiel « ajuster un état quand une prop
  // change ») — mais en PRÉSERVANT les quantités déjà saisies, par identifiant.
  // Tout réinitialiser à '' effaçait un comptage entier dès que le parent
  // rechargeait le catalogue : bouton rafraîchir, vente, réappro, création de
  // produit recréent tous un nouveau tableau `products`.
  const [syncedFor, setSyncedFor] = useState(products);
  if (syncedFor !== products) {
    setSyncedFor(products);
    setEntries((prev) => {
      const counts = new Map(prev.map((e) => [e.product.id, e.counted]));
      return products.map((p) => ({
        product: p,
        counted: counts.has(p.id) ? (counts.get(p.id) as number | '') : '',
      }));
    });
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.product.name.toLowerCase().includes(q) ||
        (e.product.sku ?? '').toLowerCase().includes(q) ||
        (e.product.category ?? '').toLowerCase().includes(q)
    );
  }, [entries, search]);

  const setCount = (productId: string, value: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.product.id === productId
          ? { ...e, counted: value === '' ? '' : Math.max(0, lireMontant(value) ?? 0) }
          : e
      )
    );
  };

  // Entrées avec une valeur saisie
  const filled = entries.filter((e) => e.counted !== '');
  const differences = filled.filter((e) => e.counted !== '' && Number(e.counted) !== e.product.stock_qty);
  const surplus = differences.filter((e) => Number(e.counted) > e.product.stock_qty);
  const deficit = differences.filter((e) => Number(e.counted) < e.product.stock_qty);

  const handleScan = (sku: string) => {
    setShowScanner(false);
    const found = entries.find((e) => e.product.sku === sku);
    if (found) {
      setError('');
      setSearch(found.product.name);
    } else {
      // Message inline, jamais un alert() bloquant : le reste de l'app
      // n'utilise pas de popup natif.
      setError(`Aucun produit trouvé pour le SKU : ${sku}`);
    }
  };

  const handleSave = async () => {
    if (differences.length === 0) return;
    setSaving(true);
    setError('');

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !ownerId) throw new Error('Session expirée, reconnectez-vous.');

      // Une ligne peut échouer (permission RLS, réseau) sans interrompre les
      // autres : l'erreur était totalement muette, l'inventaire affichait
      // « enregistré » alors qu'une partie des ajustements n'était pas passée.
      const results = await Promise.all(
        differences.map(async (entry) => {
          const newQty = Number(entry.counted);

          // Relire le stock réel avant d'écrire : `entry.product.stock_qty`
          // vient du fetch initial, une vente ou un réappro entre-temps serait
          // écrasé silencieusement (et stock_logs décrirait un faux écart).
          const { data: fresh, error: readErr } = await supabase
            .from('products')
            .select('stock_qty')
            .eq('id', entry.product.id)
            .single();
          if (readErr || !fresh) return { entry, error: readErr?.message ?? 'Produit introuvable.' };

          const stockBefore = fresh.stock_qty;

          const { data: updated, error: updateErr } = await supabase
            .from('products')
            .update({ stock_qty: newQty })
            .eq('id', entry.product.id)
            .eq('stock_qty', stockBefore) // verrou optimiste : 0 ligne si concurrence
            .select('id');
          if (updateErr) return { entry, error: updateErr.message };

          // 0 ligne : le stock a changé entre la lecture et l'écriture.
          if (!updated || updated.length === 0) {
            return { entry, error: 'Le stock a changé pendant la saisie, réessayez.' };
          }

          const { error: logErr } = await supabase.from('stock_logs').insert({
            user_id: ownerId,
            product_id: entry.product.id,
            product_name: entry.product.name,
            movement_type: 'adjustment',
            quantity_change: newQty - stockBefore,
            stock_before: stockBefore,
            stock_after: newQty,
          });
          if (logErr) return { entry, error: logErr.message };

          return { entry, error: null };
        })
      );

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length} produit${failed.length > 1 ? 's n\'ont pas pu être' : ' n\'a pas pu être'} ajusté${failed.length > 1 ? 's' : ''} (${failed[0].entry.product.name}) : ${failed[0].error}`
        );
      }

      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: 'inventory_adjustment',
        description: `Inventaire : ${differences.length} produit${differences.length > 1 ? 's' : ''} ajusté${differences.length > 1 ? 's' : ''}`,
        metadata: { count: differences.length },
      });

      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "L'inventaire n'a pas été enregistré.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!saved) return;
    // Timeout Previously jamais nettoyé : naviguer away déclenchait onComplete
    // après unmount.
    const t = setTimeout(onComplete, 1500);
    return () => clearTimeout(t);
  }, [saved, onComplete]);

  if (saved) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <CheckCircle className="h-12 w-12 text-emerald-600" />
        <p className="text-lg font-semibold text-slate-700">Inventaire enregistré !</p>
        <p className="text-slate-500 text-sm">{differences.length} produit{differences.length > 1 ? 's' : ''} mis à jour</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Instructions */}
      <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-4 py-3 text-sm text-indigo-700">
        Entrez la quantité <strong>réelle comptée</strong> pour chaque produit. Laissez vide si non compté.
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Barre recherche + scanner */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Rechercher un produit..."
            aria-label="Rechercher un produit dans l'inventaire"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <button
          aria-label="Scanner un code-barres"
          onClick={() => setShowScanner(true)}
          className="p-2.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          <ScanBarcode className="h-5 w-5" />
        </button>
      </div>

      {/* Résumé différences */}
      {filled.length > 0 && (
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
            <div className="font-bold text-slate-700">{filled.length}</div>
            <div className="text-xs text-slate-500">Comptés</div>
          </div>
          <div className={`rounded-lg border p-2 ${surplus.length > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
            <div className={`font-bold ${surplus.length > 0 ? 'text-emerald-700' : 'text-slate-700'}`}>+{surplus.length}</div>
            <div className="text-xs text-slate-500">Surplus</div>
          </div>
          <div className={`rounded-lg border p-2 ${deficit.length > 0 ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
            <div className={`font-bold ${deficit.length > 0 ? 'text-red-600' : 'text-slate-700'}`}>-{deficit.length}</div>
            <div className="text-xs text-slate-500">Manques</div>
          </div>
        </div>
      )}

      {/* Liste produits */}
      <div className="space-y-2">
        {filtered.map((entry) => {
          const counted = entry.counted;
          const diff = counted !== '' ? Number(counted) - entry.product.stock_qty : null;
          const hasDiff = diff !== null && diff !== 0;

          return (
            <Card
              key={entry.product.id}
              className={`border transition-colors ${
                hasDiff && diff! > 0 ? 'border-emerald-200 bg-emerald-50' :
                hasDiff && diff! < 0 ? 'border-red-200 bg-red-50' :
                counted !== '' ? 'border-indigo-200 bg-indigo-50' :
                'border-slate-200'
              }`}
            >
              <CardContent className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-800 text-sm truncate">{entry.product.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-slate-500">{entry.product.category ?? '-'}</span>
                    <span className="text-xs text-slate-500">Stock système : <strong>{entry.product.stock_qty}</strong></span>
                    {hasDiff && (
                      <Badge className={`text-xs py-0 ${diff! > 0 ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-red-100 text-red-700 hover:bg-red-100'}`}>
                        {diff! > 0 ? `+${diff}` : diff}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-slate-500">Compté :</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={counted}
                    onChange={(e) => setCount(entry.product.id, e.target.value)}
                    placeholder="-"
                    aria-label={`Quantité comptée pour ${entry.product.name}`}
                    className="w-16 text-center rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Boutons action */}
      {differences.length > 0 && (
        <div className="sticky bottom-20 pt-2">
          {!confirmed ? (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-lg space-y-3">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <span><strong>{differences.length}</strong> différence{differences.length > 1 ? 's' : ''} détectée{differences.length > 1 ? 's' : ''}. Confirmer les ajustements ?</span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setEntries(products.map((p) => ({ product: p, counted: '' })))}
                  className="flex-1 gap-2"
                >
                  <RotateCcw className="h-4 w-4" /> Réinitialiser
                </Button>
                <Button
                  onClick={() => setConfirmed(true)}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-700 gap-2"
                >
                  Confirmer
                </Button>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-emerald-200 rounded-xl p-4 shadow-lg space-y-3">
              <p className="text-sm text-slate-600 text-center">
                Les stocks seront mis à jour et tracés dans les logs. Cette action est irréversible.
              </p>
              {error && (
                <p className="text-xs text-red-600 text-center">{error}</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setConfirmed(false)} className="flex-1">
                  Annuler
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 bg-emerald-700 hover:bg-emerald-800 gap-2"
                >
                  {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Enregistrement...</> : <><Save className="h-4 w-4" /> Enregistrer</>}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {showScanner && (
        <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />
      )}
    </div>
  );
}
