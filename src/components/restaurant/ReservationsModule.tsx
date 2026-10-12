'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, Loader2, Check, X, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';

interface Reservation {
  id: string;
  customer_name: string;
  slot_at: string;
  party_size: number;
  phone: string | null;
  table_id: string | null;
  status: 'pending' | 'confirmed' | 'seated' | 'done' | 'no_show';
  note: string | null;
}
interface TableLite { id: string; name: string }

const STATUT: Record<Reservation['status'], { label: string; classe: string }> = {
  pending:   { label: 'À confirmer', classe: 'bg-amber-100 text-amber-700' },
  confirmed: { label: 'Confirmée',   classe: 'bg-indigo-100 text-indigo-700' },
  seated:    { label: 'Installée',   classe: 'bg-emerald-100 text-emerald-700' },
  done:      { label: 'Terminée',    classe: 'bg-slate-100 text-slate-500' },
  no_show:   { label: 'Absent',      classe: 'bg-red-100 text-red-700' },
};

const heure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Réservations de table.
 *
 * La table `restaurant_reservations` existait en base depuis le Sprint 15 mais
 * n'avait AUCUN écran : on pouvait la remplir en SQL, pas depuis l'application.
 * Ici, la prise de réservation est ouverte à l'équipe (RLS FOR ALL) — un
 * caissier prend les appels —, et l'écriture passe directement par la table
 * (aucune RPC : les policies suffisent, le tenant est déjà résolu).
 */
export function ReservationsModule() {
  const { supabase, ownerId } = useSupabase();
  const [resas, setResas] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<TableLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState(false);

  // Formulaire
  const [nom, setNom] = useState('');
  const [slot, setSlot] = useState('');
  const [partie, setPartie] = useState('2');
  const [phone, setPhone] = useState('');
  const [tableId, setTableId] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const [r, t] = await Promise.all([
      supabase.from('restaurant_reservations').select('*')
        .gte('slot_at', debut.toISOString()).order('slot_at').limit(100),
      supabase.from('restaurant_tables').select('id, name').order('name'),
    ]);
    if (r.error) setErreur(r.error.message);
    setResas((r.data as Reservation[]) ?? []);
    setTables((t.data as TableLite[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeRefresh(['restaurant_reservations'], load);

  const creer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerId) return;
    if (!nom.trim() || !slot) { setErreur('Indiquez le nom et l’heure de la réservation.'); return; }
    setEnCours('creation');
    setErreur('');
    try {
      const { error } = await supabase.from('restaurant_reservations').insert({
        owner_id: ownerId,
        customer_name: nom.trim(),
        slot_at: new Date(slot).toISOString(),
        party_size: Math.max(1, Math.floor(Number(partie) || 2)),
        phone: phone.trim() || null,
        table_id: tableId || null,
        note: note.trim() || null,
      });
      if (error) throw new Error(error.message);
      setNom(''); setSlot(''); setPartie('2'); setPhone(''); setTableId(''); setNote('');
      setOuvert(false);
      await load();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Création impossible.');
    } finally {
      setEnCours(null);
    }
  };

  const changerStatut = async (id: string, status: Reservation['status']) => {
    setEnCours(id);
    setErreur('');
    try {
      const { error } = await supabase.from('restaurant_reservations').update({ status }).eq('id', id);
      if (error) throw new Error(error.message);
      await load();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : 'Action impossible.');
    } finally {
      setEnCours(null);
    }
  };

  const nomTable = (id: string | null) => tables.find((t) => t.id === id)?.name ?? null;

  return (
    <Card className="border-slate-200">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-indigo-600 shrink-0" />
          <h3 className="font-semibold text-slate-800 text-sm">Réservations</h3>
          <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => setOuvert((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Nouvelle réservation
          </Button>
        </div>

        {erreur && <p role="alert" className="text-xs text-red-600">{erreur}</p>}

        {ouvert && (
          <form onSubmit={creer} className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Nom du client"
                aria-label="Nom du client (réservation)" className="flex-1 bg-white" required />
              <Input type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)}
                aria-label="Date et heure de la réservation" className="sm:w-56 bg-white" required />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input value={partie} onChange={(e) => setPartie(e.target.value)} inputMode="numeric"
                placeholder="Personnes" aria-label="Nombre de personnes" className="sm:w-28 bg-white" />
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
                placeholder="Téléphone (facultatif)" aria-label="Téléphone (réservation)" className="sm:w-48 bg-white" />
              <select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table (facultatif)"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                <option value="">Table (facultatif)</option>
                {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (facultatif)"
              aria-label="Note (réservation)" className="bg-white" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOuvert(false)} className="text-slate-500">Annuler</Button>
              <Button type="submit" disabled={enCours === 'creation'} className="gap-1.5 bg-indigo-600 hover:bg-indigo-700">
                {enCours === 'creation' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Enregistrer
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…</p>
        ) : resas.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Aucune réservation"
            hint="Prenez une réservation : nom, heure, nombre de personnes." className="py-4" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {resas.map((r) => {
              const st = STATUT[r.status];
              const table = nomTable(r.table_id);
              return (
                <li key={r.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">{r.customer_name}</span>
                    <Badge className={`${st.classe} border-0 text-[11px]`}>{st.label}</Badge>
                    <span className="ml-auto text-xs text-slate-500 shrink-0 tabular-nums">{heure(r.slot_at)}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {r.party_size} pers.{table ? ` · ${table}` : ''}{r.phone ? ` · ${r.phone}` : ''}{r.note ? ` · ${r.note}` : ''}
                  </div>
                  {(r.status === 'pending' || r.status === 'confirmed' || r.status === 'seated') && (
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {r.status === 'pending' && (
                        <Button size="sm" variant="outline" className="gap-1.5 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                          onClick={() => changerStatut(r.id, 'confirmed')} disabled={enCours === r.id}>
                          <Check className="h-3.5 w-3.5" /> Confirmer
                        </Button>
                      )}
                      {r.status === 'confirmed' && (
                        <Button size="sm" variant="outline" className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => changerStatut(r.id, 'seated')} disabled={enCours === r.id}>
                          <UserCheck className="h-3.5 w-3.5" /> Installer
                        </Button>
                      )}
                      {r.status === 'seated' && (
                        <Button size="sm" variant="outline" className="gap-1.5"
                          onClick={() => changerStatut(r.id, 'done')} disabled={enCours === r.id}>
                          <Check className="h-3.5 w-3.5" /> Terminer
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="gap-1.5 text-slate-500"
                        onClick={() => changerStatut(r.id, 'no_show')} disabled={enCours === r.id}>
                        <X className="h-3.5 w-3.5" /> Absent
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
