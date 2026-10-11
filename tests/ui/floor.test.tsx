import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * La salle : le plan des tables et la commande ouverte.
 *
 * Ce que ces tests verrouillent : une table libre s'ouvre en UNE commande, et
 * la commande n'écrit RIEN sur le stock. Ce second point est le cœur du Sprint
 * 13 — une commande est une intention de service, pas une vente ; seul le
 * Sprint 14 écrira dans `sales`.
 */

const { salle, prises, inserts, lignesCommande, modificateurs, updates, dishRows } = vi.hoisted(() => {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    salle: [] as unknown[],
    prises: [] as unknown[],
    inserts,
    lignesCommande: [] as unknown[],
    modificateurs: [] as unknown[],
    updates: [] as Array<{ table: string; id: string; payload: Record<string, unknown> }>,
    // Lignes renvoyées par recipe_ingredients : quels produits sont des PLATS
    // (dish_id) et quels produits sont des INGRÉDIENTS (ingredient_id).
    dishRows: [] as Array<{ dish_id?: string; ingredient_id?: string }>,
  };
});

// Le plan de salle vient de la vue restaurant_floor, qui répond déjà au tri :
// chaque appel .from('restaurant_floor') rend une promesse résolue.
const chaine = (donnees: unknown, tableCourante = '') => {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = () => c;
  // Les commandes à emporter sont filtrées par .is('table_id', null) puis
  // .neq('status', 'closed') : la chaîne doit les encaisser sans se rompre.
  c.is = () => c;
  c.neq = () => c;
  // Le module enchaîne deux .order() (zone puis nom) : la chaîne doit donc
  // rester elle-même jusqu'au dernier, et se résoudre à l'await. Une promesse
  // dès le premier .order() faisait échouer le deuxième.
  c.order = () => c;
  // thenable : la chaîne se comporte comme une promesse à l'await, mais reste
  // elle-même tant qu'on l'enchaîne.
  c.then = (ok: (v: unknown) => unknown) => ok({ data: donnees, error: null });
  c.insert = (payload: Record<string, unknown>) => {
    inserts.push(payload);
    return { select: () => ({ single: async () => ({ data: { id: 'cmd-1' }, error: null }) }) };
  };
  c.update = (payload: Record<string, unknown>) => {
    // L'identifiant de la ligne est celui passé au .eq() : c'est ce qui permet
    // d'affirmer « la quantité de CETTE ligne a été corrigée ».
    const lot: { table: string; id: string; payload: Record<string, unknown> }[] = [];
    const chain = {
      eq: (_col: string, id: string) => {
        updates.push({ table: tableCourante, id, payload });
        return chain;
      },
      then: (ok: (v: unknown) => unknown) => ok({ error: null }),
    };
    void lot;
    return chain;
  };
  c.delete = () => ({ eq: async () => ({ error: null }) });
  return c;
};

const { rpcResultats } = vi.hoisted(() => ({ rpcResultats: [] as unknown[] }));

const supabase = {
  from: (table: string) =>
    table === 'restaurant_floor'
      ? chaine(salle, table)
      : table === 'restaurant_order_items'
        ? chaine(lignesCommande, table)
        : table === 'product_modifiers'
          ? chaine(modificateurs, table)
          : table === 'restaurant_orders'
            ? chaine(prises, table)
            : table === 'recipe_ingredients'
              ? chaine(dishRows, table)
              : chaine({ id: 'x' }, table),
  rpc: vi.fn(async (fn: string, _args?: unknown) => {
    void _args; // le 2ᵉ argument typé permet aux tests de lire les paramètres
    rpcResultats.push(fn);
    if (fn === 'close_table_order') {
      return {
        data: {
          total_amount: 9200, amount_paid: 9200, tip: 2000,
          invoice_number: 'FAC-2026-00042', sale_id: 'v-1', per_share: 4600,
        },
        error: null,
      };
    }
    return { data: 1, error: null };
  }),
  auth: { getUser: vi.fn() },
};

/**
 * Le rôle de l'utilisateur affiché. Par défaut : le patron. Un test qui veut
 * voir l'écran du caissier le change avant de rendre.
 */
const acteur = { canManageProducts: true, isEmployee: false };

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    get canManageProducts() { return acteur.canManageProducts; },
    get isEmployee() { return acteur.isEmployee; },
    org: { domain: 'restaurant' },
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { FloorModule } from '@/components/restaurant/FloorModule';
import { printKitchenTicket } from '@/lib/utils/kitchen';
import type { Product } from '@/types';

/**
 * Le ticket de cuisine est le seul endroit où l'impression est observable
 * depuis la salle : on remplace la fenêtre `blob:` par un espion pour vérifier
 * CE QUI PART SUR LE PAPIER, et pas seulement que le bouton ne casse pas.
 */
vi.mock('@/lib/utils/kitchen', () => ({ printKitchenTicket: vi.fn(() => true) }));

const produits = [
  { id: 'p1', name: 'Poulet braisé', sku: 'POU', price_buy: 2000, price_sell: 4500, stock_qty: 30, min_stock_level: 5, category: 'Plats', unit: 'pce' },
] as unknown as Product[];

const table = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Table 1',
  zone: 'Salle',
  seats: 4,
  is_active: true,
  order_id: null as string | null,
  status: null as 'open' | 'bill_requested' | null,
  customer_name: null as string | null,
  opened_at: null as string | null,
  amount_paid: 0,
  order_total: 0,
  ...over,
});

function definirSalle(...lignes: ReturnType<typeof table>[]) {
  salle.length = 0;
  salle.push(...lignes);
}

/**
 * Commandes à emporter en cours. Elles ne sont PAS dans `salle` : la vue
 * restaurant_floor est pilotée par les tables, c'est précisément pourquoi une
 * commande sans table disparaissait de l'écran.
 */
function definirPrises(...ps: unknown[]) {
  prises.length = 0;
  prises.push(...ps);
}

function definirCommande(...ls: unknown[]) {
  lignesCommande.length = 0;
  lignesCommande.push(...ls);
}

function definirModificateurs(...ms: unknown[]) {
  modificateurs.length = 0;
  modificateurs.push(...ms);
}

const plat = {
  id: 'l1',
  product_id: 'p1',
  quantity: 2,
  unit_price: 4500,
  extra_price: 0,
  modifier: null,
  note: null,
  status: 'new',
  product: { name: 'Poulet braisé' },
};

beforeEach(() => {
  // Le patron, sauf si un test change le rôle pour voir l'écran du caissier.
  acteur.canManageProducts = true;
  acteur.isEmployee = false;
  updates.length = 0;
  inserts.length = 0;
  prises.length = 0;
  // Les appels RPC s'accumulaient d'un test à l'autre : un `find` renvoyait un
  // appel d'un test précédent. On vide, comme pour les inserts.
  supabase.rpc.mockClear();
  vi.mocked(printKitchenTicket).mockClear();
});

describe('FloorModule — la salle', () => {
  it('propose de créer une table quand la salle est vide', async () => {
    definirSalle();
    render(<FloorModule products={produits} />);

    await waitFor(() => {
      expect(screen.getByText(/Aucune table configurée/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Nom de la table/i)).toBeInTheDocument();
  });

  it('distingue table libre et table occupée', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1' }),
      table({
        id: 't2', name: 'Table 2', order_id: 'cmd-9', status: 'open',
        customer_name: 'M. Kponou', opened_at: new Date().toISOString(), order_total: 9500,
      }),
    );
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 2')).toBeInTheDocument());
    expect(screen.getByText('Libre')).toBeInTheDocument();
    expect(screen.getByText('En service')).toBeInTheDocument();
    expect(screen.getByText('M. Kponou')).toBeInTheDocument();
  });

  it('affiche « addition demandée » distinctement de « en service »', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'bill_requested', opened_at: new Date().toISOString() }));
    render(<FloorModule products={produits} />);

    await waitFor(() => {
      expect(screen.getByText('Addition demandée')).toBeInTheDocument();
    });
    expect(screen.queryByText('En service')).not.toBeInTheDocument();
  });

  it('montre le temps de service écoulé', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open', opened_at: new Date(Date.now() - 42 * 60000).toISOString() }));
    render(<FloorModule products={produits} />);

    // Une table servie depuis 42 minutes doit le dire : c'est le signal qui
    // dit au patron qu'une table doit attendre ou être relancée.
    await waitFor(() => expect(screen.getByText(/42 min/)).toBeInTheDocument());
  });

  it('ouvre une commande unique en touchant une table libre', async () => {
    inserts.length = 0;
    definirSalle(table());
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    await waitFor(() => expect(inserts.length).toBe(1));
    expect(inserts[0].table_id).toBe('t1');
    expect(inserts[0].owner_id).toBe('org-1');
    // L'unicité vient de l'index partiel en base ; le client n'écrit qu'une fois.
    expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument();
  });

  it('propose les options du plat avant de l\'ajouter', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    definirModificateurs(
      { id: 'm1', product_id: 'p1', name: 'Bien cuit', extra_price: 0, is_required: true },
      { id: 'm2', product_id: 'p1', name: 'Double portion', extra_price: 1500, is_required: false },
    );
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    // Premier clic : sélection, PAS d'insertion. Ajouter d'emblée donnerait une
    // ligne sans cuisson, que le serveur corrigerait à la main.
    // La tuile du plat : nom + prix dans un même bouton. Le libellé accessible
// est le nom seul (le prix est dans un span sans rôle), d'où un sélecteur
// par texte plutôt que par rôle.
fireEvent.click(screen.getAllByText('Poulet braisé')[0]);

    await waitFor(() => expect(screen.getByText('Bien cuit')).toBeInTheDocument());
    expect(screen.getByText('Double portion +1 500 F')).toBeInTheDocument();
    // Aucune ligne de commande écrite : inserts ne contient pour l'instant que
    // l'ouverture de la table.
    expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(0);

    fireEvent.click(screen.getByText('Double portion +1 500 F'));
    fireEvent.click(screen.getByRole('button', { name: /Ajouter à la commande/i }));

    // Le filtre est relu dans waitFor : une liste calculée une fois ne verrait pas
    // l'écriture qui arrive après.
    await waitFor(() => {
      expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(1);
    });
    const ligne = inserts.find((i) => 'product_id' in i)!;
    expect(ligne.modifier).toBe('Double portion');
    expect(ligne.extra_price).toBe(1500);
  });

  it('enregistre le pourboire sans le confondre avec l\'addition', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.change(screen.getByLabelText(/Pourboire/i), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser 9\s?000 F/ }));

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    // 2 000 de pourboire ne changent pas le prix affiché de l'addition.
    expect(screen.getByText(/pourboire 2 000 F \(hors CA\)/)).toBeInTheDocument();
    expect(rpcResultats).toContain('close_table_order');
  });

  it('partage l\'addition sans multiplier les ventes', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open', customer_name: 'M. Kponou' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    // La ligne doit être chargée : le partage n'apparaît qu'au-dessus d'une
    // commande non vide. Le plat apparaît aussi dans la grille de choix, d'où
    // getAllByText.
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.click(screen.getByText(/Partager l'addition/i));
    // 2 parts sur 9 000 : 4 500 chacune.
    await waitFor(() => expect(screen.getByText(/4\s?500 F par personne/i)).toBeInTheDocument());
    // Le total reste le total : le partage est un affichage, pas une écriture.
    // (Le plan de salle affiche le même montant — d'où getAllByText.)
    expect(screen.getAllByText('9 000 F').length).toBeGreaterThan(0);
  });

  it('encaisse l\'addition et confirme avec le numéro de facture', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    // Le bouton d'encaissement n'existe qu'au-dessus d'une commande non vide :
    // attendre la ligne, sinon le clic part avant qu'il ne soit rendu.
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: /Encaisser 9\s?000 F/ }));

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    expect(screen.getByText(/FAC-2026-00042/)).toBeInTheDocument();
    expect(rpcResultats).toContain('close_table_order');
  });

  it('n\'écrit rien dans le stock : une commande n\'est pas une vente', async () => {
    inserts.length = 0;
    definirSalle(table());
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(inserts.length).toBe(1));

    // Aucune écriture sur `products` : le module ne reçoit que les produits en
    // lecture, il n'a même pas de client pour les modifier.
    expect(inserts.every((i) => !('product_id' in i) || i.product_id === undefined)).toBe(true);
    await waitFor(() => {
      expect(screen.getByText(/Stock n'est décrémenté qu'à la clôture/i)).toBeInTheDocument();
    });
  });

  /**
   * Trouvé en recette navigateur le 05/10/2026.
   *
   * Le formulaire de création de table n'était rendu que dans l'état « aucune
   * table ». La première table créée, il disparaissait — et il n'existait aucun
   * autre chemin pour en ajouter : un maquis de douze tables restait bloqué à une
   * seule, sans message et sans erreur.
   */
  it('permet d\'ajouter une table même quand la salle est déjà installée', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());

    // Le formulaire n'est pas là d'emblée : il prend de la place aux tuiles.
    expect(screen.queryByLabelText(/Nom de la table/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ajouter une table/i }));

    const champ = await screen.findByLabelText(/Nom de la table/i);
    fireEvent.change(champ, { target: { value: 'Terrasse 1' } });
    inserts.length = 0;
    fireEvent.submit(champ.closest('form')!);

    await waitFor(() =>
      expect(inserts.some((i) => i.name === 'Terrasse 1')).toBe(true),
    );
  });

  /**
   * Même recette, même jour. La carte des plats était tronquée à 12 plats sans
   * rien l'annoncer : sur le catalogue d'exemple (17 articles), « Poulet braisé »
   * et « Riz gras » étaient invisibles. Le serveur, qui voit le plat absent de la
   * carte, conclut que la cuisine ne le fait pas.
   */
  it('montre toute la carte, sans troncature cachée', async () => {
    const carte = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `Plat numéro ${String(i).padStart(2, '0')}`,
      sku: `P${i}`,
      price_buy: 500,
      price_sell: 1500,
      stock_qty: 5,
      min_stock_level: 1,
      category: 'Plats',
      unit: 'portion',
    })) as unknown as Product[];

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={carte} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    await waitFor(() => expect(screen.getByText('Plat numéro 00')).toBeInTheDocument());
    expect(screen.getByText('Plat numéro 19')).toBeInTheDocument();
  });

  /**
   * Trouvé en recette le 05/10/2026.
   *
   * La quantité d'une ligne n'était modifiable qu'AU MOMENT de l'ajout. Une fois
   * le plat dans la commande, on ne pouvait plus que le supprimer — et supprimer ne
   * fusionne pas avec la ligne voisine. « Trois attiékés, puis on s'est trompé de
   * deux » obligeait à tout refaire à la main.
   */
  it('permet de corriger la quantité d\'une ligne déjà entrée', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const champ = await screen.findByLabelText(/Quantité de Poulet braisé/i);
    // type="text" (et non "number") : la valeur est une chaîne. C'est ce qui
    // permet à « 2,5 » d'entrer — voir le test suivant.
    expect(champ).toHaveValue('2');

    updates.length = 0;
    fireEvent.blur(champ, { target: { value: '5' } });

    await waitFor(() =>
      expect(updates.some((u) => u.payload.quantity === 5 && u.id === 'l1')).toBe(true),
    );
  });

  /**
   * Trouvé en recette le 05/10/2026.
   *
   * Le champ était `type="number"`, et un champ number REJETTE la virgule : il
   * vide `e.target.value` au lieu de la prendre. « 1,2 » arrivait donc dans le
   * onBlur sous forme de chaîne vide, `Number('')` vaut 0, et le serveur se
   * voyait afficher « La quantité doit être un nombre supérieur à zéro » — la
   * faute à la personne qui n'avait fait que taper comme au clavier de son
   * téléphone. Or `min="0.25"` disait pourtant que les fractions étaient
   * attendues. C'est exactement le défaut qui avait été corrigé à la caisse
   * (POSModule, `type="text" inputMode="decimal"`) et oublié ici.
   */
  it('accepte la virgule dans la quantité d\'une ligne', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const champ = await screen.findByLabelText(/Quantité de Poulet braisé/i);
    updates.length = 0;
    fireEvent.blur(champ, { target: { value: '1,25' } });

    await waitFor(() =>
      expect(updates.some((u) => u.payload.quantity === 1.25 && u.id === 'l1')).toBe(true),
    );
    expect(screen.queryByText(/doit être un nombre supérieur/i)).not.toBeInTheDocument();
  });

  /**
   * Trouvé en recette le 05/10/2026.
   *
   * Le ticket imprimait TOUTES les lignes de la commande, y compris celles
   * déjà servies. Deuxième passage sur la même table, la cuisine recevait les
   * plats cuits une première fois comme neufs et en refaisait autant : de la
   * nourriture jetée, et des clients qui attendent un plat qu'ils ont déjà
   * mangé. Le papier doit dire la même chose que send_order_items().
   */
  it('n\'imprime en cuisine que ce qui n\'est pas encore parti', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(
      plat,
      { ...plat, id: 'l2', status: 'served', product: { name: 'Riz gras' } },
    );
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const imprimer = await screen.findByRole('button', { name: /Imprimer le ticket cuisine/i });
    fireEvent.click(imprimer);

    await waitFor(() => expect(printKitchenTicket).toHaveBeenCalledTimes(1));
    const ticket = vi.mocked(printKitchenTicket).mock.calls[0][0];
    expect(ticket.items).toHaveLength(1);
    expect(ticket.items[0]).toMatchObject({ product_name: 'Poulet braisé', status: 'new' });
  });

  /**
   * La face du test précédent : quand tout est déjà parti, il n'y a rien à
   * imprimer. Imprimer quand même reviendrait à relancer un plat.
   */
  it('refuse le ticket quand la commande est déjà partie en cuisine', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande({ ...plat, status: 'served' });
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const imprimer = await screen.findByRole('button', { name: /Imprimer le ticket cuisine/i });
    fireEvent.click(imprimer);

    await expect(
      screen.findByText(/déjà partis en cuisine/i),
    ).resolves.toBeInTheDocument();
    expect(printKitchenTicket).not.toHaveBeenCalled();
  });

  /**
   * Trouvé en recette le 05/10/2026.
   *
   * Une commande à emporter n'a pas de table, et la vue `restaurant_floor` est
   * pilotée par les tables : elle n'y figure donc jamais. « Fermer le panneau »
   * — ou le simple fait de cliquer sur une table — rendait alors la commande
   * inatteignable à jamais. Ses plats étaient servis, et rien ne pouvait ni
   * l'ajouter ni la solder.
   */
  it('retrouve une commande à emporter fermée du panneau', async () => {
    // La salle est vide : c'est le cas où la commande orpheline était la plus
    // invisible — l'écran affichait « Aucune table configurée ».
    definirSalle();
    definirPrises({
      id: 'cmd-7',
      customer_name: 'Koffi',
      opened_at: new Date(Date.now() - 12 * 60000).toISOString(),
      status: 'open',
      items: [{ quantity: 2, unit_price: 4500, extra_price: 0 }],
    });

    render(<FloorModule products={produits} />);

    await waitFor(() =>
      expect(screen.getByText('À emporter en cours')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Aucune table configurée')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Reprendre la commande à emporter de Koffi/ }),
    );

    // Le panneau se rouvre sur la MÊME commande : on n'en a pas créé une autre.
    expect(screen.getByText(/Aucun plat commandé/)).toBeInTheDocument();
    expect(inserts.filter((i) => 'table_id' in i)).toHaveLength(0);
  });

  /**
   * Même recette. Une quantité nulle ou négative casserait l'addition : le total
   * afficherait moins que la somme des lignes, et close_table_order() factories
   * une ligne à prix 0.
   */
  /**
   * Décidé le 05/10/2026.
   *
   * L'écran disait « Demandez l'addition : seul le patron encaisse », et la base
   * refusait l'appel. Mais la caisse, elle, laisse un caissier vendre tous les
   * jours : dans un maquis, le personnel est employé, il ramasse l'argent et ne
   * pouvait pas l'écrire. Le patron devait solder une addition après l'autre.
   *
   * Ce que le geste ne déplace pas : la vente est écrite sur le patron
   * (create_sale() utilise l'identifiant du propriétaire, jamais celui du
   * caissier) et le montant est lu dans les lignes de commande. Voir 24j et
   * suivants dans supabase/tests/migration.test.mjs.
   */
  it('laisse le caissier encaisser une addition', async () => {
    acteur.canManageProducts = false;
    acteur.isEmployee = true;

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const encaisse = await screen.findByRole('button', { name: /Encaisser 9\s?000 F/ });
    fireEvent.click(encaisse);

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    expect(rpcResultats).toContain('close_table_order');
  });

  /**
   * Le seul endroit de la salle qui reste fermé au caissier : choisir les plats
   * servis aujourd'hui est de l'administration, pas de la vente.
   */
  it('ne laisse pas le caissier régler la carte du jour', async () => {
    acteur.canManageProducts = false;
    acteur.isEmployee = true;
    definirModificateurs({ id: 'm1', product_id: 'p1', name: 'Bien cuit', extra_price: 0 });

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    // L'ouverture de la commande est asynchrone : le panneau doit être là avant
    // de cliquer un plat, sinon on cherche un bouton qui n'existe pas encore.
    await screen.findByLabelText(/Chercher un plat/i);
    fireEvent.click(screen.getByText('Poulet braisé'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ajouter à la commande/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Servi le/i)).toBeNull();
  });

  it('refuse une quantité nulle ou négative sur une ligne', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const champ = await screen.findByLabelText(/Quantité de Poulet braisé/i);
    updates.length = 0;
    fireEvent.blur(champ, { target: { value: '0' } });

    await waitFor(() =>
      expect(screen.getByText(/quantité doit être un nombre supérieur à zéro/i)).toBeInTheDocument(),
    );
    expect(updates.length).toBe(0);
  });

  /**
   * Trouvé en recette navigateur le 06/10/2026.
   *
   * setLineQty refusait déjà une quantité nulle — mais addLine, elle, rendait
   * en silence : le serveur tapait « 0 », cliquait sur « Ajouter à la
   * commande », et rien n'arrivait ni n'apparaissait. Un clic raté, à ses
   * yeux, qui le refaisait en vain. Le message est celui de setLineQty, pour
   * que les deux chemins parlent d'une seule voix.
   */
  it('refuse une quantité nulle ou négative à l\'ajout d\'une ligne', async () => {
    definirModificateurs();
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    inserts.length = 0;
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    // Premier clic : sélection du plat, aucune écriture — même garantie que le
    // test des options.
    fireEvent.click(screen.getAllByText('Poulet braisé')[0]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ajouter à la commande/i })).toBeInTheDocument(),
    );
    expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Quantité'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter à la commande/i }));
    await waitFor(() =>
      expect(screen.getByText(/quantité doit être un nombre supérieur à zéro/i)).toBeInTheDocument(),
    );

    // Négatif, même combat : le refus doit être dit, jamais subi en silence.
    fireEvent.change(screen.getByLabelText('Quantité'), { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter à la commande/i }));
    await waitFor(() => expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(0));
  });

  it('une commande à emporter reste possible sans table configurée', async () => {
    definirSalle();
    render(<FloorModule products={produits} />);
    await waitFor(() => expect(screen.getByText(/Aucune table configurée/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Commande à emporter/i })).toBeInTheDocument();
  });

  it('le plat armé ne survit pas au changement de table', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1', order_id: 'cmd-1', status: 'open', opened_at: new Date().toISOString() }),
      table({ id: 't2', name: 'Table 2', order_id: 'cmd-2', status: 'open', opened_at: new Date().toISOString() }),
    );
    render(<FloorModule products={produits} />);
    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.click(screen.getAllByText('Poulet braisé')[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: /Ajouter à la commande/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Fermer le panneau/i }));
    fireEvent.click(screen.getByText('Table 2'));

    // Le plat choisi pour Table 1 ne doit pas être armé pour Table 2.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Ajouter à la commande/i })).not.toBeInTheDocument(),
    );
  });

  it('refuse de retirer le dernier jour de service (pas de bascule « tous les jours »)', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1', order_id: 'cmd-1', status: 'open', opened_at: new Date().toISOString() }));
    // Le plat n'est servi QUE le jour courant — c'est ce qui le rend visible
    // dans la carte du jour (sinon, un autre jour, il est masqué : correct).
    const labels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    const aujourdHui = new Date().getDay();
    (produits[0] as unknown as { menu_days: number[] | null }).menu_days = [aujourdHui];
    render(<FloorModule products={produits} />);
    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.click(screen.getAllByText('Poulet braisé')[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: /Ajouter à la commande/i })).toBeInTheDocument());

    // Décocher le seul jour coché doit être refusé, jamais transformé en
    // « tous les jours ».
    fireEvent.click(screen.getByRole('button', { name: labels[aujourdHui] }));
    await waitFor(() => expect(screen.getByText(/au moins un jour/i)).toBeInTheDocument());

    (produits[0] as unknown as { menu_days: number[] | null }).menu_days = null;
  });

  it('cède une addition à crédit avec le téléphone du client', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);
    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    // Le panneau et ses lignes arrivent en asynchrone : on attend le bouton
    // d'encaissement (rendu seulement quand les lignes sont là).
    await screen.findByRole('button', { name: /Encaisser/ });

    fireEvent.click(screen.getByRole('button', { name: 'Crédit' }));
    fireEvent.change(screen.getByLabelText('Téléphone du client (crédit)'), { target: { value: '97000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Céder à crédit/i }));

    await waitFor(() => {
      const appel = supabase.rpc.mock.calls.find(([fn]) => fn === 'close_table_order');
      expect(appel?.[1]).toEqual(expect.objectContaining({
        p_payment_method: 'credit',
        p_client_phone: '97000000',
      }));
    });
  });

  it('refuse de céder à crédit sans téléphone (rien n\'est écrit)', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);
    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await screen.findByRole('button', { name: /Encaisser/ });

    fireEvent.click(screen.getByRole('button', { name: 'Crédit' }));
    fireEvent.click(screen.getByRole('button', { name: /Céder à crédit/i }));

    await waitFor(() => expect(screen.getByText(/numéro de téléphone est requis/i)).toBeInTheDocument());
    expect(supabase.rpc.mock.calls.some(([fn]) => fn === 'close_table_order')).toBe(false);
  });
});

describe('FloorModule — disponibilité et remise à zéro', () => {
  it('refuse à l’ajout un article sans recette et à stock 0 (pas au paiement)', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    dishRows.length = 0; // aucun plat : « Spaghetti » est un article
    const catalogue = [
      { id: 'z1', name: 'Spaghetti', sku: 'SPA', price_buy: 0, price_sell: 1500, stock_qty: 0, min_stock_level: 0, category: 'Plats', unit: 'pce' },
    ] as unknown as Product[];
    render(<FloorModule products={catalogue} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    // La tuile annonce la rupture.
    await waitFor(() => expect(screen.getAllByText('Rupture de stock').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Spaghetti'));
    await waitFor(() => expect(screen.getByText(/Réapprovisionnez-le/)).toBeInTheDocument());
    // Aucune ligne de commande n'a été écrite.
    expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(0);
  });

  it('un PLAT (avec recette) à stock 0 reste vendable', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    dishRows.length = 0;
    dishRows.push({ dish_id: 'z2' });
    const catalogue = [
      { id: 'z2', name: 'Attiéké poisson', sku: 'ATT', price_buy: 0, price_sell: 2000, stock_qty: 0, min_stock_level: 0, category: 'Plats', unit: 'pce' },
    ] as unknown as Product[];
    render(<FloorModule products={catalogue} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    await waitFor(() => expect(screen.getByText('Attiéké poisson')).toBeInTheDocument());
    expect(screen.queryByText('Rupture de stock')).toBeNull();
    // Sélectionnable : le panneau d'ajout s'ouvre.
    fireEvent.click(screen.getByText('Attiéké poisson'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Ajouter à la commande/ })).toBeInTheDocument());
  });

  it('changer de table remet le partage d’addition à zéro', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1', order_id: 'cmd-1', status: 'open' }),
      table({ id: 't2', name: 'Table 2' }),
    );
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));
    fireEvent.click(screen.getByText(/Partager l'addition/i));
    await waitFor(() => expect(screen.getByText(/Répartir en/)).toBeInTheDocument());

    // Autre table : le partage de la précédente ne doit pas suivre.
    fireEvent.click(screen.getByText('Table 2'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    expect(screen.queryByText(/Répartir en/)).toBeNull();
  });

  it('masque les ingrédients du menu de la salle', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    dishRows.length = 0;
    dishRows.push({ dish_id: 'plat1' }, { ingredient_id: 'ing1' });
    const catalogue = [
      { id: 'plat1', name: 'Plat vendable', sku: 'PL', price_buy: 0, price_sell: 2000, stock_qty: 0, min_stock_level: 0, category: 'Plats', unit: 'pce' },
      { id: 'ing1', name: 'Riz cru (kg)', sku: 'RIZ', price_buy: 500, price_sell: 700, stock_qty: 50, min_stock_level: 5, category: 'Ingrédients', unit: 'pce' },
    ] as unknown as Product[];
    render(<FloorModule products={catalogue} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    // Le plat (avec recette) est au menu ; l'ingrédient n'y est pas.
    await waitFor(() => expect(screen.getByText('Plat vendable')).toBeInTheDocument());
    expect(screen.queryByText('Riz cru (kg)')).toBeNull();
  });

  it('le libellé « Servi le… » reflète les jours choisis', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    const today = new Date().getDay();
    const court: Record<number, string> = { 0: 'Dim', 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Jeu', 5: 'Ven', 6: 'Sam' };
    const catalogue = [
      { id: 'p9', name: 'Poisson braisé', sku: 'PB', price_buy: 0, price_sell: 3000, stock_qty: 5, min_stock_level: 0, category: 'Plats', unit: 'pce', menu_days: [today] },
    ] as unknown as Product[];
    render(<FloorModule products={catalogue} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Poisson braisé'));

    await waitFor(() => expect(screen.getByText(/Servi le/)).toBeInTheDocument());
    const titre = screen.getByText(/Servi le/).textContent ?? '';
    expect(titre).toContain(court[today]);
    expect(titre).not.toContain('tous les jours');
  });
});

describe('FloorModule — transfert et fusion', () => {
  it('déplace une commande vers une table libre', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1', order_id: 'cmd-1', status: 'open' }),
      table({ id: 't2', name: 'Table 2' }),
    );
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText('Déplacer')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Déplacer'));
    const select = await screen.findByLabelText('Déplacer vers la table');
    fireEvent.change(select, { target: { value: 't2' } });

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('transfer_table_order', {
        p_order_id: 'cmd-1', p_target_table_id: 't2',
      }),
    );
  });

  it('fusionne une autre table dans la commande courante', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1', order_id: 'cmd-1', status: 'open' }),
      table({ id: 't2', name: 'Table 2', order_id: 'cmd-2', status: 'open' }),
    );
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText('Fusionner')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Fusionner'));
    const select = await screen.findByLabelText('Fusionner une autre commande');
    fireEvent.change(select, { target: { value: 'cmd-2' } });

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('merge_table_orders', {
        p_source_order_id: 'cmd-2', p_target_order_id: 'cmd-1',
      }),
    );
  });

  it('enregistre le nombre de couverts de la commande', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByLabelText('Nombre de couverts')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Nombre de couverts'), { target: { value: '4' } });
    fireEvent.blur(screen.getByLabelText('Nombre de couverts'));

    await waitFor(() =>
      expect(updates.some((u) => u.table === 'restaurant_orders' && u.payload.covers === 4)).toBe(true),
    );
  });
});

describe('FloorModule — partage par article et paiement multiple', () => {
  it('rattache une ligne à un convive (partage par article)', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    const select = await screen.findByLabelText(/Part de Poulet braisé/);
    fireEvent.change(select, { target: { value: '2' } });

    await waitFor(() =>
      expect(updates.some((u) => u.table === 'restaurant_order_items' && u.payload.split_part === 2)).toBe(true),
    );
  });

  it('encaisse avec plusieurs moyens (paiement multiple)', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat); // 2 × 4 500 = 9 000
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.click(await screen.findByText(/Paiement multiple/));

    fireEvent.change(screen.getByLabelText('Montant du paiement 1'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('Montant du paiement 2'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser/ }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('close_table_order', expect.objectContaining({
        p_order_id: 'cmd-9',
        p_payments: [{ method: 'cash', amount: 5000 }, { method: 'momo', amount: 4000 }],
      })),
    );
  });

  it('refuse un paiement multiple dont la somme ne fait pas l’addition', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat); // 9 000
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.click(await screen.findByText(/Paiement multiple/));

    fireEvent.change(screen.getByLabelText('Montant du paiement 1'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser/ }));

    await waitFor(() => expect(screen.getByText(/doit égaler l.addition/)).toBeInTheDocument());
    expect(supabase.rpc.mock.calls.some(([fn]) => fn === 'close_table_order')).toBe(false);
  });
});

describe('FloorModule — remises et offerts', () => {
  it('offre une ligne (patron)', async () => {
    acteur.canManageProducts = true;
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Offert' }));

    await waitFor(() =>
      expect(updates.some((u) => u.table === 'restaurant_order_items' && u.payload.is_offered === true)).toBe(true),
    );
  });

  it('accorde une remise (patron) et l’envoie à l’encaissement', async () => {
    acteur.canManageProducts = true;
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat); // 2 × 4 500 = 9 000
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    fireEvent.change(await screen.findByLabelText('Remise (F)'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser/ }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('close_table_order', expect.objectContaining({ p_discount: 1000 })),
    );
  });

  it('un caissier ne voit ni la remise ni le bouton Offert', async () => {
    acteur.canManageProducts = false;
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText('Fermer le panneau')).toBeInTheDocument());
    expect(screen.queryByLabelText('Remise (F)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Offert' })).toBeNull();
  });
});