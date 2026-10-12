'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Bug, Lightbulb, HelpCircle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Boîte de réception des retours (éditeur).
 *
 * Réservée aux adresses de ADMIN_EMAILS : la route serveur refuse le reste.
 * On lit les retours de TOUTES les boutiques, avec leur contexte — de quoi
 * trier un bug sans ouvrir Supabase ni le téléphone.
 */

type Statut = 'new' | 'seen' | 'done';

interface Retour {
  id: string;
  owner_id: string;
  org_name: string | null;
  author_email: string | null;
  kind: string;
  message: string;
  page: string | null;
  context: Record<string, unknown> | null;
  status: Statut;
  created_at: string;
}

const ICONES: Record<string, typeof Bug> = { bug: Bug, idea: Lightbulb, question: HelpCircle };
const LIBELLES: Record<string, string> = { bug: 'Bug', idea: 'Idée', question: 'Question', other: 'Autre' };

export default function RetoursAdminPage() {
  const { supabase } = useSupabase();
  const [retours, setRetours] = useState<Retour[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState('');
  const [filtre, setFiltre] = useState<'tous' | Statut>('tous');

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur('');
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) { setErreur('Connectez-vous avec votre compte éditeur.'); return; }
      const res = await fetch('/api/admin/feedback', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.status === 403) { setErreur('Accès réservé à l’éditeur.'); return; }
      if (!res.ok) { setErreur('Chargement impossible.'); return; }
      const json = (await res.json()) as { feedback?: Retour[] };
      setRetours(json.feedback ?? []);
    } catch {
      setErreur('Chargement impossible.');
    } finally {
      setChargement(false);
    }
  }, [supabase]);

  useEffect(() => { void charger(); }, [charger]);

  const changerStatut = async (id: string, status: Statut) => {
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token;
    if (!jwt) return;
    await fetch('/api/admin/feedback', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ id, status }),
    });
    setRetours((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
  };

  const visibles = filtre === 'tous' ? retours : retours.filter((r) => r.status === filtre);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-800">Retours utilisateurs</h1>
          <div className="flex items-center gap-2">
            <Link href="/admin/plans" className="text-sm text-indigo-600 hover:underline">Plans</Link>
            <Button variant="outline" size="sm" onClick={() => void charger()} className="gap-1.5">
              <RefreshCw className="h-4 w-4" /> Actualiser
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(['tous', 'new', 'seen', 'done'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFiltre(f)}
              aria-pressed={filtre === f}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                filtre === f ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'
              }`}
            >
              {f === 'tous' ? 'Tous' : f === 'new' ? 'Nouveaux' : f === 'seen' ? 'Vus' : 'Traités'}
            </button>
          ))}
        </div>

        {erreur && <p className="text-sm text-red-600">{erreur}</p>}

        {chargement ? (
          <p className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
          </p>
        ) : visibles.length === 0 ? (
          <p className="text-sm text-slate-500 flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Aucun retour pour ce filtre.
          </p>
        ) : (
          <ul className="space-y-2">
            {visibles.map((r) => {
              const Icone = ICONES[r.kind] ?? MessageSquare;
              return (
                <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Icone className="h-4 w-4 text-indigo-600" />
                    <span className="font-medium text-slate-700">{LIBELLES[r.kind] ?? r.kind}</span>
                    <span>·</span>
                    <span>{r.org_name ?? r.owner_id}</span>
                    <span>·</span>
                    <span>{r.author_email ?? '—'}</span>
                    <span className="ml-auto">{new Date(r.created_at).toLocaleString('fr-FR')}</span>
                  </div>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap">{r.message}</p>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    {r.page && <span>onglet : {r.page}</span>}
                    {r.context?.viewport ? <span>· {String(r.context.viewport)}</span> : null}
                    {r.context?.userAgent ? <span className="truncate max-w-[220px]">· {String(r.context.userAgent)}</span> : null}
                  </div>
                  <div className="flex gap-1.5">
                    {(['new', 'seen', 'done'] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => void changerStatut(r.id, s)}
                        aria-pressed={r.status === s}
                        className={`rounded-md border px-2 py-1 text-[11px] ${
                          r.status === s ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-500'
                        }`}
                      >
                        {s === 'new' ? 'Nouveau' : s === 'seen' ? 'Vu' : 'Traité'}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
