'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Receipt, Wallet } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { readablePlanError } from '@/lib/utils/planErrors';
import { isFeatureAllowed } from '@/lib/utils/plans';
import { addDays, localTimeZone, parseISODate, todayISO } from '@/lib/utils/period';
import type { Sale, SaleItem } from '@/types';

/** Ligne renvoyée par get_cash_flow(date, date). */
interface CashFlowDay {
  day: string;
  revenue: number;
  cogs: number;
  expenses: number;
  net: number;
  transactions: number;
}

/** Ligne renvoyée par get_sales_summary(p_from, p_to, p_tz). */
interface SalesSummaryDay {
  day: string;
  revenue: number;
  cash: number;
  momo: number;
  tx: number;
}

interface Expense {
  id: string;
  category: string;
  label: string;
  amount: number;
  day: string;
  note: string | null;
}

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

/** « lundi 5 octobre 2026 », première lettre en majuscule. */
function labelDuJour(iso: string): string {
  const s = parseISODate(iso).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function heure(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Journal du jour — la page que le commerçant ouvre LE CHAQUE SOIR pour
 * vérifier ce que la journée a donné : combien entré, quelle marge, quelles
 * charges, et la liste détaille ventes et dépenses de ce jour précis.
 *
 * Une seule journée à la fois, avec le jour précédent/suivant : le vrai usage
 * n'est pas « toutes les ventes de l'année » (l'historique fait ça) mais
 * « hier, combien ? » et « le 12, pourquoi les charges sont hautes ? ».
 *
 * Trois sources, déjà existantes — aucune nouvelle fonction SQL :
 *   - get_sales_summary   → CA encaissé, ventilation espèces/MoMo, nb de ventes
 *   - get_cash_flow       → CMV, charges, résultat net (refusé hors plan Pro)
 *   - sales + expenses    → les lignes détaillées du jour
 *
 * get_cash_flow peut être refusée selon le plan : le journal reste utilisable
 * (CA, ventes, charges saisies affichés), seule la marge s'affiche en « — »
 * avec la raison. Un écran qui s'éteint parce qu'un chiffre secondaire est
 * verrouillé serait pire que pas d'écran du tout.
 */
export function DailyJournal() {
  const { supabase, plan } = useSupabase();
  /**
   * Marge et résultat net : plan Starter. Sans lui, on ne les demande même pas
   * à la base (elle répondrait 403), et l'écran ne montre que ce qui sert au
   * soir d'une boutique gratuite — encaissé et nombre de ventes — sans bandeau
   * de refus sur un écran essentiel.
   */
  const avecMarge = isFeatureAllowed(plan, 'reports');

  const [day, setDay] = useState<string>(() => todayISO());
  const [loading, setLoading] = useState(false);
  /** Erreur bloquante (réseau, droits) — le journal n'a rien à afficher. */
  const [error, setError] = useState('');
  /** Refus de plan sur get_cash_flow seul : marge et net en « — ». */
  const [flowError, setFlowError] = useState('');
  const [summary, setSummary] = useState<SalesSummaryDay | null>(null);
  const [flow, setFlow] = useState<CashFlowDay | null>(null);
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setLoading(true);
    setError('');
    setFlowError('');
    // On repart de zéro : afficher les chiffres d'hier sous l'en-tête d'aujourd'hui,
    // même un instant, c'est exactement le genre d'erreur qui fait douter d'un journal.
    setSummary(null);
    setFlow(null);
    setSales([]);
    setExpenses([]);
    setExpanded(null);

    // Bornes UTC du jour LOCAL (heure de la boutique, Africa/Porto-Novo) :
    // sales.created_at est un timestamptz, le filtrer sur « jour UTC » ferait
    // glisser les ventes de 23 h vers le lendemain.
    const debut = new Date(`${day}T00:00:00`).toISOString();
    const fin = new Date(`${day}T23:59:59.999`).toISOString();

    try {
      const [flowRes, sumRes, salesRes, expRes] = await Promise.all([
        avecMarge
          ? supabase.rpc('get_cash_flow', { p_from: day, p_to: day })
          : Promise.resolve({ data: null, error: null }),
        supabase.rpc('get_sales_summary', { p_from: day, p_to: day, p_tz: localTimeZone() }),
        supabase
          .from('sales')
          .select('*, sale_items(*)')
          .gte('created_at', debut)
          .lte('created_at', fin)
          .order('created_at', { ascending: false }),
        supabase.from('expenses').select('*').eq('day', day).order('created_at', { ascending: false }),
      ]);

      if (flowRes.error) {
        setFlowError(readablePlanError(flowRes.error.message));
      } else if (avecMarge) {
        setFlow(((flowRes.data as CashFlowDay[]) ?? [])[0] ?? null);
      }

      if (sumRes.error) throw new Error(sumRes.error.message);
      setSummary(((sumRes.data as SalesSummaryDay[]) ?? [])[0] ?? null);

      if (salesRes.error) throw new Error(salesRes.error.message);
      setSales((salesRes.data as SaleWithItems[]) ?? []);

      if (expRes.error) throw new Error(expRes.error.message);
      setExpenses((expRes.data as Expense[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [day, supabase, avecMarge]);

  useEffect(() => {
    charger();
  }, [charger]);

  const aujourdhui = todayISO();
  const estAujourdhui = day === aujourdhui;

  const totalFacture = sales.reduce((somme, s) => somme + Number(s.total_amount), 0);
  const totalCharges = flow
    ? Number(flow.expenses)
    : expenses.reduce((somme, e) => somme + Number(e.amount), 0);

  const marge = flow ? Number(flow.revenue) - Number(flow.cogs) : null;
  const tauxMarge =
    flow && Number(flow.revenue) > 0
      ? `soit ${Math.round(((Number(flow.revenue) - Number(flow.cogs)) / Number(flow.revenue)) * 100)} % du CA`
      : '';

  return (
    <div className="space-y-4">
      {/* Navigation de jour : le geste central de l'écran. */}
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
        <button
          type="button"
          aria-label="Jour précédent"
          onClick={() => {
            setDay((d) => addDays(d, -1));
          }}
          className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold text-slate-800">
            {estAujourdhui ? 'Aujourd’hui, ' : ''}
            {labelDuJour(day)}
          </div>
        </div>

        {!estAujourdhui && (
          <button
            type="button"
            onClick={() => setDay(aujourdhui)}
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            Aujourd’hui
          </button>
        )}

        <button
          type="button"
          aria-label="Jour suivant"
          disabled={day >= aujourdhui}
          onClick={() => {
            setDay((d) => addDays(d, 1));
          }}
          className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          Impossible de charger le journal : {error}
        </p>
      )}

      {loading && <p className="text-xs text-slate-400">Chargement…</p>}

      {/* Les quatre chiffres du jour. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-xs text-slate-500">Chiffre d’affaires</div>
            <div className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
              {formatCFA(Number(summary?.revenue ?? flow?.revenue ?? 0))}
            </div>
            {/* Pas de truncate : à 375 px, la carte fait la moitié de l'écran et
                « · MoMo … » disparaissait. Le texte passe à la ligne. */}
            <div className="text-[11px] text-slate-500">
              Espèces {formatCFA(Number(summary?.cash ?? 0))} · MoMo {formatCFA(Number(summary?.momo ?? 0))}
            </div>
          </CardContent>
        </Card>

        {avecMarge ? (
          <>
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">Marge brute</div>
                <div className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
                  {marge === null ? '-' : formatCFA(marge)}
                </div>
                <div className="truncate text-[11px] text-slate-500">{tauxMarge}</div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">Charges</div>
                <div className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
                  {formatCFA(totalCharges)}
                </div>
                <div className="truncate text-[11px] text-slate-500">
                  {expenses.length} saisie{expenses.length > 1 ? 's' : ''}
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="text-xs text-slate-500">Résultat net</div>
                <div className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
                  {flow === null ? '-' : formatCFA(Number(flow.net))}
                </div>
                <div className="truncate text-[11px] text-slate-500">
                  {flow === null ? '' : 'après charges et coût d’achat'}
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="text-xs text-slate-500">Ventes</div>
              <div className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
                {Number(summary?.tx ?? sales.length)}
              </div>
              <div className="truncate text-[11px] text-slate-500">enregistrées ce jour</div>
            </CardContent>
          </Card>
        )}
      </div>

      {!avecMarge && (
        <p className="text-xs text-slate-500">
          La marge et le résultat net du jour sont inclus à partir du plan Starter.
        </p>
      )}

      {flowError && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          {flowError}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {/* Ventes du jour */}
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-700">Ventes du jour</h3>
              {!loading && sales.length > 0 && (
                <span className="text-xs tabular-nums text-slate-500">
                  {sales.length} vente{sales.length > 1 ? 's' : ''} · {formatCFA(totalFacture)}
                </span>
              )}
            </div>

            {loading ? (
              <p className="py-6 text-center text-xs text-slate-400">Chargement…</p>
            ) : sales.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="Aucune vente ce jour-là"
                hint="Les ventes enregistrées ce jour apparaîtront ici."
                className="py-6"
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {sales.map((s) => {
                  const badge =
                    s.payment_method === 'momo'
                      ? 'bg-emerald-100 text-emerald-700'
                      : s.payment_method === 'credit'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600';
                  const libelle =
                    s.payment_method === 'momo'
                      ? 'MoMo'
                      : s.payment_method === 'credit'
                        ? s.settled
                          ? 'Crédit soldé'
                          : 'Crédit'
                        : 'Espèces';
                  const ouvert = expanded === s.id;

                  return (
                    <div key={s.id}>
                      <button
                        type="button"
                        onClick={() => setExpanded(ouvert ? null : s.id)}
                        aria-expanded={ouvert}
                        className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-slate-50"
                      >
                        <span className="w-10 shrink-0 text-xs tabular-nums text-slate-400">
                          {heure(s.created_at)}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${badge}`}
                        >
                          {libelle}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                          {s.client_name
                            ? s.client_name
                            : `${s.sale_items.length} article${s.sale_items.length > 1 ? 's' : ''}`}
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">
                          {formatCFA(Number(s.total_amount))}
                        </span>
                      </button>

                      {ouvert && (
                        <ul className="space-y-1 pb-2 pl-[52px]">
                          {s.sale_items.map((i) => (
                            <li
                              key={i.id}
                              className="flex justify-between gap-3 text-xs text-slate-500"
                            >
                              <span className="min-w-0 truncate">
                                {i.quantity} × {i.product_name}
                              </span>
                              <span className="shrink-0 tabular-nums">{formatCFA(Number(i.subtotal))}</span>
                            </li>
                          ))}
                          {Number(s.amount_received) < Number(s.total_amount) && (
                            <li className="text-xs text-amber-700">
                              Reçu {formatCFA(Number(s.amount_received))} · reste{' '}
                              {formatCFA(Number(s.total_amount) - Number(s.amount_received))}
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Charges du jour — avec le plan qui permet de les saisir (Rapports → Charges). */}
        {avecMarge && (
          <Card className="border-slate-200">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-700">Charges du jour</h3>
                {!loading && expenses.length > 0 && (
                  <span className="text-xs tabular-nums text-slate-500">{formatCFA(totalCharges)}</span>
                )}
              </div>

              {loading ? (
                <p className="py-6 text-center text-xs text-slate-400">Chargement…</p>
              ) : expenses.length === 0 ? (
                <EmptyState
                  icon={Wallet}
                  title="Aucune charge ce jour-là"
                  hint="Saisissez une charge depuis Rapports → Charges : elle sera rattachée à ce jour."
                  className="py-6"
                />
              ) : (
                <div className="divide-y divide-slate-100">
                  {expenses.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-700">{e.label}</div>
                        <div className="truncate text-[11px] text-slate-400">{e.category}</div>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">
                        −{formatCFA(Number(e.amount))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
