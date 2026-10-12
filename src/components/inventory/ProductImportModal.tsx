'use client';

import { useRef, useState } from 'react';
import { X, Upload, FileText, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { logActivity } from '@/lib/utils/activity';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import { formatCFA } from '@/lib/utils/currency';
import { starterCatalog } from '@/lib/starterCatalog';
import {
  parseProductsCsv, lignesImportables, type ImportResult,
} from '@/lib/utils/importProducts';
import { toCSV, downloadCSV } from '@/lib/utils/export';
import type { Product } from '@/types';

interface ProductImportProps {
  products: Product[];
  onClose: () => void;
  onDone: () => void;
}

/** PostgREST encaisse volontiers un lot ; au-delà, on fragmente. */
const LOT = 100;

const MOTIF_LIGNE = {
  ok: 'text-emerald-700 bg-emerald-50',
  doublon_fichier: 'text-slate-600 bg-slate-100',
  deja_present: 'text-amber-700 bg-amber-50',
  erreur: 'text-red-700 bg-red-50',
} as const;

const LIBELLE_STATUT = {
  ok: 'À importer',
  doublon_fichier: 'Doublon du fichier',
  deja_present: 'Déjà en boutique',
  erreur: 'Refusée',
} as const;

export function ProductImportModal({ products, onClose, onDone }: ProductImportProps) {
  const { supabase, ownerId, actorName, plan, org } = useSupabase();
  const inputRef = useRef<HTMLInputElement>(null);

  const [fichier, setFichier] = useState('');
  const [resultat, setResultat] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [erreur, setErreur] = useState('');
  const [fait, setFait] = useState<number | null>(null);

  const lire = async (f: File) => {
    setErreur('');
    setFait(null);
    setResultat(null);
    setFichier(f.name);
    const texte = await f.text();
    setResultat(
      parseProductsCsv(texte, products.map((p) => p.name))
    );
  };

  const importables = resultat ? lignesImportables(resultat) : [];
  const refuses = resultat?.rows.filter((r) => r.status === 'erreur') ?? [];
  const ignores = resultat?.rows.filter(
    (r) => r.status === 'doublon_fichier' || r.status === 'deja_present'
  ) ?? [];

  // Le contrôle est fait avant d'envoyer quoi que ce soit : la limite est
  // appliquée en base, produit par produit, et un lot coupé en deux laisserait
  // une moitié importée et l'autre refusée sans que rien ne le dise.
  const limite = PLAN_LIMITS[plan].products;
  const trop = Number.isFinite(limite) && products.length + importables.length > limite;
  const peutImporter = importables.length > 0 && !trop;

  const lancer = async () => {
    if (importables.length === 0) return;
    setImporting(true);
    setErreur('');

    // Même garde que ProductForm : sans session, ownerId est null et l'import
    // échouerait en inserting des produits sans propriétaire — ou pire, dans
    // la boutique de quelqu'un d'autre si ownerId était resté en mémoire.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !ownerId) {
      setErreur('Session expirée, reconnectez-vous.');
      setImporting(false);
      return;
    }

    const charge = importables.map((r) => ({
      user_id: ownerId,
      name: r.name,
      sku: r.sku,
      category: r.category,
      price_buy: r.price_buy,
      price_sell: r.price_sell,
      stock_qty: r.stock_qty,
      min_stock_level: r.min_stock_level,
    }));

    let inseres = 0;
    try {
      for (let i = 0; i < charge.length; i += LOT) {
        const { data, error: err } = await supabase
          .from('products')
          .insert(charge.slice(i, i + LOT))
          .select('id');
        if (err) throw new Error(err.message);
        inseres += data?.length ?? 0;
      }

      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: 'product_import',
        description:
          `Import CSV : ${inseres} produit${inseres > 1 ? 's' : ''} depuis « ${fichier} »` +
          (ignores.length ? `, ${ignores.length} ignoré${ignores.length > 1 ? 's' : ''}` : '') +
          (refuses.length ? `, ${refuses.length} refusé${refuses.length > 1 ? 's' : ''}` : ''),
      });

      setFait(inseres);
      onDone();
    } catch (e) {
      // Le lot est peut-être parti à moitié : le dire vaut mieux qu'un échec
      // muet, sinon le commerçant recharge le fichier et tombe sur ce qu'il
      // vient d'importer.
      setErreur(
        inseres > 0
          ? `${inseres} produit${inseres > 1 ? 's ont' : ' a'} été importé${inseres > 1 ? 's' : ''}, ` +
            `puis l'import s'est arrêté : ${(e as Error).message}`
          : (e as Error).message
      );
    } finally {
      setImporting(false);
    }
  };

  const telechargerModele = () => {
    // Le modèle suit le domaine : un maquis qui télécharge un gabarit rempli de
    // smartphones repart avec un fichier qu'il faut réécrire entièrement. Trois
    // lignes du catalogue réel suffisent à montrer la forme.
    const apercu = starterCatalog(org?.domain)
      .slice(0, 3)
      .map((a) => ({
        produit: a.name,
        sku: '',
        categorie: a.category,
        achat: a.priceBuy,
        vente: a.priceSell,
        stock: a.stock,
        mini: a.minStock,
      }));
    const csv = toCSV(apercu,
      [
        { key: 'produit', label: 'Produit' },
        { key: 'sku', label: 'SKU' },
        { key: 'categorie', label: 'Catégorie' },
        { key: 'achat', label: 'Prix achat (F)' },
        { key: 'vente', label: 'Prix vente (F)' },
        { key: 'stock', label: 'Stock' },
        { key: 'mini', label: 'Stock min' },
      ]
    );
    downloadCSV(csv, 'modele-import-produits.csv');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-3xl rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h2 className="font-bold text-slate-800">Importer des produits (CSV)</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600" aria-label="Fermer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Choix du fichier */}
          <div className="space-y-3">
            <input
              ref={inputRef}
              id="import-produits-fichier"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void lire(f);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => inputRef.current?.click()}
                variant="outline"
                className="gap-2 border-slate-200"
              >
                <Upload className="h-4 w-4" />
                Choisir un fichier
              </Button>
              <Button type="button" onClick={telechargerModele} variant="ghost" className="gap-2">
                <FileText className="h-4 w-4" />
                Télécharger le modèle
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Colonnes reconnues, dans l&apos;ordre ou non : <code>Produit</code>, <code>SKU</code>,{' '}
              <code>Catégorie</code>, <code>Prix achat (F)</code>, <code>Prix vente (F)</code>,{' '}
              <code>Stock</code>, <code>Stock min</code>. Les noms de colonnes de la base
              (<code>name</code>, <code>price_sell</code>…) sont acceptés aussi, ainsi que le
              point-virgule d&apos;un Excel français. Seuls le nom et le prix de vente sont obligatoires.
            </p>
          </div>

          {/* Erreur bloquante */}
          {resultat?.erreur && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-red-700 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{resultat.erreur}</span>
            </div>
          )}

          {/* Verdict */}
          {resultat && !resultat.erreur && (
            <>
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-emerald-800 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  <strong>{fichier}</strong> : {importables.length} produit
                  {importables.length > 1 ? 's' : ''} à importer
                  {ignores.length > 0 && `, ${ignores.length} ignoré${ignores.length > 1 ? 's' : ''}`}
                  {refuses.length > 0 && `, ${refuses.length} refusé${refuses.length > 1 ? 's' : ''}`}.
                </span>
              </div>

              {(ignores.length > 0 || refuses.length > 0) && (
                <details className="rounded-lg border border-slate-200">
                  <summary className="px-4 py-2 text-sm text-slate-600 cursor-pointer">
                    Voir les {ignores.length + refuses.length} ligne
                    {ignores.length + refuses.length > 1 ? 's' : ''} écartée
                    {ignores.length + refuses.length > 1 ? 's' : ''}
                  </summary>
                  <ul className="px-4 pb-3 space-y-1 text-xs text-slate-600">
                    {[...ignores, ...refuses].map((r) => (
                      <li key={r.ligne}>
                        <span className="font-medium text-slate-700">Ligne {r.ligne}</span> : {r.name}{' '}
                        <span className="text-slate-500">({LIBELLE_STATUT[r.status]}{r.problem ? ` : ${r.problem}` : ''})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* Aperçu */}
              <div className="rounded-lg border border-slate-200 overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Produit</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Catégorie</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Achat</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Vente</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">État</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultat.rows.map((r) => (
                      <tr key={r.ligne} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 text-slate-800">{r.name || '-'}</td>
                        <td className="px-3 py-1.5 text-slate-500">{r.category ?? '-'}</td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{formatCFA(r.price_buy)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{formatCFA(r.price_sell)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-xs px-2 py-0.5 rounded ${MOTIF_LIGNE[r.status]}`}>
                            {LIBELLE_STATUT[r.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {fait !== null && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-emerald-800 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{fait} produit{fait > 1 ? 's' : ''} importé{fait > 1 ? 's' : ''}.</span>
            </div>
          )}

          {erreur && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-red-700 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{erreur}</span>
            </div>
          )}

          {trop && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-amber-800 text-sm">
              <span>
                Votre plan autorise {limite} produits et vous en avez {products.length}. Ce fichier
                en apporte {importables.length} : il en resterait{' '}
                {Math.max(0, limite - products.length)} à passer. Importez un fichier plus court, ou
                changez de plan.
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={onClose} variant="ghost">
              {fait !== null ? 'Fermer' : 'Annuler'}
            </Button>
            <Button
              type="button"
              onClick={lancer}
              disabled={!peutImporter || importing || fait !== null}
              className="bg-indigo-600 hover:bg-indigo-700 gap-2"
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Importer {importables.length > 0 ? `${importables.length} produits` : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
