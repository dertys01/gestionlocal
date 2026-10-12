'use client';

import { useState } from 'react';
import { MessageCircle, X, Send, Loader2, Bug, Lightbulb, HelpCircle, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Bouton « Signaler / Suggérer » et sa fenêtre.
 *
 * Un utilisateur ne décrira pas un bug avec la page et l'heure : il dit
 * « ça a planté ». On les capture donc ici (onglet courant, navigateur,
 * taille d'écran) et on range le tout avec son message. C'est ce qui rend un
 * retour exploitable.
 */

type Type = 'bug' | 'idea' | 'question';

const TYPES: Array<{ valeur: Type; label: string; icone: typeof Bug }> = [
  { valeur: 'bug', label: 'Un bug', icone: Bug },
  { valeur: 'idea', label: 'Une idée', icone: Lightbulb },
  { valeur: 'question', label: 'Une question', icone: HelpCircle },
];

interface FeedbackWidgetProps {
  open: boolean;
  onOpenChange: (ouvert: boolean) => void;
  /** Onglet courant, joint au retour. */
  page?: string;
}

export function FeedbackWidget({ open, onOpenChange, page }: FeedbackWidgetProps) {
  const { supabase } = useSupabase();
  const [kind, setKind] = useState<Type>('bug');
  const [message, setMessage] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState('');
  const [envoye, setEnvoye] = useState(false);

  const fermer = () => {
    onOpenChange(false);
    // Laisse la fenêtre se fermer avant de réinitialiser, pour éviter un
    // clignotement du message de remerciement.
    setTimeout(() => { setEnvoye(false); setErreur(''); }, 200);
  };

  const envoyer = async () => {
    if (message.trim().length < 3) { setErreur('Décrivez en quelques mots.'); return; }
    setEnvoi(true);
    setErreur('');
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) { setErreur('Session expirée, reconnectez-vous.'); return; }
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          kind,
          message: message.trim(),
          page: page ?? null,
          context: {
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            url: window.location.pathname,
          },
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setErreur(json?.error ?? 'Envoi impossible pour le moment.');
        return;
      }
      setEnvoye(true);
      setMessage('');
    } catch {
      setErreur('Envoi impossible pour le moment.');
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <>
      {/* Bouton flottant — remonte au-dessus de la barre de caisse mobile. */}
      <button
        onClick={() => onOpenChange(true)}
        className="fixed bottom-20 lg:bottom-6 right-4 z-40 flex items-center gap-2 rounded-full bg-slate-800 text-white px-3.5 py-2.5 shadow-lg hover:bg-slate-700 text-sm font-medium"
        aria-label="Signaler un problème ou une idée"
      >
        <MessageCircle className="h-4 w-4" />
        <span className="hidden sm:inline">Un retour ?</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-800">Signaler / Suggérer</h2>
              <button onClick={fermer} className="text-slate-500 hover:text-slate-600" aria-label="Fermer">
                <X className="h-5 w-5" />
              </button>
            </div>

            {envoye ? (
              <div className="p-6 text-center space-y-3">
                <Heart className="h-10 w-10 text-indigo-500 mx-auto" />
                <p className="font-medium text-slate-800">Merci, c&apos;est bien reçu.</p>
                <p className="text-sm text-slate-500">
                  Votre retour part directement à l&apos;équipe. On revient vers vous si besoin.
                </p>
                <Button onClick={fermer} className="w-full bg-slate-800 hover:bg-slate-700">Fermer</Button>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="flex gap-1.5">
                  {TYPES.map((t) => (
                    <button
                      key={t.valeur}
                      type="button"
                      onClick={() => setKind(t.valeur)}
                      aria-pressed={kind === t.valeur}
                      className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        kind === t.valeur
                          ? 'border-indigo-600 bg-indigo-50 text-indigo-700 font-medium'
                          : 'border-slate-200 text-slate-600 hover:border-indigo-300'
                      }`}
                    >
                      <t.icone className="h-4 w-4" /> {t.label}
                    </button>
                  ))}
                </div>

                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder={
                    kind === 'bug'
                      ? 'Qu’est-ce qui a mal tourné ? Ce que vous faisiez, ce que vous attendiez…'
                      : kind === 'idea'
                        ? 'Ce qui vous ferait gagner du temps…'
                        : 'Votre question…'
                  }
                  aria-label="Votre message"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />

                <p className="text-xs text-slate-400">
                  L&apos;onglet, le navigateur et la boutique sont joints automatiquement : vous n&apos;avez
                  rien d&apos;autre à noter.
                </p>

                {erreur && <p className="text-red-600 text-sm">{erreur}</p>}

                <Button
                  onClick={() => void envoyer()}
                  disabled={envoi || message.trim().length < 3}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2"
                >
                  {envoi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Envoyer
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
