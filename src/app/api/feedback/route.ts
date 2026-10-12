import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readUser, clientFor } from '@/lib/utils/user-client';
import { serverError } from '@/lib/utils/server';

/**
 * POST /api/feedback — enregistrer un retour (bug, idée, question).
 *
 * La boutique est résolue côté serveur (get_business_owner_id) : le client ne
 * choisit ni son propriétaire ni son e-mail. Le contexte technique (navigateur)
 * est complété ici, jamais dicté par le navigateur.
 */

const Corps = z.object({
  kind: z.enum(['bug', 'idea', 'question', 'other']).default('other'),
  message: z.string().trim().min(3).max(4000),
  page: z.string().trim().max(60).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const parse = Corps.safeParse(await req.json().catch(() => null));
    if (!parse.success) {
      return NextResponse.json({ error: 'Décrivez votre retour en quelques mots.' }, { status: 400 });
    }
    const { kind, message, page, context } = parse.data;

    const db = clientFor(req);
    const { data: ownerId, error: errOwner } = await db.rpc('get_business_owner_id');
    if (errOwner) throw errOwner;
    if (!ownerId) return NextResponse.json({ error: 'Boutique introuvable' }, { status: 403 });

    const { error } = await db.from('feedback').insert({
      owner_id: ownerId,
      author_id: user.id,
      author_email: user.email,
      kind,
      message,
      page: page ?? null,
      context: { ...(context ?? {}), userAgent: req.headers.get('user-agent') ?? null },
    });
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(serverError('feedback', e), { status: 500 });
  }
}
