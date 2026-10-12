/**
 * Client Supabase agissant AU NOM de l'appelant.
 *
 * Raison d'être
 * -------------
 * Les routes API interrogeaient la base avec la clé `service_role`, qui
 * contourne TOUTES les règles de sécurité. Pour l'équipe et les invitations,
 * ce n'était pas nécessaire : les policies RLS accordent déjà au patron ce
 * dont ses écrans ont besoin, et la clé service rouvrait précisément ce que
 * `migration_security.sql` avait refermé.
 *
 * Cette clé reste nécessaire à `/api/register` — créer un compte Auth, et
 * partager le limiteur d'inscriptions entre les instances serverless. Elle
 * n'a donc pas disparu du projet ; elle a disparu d'ici.
 *
 * Fonctionnement
 * --------------
 * La clé anonyme sert d'`apikey`, et le jeton du client part dans
 * l'en-tête `Authorization`. PostgREST évalue alors les policies RLS avec
 * l'identité de ce client : une requête faite pour un autre boutique renvoie
 * zéro ligne au lieu d'en renvoyer les données.
 *
 * Ce n'est pas seulement plus sûr, c'est plus simple : les routes n'ont plus
 * à reconstituer les conditions qu'une policy sait déjà exprimer, et une
 * divergence entre les deux est impossible par construction.
 */

import { NextRequest } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './server';

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const ANON_KEY = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

/**
 * Le jeton de l'appelant, ou null.
 *
 * Une route doit TOUJOURS passer par ici plutôt que par `get_business_owner_id()`
 * seul pour décider qui est autorisé : une fonction dit à QUI appartient la
 * donnée, pas si l'appelant a le droit de la voir.
 */
export function bearerOf(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const jwt = header.slice('Bearer '.length).trim();
  return jwt.length ? jwt : null;
}

/** Client agissant comme l'appelant. À n'utiliser qu'avec un jeton présent. */
export function clientFor(req: NextRequest): SupabaseClient {
  const jwt = bearerOf(req);
  if (!jwt) throw new Error('clientFor() sans jeton : appelant readUser() d\'abord.');
  return createClient(SUPABASE_URL, ANON_KEY, {
    // Ni session ni rafraîchissement : la requête est faite une fois, au nom
    // de quelqu'un dont le jeton a déjà été validé.
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/**
 * Identité de l'appelant, vérifiée auprès du serveur d'authentification.
 *
 * `getUser(jwt)` pose une question au serveur d'authentification, il ne se
 * contente pas de décoder le jeton : un jeton forgé, révoqué ou expiré est
 * réellement refusé. Le décodage seul ne le serait pas.
 */
export async function readUser(req: NextRequest): Promise<{ id: string; email: string | null } | null> {
  const jwt = bearerOf(req);
  if (!jwt) return null;
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * Vérifie que l'appelant EST un patron, et renvoie (identité, client).
 *
 * Un·e employé·e ne gère ni l'équipe ni la facturation :
 * `get_business_owner_id()` renverrait l'id du patron pour l'employé aussi,
 * la comparaison doit donc porter sur l'identité du patron lui-même.
 * Identiques si et seulement si l'appelant est un patron. La fonction voit le
 * tenant réel même sous RLS, là où une lecture directe de `business_members`
 * ne verrait rien et laisserait passer tout le monde.
 *
 * `message` : ce que la route répond à un employé — chaque action parle de
 * son propre geste (inviter, souscrire…).
 */
export async function requirePatron(
  req: NextRequest,
  message = 'Seul le patron peut effectuer cette action',
): Promise<{ error: string; status: number } | { user: { id: string }; db: SupabaseClient }> {
  const user = await readUser(req);
  if (!user) return { error: 'Non authentifié', status: 401 };

  const db = clientFor(req);
  const { data: patron, error: errPatron } = await db.rpc('get_business_owner_id');
  if (errPatron) throw errPatron;

  if (patron !== user.id) return { error: message, status: 403 };

  return { user, db };
}