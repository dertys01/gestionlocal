import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readUser } from '@/lib/utils/user-client';
import { requireEnv, serverError } from '@/lib/utils/server';
import { estAdmin } from '@/lib/utils/admin';

/**
 * /api/admin/feedback — la boîte de réception de l'éditeur.
 *
 * Les retours de TOUTES les boutiques, réservée aux adresses listées dans
 * ADMIN_EMAILS (côté serveur). La clé service role lit au-delà des RLS ; le
 * contrôle d'accès est donc ici, et nulle part ailleurs.
 */

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');

function adminClientOrNull() {
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cle) return null;
  return createClient(SUPABASE_URL, cle, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    if (!estAdmin(user.email)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });

    const admin = adminClientOrNull();
    if (!admin) return NextResponse.json({ error: 'Service indisponible' }, { status: 503 });

    const { data, error } = await admin
      .from('feedback')
      .select('id, owner_id, author_email, kind, message, page, context, status, created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    const rows = data ?? [];
    const ids = [...new Set(rows.map((r) => r.owner_id))];
    const noms = new Map<string, string>();
    if (ids.length > 0) {
      const { data: orgs } = await admin.from('organizations').select('id, name').in('id', ids);
      for (const o of orgs ?? []) noms.set(o.id, o.name);
    }

    return NextResponse.json({
      feedback: rows.map((r) => ({ ...r, org_name: noms.get(r.owner_id) ?? null })),
    });
  } catch (e) {
    return NextResponse.json(serverError('admin/feedback', e), { status: 500 });
  }
}

const Patch = z.object({ id: z.string().uuid(), status: z.enum(['new', 'seen', 'done']) });

export async function PATCH(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    if (!estAdmin(user.email)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });

    const admin = adminClientOrNull();
    if (!admin) return NextResponse.json({ error: 'Service indisponible' }, { status: 503 });

    const parse = Patch.safeParse(await req.json().catch(() => null));
    if (!parse.success) return NextResponse.json({ error: 'Demande invalide' }, { status: 400 });

    const { error } = await admin
      .from('feedback')
      .update({ status: parse.data.status })
      .eq('id', parse.data.id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(serverError('admin/feedback/patch', e), { status: 500 });
  }
}
