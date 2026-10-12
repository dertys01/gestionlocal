import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireEnv, sanitizeError } from '@/lib/utils/server';
import { createClient } from '@supabase/supabase-js';

type Plan = 'free' | 'starter' | 'pro';

function normalizePlan(raw: unknown): Plan {
  return raw === 'starter' || raw === 'pro' ? raw : 'free';
}

/**
 * Le plan réellement souscrit, lu sur le prix et non sur les metadata.
 *
 * Les metadata viennent du client Checkout : elles disent ce que la session
 * *demandait*, pas ce que Stripe a *vendu*. Le price_id, lui, ne ment pas —
 * c'est lui qui est facturé. On retombe sur les metadata quand les variables
 * STRIPE_PRICE_* ne sont pas renseignées, pour ne pas casser un déploiement
 * qui ne les a pas encore.
 */
function planFromPrice(priceId: string | undefined): Plan | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  return null;
}

/**
 * Depuis l'API Stripe 2026-03-25, `current_period_end` n'existe plus sur
 * l'objet `Subscription` : la période est portée par chaque `SubscriptionItem`.
 * Lire `sub.current_period_end` renvoie `undefined` et faisait planter
 * `toISOString()` — le client était débité mais restait sur le plan Free.
 */
function subscriptionPeriodEnd(sub: { items?: { data?: Array<{ current_period_end?: number }> } }): string | null {
  const ts = sub.items?.data?.[0]?.current_period_end;
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

// supabase-js ne LÈVE jamais : il renvoie { error } dans le résultat. Chaque
// écriture passait donc sous silence — c'est comme ça que subscriptions est
// restée vide malgré un upsert permanent, et que le portail abonnement
// répondait 404 sans qu'aucun log n'en parle.
//
// must() transforme chaque { error } en exception, que le catch ci-dessous
// stocke dans webhook_events et que la réponse 500 renvoie à Stripe.
type PgResult = { error: { message: string } | null };
async function must<T extends PgResult>(label: string, pending: PromiseLike<T>): Promise<T> {
  const res = await pending;
  if (res.error) throw new Error(`${label} : ${res.error.message}`);
  return res;
}

export async function POST(req: NextRequest) {
  const stripeKey = requireEnv('STRIPE_SECRET_KEY');
  const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  if (!stripeKey) return NextResponse.json({ error: 'STRIPE_SECRET_KEY manquant' }, { status: 500 });
  const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' });
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET ?? '');
  } catch {
    return NextResponse.json({ error: 'Webhook signature invalide' }, { status: 400 });
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Idempotence ──
  // Stripe renvoie le même événement jusqu'à ce qu'il reçoive un 2xx, et le
  // rejoue aussi après un 500. claim_webhook_event() atomise la prise en
  // charge : la lecture puis l'upsert n'étaient pas atomiques, deux
  // livraisons concurrentes du même event_id pouvaient toutes deux traiter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventData = event.data.object as any;
  const orgId = eventData.metadata?.org_id ?? null;
  const activeStatuses = ['active', 'trialing'];

  const { data: claimed, error: claimError } = await adminClient.rpc('claim_webhook_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_org_id: orgId,
  });

  if (claimError) {
    // Fonction pas encore déployée : on retombe sur l'ancien chemin non
    // atomique plutôt que de perdre l'événement (500 → Stripe rejoue).
    const { data: prior, error: priorError } = await adminClient
      .from('webhook_events')
      .select('status')
      .eq('event_id', event.id)
      .maybeSingle();
    if (priorError) return NextResponse.json({ error: 'journal inaccessible' }, { status: 500 });
    if (prior?.status === 'processed') return NextResponse.json({ received: true, duplicate: true });

    const { error: logError } = await adminClient.from('webhook_events').upsert({
      event_id: event.id,
      event_type: event.type,
      org_id: orgId,
      status: 'received',
    }, { onConflict: 'event_id', ignoreDuplicates: true });
    if (logError) return NextResponse.json({ error: 'journal inaccessible' }, { status: 500 });
  } else if (claimed !== true) {
    // Déjà traité, ou une autre instance est en train de le traiter.
    return NextResponse.json({ received: true, duplicate: true });
  }

  let processError: string | null = null;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (!orgId) break;
        const subId = eventData.subscription as string | null;
        // Session en mode `payment` ou incomplète : pas d'abonnement à activer.
        // stripe.subscriptions.retrieve(null) levait et faisait échouer la
        // livraison en boucle.
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(subId);

        const priceId = sub.items?.data?.[0]?.price?.id as string | undefined;
        const fromPrice = planFromPrice(priceId);
        // Retomber sur les metadata n'est licite qu'en dernier recours : elles
        // disent ce que la session demandait, pas ce qui a été vendu. On trace
        // pour voir quand ça arrive en prod (STRIPE_PRICE_* non configurées ?).
        if (!fromPrice && eventData.metadata?.plan) {
          console.warn('[Webhook] plan déduit des metadata (price_id inconnu)', priceId);
        }
        const plan = fromPrice ?? normalizePlan(eventData.metadata?.plan);

        await must('subscriptions', adminClient.from('subscriptions').upsert({
          org_id: orgId,
          stripe_customer_id: eventData.customer as string,
          stripe_subscription_id: subId,
          plan,
          status: sub.status,
          current_period_end: subscriptionPeriodEnd(sub),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'org_id' }));

        // Un paiement `incomplete` ne donne pas le plan : le client n'a pas
        // encore été débité. customer.subscription.updated l'activera au
        // moment où Stripe encaisse réellement. Donner le plan ici, c'est
        // offrir Pro à quelqu'un dont la carte a été refusée.
        const effectivePlan = activeStatuses.includes(sub.status) ? plan : 'free';
        await must('organizations', adminClient
          .from('organizations')
          .update({ plan: effectivePlan })
          .eq('id', orgId));
        break;
      }

      case 'customer.subscription.updated': {
        if (!orgId) break;
        const status = eventData.status as string;
        const priceId = eventData.items?.data?.[0]?.price?.id as string | undefined;
        const fromPrice2 = planFromPrice(priceId);
        if (!fromPrice2 && eventData.metadata?.plan) {
          console.warn('[Webhook] plan déduit des metadata (price_id inconnu)', priceId);
        }
        const plan = fromPrice2 ?? normalizePlan(eventData.metadata?.plan);

        await must('subscriptions', adminClient.from('subscriptions').upsert({
          org_id: orgId,
          stripe_customer_id: (eventData.customer as string) ?? null,
          stripe_subscription_id: eventData.id,
          plan,
          status,
          current_period_end: subscriptionPeriodEnd(eventData),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'org_id' }));

        const effectivePlan = activeStatuses.includes(status) ? plan : 'free';
        await must('organizations', adminClient
          .from('organizations')
          .update({ plan: effectivePlan })
          .eq('id', orgId));
        break;
      }

      case 'customer.subscription.deleted': {
        if (!orgId) break;
        await must('subscriptions', adminClient.from('subscriptions').update({
          plan: 'free', status: 'canceled', updated_at: new Date().toISOString(),
        }).eq('org_id', orgId));
        await must('organizations', adminClient
          .from('organizations')
          .update({ plan: 'free' })
          .eq('id', orgId));
        break;
      }
    }
  } catch (e) {
    // Stocké dans webhook_events, jamais renvoyé au client — mais la table est
    // lisible par la service role. On conserve le type d'erreur, pas la pile
    // complète : le message brut du client Supabase contient l'en-tête
    // Authorization.
    processError = e instanceof Error ? e.message : 'erreur inconnue';
    console.error('[Webhook] Erreur traitement', event.type, sanitizeError(e));
  }

  // Mettre à jour le statut du log. Un échec ici ne peut pas passer pour un
  // succès : sinon on répondrait 200 à un événement que la prochaine tentative
  // jugera « déjà traité ».
  const { error: logUpdateError } = await adminClient.from('webhook_events').update({
    status: processError ? 'error' : 'processed',
    error: processError,
  }).eq('event_id', event.id);
  if (logUpdateError && !processError) processError = logUpdateError.message;

  // 500 et non 200 : Stripe rejoue tant qu'il reçoit un échec. Répondre 200
  // ici signifierait qu'un paiement confirmé reste en plan Free pour toujours,
  // sans que personne ne le sache.
  if (processError) return NextResponse.json({ error: 'traitement échoué' }, { status: 500 });

  return NextResponse.json({ received: true });
}
