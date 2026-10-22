'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

// ── Page de connexion / inscription ──
export function LoginPage({ initialMode = 'login' }: { initialMode?: 'login' | 'register' | 'forgot' } = {}) {
  const { supabase, user, loading: sessionLoading } = useSupabase();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Une session ouverte ne laisse JAMAIS le formulaire à l'écran. /connexion
  // avait ce garde ; /register, non : après une inscription réussie, le compte
  // et la session existaient, mais la page restait sur le formulaire et le
  // nouvel utilisateur ne voyait jamais l'assistant. Le garde vit donc ici,
  // pour les deux routes.
  useEffect(() => {
    if (!sessionLoading && user) router.replace('/');
  }, [sessionLoading, user, router]);

  const switchMode = (m: 'login' | 'register' | 'forgot') => {
    setMode(m);
    setError('');
    setInfo('');
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    try {
      // window.location.origin : le lien part vers la boite mail du client, pas
      // vers l'API Supabase. Si l'origine n'est pas dans la liste blanche
      // (Authentication > URL Configuration), Supabase redirige vers le Site URL
      // configure et le client atterrit sur la page d'accueil au lieu de
      // /reset-password.
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) {
        console.error('[auth] resetPasswordForEmail', error.status, error.message);
        const m = error.message || '';
        if (/redirect|not.*allow/i.test(m)) {
          setError("La demande a été refusée : l'adresse du site n'est pas autorisée. Contactez le support.");
        } else if (/rate limit|too many|seconds/i.test(m)) {
          setError('Trop de demandes envoyées. Patientez une minute avant de réessayer.');
        } else {
          // Un envoi d'email ne doit jamais reveler si l'adresse existe : on ne
          // distingue donc pas "compte inconnu" de "echec d'envoi". Mais on
          // affiche le detail technique, sinon un incident serveur reste
          // impossible a diagnostiquer depuis l'ecran.
          setError(`L'email n'a pas pu être envoyé. Détail technique : ${m}`);
        }
      } else {
        setInfo('Email envoyé ! Vérifiez votre boîte mail pour réinitialiser votre mot de passe.');
      }
    } catch (err) {
      // Une panne réseau peut rejeter au lieu de renvoyer { error } : sans ce
      // catch, setLoading(false) n'était jamais atteint (bouton figé).
      console.error('[auth] resetPasswordForEmail a rejeté', err);
      setError(err instanceof Error ? err.message : "L'email n'a pas pu être envoyé. Réessayez.");
    } finally {
      setLoading(false);
    }
  };

  // Un "email ou mot de passe incorrect" affiche quand toute requete a
  // echoue : incident Supabase (500), cle anon corrompue dans Vercel, extension
  // bloquant fetch... Le message affirmait un mauvais mot de passe sur des
  // comptes parfaitement valides, ce qui a fait perdre des heures a l'utilisateur.
  // On ne montre "incorrect" que si Supabase dit explicitement que les
  // identifiants sont.refuses ; tout le reste est qualifie.
  const describeAuthError = (err: { message: string; status?: number }) => {
    const m = err.message || '';
    if (/invalid login credentials/i.test(m)) {
      return 'Email ou mot de passe incorrect.';
    }
    if (/email rate limit|over_email_send_rate_limit|too many|rate limit/i.test(m)) {
      return 'Trop de tentatives. Patientez une minute avant de réessayer.';
    }
    if (err.status === 0 || /failed to fetch|network|load failed/i.test(m)) {
      return 'Connexion au service impossible. Vérifiez votre connexion internet.';
    }
    if (err.status && err.status >= 500) {
      return 'Le service d\'authentification rencontre un incident. Réessayez dans quelques minutes.';
    }
    return `Connexion impossible (${err.status ?? '?'}). Détail : ${m}`;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error('[auth] signInWithPassword', error.status, error.message);
        setError(describeAuthError(error));
      }
    } catch (err) {
      // signInWithPassword renvoie normalement { error }, mais une panne
      // réseau peut rejeter : sans ce catch, le bouton tournait sans fin.
      console.error('[auth] signInWithPassword a rejeté', err);
      setError(err instanceof Error ? err.message : 'Connexion impossible. Vérifiez votre réseau.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, businessName }),
      });

      // res.json() LÈVE si le corps n'est pas du JSON : page HTML servie par
      // un proxy, 502, coupure. L'exception s'échappait de l'événement,
      // setLoading(false) n'était jamais atteint — le formulaire tournait
      // indéfiniment sans le moindre message.
      let json: { error?: string; access_token?: string; refresh_token?: string } = {};
      try { json = await res.json(); } catch { /* corps non JSON : on garde {} */ }

      if (!res.ok) {
        setError(json.error ?? `Erreur lors de la création du compte (HTTP ${res.status}).`);
        return;
      }

      if (json.error) {
        // Compte créé mais login auto échoué → rediriger vers login.
        // switchMode remet error/info à zéro : le message doit être posé APRÈS,
        // sinon il est effacé aussitôt et l'utilisateur ne voit rien.
        switchMode('login');
        setError(json.error);
        return;
      }

      // res.ok mais pas de jeton : compte créé, session non ouverte. Sans ce
      // garde, setSession recevait undefined et restait silencieusement muet.
      if (!json.access_token || !json.refresh_token) {
        switchMode('login');
        setError('Compte créé, mais la session n\'a pas pu être ouverte. Connectez-vous.');
        return;
      }

      const { error: sessErr } = await supabase.auth.setSession({
        access_token: json.access_token,
        refresh_token: json.refresh_token,
      });
      if (sessErr) {
        setError(`Compte créé, mais connexion impossible : ${sessErr.message}`);
        return;
      }
      // Ne pas dépendre du seul effet ci-dessus : le jeton est posé, on quitte
      // le formulaire tout de suite. L'assistant de premier lancement prend la
      // suite à la racine.
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Réseau indisponible. Réessayez.');
    } finally {
      // Toujours atteint : plus de rotation infinie sur le bouton.
      setLoading(false);
    }
  };

  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">
            {mode === 'login' ? 'Connectez-vous à votre espace' : 'Créez votre boutique'}
          </p>
        </div>

        {/* Toggle login / register */}
        {mode !== 'forgot' && (
          <div className="flex rounded-xl bg-slate-100 p-1 mb-4">
            <button
              onClick={() => switchMode('login')}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${mode === 'login' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'}`}
            >
              Se connecter
            </button>
            <button
              onClick={() => switchMode('register')}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${mode === 'register' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'}`}
            >
              Créer un compte
            </button>
          </div>
        )}

        {/* Les formules, avant même l'inscription : on décide de s'engager en
            voyant ce que contient chaque plan, pas après avoir créé un compte. */}
        <p className="text-center mb-4">
          <Link href="/tarifs" className="text-sm text-indigo-600 hover:text-indigo-800 underline">
            Voir les formules et l&apos;essai de 14 jours →
          </Link>
        </p>

        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            {mode === 'forgot' ? (
              <form onSubmit={handleForgot} className="space-y-4">
                <div className="text-center mb-2">
                  <p className="text-sm font-semibold text-slate-700">Réinitialiser le mot de passe</p>
                  <p className="text-xs text-slate-500 mt-1">Un lien de réinitialisation sera envoyé à votre email</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="forgot-email" className="text-sm font-medium text-slate-700">Email</label>
                  <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" className={inputClass} />
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                {info && <p className="text-emerald-700 text-sm">{info}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Envoi...' : 'Envoyer le lien'}
                </Button>
                <button type="button" onClick={() => switchMode('login')} className="w-full text-sm text-slate-500 hover:text-slate-600 underline">
                  Retour à la connexion
                </button>
              </form>
            ) : mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="login-email" className="text-sm font-medium text-slate-700">Email</label>
                  <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="login-mdp" className="text-sm font-medium text-slate-700">Mot de passe</label>
                  <div className="relative">
                    <input id="login-mdp" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" className={inputClass + ' pr-11'} />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-r-lg focus:outline-none"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Connexion...' : 'Se connecter'}
                </Button>
                <button type="button" onClick={() => switchMode('forgot')} className="w-full text-sm text-slate-500 hover:text-slate-600 underline">
                  Mot de passe oublié ?
                </button>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="reg-boutique" className="text-sm font-medium text-slate-700">Nom de votre boutique</label>
                  <input id="reg-boutique" type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required placeholder="Ex: Épicerie Adjonou" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="reg-email" className="text-sm font-medium text-slate-700">Email</label>
                  <input id="reg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="reg-mdp" className="text-sm font-medium text-slate-700">Mot de passe</label>
                  <div className="relative">
                    <input id="reg-mdp" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="8 caractères minimum" minLength={6} className={inputClass + ' pr-11'} />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-r-lg focus:outline-none"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                {info && <p className="text-indigo-600 text-sm">{info}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Création...' : 'Créer mon compte'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
