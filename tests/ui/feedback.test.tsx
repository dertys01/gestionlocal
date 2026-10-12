import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Widget de retour (bêta).
 *
 * Ce qui compte : le message part avec son TYPE et sa PAGE (capturés, pas
 * dictés), l'envoi est bloqué tant qu'il n'y a rien à dire, et le succès est
 * confirmé à l'utilisateur.
 */

const { supabase } = vi.hoisted(() => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'jwt-test' } } }),
    },
  },
}));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase }),
}));

import { FeedbackWidget } from '@/components/beta/FeedbackWidget';
import { estAdmin } from '@/lib/utils/admin';

beforeEach(() => {
  vi.clearAllMocks();
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-test' } } });
});

describe('estAdmin', () => {
  it('reconnaît une adresse de la liste, insensible à la casse et aux espaces', () => {
    const env = { ADMIN_EMAILS: ' a@b.c , D@E.F ' };
    expect(estAdmin('a@b.c', env)).toBe(true);
    expect(estAdmin('D@e.f', env)).toBe(true);
    expect(estAdmin('x@y.z', env)).toBe(false);
    expect(estAdmin(null, env)).toBe(false);
  });

  it('sans liste configurée, personne n’est éditeur', () => {
    expect(estAdmin('a@b.c', {})).toBe(false);
  });
});

describe('FeedbackWidget', () => {
  it('envoie le retour avec son type et sa page, puis remercie', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FeedbackWidget open onOpenChange={vi.fn()} page="pos" />);

      // Rien à dire → envoi bloqué.
      expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: /Une idée/ }));
      fireEvent.change(screen.getByLabelText('Votre message'), {
        target: { value: 'Un bouton pour imprimer direct depuis la caisse.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/feedback',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      const corps = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(corps).toMatchObject({ kind: 'idea', page: 'pos', message: 'Un bouton pour imprimer direct depuis la caisse.' });

      await waitFor(() => expect(screen.getByText(/bien reçu/)).toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('affiche l’erreur du serveur sans perdre le message', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Envoi impossible pour le moment.' }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FeedbackWidget open onOpenChange={vi.fn()} page="floor" />);
      fireEvent.change(screen.getByLabelText('Votre message'), { target: { value: 'Ça bloque ici.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));

      await waitFor(() => expect(screen.getByText(/Envoi impossible/)).toBeInTheDocument());
      // Le message saisi reste là : l'utilisateur peut réessayer.
      expect(screen.getByLabelText('Votre message')).toHaveValue('Ça bloque ici.');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
