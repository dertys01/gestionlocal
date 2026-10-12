'use client';

import { useState } from 'react';
import { Save, Loader2, CreditCard, Zap, CheckCircle, ExternalLink, Building2, Globe, Smartphone, CalendarClock, X, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import {
  PLAN_LABELS, PLAN_LIMITS, essaiActif, lignesQuotas, montantPeriode,
  prixMensuelLabel, prixAAnnuelLabel, type DureePeriode, type PlanPayant,
} from '@/lib/utils/plans';
import { formatCFA } from '@/lib/utils/currency';
import { normalizeDomain, normalizeUiMode, DOMAIN_LABELS, DOMAIN_DESCRIPTIONS, type Domain, type UiMode } from '@/lib/modules';
import { ifuValide } from '@/lib/mecef/gate';
import { useLiaisonMecef } from '@/lib/hooks/useLiaisonMecef';
import { construireSauvegarde, telechargerSauvegarde } from '@/lib/utils/sauvegarde';
import type { Plan } from '@/types';

/**
 * Présentation des plans de l'onglet Facturation.
 *
 * Les quantités affichées (plafond de produits, postes, fenêtre
 * d'historique) viennent des quotas de configuration — écrire ici un chiffre
 * reviendrait à publier la stratégie tarifaire dans le dépôt public. Les
 * lignes sans quantité sont de la copie commerciale, pas des valeurs : elles
 * restent ici.
 */
const PLANS: { id: Plan; features: string[] }[] = [
  {
    id: 'free',
    features: [...lignesQuotas('free'), 'Caisse + scanner'],
  },
  {
    id: 'starter',
    features: [...lignesQuotas('starter'), 'Export CSV', 'Rapports avancés'],
  },
  {
    id: 'pro',
    features: [...lignesQuotas('pro'), 'Prévisions', 'Support prioritaire'],
  },
];

export function SettingsModule() {
  const { supabase, org, plan, refreshOrg, user, isEmployee } = useSupabase();
  const [tab, setTab] = useState<'org' | 'billing'>('org');
  /** Verrou de délivrance des factures : IFU + connexion e-MECeF. */
  const connexionMecef = useLiaisonMecef();

  // Sauvegarde complète des données (propriétaire uniquement).
  const [sauvegardeEnCours, setSauvegardeEnCours] = useState(false);
  const [sauvegardeErreur, setSauvegardeErreur] = useState('');
  const sauvegarder = async () => {
    setSauvegardeEnCours(true);
    setSauvegardeErreur('');
    try {
      telechargerSauvegarde(await construireSauvegarde(supabase));
    } catch (e) {
      setSauvegardeErreur(e instanceof Error ? e.message : 'Sauvegarde impossible.');
    } finally {
      setSauvegardeEnCours(false);
    }
  };

  // Org form
  const [orgName, setOrgName] = useState(org?.name ?? '');
  const [orgAddress, setOrgAddress] = useState(org?.address ?? '');
  const [orgIfu, setOrgIfu] = useState(org?.ifu ?? '');
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgSuccess, setOrgSuccess] = useState('');
  const [orgError, setOrgError] = useState('');

  // Billing
  const [loadingCheckout, setLoadingCheckout] = useState<Plan | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [billingError, setBillingError] = useState('');
  const [loadingTrial, setLoadingTrial] = useState(false);
  // Mobile Money : durée choisie pour la période prépayée, et le plan en
  // cours d'ouverture de page de paiement.
  const [periode, setPeriode] = useState<DureePeriode>(1);
  const [loadingMobile, setLoadingMobile] = useState<PlanPayant | null>(null);

  // Le plan BRUT (org.plan) dit ce qui est payé ; c'est lui qui décide de
  // l'éligibilité à l'essai — pendant l'essai, `plan` (effectif) vaut déjà
  // 'starter' et ne dirait plus jamais « éligible ».
  const planBrut = org?.plan ?? 'free';
  const enEssai = essaiActif(planBrut, org?.trial_ends_at);

  const demarrerEssai = async () => {
    setBillingError('');
    setLoadingTrial(true);
    // La base décide (patron seulement, plan gratuit seulement, une fois
    // pour toujours) : l'écran n'anticipe rien, il se contente de relire
    // la boutique après le RPC — c'est refreshOrg qui basculera le plan
    // effectif en starter.
    const { error } = await supabase.rpc('start_free_trial');
    setLoadingTrial(false);
    if (error) { setBillingError(error.message); return; }
    await refreshOrg();
  };

  // Domaine d'activité : la bascule commerce ⇄ restauration. Aucun risque —
  // elle ne touche ni aux données, ni aux quotas, ni aux RLS : elle change la
  // liste des modules affichés (src/lib/modules.ts).
  const [domain, setDomain] = useState<Domain>(() => normalizeDomain(org?.domain));
  const [savingDomain, setSavingDomain] = useState<Domain | null>(null);
  const [domainError, setDomainError] = useState('');

  const changeDomain = async (d: Domain) => {
    if (d === normalizeDomain(org?.domain)) return;
    setSavingDomain(d);
    setDomainError('');
    const { error } = await supabase
      .from('organizations')
      .update({ domain: d } as Record<string, unknown>)
      .eq('id', org?.id);
    setSavingDomain(null);
    if (error) { setDomainError(error.message); return; }
    setDomain(d);
    await refreshOrg();
  };

  // Mode d'affichage : simple (l'essentiel) ou complet. Réversible, comme le
  // domaine, et pour la même raison : il ne touche à aucune donnée.
  const uiMode = normalizeUiMode(org?.ui_mode);
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState('');

  const changeMode = async (m: UiMode) => {
    if (m === uiMode) return;
    setSavingMode(true);
    setModeError('');
    const { error } = await supabase
      .from('organizations')
      .update({ ui_mode: m } as Record<string, unknown>)
      .eq('id', org?.id);
    setSavingMode(false);
    if (error) { setModeError(error.message); return; }
    await refreshOrg();
  };

  const saveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;
    // L'IFU est la clé de la facturation normalisée : une valeur fausse
    // n'est pas un détail de formulaire, elle produirait des factures mal
    // identifiées. On refuse d'enregistrer tant qu'elle n'est pas bonne,
    // et le message renvoie au champ concerné.
    const ifu = orgIfu.trim();
    if (ifu && !ifuValide(ifu)) {
      setOrgSuccess('');
      setOrgError("L'IFU comporte 13 caractères (chiffres ou lettres). Corrigez-le ou laissez le champ vide.");
      return;
    }
    setSavingOrg(true);
    setOrgSuccess('');
    setOrgError('');

    const { error } = await supabase
      .from('organizations')
      .update({
        name: orgName.trim(),
        address: orgAddress.trim() || null,
        ifu: ifu || null,
      } as Record<string, unknown>)
      .eq('id', org?.id);

    if (error) {
      setOrgError(error.message);
    } else {
      setOrgSuccess('Modifications enregistrées');
      await refreshOrg();
    }
    setSavingOrg(false);
  };

  const startCheckout = async (targetPlan: Plan) => {
    if (targetPlan === 'free') return;
    setBillingError('');
    setLoadingCheckout(targetPlan);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ plan: targetPlan }),
      });

      // res.json() non gardé : une réponse non JSON (502, page d'erreur Vercel)
      // faisait une exception et laissait le bouton bloqué en chargement.
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setBillingError(json?.error ?? `Erreur serveur (${res.status})`);
        return;
      }
      if (json?.url) window.location.href = json.url;
      else setBillingError('Aucun lien de paiement reçu.');
    } catch (e) {
      setBillingError((e as Error).message);
    } finally {
      setLoadingCheckout(null);
    }
  };

  const openPortal = async () => {
    setBillingError('');
    setLoadingPortal(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session?.access_token}` },
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setBillingError(json?.error ?? `Erreur serveur (${res.status})`);
        return;
      }
      if (json?.url) window.location.href = json.url;
      else setBillingError('Aucun lien de portail reçu.');
    } catch (e) {
      setBillingError((e as Error).message);
    } finally {
      setLoadingPortal(false);
    }
  };

  // Mobile Money : la route recalcule le montant depuis la configuration —
  // l'écran n'envoie que { plan, mois }. Si la route refuse (prestataire non
  // branché, prix absent), l'erreur rejoint le bandeau d'en haut de l'onglet.
  const payerMobileMoney = async (cible: PlanPayant) => {
    setBillingError('');
    setLoadingMobile(cible);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/payments/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ plan: cible, mois: periode }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setBillingError(json?.error ?? `Erreur serveur (${res.status})`);
        return;
      }
      if (json?.redirectUrl) window.location.href = json.redirectUrl;
      else setBillingError('Aucune page de paiement reçue.');
    } catch (e) {
      setBillingError((e as Error).message);
    } finally {
      setLoadingMobile(null);
    }
  };

  const limits = PLAN_LIMITS[plan];

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2" role="tablist" aria-label="Sections des paramètres">
        {(['org', 'billing'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            role="tab"
            aria-selected={tab === t}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}>
            {t === 'org' ? <><Building2 className="h-4 w-4" /> Boutique</> : <><CreditCard className="h-4 w-4" /> Abonnement</>}
          </button>
        ))}
      </div>

      {/* ── ORG TAB ── */}
      {tab === 'org' && (
        <div className="space-y-4">
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 text-sm">Informations de la boutique</h3>

              <form onSubmit={saveOrg} className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="org-name" className="text-sm font-medium text-slate-700">Nom de la boutique</label>
                  <Input id="org-name" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Nom affiché" />
                </div>
                <div className="space-y-1">
                  <label htmlFor="org-address" className="text-sm font-medium text-slate-700">Adresse</label>
                  <Input id="org-address" value={orgAddress} onChange={(e) => setOrgAddress(e.target.value)} placeholder="Ex: Cotonou, Bénin" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-baseline gap-1">
                    <label htmlFor="org-ifu" className="text-sm font-medium text-slate-700">IFU</label>
                    <span id="org-ifu-hint" className="text-xs text-slate-500 font-normal">(13 caractères, requis pour délivrer une facture, Plan Pro)</span>
                  </div>
                  <Input
                    id="org-ifu"
                    aria-describedby="org-ifu-hint"
                    value={orgIfu}
                    onChange={(e) => setOrgIfu(e.target.value)}
                    placeholder="Ex: 1234567890123"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-700">Email du compte</p>
                  {/* Un paragraphe, pas un champ désactivé : l'adresse ne se
                      saisit pas ici, et un input fait défiler son texte
                      horizontalement — sur un téléphone à 320 px, la fin de
                      l'adresse disparaissait sans qu'on puisse la faire défiler
                      (disabled). Le texte, lui, passe à la ligne. */}
                  <p className="rounded-lg border border-input bg-slate-50 px-2.5 py-1 text-sm text-slate-500 break-all min-h-8 flex items-center">
                    {user?.email ?? '-'}
                  </p>
                </div>
                {orgError && <p className="text-red-600 text-sm">{orgError}</p>}
                {orgSuccess && <p className="text-emerald-700 text-sm">{orgSuccess}</p>}
                <Button type="submit" disabled={savingOrg} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                  {savingOrg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Enregistrer
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Facture normalisée (e-MECeF) — l'état du verrou, dit clairement.
              Deux conditions, deux lignes : l'IFU (à la commerçant·e) et la
              connexion DGI (à nous). Tant qu'elles ne sont pas réunies, la
              caisse n'offre que le reçu simple, et cet écran dit pourquoi. */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-3">
              <h3 className="font-semibold text-slate-800 text-sm">Facture normalisée (e-MECeF)</h3>
              <p className="text-xs text-slate-500">
                Pour délivrer une facture au lieu d&apos;un reçu simple, deux
                conditions doivent être réunies. Le reçu, lui, reste toujours
                disponible.
              </p>
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  {ifuValide(org?.ifu)
                    ? <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    : <X className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />}
                  <span className={ifuValide(org?.ifu) ? 'text-slate-700' : 'text-slate-500'}>
                    {ifuValide(org?.ifu)
                      ? 'IFU enregistré.'
                      : "IFU non enregistré : renseignez-le dans le formulaire ci-dessus."}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  {connexionMecef
                    ? <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    : <X className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />}
                  <span className={connexionMecef ? 'text-slate-700' : 'text-slate-500'}>
                    {connexionMecef
                      ? 'Connexion au service de facturation ouverte.'
                      : 'Connexion au service de facturation : ouverture en cours de notre côté, la délivrance des factures sera activée dès qu’elle sera prête.'}
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Domaine d'activité */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Domaine d&apos;activité</h3>
                <Badge className="bg-indigo-100 text-indigo-700">{DOMAIN_LABELS[domain]}</Badge>
              </div>
              <p className="text-xs text-slate-500">
                Détermine les écrans affichés. Vos produits, ventes, dettes et
                rapports ne changent pas, et vous pouvez revenir en arrière
                quand vous voulez.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['retail', 'restaurant'] as const).map((d) => {
                  const actif = domain === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => changeDomain(d)}
                      disabled={savingDomain !== null}
                      aria-pressed={actif}
                      className={`text-left rounded-lg border-2 p-3 transition-colors disabled:opacity-60 ${
                        actif ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-800">{DOMAIN_LABELS[d]}</span>
                      <span className="block text-xs text-slate-500 mt-0.5">{DOMAIN_DESCRIPTIONS[d]}</span>
                    </button>
                  );
                })}
              </div>
              {savingDomain && (
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Changement en cours…
                </p>
              )}
              {domainError && <p className="text-red-600 text-sm">{domainError}</p>}
            </CardContent>
          </Card>

          {/* Mode d'affichage — discret, sous le domaine : la plupart des
              boutiques n'en auront jamais besoin. */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-800 text-sm">Affichage</h3>
                <Badge className="bg-slate-100 text-slate-700">
                  {uiMode === 'beginner' ? 'Mode simple' : 'Mode complet'}
                </Badge>
              </div>
              <p className="text-xs text-slate-500">
                {uiMode === 'beginner'
                  ? 'Seul l’essentiel est affiché : caisse, produits, dettes et ventes. Le mode complet ajoute les rapports, les dépenses, la rentabilité et l’équipe.'
                  : 'Tous les écrans sont affichés. Le mode simple ne garde que la caisse, les produits, les dettes et les ventes.'}
                {' '}Vos données ne changent pas.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => changeMode(uiMode === 'beginner' ? 'full' : 'beginner')}
                disabled={savingMode}
                className="gap-2"
              >
                {savingMode && <Loader2 className="h-4 w-4 animate-spin" />}
                {uiMode === 'beginner' ? 'Passer en mode complet' : 'Revenir au mode simple'}
              </Button>
              {modeError && <p className="text-red-600 text-sm">{modeError}</p>}
            </CardContent>
          </Card>

          {/* Limites actuelles */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Plan actuel</h3>
                <Badge className={`${plan === 'free' ? 'bg-slate-100 text-slate-600' : plan === 'starter' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>
                  {PLAN_LABELS[plan]}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Produits', value: limits.products === Infinity ? 'Illimité' : limits.products },
                  { label: 'Employés', value: limits.employees === Infinity ? 'Illimité' : limits.employees },
                  { label: 'Historique', value: limits.salesHistoryDays === Infinity ? 'Illimité' : `${limits.salesHistoryDays}j` },
                  { label: 'Export CSV', value: limits.exportCsv ? 'Oui' : 'Non' },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="font-semibold text-slate-800 text-sm">{item.value}</p>
                  </div>
                ))}
              </div>
              {plan === 'free' && (
                <button onClick={() => setTab('billing')}
                  className="w-full text-sm text-indigo-600 hover:text-indigo-800 font-medium underline">
                  Passer à un plan supérieur →
                </button>
              )}
            </CardContent>
          </Card>

          {/* Sauvegarde : export complet des données de la boutique. Réservé au
              propriétaire — un employé n'a pas à sortir tout le carnet. */}
          {!isEmployee && (
            <Card className="border-slate-200">
              <CardContent className="p-5 space-y-3">
                <h3 className="font-semibold text-slate-800 text-sm">Sauvegarde de vos données</h3>
                <p className="text-xs text-slate-500">
                  Téléchargez toutes vos données (produits, ventes, dettes, charges, fournisseurs)
                  dans un seul fichier. À conserver hors de l&apos;application.
                </p>
                <Button variant="outline" onClick={sauvegarder} disabled={sauvegardeEnCours} className="gap-2">
                  {sauvegardeEnCours
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Préparation…</>
                    : <><Download className="h-4 w-4" /> Télécharger la sauvegarde</>}
                </Button>
                {sauvegardeErreur && <p className="text-xs text-red-600">{sauvegardeErreur}</p>}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── BILLING TAB ── */}
      {tab === 'billing' && (
        <div className="space-y-4">
          {billingError && (
            <p className="text-red-600 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              {billingError}
            </p>
          )}

          {/* Essai gratuit de 14 jours */}
          {planBrut === 'free' && (
            <Card className={`border-2 ${enEssai ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200'}`}>
              <CardContent className="p-4 space-y-2">
                {enEssai ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-indigo-600" />
                      <p className="text-sm font-semibold text-indigo-800">Essai Starter en cours</p>
                    </div>
                    <p className="text-xs text-indigo-700">
                      Il se termine le{' '}
                      {new Date(org!.trial_ends_at!).toLocaleDateString('fr-FR', {
                        day: '2-digit', month: 'long', year: 'numeric',
                      })}
                      {(() => {
                        const restants = Math.ceil(
                          (new Date(org!.trial_ends_at!).getTime() - Date.now()) / 86400000
                        );
                        return restants <= 1
                          ? ' : dernier jour'
                          : ` : ${restants} jours restants`;
                      })()}
                      . Ensuite la boutique revient au plan Gratuit, sans prélèvement ni perte de données.
                    </p>
                  </>
                ) : org?.trial_started_at ? (
                  // Déjà expiré : l'essai ne se relance jamais (une fois par
                  // boutique), dire les choses vaut mieux qu'un bouton qui
                  // échouerait.
                  <p className="text-xs text-slate-500">
                    Votre essai de 14 jours est terminé. Le plan Gratuit reste entièrement
                    utilisable, les données n&apos;ont jamais bougé.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-indigo-600" />
                      <p className="text-sm font-semibold text-slate-800">
                        Essayer Starter pendant 14 jours
                      </p>
                    </div>
                    <p className="text-xs text-slate-500">
                      Sans carte bancaire, et en un clic. Au bout de 14 jours, retour au plan
                      Gratuit, sans prélèvement, sans surprise. L&apos;essai n&apos;est proposé qu&apos;une
                      fois par boutique : à vous de choisir le bon moment.
                    </p>
                    <Button
                      size="sm"
                      onClick={demarrerEssai}
                      disabled={loadingTrial}
                      className="bg-indigo-600 hover:bg-indigo-700 gap-1 text-xs"
                    >
                      {loadingTrial
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Zap className="h-3.5 w-3.5" />}
                      Démarrer l&apos;essai
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Plans */}
          <div className="space-y-3">
            {PLANS.map((p) => {
              const isCurrent = plan === p.id;
              const isUpgrade = PLANS.findIndex((x) => x.id === p.id) > PLANS.findIndex((x) => x.id === plan);

              return (
                <Card key={p.id} className={`border-2 transition-colors ${isCurrent ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200'}`}>
                  <CardContent className="p-4 flex items-start gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-800">{PLAN_LABELS[p.id]}</span>
                        {isCurrent && (
                          <Badge className="bg-indigo-100 text-indigo-700 text-xs">Plan actuel</Badge>
                        )}
                        {p.id === 'pro' && (
                          <Badge className="bg-amber-100 text-amber-700 text-xs">Populaire</Badge>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-slate-600">
                        {prixMensuelLabel(p.id)}
                        {prixAAnnuelLabel(p.id) && (
                          <span className="ml-2 font-normal text-slate-400">
                            ou {prixAAnnuelLabel(p.id)}
                          </span>
                        )}
                      </p>
                      <ul className="space-y-0.5">
                        {p.features.map((f) => (
                          <li key={f} className="text-xs text-slate-500 flex items-center gap-1.5">
                            <CheckCircle className="h-3 w-3 text-emerald-600 shrink-0" />
                            {f}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="shrink-0">
                      {isCurrent ? (
                        <span className="text-xs text-indigo-600 font-medium">Actif</span>
                      ) : isUpgrade ? (
                        <Button
                          size="sm"
                          onClick={() => startCheckout(p.id)}
                          disabled={loadingCheckout !== null}
                          className="bg-indigo-600 hover:bg-indigo-700 gap-1 text-xs"
                        >
                          {loadingCheckout === p.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Zap className="h-3.5 w-3.5" />}
                          Passer
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Période prépayée — Mobile Money */}
          <Card className="border-slate-200">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-medium text-slate-700">
                  Payer par Mobile Money : période prépayée
                </p>
              </div>
              <p className="text-xs text-slate-500">
                Vous payez une période d&apos;avance (1, 3 ou 12 mois) sur votre
                téléphone, sans carte bancaire et sans prélèvement automatique :
                la période se termine d&apos;elle-même, et vous la prolongez quand
                vous le voulez.
              </p>

              {planBrut !== 'free' && org?.plan_valid_until &&
                new Date(org.plan_valid_until).getTime() > Date.now() && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 flex items-center gap-1.5">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                  Période {PLAN_LABELS[planBrut]} active jusqu&apos;au{' '}
                  {new Date(org.plan_valid_until).toLocaleDateString('fr-FR', {
                    day: '2-digit', month: 'long', year: 'numeric',
                  })} : prolongez-la ci-dessous, la fin de période est repoussée.
                </p>
              )}

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Durée :</span>
                {([1, 3, 12] as DureePeriode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPeriode(m)}
                    disabled={loadingMobile !== null}
                    aria-pressed={periode === m}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                      periode === m
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'
                    }`}
                  >
                    {m} mois
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2">
                {(['starter', 'pro'] as PlanPayant[]).map((p) => {
                  const montant = montantPeriode(p, periode);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => payerMobileMoney(p)}
                      disabled={montant === null || loadingMobile !== null}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <span className="font-medium text-slate-800">{PLAN_LABELS[p]}</span>
                      <span className="block text-xs text-slate-500">
                        {montant === null
                          ? 'Prix non configuré'
                          : loadingMobile === p
                            ? 'Ouverture…'
                            : formatCFA(montant)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-400">
                Parcours de démonstration tant que le prestataire Mobile Money
                n&apos;est pas branché : aucun débit réel n&apos;a lieu, la
                confirmation est simulée (bac à sable).
              </p>
            </CardContent>
          </Card>

          {/* Moyens de paiement */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide px-1">Moyens de paiement</p>

            {/* Stripe */}
            <Card className="border-slate-200">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                  <Globe className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-700">Stripe</p>
                    <Badge className="bg-emerald-100 text-emerald-700 text-xs">Disponible</Badge>
                  </div>
                  <p className="text-xs text-slate-500">Carte bancaire internationale</p>
                </div>
                {plan !== 'free' && (
                  <Button variant="outline" size="sm" onClick={openPortal} disabled={loadingPortal} className="gap-2 shrink-0">
                    {loadingPortal ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                    Gérer
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* FedaPay */}
            <Card className="border-slate-200 opacity-60">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0">
                  <Smartphone className="h-5 w-5 text-orange-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-700">FedaPay</p>
                    <Badge className="bg-slate-100 text-slate-600 text-xs">Bientôt disponible</Badge>
                  </div>
                  <p className="text-xs text-slate-500">Mobile Money (MTN, Moov) · Paiement local</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
