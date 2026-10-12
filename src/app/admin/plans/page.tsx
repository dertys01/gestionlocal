'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Outil éditeur : accorder un plan à une boutique (bêta).
 *
 * Réservé à ADMIN_EMAILS (la route serveur refuse le reste). On écrit
 * `plan` + `plan_valid_until` : le plan s'éteint tout seul à l'échéance.
 */

interface Org {
  id: string;
  name: string;
  email: string | null;
  plan: 'free' | 'starter' | 'pro';
  plan_valid_until: string | null;
  trial_ends_at: string | null;
  created_at: string;
}

const PLANS = ['free', 'starter', 'pro'] as const;

/** Ce que la boutique a réellement, aujourd'hui (miroir de current_org_plan). */
function planAffiche(o: Org): string {
  const maintenant = Date.now();
  if (o.plan !== 'free' && o.plan_valid_until && new Date(o.plan_valid_until).getTime() <= maintenant) {
    return 'free';
  }
  if (o.plan === 'free' && o.trial_ends_at && new Date(o.trial_ends_at).getTime() > maintenant) {
    return 'starter (essai)';
  }
  return o.plan;
}

const dateFR = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '-');

export default function PlansAdminPage() {
  const { supabase } = useSupabase();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  const [fait, setFait] = useState('');
  const [choix, setChoix] = useState<Record<string, { plan: string; jours: string }>>({});
  const [enCours, setEnCours] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur('');
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) { setErreur('Connectez-vous avec votre compte éditeur.'); return; }
      const res = await fetch('/api/admin/plan', { headers: { Authorization: `Bearer ${jwt}` } });
      if (res.status === 403) { setErreur('Accès réservé à l’éditeur.'); return; }
      if (!res.ok) { setErreur('Chargement impossible.'); return; }
      const json = (await res.json()) as { organizations?: Org[] };
      setOrgs(json.organizations ?? []);
    } catch {
      setErreur('Chargement impossible.');
    } finally {
      setChargement(false);
    }
  }, [supabase]);

  useEffect(() => { void charger(); }, [charger]);

  const valeur = (id: string) => choix[id] ?? { plan: 'pro', jours: '90' };
  const maj = (id: string, patch: Partial<{ plan: string; jours: string }>) =>
    setChoix((prev) => ({ ...prev, [id]: { ...valeur(id), ...patch } }));

  const appliquer = async (o: Org) => {
    const v = valeur(o.id);
    setEnCours(o.id);
    setErreur('');
    setFait('');
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) { setErreur('Session expirée.'); return; }
      const res = await fetch('/api/admin/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          orgId: o.id,
          plan: v.plan,
          jours: v.plan === 'free' ? null : Number(v.jours),
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) { setErreur(json?.error ?? 'Application impossible.'); return; }
      setFait(`${o.name} → ${v.plan}${v.plan === 'free' ? '' : ` (${v.jours} jours)`}`);
      await charger();
    } catch {
      setErreur('Application impossible.');
    } finally {
      setEnCours(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-800">Plans des boutiques</h1>
          <div className="flex items-center gap-2">
            <Link href="/admin/retours" className="text-sm text-indigo-600 hover:underline">Retours</Link>
            <Button variant="outline" size="sm" onClick={() => void charger()} className="gap-1.5">
              <RefreshCw className="h-4 w-4" /> Actualiser
            </Button>
          </div>
        </div>

        {erreur && <p className="text-sm text-red-600">{erreur}</p>}
        {fait && <p className="text-sm text-emerald-700 flex items-center gap-1.5"><Check className="h-4 w-4" /> {fait}</p>}

        {chargement ? (
          <p className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
          </p>
        ) : (
          <ul className="space-y-2">
            {orgs.map((o) => {
              const v = valeur(o.id);
              return (
                <li key={o.id} className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-800 truncate">{o.name}</span>
                    <span className="text-xs text-slate-500 shrink-0">{o.email ?? o.id}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Plan : <strong className="text-slate-700">{planAffiche(o)}</strong>
                    {' · '}brut : {o.plan}
                    {' · '}échéance : {dateFR(o.plan_valid_until)}
                    {' · '}essai : {dateFR(o.trial_ends_at)}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={v.plan}
                      onChange={(e) => maj(o.id, { plan: e.target.value })}
                      aria-label={`Plan pour ${o.name}`}
                      className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-white"
                    >
                      {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={v.jours}
                      disabled={v.plan === 'free'}
                      onChange={(e) => maj(o.id, { jours: e.target.value })}
                      aria-label={`Durée en jours pour ${o.name}`}
                      className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm disabled:bg-slate-100"
                    />
                    <span className="text-xs text-slate-400">jours</span>
                    <Button
                      size="sm"
                      onClick={() => void appliquer(o)}
                      disabled={enCours === o.id}
                      className="bg-indigo-600 hover:bg-indigo-700"
                    >
                      {enCours === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Appliquer'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs text-slate-400">
          Accorder « pro » ou « starter » pose une échéance : le plan s’éteint tout seul à la fin.
          « free » efface l’échéance.
        </p>
      </div>
    </div>
  );
}
