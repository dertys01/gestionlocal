import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readUser } from '@/lib/utils/user-client';
import { requireEnv, serverError } from '@/lib/utils/server';
import { estAdmin } from '@/lib/utils/admin';
import { calculerGrant, joursValides } from '@/lib/utils/plan-grant';

/**
 * /api/admin/plan — accorder un plan à une boutique (éditeur, bêta).
 *
 * Réservé à ADMIN_EMAILS. La clé service role écrit `organizations.plan` et
 * `plan_valid_until` : c'est la période prépayée, donc le plan s'éteint tout
 * seul à l'échéance (current_org_plan), sans cron ni nettoyage.
 */

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');

function adminClientOrNull(): SupabaseClient | null {
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cle) return null;
  return createClient(SUPABASE_URL, cle, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Table id → e-mail, pour afficher qui est derrière chaque boutique. */
async function emailsParId(admin: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    for (const u of data.users) if (u.email) map.set(u.id, u.email);
    if (data.users.length < 200) break;
  }
  return map;
}

export async function GET(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    if (!estAdmin(user.email)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });

    const admin = adminClientOrNull();
    if (!admin) return NextResponse.json({ error: 'Service indisponible' }, { status: 503 });

    const { data: orgs, error } = await admin
      .from('organizations')
      .select('id, name, plan, plan_valid_until, trial_ends_at, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const emails = await emailsParId(admin);
    return NextResponse.json({
      organizations: (orgs ?? []).map((o) => ({ ...o, email: emails.get(o.id) ?? null })),
    });
  } catch (e) {
    return NextResponse.json(serverError('admin/plan', e), { status: 500 });
  }
}

const Grant = z.object({
  orgId: z.string().uuid(),
  plan: z.enum(['free', 'starter', 'pro']),
  jours: z.number().int().nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    if (!estAdmin(user.email)) return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });

    const admin = adminClientOrNull();
    if (!admin) return NextResponse.json({ error: 'Service indisponible' }, { status: 503 });

    const parse = Grant.safeParse(await req.json().catch(() => null));
    if (!parse.success) return NextResponse.json({ error: 'Demande invalide' }, { status: 400 });
    const { orgId, plan, jours } = parse.data;

    if (plan !== 'free' && !joursValides(jours)) {
      return NextResponse.json({ error: 'Durée invalide (1 à 3650 jours)' }, { status: 400 });
    }

    const patch = calculerGrant(plan, plan === 'free' ? null : (jours as number));
    const { error } = await admin.from('organizations').update(patch).eq('id', orgId);
    if (error) throw error;

    return NextResponse.json({ ok: true, ...patch });
  } catch (e) {
    return NextResponse.json(serverError('admin/plan/post', e), { status: 500 });
  }
}
