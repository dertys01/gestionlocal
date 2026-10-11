'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';

/**
 * Un composant choisi dans une formule : le groupe (« Plat »), le produit, son
 * nom (figé pour la cuisine) et le supplément éventuel du choix.
 */
export interface FormuleComponent {
  group: string;
  product_id: string;
  name: string;
  extra_price: number;
}

interface Choix {
  product_id: string;
  extra_price: number;
  name: string;
}

interface Groupe {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  choix: Choix[];
}

interface FormulePickerProps {
  formule: { id: string; name: string; price_sell: number };
  disabled?: boolean;
  /** Appelé à chaque changement : composants, validité, total (formule + suppléments). */
  onChange: (components: FormuleComponent[], valid: boolean, total: number) => void;
}

/**
 * Sélecteur d'une formule : le client choisit, groupe par groupe, ce qu'il veut
 * (entrée, plat, dessert, boisson). Un groupe peut être « au choix » (max > 1)
 * ou obligatoire (min ≥ 1). Rien n'est ajouté tant que chaque groupe obligatoire
 * n'est pas servi.
 */
export function FormulePicker({ formule, disabled = false, onChange }: FormulePickerProps) {
  const { supabase } = useSupabase();
  const [groupes, setGroupes] = useState<Groupe[]>([]);
  const [chargement, setChargement] = useState(true);
  const [selection, setSelection] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let annule = false;
    const charger = async () => {
      setChargement(true);
      const { data } = await supabase
        .from('formule_groups')
        .select(
          'id, name, min_select, max_select, sort_order, formule_group_items(product_id, extra_price, sort_order, product:products(name))',
        )
        .eq('formule_id', formule.id)
        .order('sort_order');
      if (annule) return;
      const gs: Groupe[] = ((data ?? []) as Array<Record<string, unknown>>).map((g) => {
        const items = (g.formule_group_items ?? []) as Array<Record<string, unknown>>;
        return {
          id: g.id as string,
          name: g.name as string,
          min_select: Number(g.min_select ?? 1),
          max_select: Number(g.max_select ?? 1),
          choix: items
            .map((it) => {
              const produit = (it.product ?? {}) as Record<string, unknown>;
              return {
                product_id: it.product_id as string,
                extra_price: Number(it.extra_price ?? 0),
                name: (produit.name as string) ?? 'Article',
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        };
      });
      setGroupes(gs);
      setSelection({});
      setChargement(false);
    };
    void charger();
    return () => {
      annule = true;
    };
  }, [supabase, formule.id]);

  const basculer = (groupe: Groupe, productId: string) => {
    setSelection((prev) => {
      const actuels = prev[groupe.id] ?? [];
      const dejaLa = actuels.includes(productId);
      let suivant: string[];
      if (dejaLa) {
        // On ne descend pas sous le minimum : un groupe obligatoire reste servi.
        if (actuels.length <= groupe.min_select) return prev;
        suivant = actuels.filter((id) => id !== productId);
      } else {
        if (actuels.length >= groupe.max_select) {
          // Au-delà du maximum : on remplace le dernier choix (un seul pour un
          // groupe à choix unique) au lieu de refuser le clic.
          suivant = [...actuels.slice(0, groupe.max_select - 1), productId];
        } else {
          suivant = [...actuels, productId];
        }
      }
      return { ...prev, [groupe.id]: suivant };
    });
  };

  const { components, valid, total } = useMemo(() => {
    const comps: FormuleComponent[] = [];
    let ok = true;
    for (const g of groupes) {
      const choisis = selection[g.id] ?? [];
      if (choisis.length < g.min_select || choisis.length > g.max_select) ok = false;
      for (const pid of choisis) {
        const c = g.choix.find((x) => x.product_id === pid);
        if (c) comps.push({ group: g.name, product_id: pid, name: c.name, extra_price: c.extra_price });
      }
    }
    const supp = comps.reduce((n, c) => n + c.extra_price, 0);
    return { components: comps, valid: ok && groupes.length > 0, total: formule.price_sell + supp };
  }, [groupes, selection, formule.price_sell]);

  useEffect(() => {
    onChange(components, valid, total);
    // onChange est recréé à chaque rendu par l'appelant : on ne le met pas en
    // dépendance, sinon la boucle serait infinie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, valid, total]);

  if (chargement) {
    return (
      <p className="text-xs text-slate-500 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Composition de la formule…
      </p>
    );
  }

  if (groupes.length === 0) {
    return (
      <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
        Cette formule n&apos;est pas encore composée. Ajoutez ses groupes dans l&apos;onglet Formules.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groupes.map((g) => {
        const choisis = selection[g.id] ?? [];
        const reste = Math.max(0, g.min_select - choisis.length);
        return (
          <div key={g.id} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                {g.name}
                {g.min_select > 0 && <span className="text-rose-600 ml-1">*</span>}
              </span>
              <span className="text-[11px] text-slate-500">
                {g.max_select > 1
                  ? `jusqu'à ${g.max_select}`
                  : g.min_select === 0
                    ? 'facultatif'
                    : '1 au choix'}
                {reste > 0 && ` · ${reste} restant${reste > 1 ? 's' : ''}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.choix.map((c) => {
                const actif = choisis.includes(c.product_id);
                return (
                  <button
                    key={c.product_id}
                    type="button"
                    disabled={disabled}
                    onClick={() => basculer(g, c.product_id)}
                    aria-pressed={actif}
                    className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      actif
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 font-medium'
                        : 'border-slate-200 text-slate-600 hover:border-indigo-300'
                    }`}
                  >
                    {actif && <Check className="h-3 w-3" />}
                    {c.name}
                    {c.extra_price !== 0 && (
                      <span className="text-[10px] text-slate-500">
                        {c.extra_price > 0 ? `+${formatCFA(c.extra_price)}` : `−${formatCFA(Math.abs(c.extra_price))}`}
                      </span>
                    )}
                  </button>
                );
              })}
              {g.choix.length === 0 && (
                <span className="text-xs text-slate-400">Aucun choix dans ce groupe.</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
