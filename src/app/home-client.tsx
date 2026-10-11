'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  History,
  Handshake,
  BarChart2,
  Brain,
  Users,
  Menu,
  UtensilsCrossed,
  ChefHat,
  Layers,
  Flame,
  WifiOff,
} from 'lucide-react';
import { LandingPage } from '@/components/marketing/LandingPage';
import { InventoryTab } from '@/components/inventory/InventoryTab';
import { POSModule } from '@/components/pos/POSModule';
import { SalesHistory } from '@/components/sales/SalesHistory';
import { DailyJournal } from '@/components/sales/DailyJournal';
import { DebtsModule } from '@/components/debts/DebtsModule';
import { ReportsTab } from '@/components/reports/ReportsTab';
import { ForecastModule } from '@/components/forecast/ForecastModule';
import { FloorModule } from '@/components/restaurant/FloorModule';
import { RecipesModule } from '@/components/restaurant/RecipesModule';
import { FormulesModule } from '@/components/restaurant/FormulesModule';
import { ReservationsModule } from '@/components/restaurant/ReservationsModule';
import { KitchenDisplay } from '@/components/restaurant/KitchenDisplay';
import { TeamModule } from '@/components/team/TeamModule';
import { ProductForm } from '@/components/products/ProductForm';
import { RestockModal } from '@/components/products/RestockModal';
import { ProductImportModal } from '@/components/inventory/ProductImportModal';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { SettingsModule } from '@/components/settings/SettingsModule';
import { OnboardingWizard, type OnboardingExit } from '@/components/onboarding/OnboardingWizard';
import { GuidedCash } from '@/components/onboarding/GuidedCash';
import { normalizeOnboardingStep } from '@/lib/onboarding';
import { OrgLoadFailed } from '@/components/onboarding/OrgLoadFailed';
import { OrgSetupRequired } from '@/components/onboarding/OrgSetupRequired';
import { DashboardTab } from '@/components/dashboard/DashboardTab';
import { CashSessionCard } from '@/components/cash/CashSessionCard';
import { Sidebar } from '@/components/layout/Sidebar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { useProducts } from '@/lib/hooks/useProducts';
import { useToday } from '@/lib/hooks/useToday';
import { useHistoriqueOnglets } from '@/lib/hooks/useHistoriqueOnglets';
import { useOfflineSync } from '@/lib/hooks/useOfflineSync';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCFA } from '@/lib/utils/currency';
import { lireFile, type VenteEnAttente } from '@/lib/offline/queue';
import { isFeatureAllowed } from '@/lib/utils/plans';
import type { NavItem, Product, ReportView, Tab } from '@/types';
import { getEnabledModules, fallbackTab } from '@/lib/modules';

export default function HomePage() {
  const { supabase, user, loading, isEmployee, canManageProducts, org, plan, orgError } = useSupabase();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [reportView, setReportView] = useState<ReportView>('sales');
  // L'onglet Ventes s'ouvre sur le journal du jour (ce que le commerçant veut
  // voir en fermant la boutique) ; l'historique complet reste à un clic.
  const [salesView, setSalesView] = useState<'journal' | 'historique'>('journal');
  const { products, loadingProducts, productsError, fetchProducts } = useProducts();
  // Rejeu des ventes encaissées hors-ligne (P7) : au retour du réseau, la file
  // est rejouée (idempotente, voir migration_offline_sales.sql) et le catalogue
  // est rafraîchi — le stock a bougé.
  const { enAttente: ventesHorsLigne, syncing: syncHorsLigne, synchroniser: syncMaintenant } = useOfflineSync(fetchProducts);
  // Écran « ventes en attente » : la liste lisible de ce qui reste à rejouer.
  const [fileOuverte, setFileOuverte] = useState(false);
  const [fileVentes, setFileVentes] = useState<VenteEnAttente[]>([]);
  const ouvrirFile = async () => {
    setFileVentes(await lireFile());
    setFileOuverte(true);
  };
  // Relu à chaque retour sur l'accueil : c'est ce qui le met à jour après une vente.
  const { today, todayError } = useToday(tab === 'dashboard' && !!org?.onboarding_done);
  const [showScanner, setShowScanner] = useState(false);
  const [showInventoryCount, setShowInventoryCount] = useState(false);
  const [scanNotFound, setScanNotFound] = useState('');
  // Demande transmise au POS pour y ajouter le produit scanné.
  const [addToCartRequest, setAddToCartRequest] = useState<{ productId: string; token: number } | null>(null);
  // Compteur strictement croissant : deux scans dans la même milliseconde ne
  // doivent pas recevoir le même jeton, sinon le POS croirait une demande déjà
  // traitée et n'ajouterait que la première.
  const scanSeq = useRef(0);
  // P6 : pastille « à relancer » sur l'onglet Dettes. Lue à chaque retour
  // sur l'accueil (même rythme que `today`) : le rappel programmé doit être
  // là quand le patron ouvre l'app, pas après un rechargement manuel.
  // Échec silencieux : pas de pastille plutôt qu'une erreur — le carnet,
  // lui, reste accessible.
  const [aRelancer, setARelancer] = useState(0);
  const rappelsAuto = plan === 'starter' || plan === 'pro';
  useEffect(() => {
    let annule = false;
    // setState uniquement dans le .then (jamais synchrone dans l'effet) :
    // la pastille tombe à zéro quand le plan ne donne plus droit aux rappels.
    const travail = rappelsAuto && org?.onboarding_done
      ? supabase.rpc('dettes_a_relancer').then(({ data, error }) => (
        !error ? (data ?? []).length : 0))
      : Promise.resolve(0);
    void travail.then((n) => { if (!annule) setARelancer(n); });
    return () => { annule = true; };
  }, [supabase, rappelsAuto, org?.onboarding_done, tab]);
  // Retour système (Android, navigateur) : voir useHistoriqueOnglets — sans
  // lui, le bouton retour quitte l'application au lieu de revenir en arrière.
  useHistoriqueOnglets(tab, setTab);

  // Identité stable : passé en dépendance de l'effet du POS, un arrow inline
  // le relancerait à chaque render.
  const handleAddToCartHandled = useCallback(() => setAddToCartRequest(null), []);

  // Modals produits
  const [showProductForm, setShowProductForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  /**
   * Tiroir de navigation sur mobile. Le rail de 64 px coûtait un quart de
   * l'écran d'un téléphone — deux colonnes de produits au lieu de trois — et,
   * étant en z-40, il passait au-dessus de la barre du bas du POS (z-30), dont
   * il tronquait le total. À partir de lg le rail est permanent et cet état
   * n'a plus d'effet.
   */
  const [menuOuvert, setMenuOuvert] = useState(false);

  // Le tiroir mobile ne doit jamais rester ouvert en passant au grand écran :
  // sur lg le rail est permanent, et le `inert` posé sur le contenu bloquerait
  // toute interaction. On le referme donc dès qu'on atteint 1024 px.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const suivre = () => { if (mq.matches) setMenuOuvert(false); };
    mq.addEventListener('change', suivre);
    return () => mq.removeEventListener('change', suivre);
  }, []);
  // Écran 4 de l'onboarding → la caisse guidée. Local et non en base : après un
  // rechargement, le patron revoit la consigne « Faites votre première
  // vente » avant la caisse, ce qui ne coûte qu'un clic.
  const [caisseGuidee, setCaisseGuidee] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);
  // Même règle que canManageProducts : un prédicat nommé rend les sites
  // d'appel explicites. La vraie barrière reste la RLS.
  const canRestock = () => canManageProducts;

  const handleScan = (sku: string) => {
    // Correspondance insensible à la casse et aux espaces : les scanners
    // renvoient parfois des codes-barres avec des caractères parasites.
    const normalized = sku.trim().toLowerCase();
    const product = products.find(
      (p) => (p.sku ?? '').trim().toLowerCase() === normalized
    );

    if (product) {
      setScanNotFound('');
      setShowScanner(false);
      setTab('pos');
      // Le panier vit dans POSModule : on passe par une requête datée, sinon
      // scanner deux fois le même produit n'ajouterait qu'une unité.
      scanSeq.current += 1;
      setAddToCartRequest({ productId: product.id, token: scanSeq.current });
    } else {
      setScanNotFound(`Aucun produit trouvé pour le code-barres : ${sku}`);
    }
  };

  const openAdd = () => {
    if (!canManageProducts) return;
    setEditingProduct(null);
    setShowProductForm(true);
  };
  const openEdit = (p: Product) => {
    if (!canManageProducts) return;
    setEditingProduct(p);
    setShowProductForm(true);
  };
  const openRestock = (p: Product) => {
    if (!canRestock()) return;
    setRestockProduct(p);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  // Sans session : la page d'accueil publique (P8) — plus jamais le formulaire
  // de connexion d'emblée. Le formulaire vit à /connexion, joignable depuis
  // le héros, l'en-tête et le pied de page de la landing.
  if (!user) return <LandingPage />;

  // Onboarding : tant qu'il n'est pas terminé, aucune navigation — l'assistant
  // ou la caisse guidée, rien d'autre. Un menu à neuf entrées est exactement ce
  // qui fait fermer l'application avant la première vente.
  if (!isEmployee && org && !org.onboarding_done) {
    const finirOnboarding = (exit: OnboardingExit) => {
      if (exit === 'debts') setTab('debts');
      else if (exit === 'add-product') { setTab('inventory'); openAdd(); }
      else setTab('dashboard');
    };
    if (caisseGuidee && normalizeOnboardingStep(org.onboarding_step) === 'first_sale') {
      return (
        <GuidedCash
          products={products}
          onProductsChanged={fetchProducts}
          onSkip={() => setTab('dashboard')}
        />
      );
    }
    return (
      <OnboardingWizard
        onProductsChanged={fetchProducts}
        onGoToCash={() => setCaisseGuidee(true)}
        onFinish={finirOnboarding}
      />
    );
  }

  // Org absente = register interrompu avant la création de l'org
  // orgError = la lecture a ÉCHOUÉ. Les deux ne disent pas la même chose :
  // afficher « Configuration requise » dans le second cas invite à recréer une
  // boutique qui existe déjà, et l'INSERT échoue sur la clé primaire.
  if (!isEmployee && !org) {
    return orgError ? <OrgLoadFailed error={orgError} /> : <OrgSetupRequired />;
  }

  // TOUTES les entrées possibles, dans l'ordre d'affichage. La navigation
  // n'en garde que celles du domaine (getEnabledModules) : un onglet d'un
  // autre domaine n'est pas masqué, il n'est pas rendu. Le filtrage ici, et
  // non dans Sidebar, pour que le filtre soit testable sans rendu.
  const ALL_NAV_ITEMS: NavItem[] = [
    { key: 'dashboard', label: 'Accueil',    icon: LayoutDashboard, locked: false },
    { key: 'pos',       label: 'Caisse',     icon: ShoppingCart,    locked: false },
    { key: 'inventory', label: 'Stock',      icon: Package,         locked: false },
    { key: 'sales',     label: 'Ventes',     icon: History,         locked: false },
    // Dettes : gratuites depuis migration_onboarding_mode.sql — récupérer son
    // argent n'est pas un avantage payant. La pastille P6, elle, est payante
    // (évaluation §7) : `aRelancer` ne peut être non nul que si rappelsAuto.
    { key: 'debts',     label: 'Dettes',     icon: Handshake,       locked: false,
      ...(aRelancer > 0 ? { badge: aRelancer } : {}) },
    { key: 'reports',   label: 'Rapports',   icon: BarChart2,       locked: !isFeatureAllowed(plan, 'reports') },
    { key: 'forecast',  label: 'Prévisions', icon: Brain,           locked: !isFeatureAllowed(plan, 'forecast') },
    // Salle : module restaurant, donc filtré comme les autres. La caisse
    // comptoir reste disponible — un restaurant sert aussi à emporter.
    { key: 'floor',     label: 'Salle',     icon: UtensilsCrossed, locked: false },
    { key: 'kitchen',   label: 'Cuisine',   icon: Flame,           locked: false },
    { key: 'recipes',   label: 'Recettes',  icon: ChefHat,         locked: false },
    { key: 'formules',  label: 'Formules',  icon: Layers,          locked: false },
    { key: 'team',      label: 'Équipe',     icon: Users,           locked: false },
  ];

  // Domaine ET mode : un maquis en mode simple garde sa Salle mais pas ses
  // Recettes ; une boutique en mode simple n'a ni Rapports ni Équipe.
  const modulesActifs = getEnabledModules(org?.domain, org?.ui_mode);
  const NAV_ITEMS = ALL_NAV_ITEMS.filter((i) => modulesActifs.includes(i.key));

  // Onglet demandé hors domaine (lien, onglet mémorisé d'une autre activité) :
  // on retombe sur le premier module du domaine plutôt que d'afficher un
  // écran qui ne fait pas partie de l'application de ce client.
  if (!modulesActifs.includes(tab) && modulesActifs.length > 0) {
    setTab(fallbackTab(org?.domain, org?.ui_mode));
  }

  return (
    <div className="min-h-screen flex">

      {/* ── Sidebar gauche ── */}
      <Sidebar
        tab={tab}
        items={NAV_ITEMS}
        email={user.email}
        loadingProducts={loadingProducts}
        open={menuOuvert}
        onClose={() => setMenuOuvert(false)}
        onTab={setTab}
        onScan={() => setShowScanner(true)}
        onRefresh={fetchProducts}
        onSignOut={() => { void supabase.auth.signOut().catch(() => {}); }}
      />

      {/* Ouverture du tiroir. Occupe la place du rail, qui n'existe plus sous lg. */}
      {!menuOuvert && (
        <button
          onClick={() => setMenuOuvert(true)}
          className="lg:hidden fixed top-3 left-3 z-30 h-10 w-10 rounded-lg bg-white border border-slate-200 shadow-sm flex items-center justify-center"
          aria-label="Ouvrir le menu"
        >
          <Menu className="h-5 w-5 text-slate-700" />
        </button>
      )}

      {/* ── Contenu principal ──
          ml-0 sous lg : le rail de 64 px a disparu au profit du tiroir. pt-14
          réserve la place du bouton flottant. */}
      {/* min-w-0 : sans elle, <main> (item flex de <body>) refuse de descendre
          sous la largeur MINIMUM de son contenu. Une seule ligne de caisse à
          rallonge — un nom de produit de 90 caractères en `truncate` suffit —
          et le document débordait de 270 px sur un écran de 1280 : le panneau
          panier, à droite, sortait de l'écran. min-w-0 rend au navigateur la
          permission de rétrécir la colonne, et `truncate` fait enfin son
          travail. */}
      <main className="flex-1 min-w-0 lg:ml-56 min-h-screen bg-slate-50 pt-14 lg:pt-0" inert={menuOuvert}>
        {/* max-w-none sur la caisse : catalogue + panier (320 px) réclament
            toute la largeur. Borné à 5xl comme les autres onglets, la caisse
            affichait de larges marges mortes sur grand écran et le panier
            se faisait écraser par la colonne produits. */}
        <div className={`p-4 mx-auto ${tab === 'pos' ? 'max-w-none' : 'max-w-5xl'}`}>
          {/* Ventes hors-ligne en attente : l'information est en haut de TOUS
              les onglets — un commerçant qui vient d'encaisser sans réseau doit
              pouvoir vérifier d'un coup d'œil que rien n'est perdu. */}
          {ventesHorsLigne > 0 && (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <WifiOff className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                {ventesHorsLigne} vente{ventesHorsLigne > 1 ? 's' : ''} en attente de synchronisation.
              </span>
              <button
                onClick={ouvrirFile}
                className="rounded-md border border-amber-300 px-2 py-1 text-xs font-medium hover:bg-amber-100"
              >
                Voir
              </button>
              <button
                onClick={syncMaintenant}
                disabled={syncHorsLigne}
                className="rounded-md border border-amber-300 px-2 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
              >
                {syncHorsLigne ? 'Synchronisation…' : 'Synchroniser'}
              </button>
            </div>
          )}

          {/* Erreur de chargement des produits : HORS condition d'onglet.
              Rendue uniquement dans le dashboard, elle était invisible dès
              qu'un autre onglet était actif — l'utilisateur voyait une liste
              vide sans aucune explication. */}
          {productsError && (
            <p className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Impossible de charger les produits : {productsError}
            </p>
          )}

          {/* Frontière d'erreur : un module qui plante ne doit pas emporter
              tout le tableau de bord — le reste de la caisse reste utilisable. */}
          <ErrorBoundary zone={tab}>
          {/* ── Dashboard ── */}
          {tab === 'dashboard' && (
            <div className="space-y-4">
              <DashboardTab
                products={products}
                loadingProducts={loadingProducts}
                canManageProducts={canManageProducts}
                onNewSale={() => setTab('pos')}
                onAddProduct={openAdd}
                onRestock={openRestock}
                today={today}
                todayError={todayError}
                onOpenDebts={modulesActifs.includes('debts') ? () => setTab('debts') : undefined}
              />
              <CashSessionCard />
            </div>
          )}

          {tab === 'pos' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Point de vente</h2>
              <POSModule
                products={products}
                onSaleComplete={fetchProducts}
                addToCartRequest={addToCartRequest}
                onAddToCartHandled={handleAddToCartHandled}
              />
            </div>
          )}

          {tab === 'inventory' && (
            <InventoryTab
              products={products}
              canManageProducts={canManageProducts}
              showCount={showInventoryCount}
              onToggleCount={() => setShowInventoryCount(!showInventoryCount)}
              onCountComplete={() => { setShowInventoryCount(false); fetchProducts(); }}
              onEdit={openEdit}
              onRestock={openRestock}
              onAdd={openAdd}
              onImport={() => setShowImport(true)}
              onRefresh={fetchProducts}
            />
          )}

          {tab === 'sales' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-800">
                  {salesView === 'journal' ? 'Journal du jour' : 'Historique des ventes'}
                </h2>
                <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-sm" role="tablist" aria-label="Vue des ventes">
                  <button
                    role="tab"
                    onClick={() => setSalesView('journal')}
                    aria-selected={salesView === 'journal'}
                    className={`px-3 py-1 rounded-md font-medium transition-colors ${
                      salesView === 'journal' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    Journal
                  </button>
                  <button
                    role="tab"
                    onClick={() => setSalesView('historique')}
                    aria-selected={salesView === 'historique'}
                    className={`px-3 py-1 rounded-md font-medium transition-colors ${
                      salesView === 'historique' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    Historique
                  </button>
                </div>
              </div>
              {salesView === 'journal' ? <DailyJournal /> : <SalesHistory />}
            </div>
          )}

          {tab === 'debts' && (
            <div className="space-y-4">
              <DebtsModule />
            </div>
          )}

          {tab === 'reports' && (
            <ReportsTab view={reportView} onView={setReportView} />
          )}

          {tab === 'forecast' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Prévisions & Planification</h2>
              <ForecastModule onRestock={fetchProducts} />
            </div>
          )}

          {tab === 'floor' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Salle</h2>
              {/* La salle ne vend rien : le stock n'est touché qu'à la clôture
                  (Sprint 14), donc aucun rafraîchissement des produits ici. */}
              <FloorModule products={products} onChanged={fetchProducts} />
              <ReservationsModule />
            </div>
          )}

          {tab === 'kitchen' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Cuisine</h2>
              <KitchenDisplay products={products} />
            </div>
          )}

          {tab === 'recipes' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Recettes</h2>
              <RecipesModule />
            </div>
          )}

          {tab === 'formules' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Formules</h2>
              <FormulesModule />
            </div>
          )}

          {tab === 'team' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">
                {isEmployee ? 'Journal d\'activité' : 'Équipe & Journal'}
              </h2>
              <TeamModule />
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Paramètres</h2>
              <SettingsModule />
            </div>
          )}
          </ErrorBoundary>
        </div>
      </main>

      {/* Modals */}
      {showProductForm && canManageProducts && (
        <ProductForm
          product={editingProduct}
          onClose={() => setShowProductForm(false)}
          onSaved={fetchProducts}
          currentProductCount={products.length}
        />
      )}
      {showImport && canManageProducts && (
        <ProductImportModal
          products={products}
          onClose={() => setShowImport(false)}
          onDone={fetchProducts}
        />
      )}
      {restockProduct && canManageProducts && (
        <RestockModal product={restockProduct} onClose={() => setRestockProduct(null)} onSaved={fetchProducts} />
      )}
      {showScanner && (
        <BarcodeScanner
          onScan={handleScan}
          onClose={() => { setShowScanner(false); setScanNotFound(''); }}
          errorMessage={scanNotFound}
        />
      )}

      {/* Ventes en attente (hors-ligne) : la liste de ce qui sera rejoué, avec
          le résumé de chaque vente et un bouton pour tout synchroniser. */}
      <Dialog open={fileOuverte} onOpenChange={setFileOuverte}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Ventes en attente de synchronisation</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-80 overflow-y-auto">
            {fileVentes.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">Aucune vente en attente.</p>
            ) : (
              fileVentes.map((v) => (
                <div key={v.ref} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-800 truncate">{v.resume?.libelle ?? 'Vente'}</span>
                    <span className="text-sm font-semibold text-slate-700 shrink-0">
                      {v.resume ? formatCFA(v.resume.total) : ''}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {new Date(v.cree).toLocaleString('fr-FR')}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={async () => { await syncMaintenant(); setFileVentes(await lireFile()); }}
              disabled={syncHorsLigne}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {syncHorsLigne ? 'Synchronisation…' : 'Tout synchroniser'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
