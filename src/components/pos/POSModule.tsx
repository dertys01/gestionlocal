'use client';

import { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react';
import {
  ShoppingCart,
  Trash2,
  CreditCard,
  Handshake,
  Smartphone,
  Search,
  Share2,
  X,
  Printer,
  FileText,
  PackageX,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { rechercher } from '@/lib/utils/productSearch';
import { lireMontant } from '@/lib/utils/nombres';
import { generateWhatsAppReceiptLink } from '@/lib/utils/whatsapp';
import { logActivity } from '@/lib/utils/activity';
import { printReceipt } from '@/lib/utils/print';
import { loadDishIds, loadIngredientIds, estVendableAuMenu } from '@/lib/utils/dishes';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { isFeatureAllowed } from '@/lib/utils/plans';
import { peutDelivrerFacture } from '@/lib/mecef/gate';
import { useLiaisonMecef } from '@/lib/hooks/useLiaisonMecef';
import { mettreEnFile } from '@/lib/offline/queue';
import { nouvelleRefVente } from '@/lib/offline/ref';
import type { Product, CartItem } from '@/types';

interface POSModuleProps {
  products: Product[];
  onSaleComplete?: () => void;
  /**
   * Produit à ajouter au panier (issu du scanner de la page parente).
   * Le panier vit dans ce composant : sans cette prop, un scan depuis la
   * barre latérale changeait d'onglet mais ne remplissait rien.
   */
  addToCartRequest?: { productId: string; token: number } | null;
  /**
   * Signale au parent que la demande ci-dessus a été traitée, pour qu'il la
   * remette à null. Sans ça la requête survit au remontage du POS (changement
   * d'onglet) et le produit réapparaît dans un panier vide.
   */
  onAddToCartHandled?: () => void;
  /**
   * Le reçu de vente vient d'être fermé. Sert à la caisse guidée de
   * l'onboarding : les félicitations attendent que le patron ait vu son reçu,
   * au lieu de le lui retirer des yeux à la seconde où la vente passe.
   */
  onReceiptClosed?: () => void;
}

type PaymentMethod = 'cash' | 'momo' | 'credit';

/**
 * Nombre de cartes produits rendues d'un coup. 60 tient sur deux écrans de
 * téléphone en colonne double, soit environ 2 000 nœuds DOM pour la grille —
 * au-delà, le défilement saccade sur un appareil d'entrée de gamme.
 */
const PRODUCT_PAGE_SIZE = 60;

// formatQty vit désormais dans lib/utils/currency : la salle en a besoin aussi, et
// deux lectures de quantité qui divergent afficheraient « 1.5 » et « 1,5 » sur
// deux écrans du même service.

interface ReceiptState {
  saleId: string;
  /** Numéro de facture calculé par le serveur (Pro uniquement). */
  invoiceNumber: string | null;
  waLink: string;
  items: CartItem[];
  total: number;
  paymentMethod: PaymentMethod;
  clientName: string;
  clientPhone: string;
  amountGiven: number;
  change: number;
  date: Date;
  /** Vente à crédit : le reçu ne propose pas de monnaie, il propose de relancer. */
  isCredit: boolean;
  /** Acompte versé sur-le-champ, en crédit. 0 = rien reçu à la vente. */
  advance: number;
  /** Reste à recouvrer, renvoyé par la base. */
  due: number;
  /** Vente mise en file hors-ligne : en attente de synchronisation. */
  offline?: boolean;
}

/**
 * Les exceptions de `create_sale` (supabase/migration_sales_rpc.sql) sont
 * rédigées pour être affichables telles quelles à la caissière. Les autres
 * messages (réseau, PostgREST) ne le sont pas.
 */
function readableSaleError(message: string): string {
  if (/^(Stock insuffisant|Produit introuvable|Panier vide|Moyen de paiement invalide)/.test(message)) {
    return message;
  }
  if (message === 'Non authentifié') return 'Session expirée, reconnectez-vous.';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "Connexion impossible. Vérifiez votre réseau et réessayez : la vente n'a pas été enregistrée.";
  }
  return "La vente n'a pas été enregistrée. Aucune modification n'a été appliquée.";
}

/**
 * Carte produit (vue grille) et ligne produit (vue liste), mémoïsées.
 *
 * Le POS se re-rend à chaque geste du panier. Sans mémoïsation, les 60 cartes
 * affichées se réconcilient à chaque ajout ou retrait, alors qu'une seule
 * change. `React.memo` ne re-rend que celle dont la quantité a bougé : c'est
 * ce qui garde la caisse fluide quand le catalogue grandit.
 *
 * `onAjouter` doit être stable (useCallback), sinon la mémoïsation ne sert à
 * rien.
 *
 * `content-visibility: auto` + `contain-intrinsic-size` : le navigateur saute
 * la mise en page et la peinture des cartes hors écran — le gain réel d'une
 * liste virtualisée — SANS retirer les nœuds du DOM. C'est volontaire : un
 * virtualiseur JavaScript ne rendrait rien dans un environnement sans moteur
 * de mise en page (tests jsdom), et la caisse serait invérifiable. Ici, le
 * catalogue de 200+ références défile sans coût, et les tests voient tout.
 */
const CarteProduit = memo(function CarteProduit({
  produit, quantite, vendable, estPlat, onAjouter,
}: {
  produit: Product;
  quantite: number;
  vendable: boolean;
  estPlat: boolean;
  onAjouter: (p: Product) => void;
}) {
  return (
    <button
      onClick={() => onAjouter(produit)}
      aria-disabled={!vendable || undefined}
      className={`group relative flex flex-col text-left rounded-xl border p-3 shadow-sm transition-all [content-visibility:auto] [contain-intrinsic-size:130px] ${
        vendable
          ? 'border-slate-200 bg-white hover:border-indigo-400 hover:shadow-md active:scale-95'
          : 'border-slate-200 bg-slate-50 cursor-not-allowed'
      }`}
    >
      {quantite > 0 && (
        <span className="absolute -top-2 -right-2 h-5 min-w-5 px-1 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">
          {formatQty(quantite)}
        </span>
      )}
      <div className="text-xs text-slate-500 mb-1">{produit.category ?? '—'}</div>
      <div className={`min-h-9 font-semibold text-sm leading-tight line-clamp-2 ${vendable ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
        {produit.name}
      </div>
      <div className={`mt-2 pt-auto font-bold ${vendable ? 'text-indigo-600' : 'text-slate-300'}`}>{formatCFA(produit.price_sell)}</div>
      <div className="text-xs text-slate-500">
        {!vendable ? (
          <span className="text-red-500 font-medium">Rupture de stock</span>
        ) : estPlat ? (
          <span className="text-slate-400">Recette</span>
        ) : (
          <>Stock : {formatQty(produit.stock_qty)} {produit.unit ?? 'pce'}</>
        )}
      </div>
    </button>
  );
});

const LigneProduit = memo(function LigneProduit({
  produit, quantite, vendable, estPlat, onAjouter,
}: {
  produit: Product;
  quantite: number;
  vendable: boolean;
  estPlat: boolean;
  onAjouter: (p: Product) => void;
}) {
  return (
    <button
      onClick={() => onAjouter(produit)}
      aria-disabled={!vendable || undefined}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:56px] ${
        vendable ? 'hover:bg-indigo-50/40 active:bg-indigo-50' : 'bg-slate-50/60 cursor-not-allowed'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${vendable ? 'font-medium text-slate-800' : 'text-slate-400 line-through'}`}>
          {produit.name}
        </div>
        <div className="flex items-baseline gap-2 text-xs">
          <span className={`shrink-0 ${!vendable ? 'text-red-500 font-medium' : 'text-slate-500'}`}>
            {!vendable ? (
              'Rupture de stock'
            ) : estPlat ? (
              <span className="text-slate-400">Recette</span>
            ) : (
              <>Stock : {formatQty(produit.stock_qty)} {produit.unit ?? 'pce'}</>
            )}
          </span>
          <span className="min-w-0 truncate text-right text-slate-400">
            {produit.category ?? '—'}
          </span>
        </div>
      </div>
      <div className={`text-sm whitespace-nowrap ${vendable ? 'font-semibold text-indigo-600' : 'text-slate-300 font-semibold'}`}>
        {formatCFA(produit.price_sell)}
      </div>
      {quantite > 0 && (
        <span className="h-5 min-w-5 px-1 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">
          {formatQty(quantite)}
        </span>
      )}
    </button>
  );
});

export function POSModule({ products, onSaleComplete, addToCartRequest, onAddToCartHandled, onReceiptClosed }: POSModuleProps) {
  const { supabase, ownerId, actorName, org, plan } = useSupabase();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanError, setScanError] = useState('');
  const [search, setSearch] = useState('');
  /** Catégorie retenue dans la barre de filtres ; null = tout le catalogue. */
  const [categorie, setCategorie] = useState<string | null>(null);
  /**
   * Quantités vendues par produit sur 30 jours, indexées par identifiant.
   *
   * `get_units_sold_since()` exige le plan pro : sur les autres plans l'appel
   * échoue, et l'absence de cette section ne doit surtout pas se lire comme une
   * erreur. Une boutique qui vend 200 références n'a pas besoin du classement
   * pour trouver un téléphone.
   */
  const [plusVendus, setPlusVendus] = useState<Record<string, number>>({});
  /**
   * Produits qui sont des PLATS (ils ont une recette).
   *
   * Un plat ne se stocke pas : son stock propre est 0 par nature, et sa
   * disponibilité vient de ses ingrédients. Sans cette distinction, la caisse
   * affichait « Rupture de stock » sur chaque plat et refusait de l'ajouter au
   * panier — un maquis ne pouvait rien servir au comptoir, y compris ses propres
   * plats du catalogue d'exemple. La base ne contrôle ni ne décrémente le stock
   * d'un plat ; le client doit appliquer la même règle.
   */
  const [dishIds, setDishIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let vivant = true;
    void loadDishIds(supabase).then((ids) => { if (vivant) setDishIds(ids); });
    return () => { vivant = false; };
  }, [supabase]);
  // Ingrédients : des produits qui servent à composer, pas à vendre. Ils vivent
  // dans le Stock, pas dans le menu de la caisse.
  const [ingredientIds, setIngredientIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let vivant = true;
    void loadIngredientIds(supabase).then((ids) => { if (vivant) setIngredientIds(ids); });
    return () => { vivant = false; };
  }, [supabase]);

  /**
   * Un produit est-il vendable ? Un plat l'est toujours : ce sont ses
   * ingrédients qui peuvent manquer, et la vente sera refusée en précisant
   * lequel — un message utile, là où « Rupture de stock » sur le plat n'en
   * disait rien.
   */
  const vendable = useCallback(
    (p: Product) => dishIds.has(p.id) || p.stock_qty > 0,
    [dishIds],
  );
  const rechercheRef = useRef<HTMLInputElement>(null);
  // Vue « liste » par défaut : avec des centaines de références, la grille de
  // cartes étalait le catalogue sur des heures de scroll. La grille reste
  // accessible et le choix est mémorisé.
  const [vue, setVue] = useState<'liste' | 'grille'>(() => {
    try { return localStorage.getItem('pos:vue') === 'grille' ? 'grille' : 'liste'; } catch { return 'liste'; }
  });
  const basculerVue = () => {
    setVue((v) => {
      const n = v === 'liste' ? 'grille' : 'liste';
      try { localStorage.setItem('pos:vue', n); } catch { /* stockage plein/privé */ }
      return n;
    });
  };
  const [visibleCount, setVisibleCount] = useState(PRODUCT_PAGE_SIZE);
  // Une recherche remet la tranche au début : sans cela, taper « Nokia » après
  // avoir déroulé 400 produits affiche une grille vide alors qu'il y en a 3.
  const [lastSearch, setLastSearch] = useState('');
  if (search !== lastSearch) {
    setLastSearch(search);
    setVisibleCount(PRODUCT_PAGE_SIZE);
  }
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [amountGiven, setAmountGiven] = useState('');
  // Acompte versé sur une vente à crédit : ce que le client donne sur-le-champ.
  // Vide ou 0 = crédit total, le comportement le plus simple. « Laisse-moi
  // 50 000 sur 130 000 » est le geste le plus courant d'une boutique de quartier,
  // et sans ce champ il n'avait aucun moyen d'être enregistré.
  const [advance, setAdvance] = useState('');
  // Moyen de l'acompte : la vente est à crédit, mais l'argent réellement reçu
  // sur-le-champ est en espèces ou en MoMo — c'est lui qui ventile la part de
  // caisse du jour, pas « crédit » et pas un « cash » déduit.
  const [advanceMethod, setAdvanceMethod] = useState<'cash' | 'momo'>('cash');
  const [loading, setLoading] = useState(false);
  /**
   * Message rouge de l'encaissement refusé (« Stock insuffisant… »). Il était
   * posé à l'échec et jamais effacé : le caissier corrigeait son panier, la
   * vente passait, et le message restait — il expliquait alors un refus qui
   * n'avait plus lieu d'être.
   * Il suit donc tout ce qui décrit la vente : changer une quantité, un prix,
   * un moyen de paiement ou un champ client rend l'avertissement caduc.
   */
  const [checkoutError, setCheckoutError] = useState('');
  useEffect(() => {
    setCheckoutError('');
  }, [cart, paymentMethod, clientName, clientPhone, advance, advanceMethod, amountGiven]);
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const fermerRecu = () => {
    setReceipt(null);
    onReceiptClosed?.();
  };
  /**
   * Verrou de délivrance de la facture normalisée (e-MECeF) :
   * Plan Pro (numéro attribué) + IFU enregistré + connexion DGI ouverte.
   * Le reçu simple, lui, n'est jamais concerné — voir lib/mecef/gate.ts.
   */
  const connexionMecef = useLiaisonMecef();
  const factureEtat = peutDelivrerFacture({
    numero: receipt?.invoiceNumber ?? null,
    ifu: org?.ifu ?? null,
    connexion: connexionMecef,
  });
  /**
   * Sur mobile, le panier est un panneau plein écran plutôt qu'une colonne
   * sous la grille. En colonne il arrivait après les produits : avec 40
   * références, le caissier devait faire défiler tout le catalogue pour
   * atteindre le total et le bouton « Encaisser » — c'est-à-dire l'action
   * principale de l'écran, à chaque vente.
   */
  const [panierOuvert, setPanierOuvert] = useState(false);

  /**
   * Le panier plein écran n'a de sens que là où il n'y a pas de colonne
   * latérale.
   *
   * Sans cette lecture de la media query, « Reprendre la dernière vente »
   * ouvrait le panneau `fixed inset-0 z-40` même à 1280 px, où le panier est
   * une colonne à droite : l'écran se trouvait recouvert, navigation comprise,
   * et le commerçant se retrouvait bloqué — plus aucun onglet, plus
   * « Actualiser », plus rien.
   *
   * À l'inverse, ajouter un produit n'ouvre PAS le panneau, même sur
   * téléphone : le caissier enchaîne les articles, et c'est la barre du bas —
   * qui affiche le total en permanence — qui ouvre la caisse quand il a
   * fini. Seule la reprise d'une vente ouvre l'écran d'encaissement, parce
   * qu'elle est déjà un acte de vente.
   *
   * On suppose le grand écran au premier rendu, comme le fait la Sidebar :
   * le serveur ne doit pas pouvoir rendre le panneau mobile.
   */
  const [grandEcran, setGrandEcran] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const suivre = () => {
      setGrandEcran(mq.matches);
      // Un retour en grand écran referme un panneau resté ouvert depuis le
      // mobile, plutôt que de laisser un calque orphelin à l'écran.
      if (mq.matches) setPanierOuvert(false);
    };
    suivre();
    mq.addEventListener('change', suivre);
    return () => mq.removeEventListener('change', suivre);
  }, []);

  /**
   * Dernière vente, pour la reprendre d'un clic.
   *
   * « Deux GSM pareils » est une vente fréquente en boutique de téléphone : le
   * client revient, et le caissier resélectionne tout. C'est la fonction
   * « repeat last transaction » que tous les POS du commerce ont en standard.
   *
   * La reprise AJOUTE au panier, elle ne le remplace jamais : un clic ne peut
   * donc rien détruire, et aucune confirmation n'est demandée. Un raccourci
   * qui puisse vider une vente en cours serait plus dangereux que le temps
   * qu'il fait gagner.
   */
  const [ventePrecedente, setVentePrecedente] = useState<{
    id: string;
    lignes: { product_id: string; quantity: number; unit_price: number }[];
    total: number;
    nbLignes: number;
    nbIgnorees: number;
  } | null>(null);

  /**
   * Le caissier a fermé la proposition de reprise (le X) — mémorisé PAR VENTE.
   *
   * Avant, un booléen remis à zéro à chaque remontage : la caisse étant
   * démontée hors de son onglet, changer d'onglet puis revenir faisait
   * revenir le bandeau, encore et encore. La fermeture est maintenant
   * attachée à l'identifiant de la vente et survit dans localStorage : fermer
   * vaut pour CETTE vente-là, quelle que soit la navigation ; une NOUVELLE
   * vente (autre identifiant) réaffiche le bandeau, ce qui est son travail.
   */
  const CLE_REPRISE = 'gl:reprise-fermee';
  const [repriseFermeeId, setRepriseFermeeId] = useState<string | null>(() => {
    try {
      return window.localStorage?.getItem(CLE_REPRISE);
    } catch {
      return null;
    }
  });
  const fermerReprise = (idVente: string) => {
    setRepriseFermeeId(idVente);
    try {
      window.localStorage?.setItem(CLE_REPRISE, idVente);
    } catch {
      /* stockage indisponible : la fermeture vaut pour la session */
    }
  };

  /**
   * Catalogue de la caisse : non archivé, puis filtré et classé.
   *
   * Les articles EN RUPTURE restent visibles, marqués « Rupture », au lieu de
   * disparaître. C'est le premier écart avec les caisses du commerce : un
   * client demande de l'huile, le caissier tape « huile », et l'écran ne
   * répondait rien — impossible de distinguer « on n'en a plus » de « on
   * n'en vend pas ». Le stock parti signifie « plus pour l'instant », pas
   * « ça n'existe pas ici ».
   *
   * Le classement vient de `rechercher()`, qui tolère les fautes de frappe,
   * trouve une variante par son nombre (« 128/6 ») et un article par son prix.
   * Le simple `includes()` d'avant renvoyait « aucun résultat » sur une faute —
   * ce que le caissier lisait comme une rupture de stock.
   */
  const disponibles = useMemo(
    () =>
      products.filter(
        (p) =>
          p.is_active !== false &&
          // Un ingrédient n'est pas un article de vente : il vit dans le Stock.
          estVendableAuMenu(p, dishIds, ingredientIds),
      ),
    [products, ingredientIds, dishIds],
  );

  /**
   * Les + vendus remontent devant tout le reste.
   *
   * Dans une boutique de quartier, les mêmes références se vendent des
   * centaines de fois : les classer en tête rend la grille inutile. C'est
   * ce qui répond à « 1000 articles » : le classement rend la longueur du
   * catalogue indifférente.
   */
  const parFrequence = useMemo(() => {
    if (Object.keys(plusVendus).length === 0) return disponibles;
    return [...disponibles].sort((a, b) => {
      const va = plusVendus[a.id] ?? 0;
      const vb = plusVendus[b.id] ?? 0;
      if (va !== vb) return vb - va;
      return a.name.localeCompare(b.name, 'fr');
    });
  }, [disponibles, plusVendus]);

  const [tri, setTri] = useState<'frequence' | 'nom' | 'prixAsc' | 'prixDesc' | 'stockAsc'>('frequence');

  const filtered = useMemo(() => {
    // La recherche porte sur TOUT le catalogue, jamais sur la seule catégorie
    // retenue. Filtrer sur « laptop » puis chercher « a17 » ne doit pas
    // disparaître : le caissier taperait trois mots de plus, ne trouverait
    // rien, croiraitait que le téléphone n'existe pas. La catégorie est un
    // filtre de parcours ; la recherche est une recherche.
    let list = search.trim()
      ? rechercher(parFrequence, search).map((r) => r.product)
      : categorie === null
        ? parFrequence
        : parFrequence.filter((p) => (p.category ?? '') === categorie);

    if (tri === 'nom') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    else if (tri === 'prixAsc') list = [...list].sort((a, b) => a.price_sell - b.price_sell);
    else if (tri === 'prixDesc') list = [...list].sort((a, b) => b.price_sell - a.price_sell);
    else if (tri === 'stockAsc') list = [...list].sort((a, b) => a.stock_qty - b.stock_qty);
    return list;
  }, [parFrequence, categorie, search, tri]);

  /** Les catégories présentes dans le catalogue, pour la barre de filtres. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of parFrequence) if (p.category?.trim()) set.add(p.category.trim());
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }, [parFrequence]);

  /**
   * Les + vendus sur 30 jours.
   *
   * L'échec est silencieux et assumé : la fonction est verrouillée par plan, et
   * une bannière d'erreur au-dessus d'une grille de produits nuirait plus au
   * commerce qu'elle n'informerait.
   */
  const chargerPlusVendus = useCallback(async () => {
    // Sans le plan, on n'appelle même pas : la base répondrait 403 à chaque
    // ouverture de la caisse, une erreur réseau pour rien dans la console.
    if (!ownerId || !isFeatureAllowed(plan, 'forecast')) return;
    try {
      const { data, error } = await supabase.rpc('get_units_sold_since', { p_days: 30 });
      if (error || !data) return;
      const map: Record<string, number> = {};
      for (const l of data as { product_id: string; quantity: number }[]) {
        if (l?.product_id) map[l.product_id] = Number(l.quantity ?? 0);
      }
      setPlusVendus(map);
    } catch {
      // plan gratuit ou starter : pas de classement, sans le dire.
    }
  }, [supabase, ownerId, plan]);

  useEffect(() => {
    void chargerPlusVendus();
  }, [chargerPlusVendus]);

  /**
   * Charge la dernière vente pour la proposer en un clic.
   *
   * Silencieux comme le classement : pas de dernière vente, pas de bouton. Une
   * ligne dont le produit a quitté le catalogue est comptée à part plutôt que
   * d'être remontée en erreur — le caissier n'a rien à faire pour la retirer.
   */
  const chargerDerniereVente = useCallback(async () => {
    if (!ownerId) return;
    try {
      const { data: ventes, error } = await supabase
        .from('sales')
        .select('id, total_amount')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error || !ventes?.length) {
        setVentePrecedente(null);
        return;
      }
      const vente = ventes[0] as { id: string; total_amount: number };
      const { data: lignes, error: errLignes } = await supabase
        .from('sale_items')
        .select('product_id, quantity, unit_price')
        .eq('sale_id', vente.id);
      if (errLignes || !lignes) {
        setVentePrecedente(null);
        return;
      }
      const presents = new Set(products.map((p) => p.id));
      const retenues = (lignes as { product_id: string; quantity: number; unit_price: number }[])
        .filter((l) => presents.has(l.product_id));
      setVentePrecedente({
        id: vente.id,
        lignes: retenues,
        total: Number(vente.total_amount ?? 0),
        nbLignes: retenues.length,
        nbIgnorees: lignes.length - retenues.length,
      });
    } catch {
      setVentePrecedente(null);
    }
  }, [supabase, ownerId, products]);

  useEffect(() => {
    void chargerDerniereVente();
  }, [chargerDerniereVente]);

  /** Recopie les lignes de la dernière vente dans le panier, sans rien écraser. */
  const reprendreDerniereVente = useCallback(() => {
    if (!ventePrecedente || ventePrecedente.lignes.length === 0) return;
    const parId = new Map(products.map((p) => [p.id, p]));

    setCart((prev) => {
      const suivant = prev.map((l) => ({ ...l }));
      for (const l of ventePrecedente.lignes) {
        const produit = parId.get(l.product_id);
        if (!produit) continue;
        const qte = Number(l.quantity ?? 0);
        if (qte <= 0) continue;
        const ligne = suivant.find((i) => i.product.id === produit.id);
        if (ligne) {
          // Jamais au-delà du stock : c'est la caisse qui refuse au dernier
          // moment, et le caissier perd alors la vente entière.
          ligne.quantity = dishIds.has(produit.id)
            ? ligne.quantity + qte
            : Math.min(ligne.quantity + qte, produit.stock_qty);
        } else {
          // Prix négocié repris aussi : « reprendre la dernière vente » doit
          // redonner la vente telle qu'elle a été conclusé, pas au prix
          // catalogue. On ne le pose que s'il diffère du catalogue — sinon
          // `null` garde le comportement habituel (prix courant du produit).
          const prixConvenu = Number(l.unit_price);
          const prixCatalogue = Number(produit.price_sell);
          suivant.push({
            product: produit,
            quantity: dishIds.has(produit.id) ? qte : Math.min(qte, produit.stock_qty),
            unitPrice: Number.isFinite(prixConvenu) && prixConvenu !== prixCatalogue
              ? prixConvenu
              : null,
          });
        }
      }
      return suivant;
    });

    if (!grandEcran) setPanierOuvert(true);
  }, [ventePrecedente, products, dishIds, grandEcran]);

  /**
   * Une frappe sur une lettre met le curseur dans la recherche.
   *
   * C'est le geste de toutes les caisses à clavier : on commence à taper sans
   * viser un champ. Sans cela il faut viser le champ à la souris, puis taper —
   * deux gestes là où un seul suffit.
   */
  useEffect(() => {
    const surFrappe = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const cible = e.target as HTMLElement | null;
      if (cible) {
        const balise = cible.tagName;
        if (balise === 'INPUT' || balise === 'TEXTAREA' || balise === 'SELECT') return;
        if (cible.isContentEditable) return;
      }
      if (e.key.length !== 1 || e.key === ' ') return;
      // Dialogue ouvert (ajout de produit, reçu de vente) : la frappe lui
      // appartient. Sans ce garde, taper sur un bouton du dialogue enverrait
      // le focus derrière la fenêtre, où l'utilisateur ne verrait rien se
      // passer — et Radix, pare-feu de focus, le renverrait dedans en boucle.
      if (document.querySelector('[role="dialog"]')) return;
      rechercheRef.current?.focus();
    };
    window.addEventListener('keydown', surFrappe);
    return () => window.removeEventListener('keydown', surFrappe);
  }, []);

  /**
   * Rendu par tranches, sans clic : la tranche suivante se charge d'elle-même
   * quand « Afficher plus » entre dans le champ (un peu avant, via
   * rootMargin). À 200 références, la 150e s'arrêtait sur un bouton toutes
   * les 60 références — maintenant on défile jusqu'au bout. Le bouton reste
   * en repli pour le clavier et le lecteur d'écran.
   *
   * L'observateur est recréé à chaque tranche : une observation déclenche
   * toujours une première entrée, ce qui couvre le cas (écran très haut)
   * où le bouton resterait visible après l'augmentation.
   *
   * Garde jsdom : IntersectionObserver n'existe pas là-bas et les tests ne
   * simulent pas le défilement — ils cliquent sur le bouton, qui reste.
   */
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((n) => n + PRODUCT_PAGE_SIZE);
        }
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);

  // Rendu par tranches. La recherche porte sur tout le catalogue : une caissière
  // qui tape « Nokia » doit le trouver même si la carte est à la position 800.
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  );

  // Quantité au panier par produit, passée aux cartes mémoïsées : elle ne
  // change que pour le produit concerné, donc les autres cartes ne se
  // re-rendent pas à chaque geste du panier.
  const quantites = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of cart) m.set(i.product.id, i.quantity);
    return m;
  }, [cart]);

  // Prix effectif de la ligne : prix convenu s'il y en a un, sinon catalogue.
  const linePrice = (item: CartItem) => item.unitPrice ?? item.product.price_sell;

  /**
   * Unités, pas lignes de panier. Deux fois le même téléphone est « 2 articles »
   * et non « 1 » : dire « 1 article » pour deux GSM donne au
   * caissier l'impression d'une erreur — et la pastille du produit
   * ne comptait que la ligne.
   */
  const unites = useMemo(
    () => cart.reduce((n, l) => n + l.quantity, 0),
    [cart],
  );

  const total = useMemo(
    () => cart.reduce((sum, item) => sum + linePrice(item) * item.quantity, 0),
    [cart]
  );

  /** Remise totale accordée sur le panier, en FCFA. */
  const totalDiscount = useMemo(
    () => cart.reduce(
      (sum, item) => sum + (item.product.price_sell - linePrice(item)) * item.quantity,
      0
    ),
    [cart]
  );

  /** Lignes dont le prix convenu passe sous le prix d'achat. */
  const atLossLines = useMemo(
    () => cart.filter((i) => linePrice(i) < i.product.price_buy).length,
    [cart]
  );

  /** Ce que le client a réellement posé sur le comptoir. */
  const donne = lireMontant(String(amountGiven)) ?? 0;

  // ── Crédit client ──
  // Une vente à crédit exige un nom ET un téléphone : sans numéro, la dette
  // n'est rattachable à personne et la relance WhatsApp devient impossible.
  // On le signale pendant la saisie plutôt qu'après l'échec du serveur.
  const creditNeedsPhone = paymentMethod === 'credit' && !clientPhone.trim();

  // ── Acompte ──
  // lireMontant : virgule ou point, et « 5.000 » lu comme cinq mille.
  const advanceBrut = lireMontant(advance);
  const advanceOk = !advance.trim() || (advanceBrut !== null && advanceBrut >= 0);
  const advanceAmount = advanceOk ? Math.min(advanceBrut ?? 0, 1e12) : 0;
  // Un acompte supérieur au prix n'est pas un acompte, c'est un trop-perçu : le
  // serveur le refuse, et le signaler ici évite une erreur rouge après coup.
  const advanceTooHigh = paymentMethod === 'credit' && advanceAmount > total;
  const remaining = Math.max(total - advanceAmount, 0);
  const creditFormIncomplete =
    paymentMethod === 'credit' && (creditNeedsPhone || !clientName.trim() || !advanceOk || advanceTooHigh);

  const addToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        // Jamais au-delà du stock... SAUF pour un plat : son stock propre vaut 0
        // par nature, et une borne à 0 figerait la ligne à 0 — le plat serait
        // invendable au comptoir, comme en salle.
        const plafond = dishIds.has(product.id) ? Number.POSITIVE_INFINITY : product.stock_qty;
        if (existing.quantity >= plafond) return prev;
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1, unitPrice: null }];
    });
  }, [dishIds]);

  /**
   * Clic sur une tuile du catalogue.
   *
   * Un article en rupture ne s'ajoute pas — il répond. Le message est le même
   * que celui du scanner, parce que c'est la même situation vue de deux
   * endroits : le client demande un produit, la caisse n'a plus rien. Le
   * caissier peut alors dire « il n'y en a plus » au lieu de chercher pourquoi
   * le produit n'est pas dans la liste.
   */
  const ajouter = useCallback((product: Product) => {
    if (!vendable(product)) {
      setScanError(`« ${product.name} » est en rupture de stock.`);
      return;
    }
    setScanError('');
    addToCart(product);
  }, [vendable, addToCart]);

  /**
   * Quantité saisie. Le champ est décimal : « 1,2 » comme « 1.2 » sont acceptés
   * — un clavier de téléphone au Bénin produit les deux.
   *
   * La valeur est bornée au stock, mais pas refusée au-delà : la caisse doit
   * pouvoir terminer sa saisie. C'est create_sale() qui refuse, avec un message
   * qui nomme le produit et les deux quantités.
   */
  const setLineQty = useCallback((productId: string, raw: string) => {
    setCart((prev) => prev.map((i) => {
      if (i.product.id !== productId) return i;
      const n = lireMontant(raw);
      if (n === null || n <= 0) return i;
      return { ...i, quantity: Math.min(n, 1000000) };
    }));
  }, []);

  const setLinePrice = useCallback((productId: string, raw: string) => {
    setCart((prev) => prev.map((i) => {
      if (i.product.id !== productId) return i;
      // Vide = retour au prix catalogue, pas un prix à zéro.
      if (raw.trim() === '') return { ...i, unitPrice: null };
      const n = lireMontant(raw);
      if (n === null || n <= 0) return i;
      return { ...i, unitPrice: n };
    }));
  }, []);

  // Demande d'ajout venue du scanner (page parente). Le `token` permet de
  // re-scanner deux fois le même SKU : comparer la seule valeur de productId
  // ferait ignorer le second scan.
  //
  // La requête est CONSOMMÉE, pas simplement lue : addToCartRequest ne change
  // jamais dans le parent, alors que products, lui, est remplacé par un
  // nouveau tableau à chaque fetchProducts() — et onSaleComplete pointe
  // justement sur fetchProducts. Sans ce jeton, l'enchaînement « scan →
  // encaissement → setCart([]) → fetchProducts » relançait l'effet et
  // réajoutait le produit scanné au panier qu'on venait de vider.
  const consumedToken = useRef<number | null>(null);
  useEffect(() => {
    if (!addToCartRequest) return;
    // Déjà traité : on ne revient pas, quel que soit le nombre de refreshs.
    if (consumedToken.current === addToCartRequest.token) return;
    // Consommé d'office, y compris dans les branches de refus : sinon le
    // message « rupture de stock » réapparaîtrait à chaque actualisation, et
    // la requête survivrait au remontage du composant.
    consumedToken.current = addToCartRequest.token;
    onAddToCartHandled?.();

    const product = products.find((p) => p.id === addToCartRequest.productId);
    if (!product) {
      setScanError('Produit introuvable.');
      return;
    }
    if (!vendable(product)) {
      setScanError(`« ${product.name} » est en rupture de stock.`);
      return;
    }
    setScanError('');
    addToCart(product);
  }, [addToCartRequest, products, addToCart, onAddToCartHandled, vendable]);

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, []);

  const handleCheckout = async () => {
    if (cart.length === 0 || loading) return;
    setCheckoutError('');
    setLoading(true);

    // Tout ce qui prépare l'appel est calculé AVANT le try : le catch a besoin
    // de `payload` et `refVente` pour mettre la vente en file hors-ligne. Rien
    // ici ne lève.
    const items = cart.map((i) => ({
      product_id: i.product.id,
      quantity: i.quantity,
      // Absent quand le prix catalogue s'applique : le serveur garde alors
      // son comportement habituel. Envoyé seulement s'il y a eu marchandage.
      ...(i.unitPrice !== null ? { unit_price: i.unitPrice } : {}),
    }));

    // Le crédit passe par record_credit_sale() et non create_sale() : c'est
    // elle qui rattache la vente à un numéro de téléphone et la marque non
    // encaissée. create_sale() refuse 'credit' volontairement — un appel
    // direct créerait une vente comptée comme encaissée, sans dette derrière.
    const fn = paymentMethod === 'credit' ? 'record_credit_sale' : 'create_sale';
    // Référence idempotente de la vente (client_ref) : hors-ligne, une vente
    // rejouée ne doit pas être créée deux fois. Vaut pour l'espèces, le MoMo
    // ET le crédit — record_credit_sale() la vérifie aussi, dette comprise.
    const refVente = nouvelleRefVente();
    const payload = paymentMethod === 'credit'
      ? {
          p_items: items,
          p_client_name: clientName.trim(),
          p_client_phone: clientPhone.trim(),
          // Acompte : 0 = crédit total. La colonne amount_received en base ne
          // connaît que ce montant, donc c'est le seul endroit où il doit être
          // décidé.
          p_advance: advanceAmount,
          // Moyen du versement : compté en « cash » avant, un moyen déduit
          // et non choisi. Sans acompte, le serveur ne lit pas ce champ.
          p_advance_method: advanceMethod,
          p_client_ref: refVente,
        }
      : {
          p_items: items,
          p_payment_method: paymentMethod,
          p_client_name: clientName.trim() || null,
          p_client_ref: refVente,
        };

    // Bascule hors-ligne : met la vente en file et affiche le reçu provisoire.
    // Renvoie true si la vente a bien été mise en file — l'appelant s'arrête.
    const basculerHorsLigne = async (): Promise<boolean> => {
      if (!refVente) return false;
      const estCredit = paymentMethod === 'credit';
      const mise = await mettreEnFile({
        ref: refVente,
        cree: Date.now(),
        // Le crédit se rejoue par record_credit_sale() : c'est elle qui crée
        // la dette, create_sale() la refuse.
        fn: estCredit ? 'record_credit_sale' : 'create_sale',
        payload: payload as Record<string, unknown>,
        // Résumé lisible pour l'écran « ventes en attente » : le payload ne
        // porte que des identifiants, pas les noms.
        resume: {
          total,
          libelle: cart.map((i) => `${formatQty(i.quantity)}× ${i.product.name}`).join(', '),
        },
      });
      if (!mise) return false;
      // Reçu provisoire : total calculé localement (le serveur n'a rien
      // renvoyé), aucun numéro de facture. La vente est en file, elle sera
      // rejouée au retour du réseau — la référence la rend idempotente.
      const waLink = generateWhatsAppReceiptLink(
        {
          items: cart.map((i) => ({
            product_name: i.product.name,
            quantity: i.quantity,
            unit_price: linePrice(i),
            subtotal: linePrice(i) * i.quantity,
          })),
          total,
          paymentMethod,
          date: new Date(),
          businessName: org?.name,
          plan,
          advance: estCredit ? advanceAmount : 0,
          due: estCredit ? remaining : 0,
        },
        clientPhone.trim() || undefined
      );
      const given = lireMontant(String(amountGiven)) ?? 0;
      setReceipt({
        saleId: refVente,
        invoiceNumber: null,
        waLink,
        items: [...cart],
        total,
        paymentMethod,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        amountGiven: given,
        change: paymentMethod === 'cash' && given >= total ? given - total : 0,
        date: new Date(),
        isCredit: estCredit,
        advance: estCredit ? advanceAmount : 0,
        due: estCredit ? remaining : 0,
        offline: true,
      });
      setCart([]);
      setClientName('');
      setClientPhone('');
      setAmountGiven('');
      setAdvance('');
      setPanierOuvert(false);
      return true;
    };

    // Panne réseau, et non refus métier. La détection porte sur le message BRUT
    // renvoyé par Supabase : la version traduite par readableSaleError() ne
    // contient plus « failed to fetch », et c'est précisément ce qui empêchait
    // la bascule hors-ligne de se déclencher.
    const estPanneReseau = (msg: string) =>
      /failed to fetch|networkerror|fetch failed|load failed|network request failed/i.test(msg);

    try {
      const { data, error: saleErr } = await supabase.rpc(fn, payload);

      if (saleErr) {
        // Réseau coupé : la vente n'est pas perdue, on la met en file.
        if (estPanneReseau(saleErr.message) && await basculerHorsLigne()) return;
        throw new Error(readableSaleError(saleErr.message));
      }
      if (!data || typeof data !== 'object') throw new Error("La vente n'a pas pu être enregistrée.");

      // Total et numéro de facture sont ceux retenus par le serveur.
      const saleId = String(data.id);
      const serverTotal = Number(data.total_amount ?? total);
      const invoiceNumber = (data.invoice_number as string | null) ?? null;
      const creditPhone = (data as { client_phone?: string }).client_phone ?? null;

      // ── À partir d'ici, la vente EST commitée. ────────────────────────
      // Ce qui suit ne doit JAMAIS pouvoir la faire passer pour un échec : le
      // catch plus bas afficherait « la vente n'a pas été enregistrée » et
      // laisserait le panier intact, alors que le stock est déjà sorti et le
      // chiffre d'affaires écrit. La caissière re-saisirait la vente — double
      // décrément, double chiffre d'affaires. Tout ce bloc est donc synchrone,
      // ou lancé sans être attendu.

      // Lien WhatsApp. businessName et phone n'étaient jamais transmis : tous
      // les reçus disaient « Notre Boutique » et s'ouvraient sans destinataire.
      const waLink = generateWhatsAppReceiptLink(
        {
          // Prix réellement encaissé, pas le prix catalogue : envoyer un reçu
          // affichant 15 000 F pour une ligne négociée à 12 000 F met le client
          // et le commerçant en désaccord sur ce qui a été payé.
          items: cart.map((i) => ({
            product_name: i.product.name,
            quantity: i.quantity,
            unit_price: linePrice(i),
            subtotal: linePrice(i) * i.quantity,
          })),
          total: serverTotal,
          paymentMethod,
          date: new Date(),
          businessName: org?.name,
          // Plan effectif (useSupabase) : le pied de diffusion P4 ne s'affiche
          // que sur le gratuit.
          plan,
          // Acompte et reste dû, pour que le message dise la vérité au client.
          // Les deux sont calculés plus haut : sur un crédit, advanceAmount est l'acompte
          // saisi et remaining ce qui reste — les deux viennent du même calcul
          // que le bouton, donc pas de désaccord possible à l'écran.
          advance: paymentMethod === 'credit' ? advanceAmount : 0,
          due: paymentMethod === 'credit' ? remaining : 0,
        },
        clientPhone.trim() || undefined
      );

      const given = lireMontant(String(amountGiven)) ?? 0;
      setReceipt({
        saleId,
        invoiceNumber,
        waLink,
        items: [...cart],
        total: serverTotal,
        paymentMethod,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        amountGiven: given,
        change: paymentMethod === 'cash' && given >= serverTotal ? given - serverTotal : 0,
        date: new Date(),
        // Après un crédit, on revient à l'espèces : enchaîner deux ventes à
        // crédit par inadvertance transformerait une boutique en bureau de
        // crédit sans que personne l'ait voulu.
        isCredit: paymentMethod === 'credit',
        // Renvoyés par la base, qui est la seule à savoir le prix retenu après
        // les remises. Les recalculer ici donnerait un reçu différent du dû en
        // cas d'arrondi.
        advance: Number((data as { amount_advance?: number }).amount_advance ?? 0),
        due: Number((data as { amount_due?: number }).amount_due ?? serverTotal),
      });
      setCart([]);
      setClientName('');
      setClientPhone('');
      setAmountGiven('');
      setAdvance('');
      // Le panneau se referme avec la vente : le caisser doit voir la grille
      // vide pour la vente suivante, pas un panier vide à faire fermer.
      setPanierOuvert(false);
      if (paymentMethod === 'credit') setPaymentMethod('cash');

      // Journal d'activité : best-effort ET hors du chemin critique. On ne
      // l'attend pas : son échec (réseau, RLS) ne doit ni retarder ni invalider
      // l'affichage du reçu. cart, paymentMethod, data et serverTotal sont figés
      // par cette closure — setCart([]) ci-dessus ne les altère pas.
      void (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user || !ownerId) return;
          const itemsDesc = cart
            .map((i) => `${i.quantity}x ${i.product.name}`)
            .join(', ');
          // La remise est mentionnée dans le journal : c'est elle qui rend la
          // concession lisible plus tard, quand le prix convenu n'est plus
          // déductible de la ligne de vente.
          const remise = Number((data as { discount_amount?: number })?.discount_amount ?? 0);
          const moyen = paymentMethod === 'cash' ? 'Espèces'
            : paymentMethod === 'momo' ? 'MoMo' : 'Crédit';
          await logActivity({
            ownerId,
            actorId: user.id,
            actorEmail: user.email ?? '',
            actorName,
            action: 'sale',
            description:
              `Vente ${formatCFA(serverTotal)} (${moyen}) : ${itemsDesc}` +
              (remise > 0 ? `, remise ${formatCFA(remise)}` : ''),
            metadata: {
              sale_id: saleId,
              total: serverTotal,
              payment_method: paymentMethod,
              discount: remise,
              // Un crédit cède la marchandise sans encaissement : le dire dans
              // le journal est ce qui permet, des mois plus tard, de comprendre
              // pourquoi le chiffre d'affaires ne correspond pas aux articles
              // sortis du stock.
              ...(paymentMethod === 'credit' ? { credit_to: creditPhone } : {}),
            },
          });
        } catch (e) {
          // Une écriture d'audit manquée ne remonte jamais à l'écran.
          console.error("[pos] journal d'activité non écrit", e);
        }
      })();

      // Callbacks du parent : un throw synchrone ne doit pas non plus être pris
      // pour un échec d'encaissement.
      try {
        onSaleComplete?.();
      } catch (e) {
        console.error('[pos] onSaleComplete a échoué', e);
      }

      // Le bandeau « Reprendre la dernière vente » doit basculer sur la
      // vente qu'on vient de valider sans attendre le rechargement du
      // catalogue du parent. Ce lien indirect — un nouveau tableau de
      // produits qui relançait l'effet de chargement — suffisait, en
      // pratique, à laisser l'ancienne vente affichée : un échec ou un
      // retard de ce rechargement, et le bandeau ne bougeait plus alors
      // que la vente était déjà validée et clôturée. create_sale a commité
      // avant de renvoyer, donc la requête ci-dessous voit la nouvelle
      // vente, immédiatement.
      void chargerDerniereVente();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur inconnue';
      // Repli : l'appel RPC peut aussi rejeter directement (fetch qui lève) au
      // lieu de renvoyer { error }. Même bascule, sur le message brut.
      if (estPanneReseau(message) && await basculerHorsLigne()) return;
      setCheckoutError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full">
      {/* ── Grille produits ── */}
      {/* pb-24 : la barre du bas est fixe, sans cette réserve la dernière
          rangée de produits passe dessous et devient incliquable.
          inert : quand le panneau est ouvert il recouvre la grille, qui doit
          alors sortir du parcours de tabulation et des lecteurs d'écran —
          sinon le clavier saute dans un contenu que l'utilisateur ne voit pas. */}
      {/* inert seulement quand le panneau plein écran recouvre réellement la
          grille : à partir de lg le panier est une colonne, et inert rendait
          tout le catalogue inaccessible au clavier pour rien. */}
      <div className="flex-1 min-w-0 space-y-4 pb-24 lg:pb-0" inert={panierOuvert && !grandEcran}>
        {/* Recherche collante sur grand écran : à 200 références, descendre
            au produit 150 puis remonter à la recherche pour une autre
            requête était un aller-retour à chaque frappe. relative reste le
            socle de l'icône en absolu ; lg:sticky épingle le champ en haut
            de la colonne, et bg ferme les coins arrondis sur la liste qui
            défile dessous. */}
        <div className="relative lg:sticky lg:top-0 z-20 bg-slate-50">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            ref={rechercheRef}
            placeholder="Rechercher un produit ou un prix"
            aria-label="Rechercher un produit, une variante ou un prix"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Reprendre la dernière vente. Au-dessus de la grille : l'action vaut un
            clic si elle est visible sans défiler.
            Conteneur + deux boutons : imbriquer le X dans le bouton de reprise
            donnerait un bouton dans un bouton (HTML invalide), et le X perdrait
            alors sa propre cible d'accessibilité. */}
        {ventePrecedente && ventePrecedente.nbLignes > 0 && ventePrecedente.id !== repriseFermeeId && (
          <div className="flex w-full items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-indigo-800">
            <button
              onClick={reprendreDerniereVente}
              className="flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left transition-colors hover:bg-indigo-100"
              aria-label={`Ajouter au panier les ${ventePrecedente.nbLignes} articles de la dernière vente`}
            >
              <RotateCcw className="h-4 w-4 shrink-0" />
              <span className="text-sm font-medium">Reprendre la dernière vente</span>
              <span className="text-xs text-indigo-600">
                {ventePrecedente.nbLignes} article{ventePrecedente.nbLignes > 1 ? 's' : ''} ·{' '}
                {formatCFA(ventePrecedente.total)}
              </span>
              {ventePrecedente.nbIgnorees > 0 && (
                <span className="ml-auto text-xs text-amber-700">
                  {ventePrecedente.nbIgnorees} retiré{ventePrecedente.nbIgnorees > 1 ? 's' : ''} du
                  catalogue
                </span>
              )}
            </button>
            <button
              onClick={() => { if (ventePrecedente) fermerReprise(ventePrecedente.id); }}
              aria-label="Masquer la reprise de la dernière vente"
              className="shrink-0 rounded p-1.5 text-indigo-400 transition-colors hover:bg-indigo-100 hover:text-indigo-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Barre de catégories, collante sous la recherche.
            C'est ce qui remplace le défilement quand le catalogue est grand :
            on choisit un rayon au lieu de parcours 1000 cartes. sticky pour que
            le filtre reste atteignable au milieu de la liste.
            lg:top-10 : sur grand écran la recherche est épinglée juste au
            dessus (h-10 = 40 px) — les deux barres se calent l'une sous
            l'autre sans se recouvrir. Sur mobile la recherche défile, le
            top-14 d'origine reste juste. */}
        {categories.length > 1 && (
          <div className="sticky top-14 lg:top-10 z-10 -mx-1 bg-slate-50/95 backdrop-blur px-1 py-1">
            {/* flex-wrap et non overflow-x-auto : en rangée non-wrap, la
                somme des pastilles (~840 px) devient la largeur minimale de
                toute la colonne, qui écrase alors le panneau du panier. Le
                défilement horizontal masquait en plus les rayons de droite. */}
            <div className="flex flex-wrap gap-1.5 pb-1" role="group" aria-label="Filtrer par catégorie">
              <button
                onClick={() => setCategorie(null)}
                aria-pressed={categorie === null}
                className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                  categorie === null
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                Tous
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategorie(categorie === c ? null : c)}
                  aria-pressed={categorie === c}
                  className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                    categorie === c
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Le compteur évite qu'un commerçant cherche un produit absent en
            croyant qu'il n'existe pas : avec 1 000 références, une grille
            tronquée sans indication paraît vide. flex-wrap : en colonne
            étroite (petit écran), une rangée non-wrap déborderait. */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span>
            {filtered.length} produit{filtered.length > 1 ? 's' : ''}
            {search.trim() && ` pour « ${search.trim()} »`}
            {search.trim() && categorie !== null && ', tout le catalogue'}
          </span>
          {visibleProducts.length < filtered.length && (
            <span>affichage par tranches</span>
          )}
          <button
            type="button"
            onClick={basculerVue}
            className="ml-auto rounded-lg border border-slate-200 px-2 py-1 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
            aria-label={vue === 'liste' ? 'Passer en vue grille' : 'Passer en vue liste'}
          >
            {vue === 'liste' ? 'Vue grille' : 'Vue liste'}
          </button>
          <select
            aria-label="Tri des produits"
            value={tri}
            onChange={(e) => setTri(e.target.value as typeof tri)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {/* Sans le classement (plan Pro), ce tri garde l'ordre du
                catalogue : l'appeler « les plus vendus » serait faux. */}
            <option value="frequence">
              {isFeatureAllowed(plan, 'forecast') ? 'Les plus vendus' : 'Ordre du catalogue'}
            </option>
            <option value="nom">Nom A–Z</option>
            <option value="prixAsc">Prix croissant</option>
            <option value="prixDesc">Prix décroissant</option>
            <option value="stockAsc">Stock faible d&apos;abord</option>
          </select>
        </div>

        {vue === 'liste' ? (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {visibleProducts.map((p) => (
              <LigneProduit
                key={p.id}
                produit={p}
                quantite={quantites.get(p.id) ?? 0}
                vendable={vendable(p)}
                estPlat={dishIds.has(p.id)}
                onAjouter={ajouter}
              />
            ))}

            {filtered.length === 0 && (
              <div className="p-6">
                {search.trim() ? (
                  <div className="text-center text-sm text-slate-500">
                    Aucun produit ne correspond à « {search.trim()} »
                  </div>
                ) : (
                  <EmptyState
                    icon={PackageX}
                    title="Aucun produit disponible"
                    hint="Ajoutez d’abord vos produits depuis l’onglet Stock : ils apparaîtront ici pour la caisse."
                  />
                )}
              </div>
            )}
          </div>
        ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {visibleProducts.map((p) => (
            <CarteProduit
              key={p.id}
              produit={p}
              quantite={quantites.get(p.id) ?? 0}
              vendable={vendable(p)}
              estPlat={dishIds.has(p.id)}
              onAjouter={ajouter}
            />
          ))}

          {filtered.length === 0 && (
            <div className="col-span-full">
              {search.trim() ? (
                <div className="py-12 text-center text-sm text-slate-500">
                  Aucun produit ne correspond à « {search.trim()} »
                </div>
              ) : (
                <EmptyState
                  icon={PackageX}
                  title="Aucun produit disponible"
                  hint="Ajoutez d’abord vos produits depuis l’onglet Stock : ils apparaîtront ici pour la caisse."
                />
              )}
            </div>
          )}
        </div>
        )}

        {/* Pagination par tranches plutôt que rendu de 1 000 cartes : le DOM
            devient inutilisable sur un téléphone, et une caissière doit
            trouver un produit en deux secondes. La recherche porte toujours
            sur le catalogue entier, pas sur la tranche affichée. */}
        {visibleProducts.length < filtered.length && (
          <button
            ref={loadMoreRef}
            onClick={() => setVisibleCount((n) => n + PRODUCT_PAGE_SIZE)}
            className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
          >
            Afficher plus de produits
            <span className="text-slate-500 font-normal">
              {' '}({visibleProducts.length} / {filtered.length})
            </span>
          </button>
        )}
      </div>

      {/* ── Panier ──
          Sur grand écran : une colonne à droite, toujours visible.
          Sur mobile : absent du flux, et la barre fixe du bas l'ouvre en
          plein écran. Sans cette bifurcation, il se retrouvait sous les
          produits — il fallait défiler tout le catalogue pour encaisser.
          lg:shrink-0 : sans ce garde-fou, la colonne produits (flex-1) peut
          comprimer le panneau jusqu'à sa largeur minimale (~135 px), où les
          libellés client et les boutons de paiement se chevauchent.
          lg:sticky : la caisse suit le défilement. Sur 200 produits, atteindre
          la référence 150 laissait total et « Encaisser » en haut de page —
          chaque ajout devenait un aller-retour. max-h borné à la fenêtre :
          les articles défilent à l'intérieur du panneau, le pied (client,
          total, paiement, bouton) reste toujours visible sans défiler. */}
      {/* panierOuvert ET !grandEcran : à partir de lg le panier est la colonne
          de droite. Sans le `!grandEcran`, l'état resté vrai après un agrandissement
          de fenêtre (rotation, branchement d'un second écran) faisait basculer le
          panier en calque `fixed inset-0` par-dessus toute l'application —
          navigation comprise, donc un écran mort. */}
      <div
        className={
          panierOuvert && !grandEcran
            ? 'fixed inset-0 z-40 bg-white flex flex-col gap-3 p-4 overflow-hidden'
            : 'hidden lg:flex lg:w-80 lg:shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto flex-col gap-3'
        }
      >
        <div className="flex items-center gap-2 font-semibold text-slate-700">
          <ShoppingCart className="h-5 w-5 text-indigo-600" />
          Panier
          {unites > 0 && (
            <Badge className="ml-auto bg-indigo-600">{unites}</Badge>
          )}
          {/* Présent seulement quand le panneau a été ouvert, c'est-à-dire
              depuis la barre du bas. Sans le `lg:hidden`, un passage en
              grand écran après ouverture (rotation du téléphone) laisserait
              la grille inerte sans issue visible pour la réactiver. */}
          {panierOuvert && !grandEcran && (
            <button
              onClick={() => setPanierOuvert(false)}
              className="ml-auto p-1 text-slate-500 hover:text-slate-700"
              aria-label="Fermer le panier et revenir aux produits"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Articles — la zone défilante. Elle prend la hauteur qu'il reste
            dans le panneau : plein écran sur mobile, bornée par le max-h du
            panneau sur grand écran. Total et « Encaisser » restent donc
            toujours en bas, visibles, sans aller-retour de défilement. */}
        <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
          {cart.length === 0 ? (
            <div className="text-center text-slate-500 py-10 text-sm">
              Cliquez sur un produit pour l&apos;ajouter
            </div>
          ) : (
            cart.map((item) => {
              const prix = linePrice(item);
              const remise = item.product.price_sell - prix;
              const sousCout = prix < item.product.price_buy;
              return (
              <Card
                key={item.product.id}
                className={`shadow-none ${remise ? 'border-amber-300' : 'border-slate-200'}`}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {item.product.name}
                      </div>
                      <div className="text-xs text-indigo-600 font-semibold">
                        {formatCFA(prix * item.quantity)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* Quantité saisie directement : un poids vendu ne
                          s'atteint pas avec des boutons +/-. Le champ reste
                          numérique pour le clavier mobile, et l'unité du
                          produit s'affiche à côté. */}
                      {/* type="text" et non "number" : un champ number REJETTE la virgule —
                        il vide la saisie au lieu de la prendre. Or « 2,5 kg »
                        est ce qu'un client dit, et ce qu'un clavier béninois
                        produit. inputMode="decimal" garde le pavé numérique du
                        téléphone ; le retour arrière du navigateur fonctionne
                        sur un text comme sur un number. Le filtrage reste fait
                        par setLineQty, qui refuse tout ce qui n'est pas un
                        nombre positif. */}
                      <input
                        type="text"
                        inputMode="decimal"
                        value={item.quantity}
                        onChange={(e) => setLineQty(item.product.id, e.target.value)}
                        aria-label={`Quantité pour ${item.product.name}`}
                        className="w-16 rounded-lg border border-slate-200 px-1.5 py-1 text-sm font-bold text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <span className="text-[11px] text-slate-500 w-8">
                        {item.product.unit ?? 'pce'}
                      </span>
                      <button
                        aria-label="Retirer du panier"
                        onClick={() => removeFromCart(item.product.id)}
                        className="ml-1 text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Prix négocié : tapotable directement, sans menu. Un
                      marchandage se fait en trois secondes, un écran
                      supplémentaire le ferait abandonner.
                      Le prix catalogue est un FRÈRE du champ, jamais un
                      overlay par-dessus : « pr-14 » + span absolu recouvrait
                      la saisie dès que le montant dépassait 4 chiffres —
                      deux textes l'un sur l'autre, illisible. */}
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="1"
                      value={item.unitPrice ?? ''}
                      onChange={(e) => setLinePrice(item.product.id, e.target.value)}
                      placeholder={String(item.product.price_sell)}
                      aria-label={`Prix unitaire négocié pour ${item.product.name}`}
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />

                    <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                      {formatCFA(item.product.price_sell)}
                    </span>

                    {remise > 0 && (
                      <span className="shrink-0 text-[11px] font-medium text-amber-700 whitespace-nowrap">
                        −{formatCFA(remise * item.quantity)}
                      </span>
                    )}
                  </div>

                  {/* Vente sous le prix d'achat : signalée, jamais bloquée.
                      Écouler un stock aging est un motif légitime ; ce qui ne
                      l'est pas, c'est de le faire sans le savoir. */}
                  {sousCout && (
                    <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-1">
                      Sous le prix d&apos;achat ({formatCFA(item.product.price_buy)})
                    </p>
                  )}
                </CardContent>
              </Card>
              );
            })
          )}
        </div>

        {scanError && (
          <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {scanError}
          </p>
        )}

        {/* Nom + téléphone client. Facultatif en espèces et MoMo, obligatoire
            en crédit : sans numéro, la dette n'est rattachable à personne.
            Libellés VISIBLES au-dessus des champs et non en placeholder :
            « Téléphone Wht… » tronqué dans une case étroite ne disait rien,
            et disparaissait dès qu'on tapait. Champs en h-10 : la case par
            défaut (h-8) était trop basse pour un pouce. */}
        <div className="border-t border-slate-200 pt-3 space-y-2.5">
          <div className="space-y-1">
            <label htmlFor="pos-client-name" className="text-xs font-medium text-slate-500">
              Nom du client{' '}
              {creditNeedsPhone
                ? <span className="text-amber-600">*</span>
                : <span className="font-normal text-slate-400">(optionnel)</span>}
            </label>
            <Input
              id="pos-client-name"
              aria-label="Nom du client"
              placeholder="Ex. Koffi Adjovi"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              className={`h-10 ${creditNeedsPhone ? 'border-amber-400' : ''}`}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="pos-client-phone" className="text-xs font-medium text-slate-500">
              Téléphone WhatsApp{' '}
              {creditNeedsPhone
                ? <span className="text-amber-600">*</span>
                : <span className="font-normal text-slate-400">(optionnel)</span>}
            </label>
            <Input
              id="pos-client-phone"
              type="tel"
              inputMode="tel"
              aria-label="Téléphone du client"
              placeholder="Ex. +229 97 00 00 00"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              className={`h-10 ${creditNeedsPhone ? 'border-amber-400' : ''}`}
            />
          </div>
          {creditNeedsPhone && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Une vente à crédit exige le nom et le téléphone du client, sans quoi
              la dette ne peut pas être suivie.
            </p>
          )}
        </div>

        {/* Total */}
        <div className="border-t border-slate-200 pt-3 space-y-3">
          {/* Le prix catalogue reste visible quand une remise a été faite :
              sans lui, le commerçant ne peut plus contrôler ce qu'il
              concède, et l'écart se normalise sans qu'on s'en aperçoive. */}
          {totalDiscount > 0 && (
            <div className="flex justify-between text-xs text-slate-500">
              <span>Prix catalogue</span>
              <span className="line-through">{formatCFA(total + totalDiscount)}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold text-slate-800">
            <span>Total</span>
            <span className="text-indigo-600">{formatCFA(total)}</span>
          </div>
          {totalDiscount > 0 && (
            <div className="flex justify-between text-xs text-amber-700 font-medium">
              <span>Remise accordée</span>
              <span>− {formatCFA(totalDiscount)}</span>
            </div>
          )}
          {atLossLines > 0 && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
              {atLossLines} ligne(s) sous le prix d&apos;achat. La vente reste possible.
            </p>
          )}

          {/* Mode de paiement — trois colonnes : le crédit est aussi fréquent
              qu'un paiement normal dans une boutique de quartier, et
              l'enterrer dans un menu le ferait oublier.
              min-w-0 + whitespace-nowrap : les colonnes de grid-cols-3 sont
              minmax(0, 1fr), donc le libellé pouvait déborder de sa case et
              se mêler au bouton voisin — le côté « pas pro » justement. */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setPaymentMethod('cash')}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1 py-2.5 text-xs font-medium transition-colors ${
                paymentMethod === 'cash'
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <CreditCard className="h-4 w-4 shrink-0" />
              Espèces
            </button>
            <button
              onClick={() => setPaymentMethod('momo')}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1 py-2.5 text-xs font-medium transition-colors ${
                paymentMethod === 'momo'
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Smartphone className="h-4 w-4 shrink-0" />
              MoMo
            </button>
            <button
              onClick={() => setPaymentMethod('credit')}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1 py-2.5 text-xs font-medium transition-colors ${
                paymentMethod === 'credit'
                  ? 'border-amber-500 bg-amber-50 text-amber-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Handshake className="h-4 w-4 shrink-0" />
              Crédit
            </button>
          </div>

          {paymentMethod === 'credit' && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Le stock part, mais le chiffre d&apos;affaires n&apos;augmente qu&apos;au
              moment du règlement. La dette apparaîtra dans l&apos;écran Dettes.
            </p>
          )}

          {/* Montant donné + monnaie (espèces uniquement) */}
          {paymentMethod === 'cash' && (
            <div className="space-y-2">
              <div className="space-y-1">
                <label htmlFor="pos-amount-given" className="text-xs font-medium text-slate-500">Montant donné (FCFA)</label>
                <Input
                  id="pos-amount-given"
                  type="number"
                  placeholder={String(total)}
                  value={amountGiven}
                  onChange={(e) => setAmountGiven(e.target.value)}
                  min={0}
                  className="h-10"
                />
              </div>
              {donne >= total && total > 0 && (
                <div className="flex justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                  <span className="text-sm font-medium text-emerald-700">Monnaie à rendre</span>
                  <span className="text-sm font-bold text-emerald-700">
                    {formatCFA(donne - total)}
                  </span>
                </div>
              )}
              {donne > 0 && donne < total && (
                <>
                  <div className="flex justify-between rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                    <span className="text-sm font-medium text-red-600">Reste à payer</span>
                    <span className="text-sm font-bold text-red-600">
                      {formatCFA(total - donne)}
                    </span>
                  </div>
                  {/* Un vente espèces comptée entière alors qu'il manque
                      de l'argent dans la caisse est un chiffre faux, et c'est
                      le chiffre sur lequel le commerçant décide. La vente à
                      crédit existe justement pour ce cas : elle exige le nom et
                      le téléphone du client, donc la dette reste
                      recouvrable. Proposer l'autre voie ici évite qu'on
                      enregistre une vente qui n'a pas été payée. */}
                  <p className="text-[11px] text-red-600">
                    Une vente espèces est enregistrée comme payée en totalité.
                    Pour suivre ce reste à payer, utilisez{' '}
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('credit')}
                      className="underline font-medium hover:text-red-700"
                    >
                      Crédit
                    </button>
                    .
                  </p>
                </>
              )}
            </div>
          )}

          {/* Acompte — le cas « il donne 50 000 sur 130 000 », plus courant en
              boutique de quartier que le crédit total. Le champ est vide par
              défaut : ne pas pré-remplir un champ à chaque vente ferait perdre le
              geste simple, qui est majoritaire. */}
          {paymentMethod === 'credit' && (
            <div className="space-y-2">
              <label htmlFor="pos-advance" className="text-xs font-medium text-slate-500">
                Acompte versé maintenant (FCFA)
              </label>
              <Input
                id="pos-advance"
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                placeholder="Rien, tout à crédit"
                value={advance}
                onChange={(e) => setAdvance(e.target.value)}
                className={`h-10 ${advanceTooHigh ? 'border-red-400' : ''}`}
              />
              {advanceTooHigh ? (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                  L&apos;acompte ne peut pas dépasser le prix de {formatCFA(total)}.
                </p>
              ) : (
                <div className="flex justify-between rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                  <span className="text-sm font-medium text-amber-800">Reste à recouvrer</span>
                  <span className="text-sm font-bold text-amber-900 tabular-nums">
                    {formatCFA(remaining)}
                  </span>
                </div>
              )}
              {/* Moyen de l'acompte — visible seulement quand il y en a un :
                  sans argent reçu, il n'y a rien à ventiler, et une question
                  de plus à chaque vente ferait perdre le geste simple. */}
              {advanceAmount > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-slate-500">
                    Acompte payé en
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setAdvanceMethod('cash')}
                      className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                        advanceMethod === 'cash'
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      Espèces
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdvanceMethod('momo')}
                      className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                        advanceMethod === 'momo'
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      MoMo
                    </button>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-slate-500">
                L&apos;acompte compte au chiffre d&apos;affaires aujourd&apos;hui. Le reste
                apparaîtra dans l&apos;écran Dettes, et le client sera relancé par
                WhatsApp.
              </p>
            </div>
          )}

          {checkoutError && (
            <p className="text-red-600 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              {checkoutError}
            </p>
          )}
          <Button
            onClick={handleCheckout}
            // Le crédit est bloqué tant que le nom, le téléphone ou l'acompte
            // sont inexploitables : le serveur refuserait de toute façon, et
            // mieux vaut le dire avant que renvoyer une erreur rouge après coup.
            disabled={cart.length === 0 || loading || creditFormIncomplete}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl"
          >
            {loading
              ? 'Enregistrement...'
              : paymentMethod === 'credit'
                ? advanceAmount > 0
                  ? `Encaisser ${formatCFA(advanceAmount)} (dû ${formatCFA(remaining)})`
                  : `Céder à crédit ${formatCFA(total)}`
                : `Encaisser ${formatCFA(total)}`}
          </Button>
        </div>
      </div>

      {/* ── Modal reçu ── */}
      <Dialog open={!!receipt} onOpenChange={(ouvert) => { if (!ouvert) fermerRecu(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2 ${receipt?.offline || receipt?.isCredit ? 'text-amber-700' : 'text-emerald-700'}`}>
              {receipt?.offline
                ? 'Vente enregistrée hors-ligne'
                : receipt?.isCredit ? 'Vente cédée à crédit' : 'Vente enregistrée !'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-slate-600 text-sm text-center">
              {receipt?.offline
                ? 'Pas de réseau : la vente est mise en attente. Elle sera synchronisée automatiquement, sans double comptage.'
                : receipt?.isCredit
                ? receipt.advance > 0
                  // Avec acompte, la phrase doit dire ce qui est payé et ce qui
                  // reste — sinon la caissière ne sait pas quoi annoncer au
                  // client qui demande « je te dois combien ? ».
                  ? `${formatCFA(receipt.advance)} encaissés, ${formatCFA(receipt.due)} à recouvrer.`
                  : `${formatCFA(receipt.total)} à recouvrer. Comptabilisé au règlement.`
                : 'La vente a été enregistrée avec succès.'}
            </p>
            {receipt?.isCredit && receipt.advance > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-center">
                  <div className="text-[11px] text-emerald-700">Encaissé</div>
                  <div className="text-sm font-bold text-emerald-700 tabular-nums">
                    {formatCFA(receipt.advance)}
                  </div>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-center">
                  <div className="text-[11px] text-amber-700">Reste dû</div>
                  <div className="text-sm font-bold text-amber-800 tabular-nums">
                    {formatCFA(receipt.due)}
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              {/* WhatsApp — en crédit, le message sert de rappel de dette */}
              <a
                href={receipt?.waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl bg-[#0f7a3d] text-white font-semibold py-3 hover:bg-[#0c6631] transition-colors"
              >
                <Share2 className="h-4 w-4" />
                {receipt?.isCredit
                  ? 'Envoyer le rappel WhatsApp'
                  : receipt?.clientPhone
                    ? 'Envoyer le reçu WhatsApp'
                    : 'Partager le reçu WhatsApp'}
              </a>
              {!receipt?.clientPhone && (
                <p className="text-xs text-slate-500 text-center -mt-1">
                  Renseignez un téléphone ci-dessus pour envoyer directement au client.
                </p>
              )}

              {/* Reçu simple — tous les plans, jamais bloqué. Il est
                  TOUJOURS imprimé sans numéro : « FACTURE N° » n'apparaît
                  que sur le bouton facture, une fois le verrou rempli.
                  Sans ça, les deux boutons seraient identiques et le
                  verrou se contournerait par le premier. */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  if (!receipt || !org) return;
                  printReceipt({ ...receipt, org, invoiceNumber: null });
                }}
              >
                <Printer className="h-4 w-4" />
                Imprimer le reçu
              </Button>

              {/* Facture normalisée — délivrance verrouillée :
                  Pro (numéro attribué par create_sale) + IFU + connexion DGI.
                  Tant que le verrou est fermé, l'emplacement explique pourquoi
                  au lieu d'un bouton mort. Masquée sur une vente hors-ligne :
                  sans numéro attribué, il n'y a rien à délivrer. */}
              {!receipt?.offline && (factureEtat.delivrable ? (
                <Button
                  variant="outline"
                  className="w-full gap-2 border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => {
                    if (!receipt || !org) return;
                    printReceipt({ ...receipt, org });
                  }}
                >
                  <FileText className="h-4 w-4" />
                  Facture normalisée
                </Button>
              ) : (
                <p className="text-xs text-slate-500 flex items-center justify-center gap-1 text-center">
                  <FileText className="h-3 w-3 shrink-0" />
                  {factureEtat.motif}
                </p>
              ))}

              <Button variant="ghost" onClick={fermerRecu} className="w-full gap-2 text-slate-500">
                <X className="h-4 w-4" />
                Fermer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Barre fixe, mobile seulement ──
          Le total et l'accès à la caisse restent sous le pouce. Sans elle, le
          panier était une colonne sous la grille : le caissier défilait tout
          le catalogue pour vendre. Une seule cible, une seule action — ouvrir
          le panier, où le total et « Encaisser » sont déjà affichés. */}
      <button
        onClick={() => setPanierOuvert(true)}
        disabled={cart.length === 0}
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 text-left shadow-lg disabled:bg-white"
        aria-label={
          cart.length === 0
            ? 'Panier vide'
            : `Ouvrir le panier : ${unites} article${unites > 1 ? 's' : ''}, total ${formatCFA(total)}`
        }
      >
        <span className="relative shrink-0">
          <ShoppingCart className="h-5 w-5 text-indigo-600" />
          {unites > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-indigo-600 text-white text-[10px] leading-4 text-center font-bold">
              {unites}
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-xs text-slate-500">
            {unites === 0
              ? 'Panier vide'
              : `${unites} article${unites > 1 ? 's' : ''} · Total`}
          </span>
          <span className="block text-base font-bold text-slate-800">{formatCFA(total)}</span>
        </span>
        {cart.length > 0 && (
          <span className="ml-auto shrink-0 text-indigo-600 font-medium text-sm">Encaisser ›</span>
        )}
      </button>
    </div>
  );
}
