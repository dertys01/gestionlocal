'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle, ChefHat, Handshake, LayoutDashboard, Loader2, Package, PartyPopper, Plus, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { hasStarterCatalog, loadStarterCatalog } from '@/lib/starterCatalog.client';
import {
  BUSINESS_DESCRIPTIONS,
  BUSINESS_LABELS,
  BUSINESS_TYPES,
  carteDeDemarrage,
  domainOf,
  normalizeBusinessType,
  normalizeOnboardingStep,
  onboardingSamples,
  sampleRows,
  type BusinessType,
  type OnboardingStep,
} from '@/lib/onboarding';
import { lireMontant } from '@/lib/utils/nombres';

/** Où l'écran de félicitations envoie le patron. */
export type OnboardingExit = 'debts' | 'add-product' | 'dashboard';

interface OnboardingWizardProps {
  /** Les produits viennent d'être écrits : la caisse guidée doit les voir. */
  onProductsChanged: () => void;
  /** Écran 4 → la caisse guidée, rendue par page.tsx sans la navigation. */
  onGoToCash: () => void;
  /** Fin de l'assistant, et l'écran où le patron veut aller. */
  onFinish: (exit: OnboardingExit) => void;
}

/**
 * Assistant de premier lancement — 5 écrans, une seule promesse : la première
 * vente en moins de 4 minutes.
 *
 * Les textes suivent PLAN-TRAVAIL-GESTIONLOCAL.md §4, au vouvoiement : c'est
 * la forme de respect attendue d'un fournisseur par un commerçant, et celle du
 * reste de l'application. Un logiciel qui tutoie un patron de 50 ans le perd.
 *
 * L'étape courante est en base (organizations.onboarding_step) : un
 * rechargement, une coupure réseau, un téléphone qui s'éteint — on reprend là
 * où on en était, et jamais avec des exemples en double.
 */
export function OnboardingWizard({ onProductsChanged, onGoToCash, onFinish }: OnboardingWizardProps) {
  const { supabase, ownerId, org, refreshOrg } = useSupabase();
  const step = normalizeOnboardingStep(org?.onboarding_step);
  const [choix, setChoix] = useState<BusinessType | null>(() => normalizeBusinessType(org?.business_type));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Variante de l'écran 3 : « Je préfère ajouter mes propres produits ».
  const [mesProduits, setMesProduits] = useState(false);
  const [ajoutes, setAjoutes] = useState<{ name: string; price: number }[]>([]);
  const [nom, setNom] = useState('');
  const [prix, setPrix] = useState('');
  const [quantite, setQuantite] = useState('');

  const type: BusinessType = normalizeBusinessType(org?.business_type) ?? choix ?? 'autre';
  // Un restaurant n'accueille pas avec des articles génériques : il accueille
  // avec sa carte, recettes comprises. L'écran montre des PLATS (l'unité de
  // travail d'un maquis), pas les 17 articles du stock.
  const estRestaurant = type === 'restaurant';
  const carte = carteDeDemarrage();

  /** Écrit l'étape (et d'autres colonnes au besoin), puis relit la boutique. */
  const avancer = async (suivante: OnboardingStep, extra: Record<string, unknown> = {}) => {
    if (!ownerId) return false;
    setLoading(true);
    setError('');
    try {
      const { error: err } = await supabase
        .from('organizations')
        .update({ onboarding_step: suivante, ...extra } as Record<string, unknown>)
        .eq('id', ownerId);
      if (err) { setError(err.message); return false; }
      await refreshOrg();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const choisirActivite = async () => {
    if (!choix) return;
    // Le domaine suit l'activité dans la même écriture : il décide des modules,
    // il ne doit jamais contredire ce que le patron vient de choisir.
    await avancer('samples', { business_type: choix, domain: domainOf(choix) });
  };

  const garderLesExemples = async () => {
    if (!ownerId) return;
    setLoading(true);
    setError('');
    try {
      if (estRestaurant) {
        // La carte de démarrage écrit les plats, leurs recettes, les ingrédients
        // au stock et les options. La fonction est idempotente : un second
        // passage ne réécrit rien.
        const r = await loadStarterCatalog(supabase, ownerId, 'restaurant');
        if ('erreur' in r) { setError(r.erreur); return; }
      } else if ((await hasStarterCatalog(supabase, ownerId)) === 0) {
        // Un second passage (retour arrière, double tap, reprise après coupure)
        // ne doit pas créer les exemples en double.
        const { error: err } = await supabase.from('products').insert(sampleRows(type, ownerId));
        if (err) { setError(err.message); return; }
      }
      onProductsChanged();
      await avancer('first_sale');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ajout du catalogue impossible.');
    } finally {
      setLoading(false);
    }
  };

  const ajouterMonProduit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerId) return;
    const prixVente = lireMontant(prix) ?? 0;
    const stock = lireMontant(quantite) ?? 0;
    if (!nom.trim() || !(prixVente > 0)) { setError('Indiquez le nom et le prix de vente.'); return; }
    // Sans stock, la caisse refuse la vente : mieux vaut le dire ici qu'à
    // l'écran suivant, sur un « Stock insuffisant » incompréhensible.
    if (!(stock > 0)) { setError('Indiquez combien vous en avez en stock.'); return; }

    setLoading(true);
    setError('');
    try {
      const { error: err } = await supabase.from('products').insert({
        user_id: ownerId,
        name: nom.trim(),
        price_buy: 0,
        price_sell: prixVente,
        stock_qty: stock,
        min_stock_level: 0,
      });
      if (err) { setError(err.message); return; }
      setAjoutes((a) => [...a, { name: nom.trim(), price: prixVente }]);
      setNom('');
      setPrix('');
      setQuantite('');
      onProductsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ajout impossible.');
    } finally {
      setLoading(false);
    }
  };

  const terminer = async (exit: OnboardingExit) => {
    if (!ownerId) return;
    setLoading(true);
    setError('');
    try {
      const { error: err } = await supabase
        .from('organizations')
        .update({ onboarding_done: true, onboarding_step: null } as Record<string, unknown>)
        .eq('id', ownerId);
      if (err) { setError(err.message); return; }
      onFinish(exit);
      await refreshOrg();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
    } finally {
      setLoading(false);
    }
  };

  const ecrans: OnboardingStep[] = ['welcome', 'business', 'samples', 'first_sale', 'congrats'];
  const rang = ecrans.indexOf(step);

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-md">
        <ol className="flex items-center justify-center gap-2 mb-6" aria-label={`Étape ${rang + 1} sur ${ecrans.length}`}>
          {ecrans.map((s, i) => (
            <li
              key={s}
              className={`h-2 rounded-full transition-all ${
                i < rang ? 'w-2 bg-emerald-600' : i === rang ? 'w-6 bg-indigo-600' : 'w-2 bg-slate-300'
              }`}
            />
          ))}
        </ol>

        <div className="bg-white rounded-2xl shadow-lg p-6 sm:p-8 space-y-6">
          {/* ── Écran 1 — Bienvenue ── */}
          {step === 'welcome' && (
            <div className="text-center space-y-5">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Bienvenue sur GestionLocal</h2>
                <p className="text-slate-600 text-sm mt-2">
                  Nous allons configurer votre boutique en moins de 2 minutes.
                </p>
              </div>
              <Button
                onClick={() => avancer('business')}
                disabled={loading}
                className="w-full h-12 text-base bg-indigo-600 hover:bg-indigo-700 gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Commencer <ArrowRight className="h-4 w-4" /></>}
              </Button>
            </div>
          )}

          {/* ── Écran 2 — Type d'activité ── */}
          {step === 'business' && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-slate-800">Quel type de commerce avez-vous&nbsp;?</h2>
                <p className="text-sm text-slate-600 mt-2">Cela nous aide à vous proposer les bons exemples.</p>
              </div>
              <div className="grid gap-2" role="group" aria-label="Type de commerce">
                {BUSINESS_TYPES.map((t) => {
                  const actif = choix === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setChoix(t)}
                      aria-pressed={actif}
                      className={`rounded-xl border-2 p-4 text-left transition-colors ${
                        actif ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <span className="block text-sm font-semibold text-slate-800">{BUSINESS_LABELS[t]}</span>
                      {BUSINESS_DESCRIPTIONS[t] && (
                        <span className="block text-xs text-slate-500 mt-0.5">{BUSINESS_DESCRIPTIONS[t]}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <Button
                onClick={choisirActivite}
                disabled={!choix || loading}
                className="w-full h-12 text-base bg-indigo-600 hover:bg-indigo-700 gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Continuer <ArrowRight className="h-4 w-4" /></>}
              </Button>
            </div>
          )}

          {/* ── Écran 3 — Produits d'exemple (commerce) ou carte (restaurant) ── */}
          {step === 'samples' && !mesProduits && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-slate-800">
                  {estRestaurant ? 'Votre carte de démarrage' : 'Voici quelques produits pour commencer'}
                </h2>
                <p className="text-sm text-slate-600 mt-2">
                  {estRestaurant
                    ? 'Ces plats arrivent avec leurs recettes. Leurs ingrédients entrent au stock : à chaque vente, ils sont déduits et la marge du plat se calcule.'
                    : 'Vous pourrez les modifier ou les supprimer plus tard.'}
                </p>
              </div>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {estRestaurant
                  ? carte.plats.map((p) => (
                      <li key={p.name} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <ChefHat className="h-4 w-4 text-indigo-500 shrink-0" />
                          <span className="flex-1 min-w-0 text-sm font-medium text-slate-800 truncate">{p.name}</span>
                          <span className="text-sm text-slate-600 tabular-nums">{formatCFA(p.priceSell)}</span>
                        </div>
                        {/* La recette est écrite en clair : c'est elle qui montre
                            au patron qu'un plat se vend AVEC ses ingrédients. */}
                        <p className="mt-1 pl-7 text-xs text-slate-500">{p.recette}</p>
                      </li>
                    ))
                  : onboardingSamples(type).map((s) => (
                      <li key={s.name} className="flex items-center gap-3 px-4 py-3">
                        <Package className="h-4 w-4 text-indigo-500 shrink-0" />
                        <span className="flex-1 min-w-0 text-sm font-medium text-slate-800 truncate">{s.name}</span>
                        <span className="text-sm text-slate-600 tabular-nums">{formatCFA(s.priceSell)}</span>
                      </li>
                    ))}
              </ul>
              {estRestaurant && (
                <p className="text-xs text-slate-500 text-center">
                  {carte.ingredientsEnStock} ingrédients au stock et {carte.boissons} boissons à la carte. Vous pourrez tout modifier.
                </p>
              )}
              <Button
                onClick={garderLesExemples}
                disabled={loading}
                className="w-full h-12 text-base bg-indigo-600 hover:bg-indigo-700 gap-2"
              >
                {loading
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <>{estRestaurant ? 'Continuer avec cette carte' : 'Continuer avec ces produits'} <ArrowRight className="h-4 w-4" /></>}
              </Button>
              <button
                type="button"
                onClick={() => { setError(''); setMesProduits(true); }}
                className="w-full text-sm text-slate-600 hover:text-slate-800 underline"
              >
                {estRestaurant ? 'Je préfère saisir ma carte' : 'Je préfère ajouter mes propres produits'}
              </button>
            </div>
          )}

          {/* ── Écran 3 bis — Mes propres produits ──
              Trois champs, pas un de plus : le prix d'achat, la catégorie et
              le code-barres se complètent plus tard, depuis le Stock. */}
          {step === 'samples' && mesProduits && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-slate-800">
                  {estRestaurant ? 'Ajoutez votre premier plat' : 'Ajoutez vos produits'}
                </h2>
                <p className="text-sm text-slate-600 mt-2">
                  {estRestaurant
                    ? 'Un seul suffit pour faire votre première vente. Sa recette s\'ajoute juste après, dans l\'onglet Recettes.'
                    : 'Un seul suffit pour faire votre première vente.'}
                </p>
              </div>

              {ajoutes.length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="Produits ajoutés">
                  {ajoutes.map((p, i) => (
                    <li key={`${p.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                      <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
                      <span className="flex-1 min-w-0 text-sm text-slate-800 truncate">{p.name}</span>
                      <span className="text-sm text-slate-600 tabular-nums">{formatCFA(p.price)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={ajouterMonProduit} className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="ob-nom" className="text-sm font-medium text-slate-700">Nom du produit</label>
                  <Input id="ob-nom" value={nom} onChange={(e) => setNom(e.target.value)}
                    placeholder={`Ex : ${onboardingSamples(type)[0].name}`} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="ob-prix" className="text-sm font-medium text-slate-700">Prix de vente (F)</label>
                    <Input id="ob-prix" inputMode="decimal" value={prix} onChange={(e) => setPrix(e.target.value)} placeholder="0" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="ob-stock" className="text-sm font-medium text-slate-700">Quantité en stock</label>
                    <Input id="ob-stock" inputMode="decimal" value={quantite} onChange={(e) => setQuantite(e.target.value)} placeholder="0" />
                  </div>
                </div>
                <Button type="submit" disabled={loading} variant="outline" className="w-full h-11 gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Ajouter ce produit</>}
                </Button>
              </form>

              <Button
                onClick={() => avancer('first_sale')}
                disabled={ajoutes.length === 0 || loading}
                className="w-full h-12 text-base bg-indigo-600 hover:bg-indigo-700 gap-2"
              >
                Continuer <ArrowRight className="h-4 w-4" />
              </Button>
              <button
                type="button"
                onClick={() => { setError(''); setMesProduits(false); }}
                className="w-full text-sm text-slate-600 hover:text-slate-800 underline"
              >
                {estRestaurant ? 'Revenir à la carte de démarrage' : 'Revenir aux produits d\'exemple'}
              </button>
            </div>
          )}

          {/* ── Écran 4 — Première vente ── */}
          {step === 'first_sale' && (
            <div className="text-center space-y-5">
              <div className="h-16 w-16 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto">
                <ShoppingCart className="h-8 w-8 text-indigo-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">Faites votre première vente</h2>
                <p className="text-sm text-slate-600 mt-2">
                  Cliquez sur un produit, puis sur «&nbsp;Encaisser&nbsp;». C&apos;est tout.
                </p>
              </div>
              <Button onClick={onGoToCash} className="w-full h-12 text-base bg-indigo-600 hover:bg-indigo-700 gap-2">
                Aller à la caisse <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* ── Écran 5 — Félicitations ── */}
          {step === 'congrats' && (
            <div className="text-center space-y-5">
              <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                <PartyPopper className="h-8 w-8 text-emerald-700" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">Bravo&nbsp;! Première vente enregistrée</h2>
                <p className="text-sm text-slate-600 mt-2">Vous savez déjà utiliser l&apos;essentiel.</p>
              </div>
              <div className="grid gap-2">
                {([
                  ['debts', Handshake, 'Voir mes dettes clients'],
                  ['add-product', Package, 'Ajouter d\'autres produits'],
                  ['dashboard', LayoutDashboard, 'Voir mon tableau de bord du jour'],
                ] as const).map(([exit, Icon, label]) => (
                  <Button
                    key={exit}
                    variant="outline"
                    onClick={() => terminer(exit)}
                    disabled={loading}
                    className="w-full h-12 justify-start gap-3 text-sm"
                  >
                    <Icon className="h-5 w-5 text-indigo-600" /> {label}
                  </Button>
                ))}
              </div>
              {/* Le mode complet se trouve dans Paramètres. Ce lien termine
                  l'assistant sans rien changer : il dit seulement que la
                  porte existe, sans pousser à l'ouvrir maintenant. */}
              <button
                type="button"
                onClick={() => terminer('dashboard')}
                disabled={loading}
                className="text-xs text-slate-500 hover:text-slate-700 underline"
              >
                Passer en mode complet plus tard
              </button>
            </div>
          )}

          {error && <p role="alert" className="text-red-600 text-sm text-center">{error}</p>}
        </div>
      </div>
    </div>
  );
}
