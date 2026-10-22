import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Page de connexion / inscription / mot de passe oublié.
 *
 * Deux familles de comportements :
 *   - qualifier les erreurs d'auth (« mot de passe incorrect » seulement quand
 *     Supabase le dit explicitement — sinon incident, réseau, ou rate limit) ;
 *   - ne JAMAIS perdre un message : après « compte créé mais session non
 *     ouverte », on bascule sur la connexion EN MONTRANT pourquoi.
 */

const h = vi.hoisted(() => {
  const state = {
    signIn: { error: null as null | { message: string; status?: number } },
    reset: { error: null as null | { message: string; status?: number } },
    setSession: { error: null as null | { message: string } },
    calls: { signIn: [] as unknown[], reset: [] as Array<[string, { redirectTo: string }]>, setSession: [] as unknown[] },
    fetch: vi.fn(),
    // Session lue par le composant : nulle par défaut, comme sur la page.
    session: { user: null as null | { id: string }, loading: false },
    replace: vi.fn(),
  };
  const supabase = {
    auth: {
      signInWithPassword: (a: unknown) => { state.calls.signIn.push(a); return Promise.resolve(state.signIn); },
      resetPasswordForEmail: (e: string, o: { redirectTo: string }) => { state.calls.reset.push([e, o]); return Promise.resolve(state.reset); },
      setSession: (s: unknown) => { state.calls.setSession.push(s); return Promise.resolve(state.setSession); },
    },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase,
    user: h.state.session.user,
    loading: h.state.session.loading,
  }),
}));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: h.state.replace }) }));

import { LoginPage } from '@/components/auth/LoginPage';

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
  h.state.signIn = { error: null };
  h.state.reset = { error: null };
  h.state.setSession = { error: null };
  h.state.calls.signIn = [];
  h.state.calls.reset = [];
  h.state.calls.setSession = [];
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async () => json({ access_token: 'at', refresh_token: 'rt' }));
  h.state.session = { user: null, loading: false };
  h.state.replace.mockReset();
  vi.stubGlobal('fetch', h.state.fetch);
});

const soumettre = () => {
  const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement;
  fireEvent.submit(form);
};
const connexion = (email = 'a@b.c', mdp = 'secret1') => {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: mdp } });
  soumettre();
};

describe('LoginPage — connexion', () => {
  it('qualifie « identifiants refusés » seulement quand Supabase le dit', async () => {
    h.state.signIn = { error: { message: 'Invalid login credentials', status: 400 } };
    render(<LoginPage />);
    connexion();
    await waitFor(() => expect(screen.getByText('Email ou mot de passe incorrect.')).toBeInTheDocument());
  });

  it('panne réseau (status 0) : « connexion au service impossible »', async () => {
    h.state.signIn = { error: { message: 'Failed to fetch', status: 0 } };
    render(<LoginPage />);
    connexion();
    await waitFor(() => expect(screen.getByText(/Connexion au service impossible/)).toBeInTheDocument());
  });

  it('incident serveur (500) : message d’incident, pas « mot de passe incorrect »', async () => {
    h.state.signIn = { error: { message: 'Internal Server Error', status: 500 } };
    render(<LoginPage />);
    connexion();
    await waitFor(() => expect(screen.getByText(/rencontre un incident/)).toBeInTheDocument());
  });

  it('une session déjà ouverte renvoie vers l\'application', async () => {
    h.state.session = { user: { id: 'u1' }, loading: false };
    render(<LoginPage />);
    await waitFor(() => expect(h.state.replace).toHaveBeenCalledWith('/'));
  });

  it('pendant la restauration de la session, le formulaire reste affiché', () => {
    h.state.session = { user: null, loading: true };
    render(<LoginPage />);
    expect(h.state.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('bascule l’affichage du mot de passe', () => {
    render(<LoginPage />);
    const mdp = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    expect(mdp.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).type).toBe('text');
  });
});

describe('LoginPage — inscription', () => {
  const remplir = () => {
    fireEvent.change(screen.getByLabelText('Nom de votre boutique'), { target: { value: 'Ma Boutique' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon compte/ }));
  };

  it('succès : ouvre la session avec les jetons reçus', async () => {
    render(<LoginPage initialMode="register" />);
    remplir();

    await waitFor(() => expect(h.state.calls.setSession[0]).toEqual({ access_token: 'at', refresh_token: 'rt' }));
  });

  it('succès : quitte le formulaire pour l\'application', async () => {
    // C'était le bug : le compte était créé, la session ouverte, et la page
    // /register restait affichée. Le nouvel utilisateur ne voyait jamais
    // l'assistant de premier lancement.
    render(<LoginPage initialMode="register" />);
    remplir();

    await waitFor(() => expect(h.state.replace).toHaveBeenCalledWith('/'));
  });

  it('session impossible : reste sur le formulaire et explique', async () => {
    h.state.setSession = { error: { message: 'nope' } };
    render(<LoginPage initialMode="register" />);
    remplir();

    await waitFor(() =>
      expect(screen.getByText(/Compte créé, mais connexion impossible : nope/)).toBeInTheDocument(),
    );
    expect(h.state.replace).not.toHaveBeenCalled();
  });

  it('refus serveur : affiche l’erreur', async () => {
    h.state.fetch.mockImplementation(async () => json({ error: 'Email déjà utilisé' }, false, 400));
    render(<LoginPage initialMode="register" />);
    remplir();

    await waitFor(() => expect(screen.getByText('Email déjà utilisé')).toBeInTheDocument());
  });

  it('compte créé mais login auto échoué : bascule sur la connexion EN le disant', async () => {
    h.state.fetch.mockImplementation(async () => json({ error: 'Connectez-vous manuellement' }));
    render(<LoginPage initialMode="register" />);
    remplir();

    // Le message doit SURVIVRE à la bascule (il était effacé avant le correctif).
    await waitFor(() => expect(screen.getByText('Connectez-vous manuellement')).toBeInTheDocument());
    // On est bien repassé sur le formulaire de connexion.
    expect(screen.getByRole('button', { name: /Mot de passe oublié/ })).toBeInTheDocument();
  });

  it('compte créé sans jeton : bascule sur la connexion en expliquant', async () => {
    h.state.fetch.mockImplementation(async () => json({})); // ok mais pas de jetons
    render(<LoginPage initialMode="register" />);
    remplir();

    await waitFor(() => expect(screen.getByText(/session n'a pas pu être ouverte/)).toBeInTheDocument());
  });
});

describe('LoginPage — mot de passe oublié', () => {
  const versForgot = () => fireEvent.click(screen.getByRole('button', { name: /Mot de passe oublié/ }));

  it('envoie le lien et confirme', async () => {
    render(<LoginPage />);
    versForgot();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer le lien/ }));

    await waitFor(() => expect(screen.getByText(/Email envoyé !/)).toBeInTheDocument());
    expect(h.state.calls.reset[0][1]).toMatchObject({ redirectTo: expect.stringContaining('/reset-password') });
  });

  it('trop de demandes : message de patience', async () => {
    h.state.reset = { error: { message: 'email rate limit exceeded', status: 429 } };
    render(<LoginPage />);
    versForgot();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer le lien/ }));

    await waitFor(() => expect(screen.getByText(/Patientez une minute/)).toBeInTheDocument());
  });
});
