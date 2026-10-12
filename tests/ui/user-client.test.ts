import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Rôle de l'appelant côté serveur.
 *
 * La règle qui compte : « patron » se prouve en comparant l'identité de
 * l'appelant à get_business_owner_id() — l'employé reçoit sinon l'id du patron
 * et passerait pour lui. Aucun jeton → 401 ; mauvais patron → 403.
 */

const h = vi.hoisted(() => {
  const state = {
    getUser: { data: { user: { id: 'u1', email: 'a@b.c' } as { id: string; email: string | null } | null }, error: null as null | { message: string } },
    rpc: { data: 'u1' as unknown, error: null as null | { message: string } },
    calls: 0,
  };
  const client = {
    auth: { getUser: async () => state.getUser },
    rpc: async () => state.rpc,
  };
  const createClient = vi.fn(() => { state.calls += 1; return client; });
  return { state, client, createClient };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.createClient() }));

import { bearerOf, clientFor, readUser, requirePatron } from '@/lib/utils/user-client';

const req = (headers: Record<string, string> = {}) =>
  new NextRequest(new URL('http://localhost/api/x'), { headers });

beforeEach(() => {
  h.state.getUser = { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null };
  h.state.rpc = { data: 'u1', error: null };
  h.state.calls = 0;
});

describe('bearerOf', () => {
  it('extrait le jeton, sinon null', () => {
    expect(bearerOf(req({ authorization: 'Bearer jeton-123' }))).toBe('jeton-123');
    expect(bearerOf(req())).toBeNull();
    expect(bearerOf(req({ authorization: 'Basic x' }))).toBeNull();
    expect(bearerOf(req({ authorization: 'Bearer    ' }))).toBeNull();
  });
});

describe('clientFor', () => {
  it('refuse sans jeton (lecture de l’identité d’abord)', () => {
    expect(() => clientFor(req())).toThrow(/sans jeton/);
  });
});

describe('readUser', () => {
  it('sans jeton : null, sans appeler le serveur d’auth', async () => {
    expect(await readUser(req())).toBeNull();
    expect(h.state.calls).toBe(0);
  });

  it('jeton valide : renvoie l’identité (id + e-mail)', async () => {
    expect(await readUser(req({ authorization: 'Bearer ok' }))).toEqual({ id: 'u1', email: 'a@b.c' });
  });

  it('jeton refusé : null', async () => {
    h.state.getUser = { data: { user: null }, error: { message: 'invalid JWT' } };
    expect(await readUser(req({ authorization: 'Bearer faux' }))).toBeNull();
  });
});

describe('requirePatron', () => {
  it('sans session : 401', async () => {
    expect(await requirePatron(req(), 'Interdit')).toEqual({ error: 'Non authentifié', status: 401 });
  });

  it('appelant ≠ patron : 403 avec le message de l’action', async () => {
    h.state.rpc = { data: 'autre-patron', error: null };
    expect(await requirePatron(req({ authorization: 'Bearer ok' }), 'Seul le patron peut inviter')).toEqual({
      error: 'Seul le patron peut inviter', status: 403,
    });
  });

  it('patron : renvoie l’identité et un client', async () => {
    const res = await requirePatron(req({ authorization: 'Bearer ok' }));
    expect('user' in res && res.user.id).toBe('u1');
    expect('db' in res).toBe(true);
  });
});
