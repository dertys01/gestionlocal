import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireEnv, sanitizeError } from '@/lib/utils/server';
import { z } from 'zod';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  businessName: z.string().min(1),
});

// Validées AVANT tout appel réseau : createClient(URL, undefined) produisait
// une erreur d'en-tête invalide dont le message affichait la clé utilisée.
//
// SUPABASE_URL et ANON_KEY restent des constantes de module : elles sont
// présentes sur tous les environnements. La clé service role, elle, est lue
// DANS le handler : c'est la seule chose ici qui ne soit pas disponible en
// local, et exiger sa présence au chargement du module faisait échouer le
// `next build` et le serveur de développement — donc TOUTE l'application —
// pour une variable dont l'absence n'affecte que la création de compte.
// Une inscription tentée sans la variable doit répondre « inscription
// indisponible », pas empêcher l'application de démarrer.
const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const ANON_KEY = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

/**
 * Client admin, ou null si la clé service role n'est pas configurée.
 *
 * La présence de la clé est vérifiée ici plutôt qu'en amont pour que
 * `requireEnv` ne jette pas au chargement du module : voir ci-dessus.
 */
function adminClientOrNull() {
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cle) return null;
  return createClient(SUPABASE_URL, cle, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const MAX_ATTEMPTS_PER_HOUR = 3;

/**
 * Rate limiting par IP : max 3 inscriptions par heure.
 *
 * Le comptage passe par la service role pour être partagé entre toutes les
 * instances serverless. Un limiteur en mémoire (Map) serait recréé vide à
 * chaque invocation et ne limiterait rien en production.
 *
 * Appelé APRÈS la validation du corps (voir POST) : seules les tentatives
 * assez bien formées pour atteindre GoTrue sont comptées. Une faute de
 * frappe ne coûte donc plus une heure — mais le comptage reste placé avant
 * createUser(), sinon sonder des adresses une à une serait gratuit.
 *
 * Si la fonction SQL est absente (migration pas encore appliquée), on laisse
 * passer plutôt que de rendre l'inscription indisponible.
 */
// Le client Supabase n'est typé sur aucun schéma : les signatures de RPC ne
// sont pas connues tant que les types ne sont pas générés.
interface RpcCapable {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

async function isRateLimited(client: unknown, ip: string): Promise<boolean> {
  const db = client as RpcCapable;

  try {
    const { data, error } = await db.rpc('bump_rate_limit', {
      p_key: `register:${ip}`,
      p_max: MAX_ATTEMPTS_PER_HOUR,
      p_window_seconds: 3600,
    });

    if (error) {
      console.error('[register] rate limit indisponible', error.message);
      return false;
    }

    return data === true;
  } catch (e) {
    console.error('[register] rate limit indisponible', e);
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    const adminClient = adminClientOrNull();
    if (!adminClient) {
      // 503 : ce n'est pas une erreur du visiteur, et un 500 ferait croire à un
      // problème de son côté. Le message est volontairement sans détail.
      return NextResponse.json(
        { error: 'Inscription temporairement indisponible. Réessayez plus tard.' },
        { status: 503 }
      );
    }

    // Validation AVANT le compteur : une faute de frappe, un champ oublié ou
    // un e-mail déjà utilisé ne doit pas griller une heure d'essai au patron.
    // Le volume brut, lui, reste borné par le proxy — 10 écritures/min par
    // couple (IP, chemin), valides ou non — donc une boucle de requêtes
    // invalides ne devient pas gratuite pour autant.
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      // Corps illisible : 400 SANS compter. C'est exactement le cas que le
      // compteur ne doit plus griller — un client sur réseau capricieux qui
      // renvoie un JSON tronqué paierait une heure entière pour rien.
      return NextResponse.json({ error: 'Requête invalide.' }, { status: 400 });
    }
    const parsed = RegisterBody.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Tous les champs sont requis et valides.' }, { status: 400 });
    }
    const { password, businessName } = parsed.data;
    // Sans normalisation, `Register@Exemple.com ` et `register@exemple.com`
    // créent deux comptes pour la même personne — ou une session introuvable.
    const email = parsed.data.email.trim().toLowerCase();
    if (password.length < 6) {
      return NextResponse.json({ error: 'Mot de passe : 6 caractères minimum.' }, { status: 400 });
    }
    if (businessName.trim().length < 2) {
      return NextResponse.json({ error: 'Nom de boutique trop court.' }, { status: 400 });
    }

    if (await isRateLimited(adminClient, ip)) {
      return NextResponse.json(
        { error: 'Trop de tentatives. Réessayez dans une heure.' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }

    // Créer le compte sans confirmation email
    const { data: newUser, error: signUpError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (signUpError) {
      const msg = signUpError.message.includes('already registered')
        ? 'Cet email est déjà utilisé.'
        : signUpError.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const userId = newUser.user.id;
    const slug = businessName.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 6);

    const { error: orgError } = await adminClient.from('organizations').insert({
      id: userId,
      name: businessName.trim(),
      slug,
      plan: 'free',
      onboarding_done: false,
    });

    if (orgError) {
      // Rollback : supprimer le user si l'org échoue
      await adminClient.auth.admin.deleteUser(userId);
      // Message technique dans les logs serveur uniquement : le message brut
      // d'un client Supabase peut contenir des détails de schéma, voire
      // l'en-tête Authorization (cf. SECURITY.md). On ne renvoie qu'un texte
      // générique, jamais `orgError.message`.
      console.error('[register] création boutique', sanitizeError(orgError));
      return NextResponse.json(
        { error: 'Erreur interne du serveur. Réessayez dans un moment.' },
        { status: 500 }
      );
    }

    // Connecter l'utilisateur via le client anon (retourne une session)
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data: session, error: loginError } = await anonClient.auth.signInWithPassword({ email, password });
    if (loginError || !session.session) {
      // Le compte est créé, mais la session ne s'ouvre pas. Sans ce journal, la
      // cause exacte (identifiants refusés, quota GoTrue, délai de propagation)
      // était perdue : la route répondait « veuillez vous connecter » et rien
      // n'expliquait pourquoi. On garde le code et le statut, jamais le jeton.
      console.error('[register] connexion automatique impossible', {
        status: loginError?.status,
        code: loginError?.code,
        message: loginError ? sanitizeError(loginError) : 'session absente',
      });
      return NextResponse.json({ error: 'Compte créé, veuillez vous connecter.' }, { status: 200 });
    }

    return NextResponse.json({
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
    });
  } catch (e) {
    // `String(e)` renvoyait l'erreur brute du client Supabase, qui inclut
    // l'en-tête Authorization — donc la clé service role exposée à l'écran
    // (visible sur la capture « Headers.append: "Bearer eyJ…" is an invalid
    // header value »). On ne renvoie plus que le type d'erreur.
    console.error('[register] échec inattendu', sanitizeError(e));
    return NextResponse.json(
      { error: 'Erreur interne du serveur. Réessayez dans un moment.' },
      { status: 500 }
    );
  }
}
