import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Parcours critique du lancement (Sprint 17) : une boutique neuve fait sa
 * première vente en moins de 4 minutes.
 *
 * Ce que ces tests verrouillent :
 *   1. le choix de l'activité écrit business_type ET le domaine qui en découle ;
 *   2. les 3 exemples sont écrits avec du stock (sinon la première vente
 *      échouerait sur « Stock insuffisant »), et une seule fois ;
 *   3. la vente fait passer aux félicitations, mais seulement une fois le reçu
 *      fermé ;
 *   4. les félicitations terminent l'assistant et ouvrent l'écran choisi.
 */

const etat = vi.hoisted(() => ({
  org: { id: 'org-1', onboarding_step: 'welcome', business_type: null } as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
  inserts: [] as unknown[],
  demoDejaLa: 0,
  carte: { charges: 17, recettes: 12, options: 5 } as
    | { charges: number; recettes: number; options: number }
    | { erreur: string },
  refreshOrg: vi.fn(),
}));

const supabase = {
  from: (table: string) => ({
    update: (payload: Record<string, unknown>) => ({
      eq: async () => {
        if (table === 'organizations') {
          etat.updates.push(payload);
          Object.assign(etat.org, payload);
        }
        return { error: null };
      },
    }),
    insert: async (rows: unknown) => {
      etat.inserts.push(rows);
      return { error: null };
    },
    // hasStarterCatalog : select(..., { count, head }).eq().like()
    select: () => ({
      eq: () => ({ like: async () => ({ count: etat.demoDejaLa, error: null }) }),
    }),
  }),
};

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    ownerId: 'org-1',
    org: etat.org,
    refreshOrg: etat.refreshOrg,
  }),
}));

// Le chargement réel du catalogue est couvert par starter-catalog-client.test.ts.
// Ici on vérifie seulement que l'assistant l'appelle pour un restaurant, au lieu
// d'insérer les trois articles génériques du commerce.
vi.mock('@/lib/starterCatalog.client', () => ({
  hasStarterCatalog: vi.fn(async () => etat.demoDejaLa),
  loadStarterCatalog: vi.fn(async () => etat.carte),
}));

// La caisse réelle est couverte par ses propres tests : ici, seul compte ce
// que la caisse guidée fait de ses deux signaux.
vi.mock('@/components/pos/POSModule', () => ({
  POSModule: ({ onSaleComplete, onReceiptClosed }: { onSaleComplete: () => void; onReceiptClosed: () => void }) => (
    <div>
      <button onClick={onSaleComplete}>vente-test</button>
      <button onClick={onReceiptClosed}>fermer-recu-test</button>
    </div>
  ),
}));

import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { GuidedCash } from '@/components/onboarding/GuidedCash';
import { carteDeDemarrage, domainOf, onboardingSamples, BUSINESS_TYPES } from '@/lib/onboarding';
import { loadStarterCatalog } from '@/lib/starterCatalog.client';

function renderWizard() {
  const props = { onProductsChanged: vi.fn(), onGoToCash: vi.fn(), onFinish: vi.fn() };
  const r = render(<OnboardingWizard {...props} />);
  return { ...props, rerender: () => r.rerender(<OnboardingWizard {...props} />) };
}

beforeEach(() => {
  etat.org = { id: 'org-1', onboarding_step: 'welcome', business_type: null };
  etat.updates = [];
  etat.inserts = [];
  etat.demoDejaLa = 0;
  etat.carte = { charges: 17, recettes: 12, options: 5 };
  vi.mocked(loadStarterCatalog).mockClear();
  etat.refreshOrg.mockReset();
});

describe('Onboarding — les données', () => {
  it('relie chacune des 4 activités au bon domaine', () => {
    expect(domainOf('restaurant')).toBe('restaurant');
    for (const t of ['epicerie', 'boutique', 'autre'] as const) expect(domainOf(t)).toBe('retail');
  });

  it('propose 3 exemples vendables par activité', () => {
    for (const t of BUSINESS_TYPES) {
      const s = onboardingSamples(t);
      expect(s).toHaveLength(3);
      for (const p of s) {
        expect(p.stock).toBeGreaterThan(0);
        expect(p.priceSell).toBeGreaterThan(p.priceBuy);
      }
    }
  });

  it('la carte restaurant arrive avec ses recettes et ses ingrédients', () => {
    const c = carteDeDemarrage();
    expect(c.plats.length).toBeGreaterThanOrEqual(4);
    for (const p of c.plats) {
      expect(p.recette.length).toBeGreaterThan(0);
      expect(p.lignes).toBeGreaterThan(0);
      // La recette est lisible : un ingrédient, une quantité, une unité.
      expect(p.recette).toMatch(/\d/);
      expect(p.recette).not.toContain('—');
    }
    expect(c.ingredientsEnStock).toBeGreaterThan(0);
    expect(c.boissons).toBeGreaterThan(0);
  });
});

describe('Onboarding — le parcours', () => {
  it('écran 1 → 2 : « Commencer » enregistre l\'étape', async () => {
    const w = renderWizard();
    expect(screen.getByText('Bienvenue sur GestionLocal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Commencer/ }));
    await waitFor(() => expect(etat.updates).toContainEqual({ onboarding_step: 'business' }));
    w.rerender();
    expect(screen.getByText(/Quel type de commerce avez-vous/)).toBeInTheDocument();
  });

  it('écran 2 : l\'activité choisie fixe aussi le domaine', async () => {
    etat.org.onboarding_step = 'business';
    renderWizard();
    const continuer = screen.getByRole('button', { name: /Continuer/ });
    expect(continuer).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Maquis \/ Restaurant/ }));
    fireEvent.click(continuer);
    await waitFor(() =>
      expect(etat.updates).toContainEqual({ onboarding_step: 'samples', business_type: 'restaurant', domain: 'restaurant' })
    );
  });

  it('écran 3 : les 3 exemples sont écrits avec du stock, puis la caisse', async () => {
    Object.assign(etat.org, { onboarding_step: 'samples', business_type: 'epicerie' });
    const w = renderWizard();
    for (const n of ['Riz 25 kg', 'Huile 1L', 'Sucre 1 kg']) expect(screen.getByText(n)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continuer avec ces produits/ }));
    await waitFor(() => expect(etat.updates).toContainEqual({ onboarding_step: 'first_sale' }));
    const lignes = etat.inserts[0] as { stock_qty: number; sku: string }[];
    expect(lignes).toHaveLength(3);
    expect(lignes.every((l) => l.stock_qty > 0 && l.sku.startsWith('DEMO-'))).toBe(true);
    expect(w.onProductsChanged).toHaveBeenCalled();

    w.rerender();
    fireEvent.click(screen.getByRole('button', { name: /Aller à la caisse/ }));
    expect(w.onGoToCash).toHaveBeenCalled();
  });

  it('écran 3 restaurant : une carte avec recettes, jamais les 3 articles génériques', async () => {
    Object.assign(etat.org, { onboarding_step: 'samples', business_type: 'restaurant' });
    const w = renderWizard();

    expect(screen.getByText('Votre carte de démarrage')).toBeInTheDocument();
    // La recette du plat est écrite à l'écran : c'est elle qui dit au patron
    // qu'un plat se vend avec ses ingrédients.
    expect(screen.getByText(/Poulet entier × 1 pce/)).toBeInTheDocument();
    expect(screen.queryByText('Voici quelques produits pour commencer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continuer avec cette carte/ }));
    await waitFor(() => expect(etat.updates).toContainEqual({ onboarding_step: 'first_sale' }));

    expect(loadStarterCatalog).toHaveBeenCalledWith(supabase, 'org-1', 'restaurant');
    // Aucun insert direct : la carte passe par la fonction qui écrit aussi les
    // recettes, les ingrédients et les options.
    expect(etat.inserts).toHaveLength(0);
    expect(w.onProductsChanged).toHaveBeenCalled();
  });

  it('écran 3 restaurant : une erreur de chargement ne fait pas avancer', async () => {
    Object.assign(etat.org, { onboarding_step: 'samples', business_type: 'restaurant' });
    etat.carte = { erreur: 'Connexion interrompue' };
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Continuer avec cette carte/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion interrompue');
    expect(etat.updates).toHaveLength(0);
  });

  it('écran 3 : un second passage ne crée pas les exemples en double', async () => {
    Object.assign(etat.org, { onboarding_step: 'samples', business_type: 'boutique' });
    etat.demoDejaLa = 3;
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Continuer avec ces produits/ }));
    await waitFor(() => expect(etat.updates).toContainEqual({ onboarding_step: 'first_sale' }));
    expect(etat.inserts).toHaveLength(0);
  });

  it('écran 3 bis : un produit sans stock est refusé avant la caisse', async () => {
    Object.assign(etat.org, { onboarding_step: 'samples', business_type: 'autre' });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Je préfère ajouter mes propres produits/ }));
    fireEvent.change(screen.getByLabelText('Nom du produit'), { target: { value: 'Pagne' } });
    fireEvent.change(screen.getByLabelText('Prix de vente (F)'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter ce produit/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/en stock/);
    expect(etat.inserts).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
  });

  it('caisse guidée : félicitations après la vente, une fois le reçu fermé', async () => {
    etat.org.onboarding_step = 'first_sale';
    const onProductsChanged = vi.fn();
    render(<GuidedCash products={[]} onProductsChanged={onProductsChanged} onSkip={vi.fn()} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('vente-test'));
    await waitFor(() => expect(etat.updates).toContainEqual({ onboarding_step: 'congrats' }));
    expect(onProductsChanged).toHaveBeenCalled();
    // Le reçu est encore ouvert : on ne le retire pas des yeux du patron.
    expect(etat.refreshOrg).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('fermer-recu-test'));
    await waitFor(() => expect(etat.refreshOrg).toHaveBeenCalled());
  });

  it('caisse guidée : fermer un reçu sans vente ne passe pas l\'étape', async () => {
    render(<GuidedCash products={[]} onProductsChanged={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByText('fermer-recu-test'));
    await Promise.resolve();
    expect(etat.refreshOrg).not.toHaveBeenCalled();
    expect(etat.updates).toHaveLength(0);
  });

  it('écran 5 : « Voir mes dettes clients » termine l\'assistant et ouvre les dettes', async () => {
    etat.org.onboarding_step = 'congrats';
    const w = renderWizard();
    expect(screen.getByText(/Bravo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Voir mes dettes clients/ }));
    await waitFor(() => expect(w.onFinish).toHaveBeenCalledWith('debts'));
    expect(etat.updates).toContainEqual({ onboarding_done: true, onboarding_step: null });
  });
});
