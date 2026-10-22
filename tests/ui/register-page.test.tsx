import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * /register : le même composant que /connexion, démarré sur l'onglet
 * « Inscription ». On vérifie qu'on atterrit bien sur le formulaire d'inscription
 * (nom de boutique), pas sur celui de connexion.
 */
vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: { auth: {} }, user: null, loading: false }),
}));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import RegisterPage from '@/app/register/page';

describe('/register', () => {
  it('ouvre directement le formulaire d’inscription', () => {
    render(<RegisterPage />);
    expect(screen.getByText('Créez votre boutique')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom de votre boutique')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Créer mon compte/ })).toBeInTheDocument();
    // Pas de champ « Mot de passe oublié » : ce n'est pas l'écran de connexion.
    expect(screen.queryByRole('button', { name: /Mot de passe oublié/ })).toBeNull();
  });
});
