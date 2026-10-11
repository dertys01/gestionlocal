'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  UtensilsCrossed, Loader2, Plus, Users, Clock, CheckCircle2, PackageX, ChefHat, X,
} from 'lucide-react';

import { useSupabase } from '@/components/providers/SupabaseProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { logActivity } from '@/lib/utils/activity';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { printKitchenTicket } from '@/lib/utils/kitchen';
import { platsServisAujourdhui } from '@/lib/utils/menu';
import { loadDishIds, loadIngredientIds, estVendableAuMenu } from '@/lib/utils/dishes';
import { lireMontant } from '@/lib/utils/nombres';
import { localTimeZone, todayISO } from '@/lib/utils/period';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';
import type { Product } from '@/types';

/**
 * La salle : le plan des tables et la commande en cours.
 *
 * Ce module ne fait PAS d'encaissement. Une commande vit sur sa table jusqu'à
 * sa clôture (Sprint 14, qui écrira la vente) : ici on prend la commande, on
 * marque ce qui part en cuisine et ce qui est servi. Le stock n'est pas
 * touché tant que la commande n'est pas close — le serveur ne « vend » rien.
 */

interface TableRow {
  id: string;
  name: string;
  zone: string;
  seats: number | null;
  is_active: boolean;
  order_id: string | null;
  status: 'open' | 'bill_requested' | null;
  customer_name: string | null;
  opened_at: string | null;
  amount_paid: number;
  order_total: number;
}

interface OrderLine {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  /** Supplément du modificateur choisi, figé à l'insertion. */
  extra_price: number;
  modifier: string | null;
  note: string | null;
  status: 'new' | 'sent' | 'served';
  /** Convive (partage par article). null = non affecté. */
  split_part: number | null;
  /** Ligne offerte (tournée) : exclue de l'addition. */
  is_offered: boolean;
  name?: string;
}

/** Option de carte : « bien cuit », « double portion », « sans piment ». */
interface Modifier {
  id: string;
  product_id: string;
  name: string;
  extra_price: number;
  is_required: boolean;
}

const STATUT_LIBELLE = {
  open: 'En service',
  bill_requested: 'Addition demandée',
} as const;

const minutesDepuis = (iso: string | null) => {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
};

/**
 * Une commande à emporter en cours.
 *
 * Elle n'a pas de table, et c'est là que se joue le bug qu'elle répare : la vue
 * `restaurant_floor` est pilotée par les tables (FROM restaurant_tables LEFT
 * JOIN restaurant_orders), donc une commande sans table n'y apparaît jamais.
 * Le seul écran qui la connaissait était le panneau ouvert — « Fermer le
 * panneau », ou le clic sur n'importe quelle table, la rendait alors
 * inatteignable à jamais. Ses plats étaient servis, sa ligne de commande
 * existait, et personne ne pouvait plus ni l'ajouter ni la solder : ni vente,
 * ni stock décrémenté. (Retrouvé en recette le 05/10/2026.)
 *
 * Les lignes viennent avec la commande, pour afficher le montant déjà
 * engagé : c'est ce qui permet de reconnaître la commande dans la liste.
 */
interface TakeawayRow {
  id: string;
  customer_name: string | null;
  opened_at: string | null;
  /**
   * Serves le même libellé que les tables. `closed` est filtré par la requête
   * (`.neq('status','closed')`) : il ne vient pas ici, et STATUT_LIBELLE n'a
   * pas de clé pour.
   */
  status: 'open' | 'bill_requested';
  items: Array<{ quantity: number; unit_price: number; extra_price: number | null }> | null;
}

/**
 * Même addition que celle du panneau (`totalLignes`) et de la vue
 * (`order_total`) : quantité × (prix convenu + supplément du modificateur).
 * Trois endroits, une seule formule.
 */
const totalPrise = (p: TakeawayRow) =>
  (p.items ?? []).reduce(
    (n, l) => n + Number(l.quantity) * (Number(l.unit_price) + Number(l.extra_price ?? 0)),
    0,
  );

/** getDay() : 0 = dimanche. L'ordre commence donc par lundi, comme un menu. */
const JOURS = [
  { valeur: 1, court: 'Lun' },
  { valeur: 2, court: 'Mar' },
  { valeur: 3, court: 'Mer' },
  { valeur: 4, court: 'Jeu' },
  { valeur: 5, court: 'Ven' },
  { valeur: 6, court: 'Sam' },
  { valeur: 0, court: 'Dim' },
] as const;

export function FloorModule({
  products,
  onChanged,
}: {
  products: Product[];
  /** Rafraîchit le catalogue après une modification de carte. */
  onChanged?: () => void;
}) {
  const { supabase, ownerId, actorName, user, canManageProducts, isEmployee, org } = useSupabase();
  // Le client Supabase n'est typé sur aucun schéma : les noms de colonnes ne
  // sont pas vérifiés. Une petite surface typée vaut mieux que des `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const [tables, setTables] = useState<TableRow[]>([]);
  const [prises, setPrises] = useState<TakeawayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Commande ouverte sélectionnée. On retient l'IDENTITÉ de la table, pas sa
  // lignecopiée : la vue restaurant_floor la rafraîchit (montant, statut) et le
  // rendu prend toujours la version la plus récente quand elle existe.
  const [orderId, setOrderId] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<{ tableId: string; nom: string; client: string | null } | null>(null);
  // Panneau « Déplacer / Fusionner » ouvert sous l'en-tête de la commande.
  const [actionTable, setActionTable] = useState<'transfer' | 'merge' | null>(null);
  // Couverts (nombre de clients) de la commande ouverte, saisi au service.
  const [covers, setCovers] = useState('');
  // Remise sur l'addition (patron/manager uniquement).
  const [remise, setRemise] = useState('');
  // Résumé du jour : couverts, additions, CA → ticket moyen par couvert.
  const [stats, setStats] = useState<{ covers: number; additions: number; revenue: number } | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  // Numéro de la dernière requête de lignes : ouvrir Table A puis Table B sans
  // attendre ne doit pas laisser A écraser B (ou lever le spinner de B).
  const linesReqRef = useRef(0);
  // Ligne en attente de confirmation de retrait : un mis-tap ne doit pas
  // effacer une ligne en plein service.
  const [aRetirer, setARetirer] = useState<OrderLine | null>(null);

  // Saisie
  const [clientName, setClientName] = useState('');
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  /** Le formulaire « nouvelle table » est-il déplié ? Replié dès qu'il y a des tables. */
  const [nouvelleTableOuverte, setNouvelleTableOuverte] = useState(false);
  /**
   * La recherche ne doit pas survivre au changement de table : le serveur
   * ouvre Table 2 après avoir tapé « poulet » sur Table 1, et voit une carte
   * réduite à deux plats — puis conclut que les autres ne sont pas à la carte.
   * La carte complète est rendue d'office, la recherche sert à retrouver un plat
   * précis, pas à en cacher la moitié.
   */

  // Carte des options : chargée pour le plat sélectionné, pas pour tout le
  // catalogue. Un restaurant de 200 plats ne doit pas envoyer 200 lignes de
  // modificateurs pour en afficher trois.
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  // Vrai pendant le chargement des options du plat sélectionné : évite d'afficher
  // « Aucune option » une fraction de seconde avant que les options n'arrivent
  // (le serveur croyait alors que le plat n'avait pas d'options).
  const [modifiersLoading, setModifiersLoading] = useState(false);
  const [modSelection, setModSelection] = useState('');
  const [platChoisi, setPlatChoisi] = useState<Product | null>(null);
  // Carte du jour : un restaurant ne sert pas le poisson le mardi. Sans ce
  // filtre, la commande propose des plats que la cuisine ne cuisine pas.
  const [menuDuJour, setMenuDuJour] = useState(true);
  // Plats = produits AVEC recette. Un plat se vend sans stock propre (sa
  // disponibilité vient de ses ingrédients) ; un article sans recette, lui, est
  // borné par son stock. Même règle que la caisse (POSModule).
  const [dishIds, setDishIds] = useState<Set<string>>(() => new Set());
  // Ingrédients : produits qui composent, pas qui se vendent. Masqués du menu de
  // la salle (ils restent dans le Stock), sauf s'ils sont aussi des plats.
  const [ingredientIds, setIngredientIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let vivant = true;
    void loadDishIds(db).then((ids) => { if (vivant) setDishIds(ids); });
    void loadIngredientIds(db).then((ids) => { if (vivant) setIngredientIds(ids); });
    return () => { vivant = false; };
  }, [db]);
  /** Un produit est vendable s'il a une recette (plat) ou du stock. */
  const vendable = (p: Product) => dishIds.has(p.id) || Number(p.stock_qty) > 0;

  /**
   * Remet la saisie d'ajout à zéro (plat, option, quantité, note, recherche).
   *
   * Sans cela, le plat sélectionné pour une table restait ARMÉ quand on passait
   * à une autre : un seul tap l'ajoutait à la mauvaise commande. Le même vidage
   * sert à la fermeture du panneau et à l'ouverture d'une table/commande.
   */
  const viderSaisie = () => {
    setPlatChoisi(null);
    setModSelection('');
    setModifiers([]);
    setQty('');
    setNote('');
    setSearch('');
    // La CLÔTURE repart de zéro elle aussi : le partage d'addition, le moyen de
    // paiement et le pourboire de la commande précédente ne doivent pas
    // s'appliquer à la suivante. Sans ça, une table « partagée en 2 » laissait
    // un reçu « 2 parts » sur la commande suivante (jamais partagée).
    setSplitOpen(false);
    setSplitCount(1);
    setPayment('cash');
    setCreditPhone('');
    setCreditAdvance('');
    setTip(0);
  };

  // « 42 min » doit avancer tout seul : sans ce tic, l'écart de service ne
  // bougeait qu'au prochain rendu (action ou temps réel), jamais avec l'horloge.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const loadTables = useCallback(async () => {
    setLoading(true);
    setError('');
    // Deux lectures en parallèle : le plan de salle ET les commandes à
    // emporter, qui n'y figurent pas (voir TakeawayRow). Les faire séquentielles
    // ajouterait une aller-retour au rafraîchissement le plus fréquent de
    // l'application.
    const [plan, emporter] = await Promise.all([
      db
        .from('restaurant_floor')
        .select('id, name, zone, seats, is_active, order_id, status, customer_name, opened_at, amount_paid, order_total')
        .order('zone')
        .order('name'),
      db
        .from('restaurant_orders')
        .select('id, customer_name, opened_at, status, items:restaurant_order_items(quantity, unit_price, extra_price)')
        .is('table_id', null)
        .neq('status', 'closed')
        .order('opened_at'),
    ]);
    setLoading(false);
    if (plan.error) { setError(plan.error.message); return; }
    setTables((plan.data ?? []) as TableRow[]);
    // Une erreur sur la seconde lecture ne doit pas masquer le plan déjà reçu :
    // on la signale et on laisse la liste vide au pire.
    if (emporter.error) {
      // On vide la liste : garder des tuiles « à emporter » périmées sous un
      // bandeau d'erreur laissait le serveur reprendre une commande fantôme.
      setError(emporter.error.message);
      setPrises([]);
      return;
    }
    setPrises(
      Array.isArray(emporter.data) ? (emporter.data as TakeawayRow[]) : []
    );
  }, [db]);

  const loadLines = useCallback(async (id: string) => {
    const req = ++linesReqRef.current;
    setLinesLoading(true);
    const { data, error: err } = await db
      .from('restaurant_order_items')
      .select('id, product_id, quantity, unit_price, extra_price, modifier, note, status, split_part, is_offered, product:products(name)')
      .eq('order_id', id)
      .order('created_at');
    // Une réponse d'une table déjà quittée est ignorée : sinon ses lignes
    // s'affichaient sous la mauvaise table.
    if (req !== linesReqRef.current) return;
    setLinesLoading(false);
    if (err) { setError(err.message); return; }
    setLines(
      ((data ?? []) as Array<Omit<OrderLine, 'name'> & { product: { name: string } | null }>).map((l) => ({
        ...l,
        name: l.product?.name ?? 'Produit',
      }))
    );
  }, [db]);

  // Options du plat sélectionné. Un restaurant de 200 plats n'envoie pas 200
  // lignes de modificateurs pour en proposer trois : on charge à la demande.
  useEffect(() => {
    const plat = platChoisi;
    let annule = false;
    const t = setTimeout(async () => {
      if (!plat) { setModifiers([]); setModifiersLoading(false); return; }
      setModifiersLoading(true);
      const { data } = await db
        .from('product_modifiers')
        .select('id, product_id, name, extra_price, is_required')
        .eq('product_id', plat.id)
        .order('name');
      // Le plat a changé pendant la requête : on n'affiche pas les options du
      // précédent sous le titre du suivant.
      if (annule) return;
      setModifiers((data ?? []) as Modifier[]);
      setModifiersLoading(false);
    }, 0);
    return () => { annule = true; clearTimeout(t); };
  }, [platChoisi, db]);

  // Les effets encapsulent l'appel async plutôt que d'appeler loadTables()
// directement : setLoading(true) serait alors un setState synchrone dans un
// effet, ce qui provoque un rendu en cascade (react-hooks/set-state-in-effect).
  useEffect(() => {
    const t = setTimeout(() => { void loadTables(); }, 0);
    return () => clearTimeout(t);
  }, [loadTables]);

  // Temps réel (si NEXT_PUBLIC_REALTIME=1) : une commande ouverte sur un autre
  // appareil (le serveur, la caisse) rafraîchit le plan de salle.
  useRealtimeRefresh(['restaurant_orders'], loadTables);

  // Et les LIGNES de la commande ouverte : une ligne ajoutée par un autre
  // appareil sur la même table n'apparaissait qu'en rouvrant la table.
  useRealtimeRefresh(['restaurant_order_items'], () => {
    if (orderId) void loadLines(orderId);
  });

  useEffect(() => {
    if (!orderId) return;
    const id = orderId;
    const t = setTimeout(() => { void loadLines(id); }, 0);
    return () => clearTimeout(t);
  }, [orderId, loadLines]);

  // La vue recharge la commande ouverte (montant, statut) : on la reprend dès
  // qu'elle est revenue, sinon le panneau afficherait un total à zéro. Un effet
  // qui appelle setState ici déclencherait un rendu en cascade — d'où la
  // dérivation ci-dessous, purement calculée au rendu.
  const tableOuverte: TableRow | null = useMemo(() => {
    const vue = tables.find((t) => t.order_id === orderId);
    if (vue) return vue;
    if (!ouverte || !orderId) return null;
    return {
      id: ouverte.tableId,
      name: ouverte.nom,
      zone: '',
      seats: null,
      is_active: true,
      order_id: orderId,
      status: 'open',
      customer_name: ouverte.client,
      opened_at: null,
      amount_paid: 0,
      order_total: 0,
    };
  }, [tables, orderId, ouverte]);

  // Une commande ouverte sur une table : c'est ce que le serveur fait en
  // arrivant. Le nom du client est facultatif — la table parle déjà.
  const openOrder = async (tableId: string) => {
    if (!ownerId) return;
    setBusy(true);
    setError('');
    const { data, error: err } = await db
      .from('restaurant_orders')
      .insert({
        owner_id: ownerId,
        table_id: tableId,
        customer_name: clientName.trim() || null,
        opened_by: user?.id ?? null,
      })
      .select('id')
      .single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    setClientName('');
    // La table vient d'être ouverte : on retient son identité pour que le panneau
    // existe avant le prochain rechargement de la vue.
    const table = tables.find((t) => t.id === tableId);
    if (table) setOuverte({ tableId, nom: table.name, client: clientName.trim() || null });
    setOrderId(data.id);
    await loadTables();
  };

  // Commande à emporter : sans table. La moitié du chiffre d'affaires d'un
  // maquis, et le plus simple quand la salle est pleine.
  const openTakeaway = async () => {
    if (!ownerId) return;
    // La clôture et la saisie de la commande précédente ne doivent pas suivre.
    viderSaisie();
    setBusy(true);
    setError('');
    const { data, error: err } = await db
      .from('restaurant_orders')
      .insert({
        owner_id: ownerId,
        table_id: null,
        customer_name: clientName.trim() || null,
        opened_by: user?.id ?? null,
      })
      .select('id')
      .single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    setClientName('');
    setOuverte({ tableId: '', nom: 'À emporter', client: clientName.trim() || null });
    setOrderId(data.id);
    await loadTables();
  };

  /**
   * Déplacer la commande ouverte vers une table LIBRE.
   * Le verrou de table est tenu par la fonction SQL (transaction) : pas de
   * fenêtre où la table serait libre pour tout le monde.
   */
  const transferer = async (targetTableId: string) => {
    if (!orderId || !targetTableId) return;
    setBusy(true);
    setError('');
    const { error: err } = await db.rpc('transfer_table_order', {
      p_order_id: orderId,
      p_target_table_id: targetTableId,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const t = tables.find((x) => x.id === targetTableId);
    setActionTable(null);
    if (t) setOuverte({ tableId: t.id, nom: t.name, client: tableOuverte?.customer_name ?? null });
    await loadTables();
  };

  /**
   * Fusionner une AUTRE commande ouverte dans celle-ci : ses lignes rejoignent
   * la commande courante, et sa table redevient libre.
   */
  const fusionner = async (sourceOrderId: string) => {
    if (!orderId || !sourceOrderId) return;
    setBusy(true);
    setError('');
    const { error: err } = await db.rpc('merge_table_orders', {
      p_source_order_id: sourceOrderId,
      p_target_order_id: orderId,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setActionTable(null);
    await Promise.all([loadTables(), loadLines(orderId)]);
  };

  // Couverts de la commande ouverte : relus à chaque changement de commande.
  useEffect(() => {
    const commande = orderId;
    let annule = false;
    const t = setTimeout(async () => {
      if (!commande) { if (!annule) setCovers(''); return; }
      const { data } = await db.from('restaurant_orders').select('covers').eq('id', commande);
      if (annule) return;
      const row = (Array.isArray(data) ? data[0] : data) as { covers?: number | null } | null;
      setCovers(row?.covers != null ? String(row.covers) : '');
    }, 0);
    return () => { annule = true; clearTimeout(t); };
  }, [orderId, db]);

  /** Enregistre le nombre de couverts de la commande ouverte. */
  const enregistrerCovers = async () => {
    if (!orderId) return;
    const brut = covers.trim();
    const n = brut === '' ? null : Math.max(1, Math.floor(lireMontant(brut) ?? 0));
    const { error: err } = await db.from('restaurant_orders').update({ covers: n }).eq('id', orderId);
    if (err) setError(err.message);
  };

  /** Rattache une ligne de commande à un convive (partage par article). */
  const setLinePart = async (line: OrderLine, part: number) => {
    setBusy(true);
    setError('');
    const { error: err } = await db.from('restaurant_order_items').update({ split_part: part }).eq('id', line.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    if (orderId) await loadLines(orderId);
  };

  /** Offre une ligne (tournée) ou annule l'offert. Patron/manager seulement. */
  const toggleOffert = async (line: OrderLine) => {
    if (!canManageProducts) {
      setError('Seul le patron ou un manager peut offrir une ligne.');
      return;
    }
    setBusy(true);
    setError('');
    const { error: err } = await db.from('restaurant_order_items').update({ is_offered: !line.is_offered }).eq('id', line.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    if (orderId) await loadLines(orderId);
  };

  // Couverts / additions / CA du jour → ticket moyen par couvert.
  const loadStats = useCallback(async () => {
    const jour = todayISO();
    const { data } = await db.rpc('get_restaurant_stats', { p_from: jour, p_to: jour, p_tz: localTimeZone() });
    const r = (Array.isArray(data) ? data[0] : data) as { covers?: number; additions?: number; revenue?: number } | null;
    if (r && typeof r === 'object') {
      setStats({ covers: Number(r.covers ?? 0), additions: Number(r.additions ?? 0), revenue: Number(r.revenue ?? 0) });
    }
  }, [db]);
  useEffect(() => {
    const t = setTimeout(() => { void loadStats(); }, 0);
    return () => clearTimeout(t);
  }, [loadStats]);

  const addLine = async (product: Product) => {
    if (!orderId) return;
    // Même règle que la caisse : un produit sans recette et à stock 0 n'est pas
    // vendable. On le refuse ICI, à l'ajout — sinon l'erreur n'arrivait qu'à
    // l'encaissement, après avoir servi le client.
    if (!vendable(product)) {
      setError(
        `« ${product.name} » est en rupture de stock. Réapprovisionnez-le, ou donnez-lui une recette (onglet Recettes).`,
      );
      return;
    }
    // Un champ quantité vide vaut 1 — le serveur tape rarement la quantité.
    // lireMontant('') rend 0 (zéro est une quantité valide ailleurs), donc le
    // cas du champ vide doit être traité avant l'appel.
    const n = qty.trim() === '' ? 1 : lireMontant(qty);
    if (n === null || n <= 0) {
      // Jamais un retour muet : le serveur tape « 0 », clique sur
      // « Ajouter à la commande » et ne voit RIEN arriver — il croit à un
      // clic raté et recommence. C'est le même message que setLineQty(),
      // pour que les deux chemins parlent d'une seule voix.
      setError('La quantité doit être un nombre supérieur à zéro.');
      return;
    }
    if (n > 1000) {
      // Même borne que setLineQty : les deux chemins doivent s'accorder.
      setError('Une ligne de commande ne peut pas dépasser 1 000 portions.');
      return;
    }
    // Un modificateur choisi (« double portion ») porte son supplément dans
    // extra_price. La colonne est renseignée à l'insertion : la modifier
    // ensuite laisserait un supplément fantôme, et le total affiché par la vue
    // de la salle (qui additionne quantity × unit_price) divergerait de
    // l'addition réellement encaissée.
    const mod = modifiers.find((m) => m.id === modSelection) ?? null;
    setBusy(true);
    setError('');
    const { error: err } = await db.from('restaurant_order_items').insert({
      order_id: orderId,
      product_id: product.id,
      quantity: n,
      // Prix convenu : comme au POS, le patron négocie à la table.
      unit_price: product.price_sell,
      extra_price: mod?.extra_price ?? 0,
      modifier: mod?.name ?? null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setQty('');
    setNote('');
    setModSelection('');
    setPlatChoisi(null);
    await Promise.all([loadLines(orderId), loadTables()]);
  };

  /**
   * Changer la quantité d'une ligne déjà entrée.
   *
   * Trouvé en recette le 05/10/2026 : la quantité n'était modifiable qu'AU
   * MOMENT de l'ajout. Une fois le plat dans la commande, on ne pouvait plus que
   * le supprimer — et le supprimer ne fusionne pas avec une ligne voisine. Le
   * geste le plus courant d'un maquis (trois attiékés, puis on s'est trompé de
   * deux) obligeait donc à tout refaire à la main.
   *
   * On écrit directement la colonne : la policy ALL de restaurant_order_items
   * l'autorise tant que la commande est ouverte, et close_table_order() relit
   * les lignes au moment de l'encaissement — c'est cette quantité qui est
   * facturée et qui décrémente les ingrédients.
   */
  const setLineQty = async (line: OrderLine, raw: string): Promise<boolean> => {
    if (!orderId) return false;
    const n = lireMontant(raw);
    if (n === null || n <= 0) {
      setError('La quantité doit être un nombre supérieur à zéro.');
      return false;
    }
    if (n > 1000) {
      setError('Une ligne de commande ne peut pas dépasser 1 000 portions.');
      return false;
    }
    setBusy(true);
    setError('');
    const { error: err } = await db
      .from('restaurant_order_items')
      .update({ quantity: n })
      .eq('id', line.id);
    setBusy(false);
    if (err) { setError(err.message); return false; }
    await Promise.all([loadLines(orderId), loadTables()]);
    return true;
  };

  const cycleLine = async (line: OrderLine) => {
    // `busy` empêche deux taps rapides de calculer tous les deux depuis l'ancien
    // statut (new → sent deux fois) : la transition vers « servi » serait perdue.
    if (!orderId || busy) return;
    setBusy(true);
    const suivant = line.status === 'new' ? 'sent' : line.status === 'sent' ? 'served' : 'new';
    const { error: err } = await db
      .from('restaurant_order_items')
      .update({ status: suivant })
      .eq('id', line.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await loadLines(orderId);
  };

  const removeLine = async (line: OrderLine) => {
    if (!orderId) return;
    const { error: err } = await db.from('restaurant_order_items').delete().eq('id', line.id);
    if (err) { setError(err.message); return; }
    await Promise.all([loadLines(orderId), loadTables()]);
  };

  /** Comparaison de noms de tables : « table 1 » et « Table 1 » sont la même. */
  const memeNom = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

  const addTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerId || !newTableName.trim()) return;

    // Un nom en double rend le plan et le ticket cuisine ambigus : deux tuiles
    // « Table 1 », et le plongeur ne sait plus laquelle attendre. La base
    // refuse aussi (restaurant_tables_owner_name_uniq), mais elle répond par un
    // « duplicate key » que personne ne sait traduire — on parle donc en
    // français, et la base reste la garantie.
    const nom = newTableName.trim();
    if (tables.some((t) => memeNom(t.name, nom))) {
      setError(`Une table s'appelle déjà « ${nom} ».`);
      return;
    }

    setBusy(true);
    const { error: err } = await db.from('restaurant_tables').insert({
      owner_id: ownerId,
      name: nom,
    });
    setBusy(false);
    if (err) {
      setError(
        err.code === '23505'
          ? `Une table s'appelle déjà « ${nom} ».`
          : err.message,
      );
      return;
    }
    setNewTableName('');
    setNouvelleTableOuverte(false);
    await loadTables();
    if (user) {
      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: 'restaurant_table_add',
        description: `Table ajoutée : ${newTableName.trim()}`,
      });
    }
  };

  /**
   * Recherche : même tolérance que la caisse (fautes de frappe), pour qu'un
   * serveur ne doive pas épeler un plat au client.
   *
   * La carte n'est PAS tronquée. Elle l'était, à 12 plats, sans rien l'annoncer :
   * sur le catalogue d'exemple de 17 plats, Poulet braisé et Riz gras — les deux
   * plats d'un maquis — étaient invisibles, et le serveur, qui voit son plat
   * absent de la carte, conclut que la cuisine ne le fait pas. Le serveur ne
   * sait pas qu'il faut taper dans la recherche.
   *
   * Le tri par défaut range d'abord les plats du jour (voir platsServisAujourdhui)
   * puis le reste par ordre alphabétique, ce qui garde les plats courants en haut.
   */
  const resultats = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Les ingrédients ne sont pas au menu (ils restent dans le Stock) — sauf
    // ceux qui sont aussi des plats.
    const auMenu = products.filter((p) => estVendableAuMenu(p, dishIds, ingredientIds));
    const actifs = platsServisAujourdhui(auMenu, menuDuJour);
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!q) return actifs;
    const nq = norm(q);
    return actifs
      .map((p) => {
        const n = norm(p.name);
        // Préfixe avant « contient » : sinon un plat dont le nom commence par
        // la requête tombait dans le rang 0 de `includes`, et le rang de
        // préfixe (2) n'était jamais atteint.
        if (n.startsWith(nq)) return { p, rang: 0 };
        if (n.includes(nq)) return { p, rang: 1 };
        if (norm(p.sku ?? '').includes(nq)) return { p, rang: 2 };
        return null;
      })
      .filter((x): x is { p: Product; rang: number } => x !== null)
      .sort((a, b) => a.rang - b.rang)
      .map((x) => x.p);
  }, [products, search, menuDuJour, ingredientIds, dishIds]);

  // Le supplément des modificateurs compte dans le total affiché : c'est le
  // montant que la table va payer. Il est figé à l'insertion de la ligne, donc
  // les deux endroits qui l'additionnent (ligne et total) restent d'accord.
  const totalLignes = lines.reduce(
    (n, l) => n + Number(l.quantity) * (Number(l.unit_price) + Number(l.extra_price ?? 0)),
    0
  );

  // Totaux par convive (partage par article). Les lignes sans part comptent en P1.
  const partsTotaux = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of lines) {
      const p = l.split_part ?? 1;
      m.set(p, (m.get(p) ?? 0) + Number(l.quantity) * (Number(l.unit_price) + Number(l.extra_price ?? 0)));
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [lines]);

  // Offerts et remise : l'addition réellement due.
  const totalOffert = lines.reduce(
    (n, l) => n + (l.is_offered ? Number(l.quantity) * (Number(l.unit_price) + Number(l.extra_price ?? 0)) : 0),
    0,
  );
  const totalNet = totalLignes - totalOffert;
  const remiseMontant = Math.max(0, lireMontant(remise) ?? 0);
  const aPayer = Math.max(0, totalNet - remiseMontant);

  // ── Clôture ────────────────────────────────────────────────
  // Fractionner ne multiplie PAS les ventes : trois convives à 12 000 F font
  // une vente de 36 000 F, répartie en 3 parts pour l'affichage. La part de
  // chacun est donc purement visuelle, et c'est le total qu'on encaisse.
  const [splitCount, setSplitCount] = useState(1);
  const [splitOpen, setSplitOpen] = useState(false);
  const [payment, setPayment] = useState<'cash' | 'momo' | 'credit'>('cash');
  // Crédit de table (Sprint 16) : le téléphone est obligatoire (la dette doit
  // être rattachable), l'acompte est ce qui est versé à la clôture.
  const [creditPhone, setCreditPhone] = useState('');
  const [creditAdvance, setCreditAdvance] = useState('');
  // Paiement multiple : plusieurs moyens sur une même addition. Chaque ligne =
  // un moyen + un montant ; la somme doit égaler l'addition.
  const [multiPaiement, setMultiPaiement] = useState(false);
  const [paiements, setPaiements] = useState<Array<{ method: 'cash' | 'momo'; amount: string }>>([]);
  // Pourboire laissé sur la table. Il est enregistré mais HORS du chiffre
  // d'affaires : c'est une manne, pas une recette.
  const [tip, setTip] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<{ total: number; paid: number; tip: number; invoice: string | null; saleId: string; perShare: number } | null>(null);
  /**
   * Qui encaisse une addition ? Tout membre de l'équipe — comme à la caisse.
   *
   * La règle était l'inverse (« seul le patron encaisse »), et c'était une
   * incohérence coûteuse : le caissier encaisse au comptoir tous les jours,
   * create_sale() n'examine pas le rôle, mais il ne pouvait pas solder une table
   * dont il venait de servir les plats. Dans un maquis, le personnel est
   * employé : il ramasse l'argent et ne pouvait pas l'écrire, et le patron
   * devait solder une addition après l'autre.
   *
   * Ce que ça ne change pas : la vente est écrite avec user_id = le patron dans
   * tous les cas, et le montant facturé est lu dans les lignes de commande. Le
   * caissier fait le geste, pas le chiffre d'affaires.
   */

  /**
   * Qui règle la carte du jour ? Le patron et les managers.
   *
   * Choisir les plats servis aujourd'hui est de l'administration : un caissier
   * qui modifie la carte change le restaurant sans avoir mandat pour ça. Ça
   * reste donc fermé, et c'est le seul endroit de la salle qui l'est.
   */
  const peutReglerCarte = !isEmployee || canManageProducts;

  const part = splitCount > 0 ? Math.round((totalLignes / splitCount) * 100) / 100 : 0;

  const closeOrder = async () => {
    if (!orderId) return;
    // Une addition à crédit exige un numéro : sans lui, la dette n'est
    // rattachable à personne. On le dit avant d'appeler, comme le serveur.
    if (payment === 'credit' && !creditPhone.trim()) {
      setError('Un numéro de téléphone est requis pour une addition à crédit.');
      return;
    }
    // Paiement multiple : la somme des lignes doit égaler l'addition.
    let paiementsValides: Array<{ method: string; amount: number }> = [];
    if (multiPaiement) {
      paiementsValides = paiements
        .map((x) => ({ method: x.method, amount: lireMontant(x.amount) ?? 0 }))
        .filter((x) => x.amount > 0);
      if (paiementsValides.length === 0) {
        setError('Ajoutez au moins un paiement.');
        return;
      }
      const somme = paiementsValides.reduce((n, x) => n + x.amount, 0);
      if (Math.abs(somme - aPayer) > 0.01) {
        setError(`La somme des paiements (${formatCFA(somme)}) doit égaler l'addition (${formatCFA(aPayer)}).`);
        return;
      }
    }
    const avance = payment === 'credit' ? (lireMontant(creditAdvance) ?? 0) : 0;
    setClosing(true);
    setError('');
    const { data, error: err } = await db.rpc('close_table_order', {
      p_order_id: orderId,
      p_payment_method: payment,
      p_split_count: splitCount,
      p_tip: tip,
      p_client_phone: payment === 'credit' ? creditPhone.trim() : null,
      p_amount_paid: avance,
      p_discount: remiseMontant,
      ...(multiPaiement ? { p_payments: paiementsValides } : {}),
    });
    setClosing(false);
    if (err) { setError(err.message); return; }
    const r = data as {
      total_amount: number;
      amount_paid: number;
      tip?: number;
      invoice_number: string | null;
      sale_id: string;
      per_share: number;
    };
    setClosed({
      total: Number(r.total_amount),
      paid: Number(r.amount_paid),
      tip: Number(r.tip ?? 0),
      invoice: r.invoice_number ?? null,
      saleId: r.sale_id,
      perShare: Number(r.per_share),
    });
    setTip(0);
    // La commande disparaît du plan : la table redevient libre.
    setOrderId(null);
    setOuverte(null);
    setLines([]);
    setSplitOpen(false);
    // Le partage et le moyen de paiement ne doivent pas survivre à la table :
    // sinon l'addition SUIVANTE partait en 3 parts (jamais demandé) et en MoMo
    // (choix de l'autre table). La commande précédente les a consommés.
    setSplitCount(1);
    setPayment('cash');
    setCreditPhone('');
    setCreditAdvance('');
    setMultiPaiement(false);
    setPaiements([]);
    setRemise('');
    await loadTables();
    void loadStats();
  };

  const sendToKitchen = async () => {
    if (!orderId) return;
    setBusy(true);
    setError('');
    const { error: err } = await db.rpc('send_order_items', { p_order_id: orderId });
    setBusy(false);
    if (err) { setError(err.message); return; }
    await loadLines(orderId);
  };

  /**
   * Le ticket de cuisine.
   *
   * On imprime AVANT de marquer « parti » : un ticket jeté parce que
   * l'impression a échoué est récupérable, une commande partie sans papier
   * ne l'est pas. Les lignes viennent de l'état affiché, pas d'une requête
   * supplémentaire — ce sont exactement celles que le serveur vient de lire.
   *
   * Seules les lignes « à envoyer » partent sur le papier. Trouvé en recette
   * le 05/10/2026 : le ticket imprimait TOUTES les lignes de la commande,
   * y compris celles déjà servies. Deuxième passage sur la même table, la
   * cuisine recevait les plats cuits une première fois comme neufs et en
   * refaisait autant — de la nourriture jetée, et des clients qui attendent
   * le plat qu'ils ont déjà mangé. C'est send_order_items() qui marque
   * « envoyé » : le papier doit dire la même chose qu'elle.
   */
  const imprimerTicket = () => {
    if (!org || !orderId) return;
    const aEnvoyer = lines.filter((l) => l.status === 'new');
    if (aEnvoyer.length === 0) {
      setError('Tous les plats de cette commande sont déjà partis en cuisine : rien à imprimer.');
      return;
    }
    const ok = printKitchenTicket({
      orderId,
      tableName: tableOuverte?.name ?? null,
      zone: tableOuverte?.zone || null,
      openedAt: tableOuverte?.opened_at ?? null,
      items: aEnvoyer.map((l) => ({
        product_name: l.name ?? 'Plat',
        quantity: Number(l.quantity),
        note: l.note,
        modifier: l.modifier,
        status: l.status,
      })),
      org,
    });
    if (!ok) {
      // Popup bloquée : on le dit, mais on envoie QUAND MÊME à l'écran Cuisine.
      setError("L'impression a été bloquée par le navigateur. La commande est bien envoyée à l'écran Cuisine.");
      // Pas de `return` : l'écran Cuisine prend le relais même sans papier.
    }
    void sendToKitchen();
  };

  /**
   * Formulaire de création d'une table.
   *
   * Il était rendu UNIQUEMENT dans l'état « aucune table » : dès la première
   * table créée, il disparaissait, et le client n'avait plus aucun moyen d'en
   * ajouter. Un maquis de douze tables restait bloqué à une seule table, sans
   * message et sans erreur. Trouvé en recette le 05/10/2026.
   *
   * Il est donc rendu partout où il a du sens : dans l'état vide (où il est la
   * seule chose à faire) et, une fois la salle installée, derrière un bouton
   * « Ajouter une table ».
   */
  const formulaireTable = (compact: boolean) =>
    canManageProducts ? (
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <form onSubmit={addTable} className="flex gap-2">
            <Input
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              placeholder="Nom de la table (ex: Table 1)"
              aria-label="Nom de la table"
            />
            <Button type="submit" disabled={busy} className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {compact ? 'Ajouter' : 'Ajouter une table'}
            </Button>
          </form>
        </CardContent>
      </Card>
    ) : null;

  // ── Aucune table : le module n'a rien à montrer tant que la salle est vide.
  // Les commandes à emporter comptent ici : elles vivent sans table, donc une
  // salle vide n'implique pas un module vide.
  if (!loading && tables.length === 0 && prises.length === 0) {
    return (
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <EmptyState
          icon={UtensilsCrossed}
          title="Aucune table configurée"
          hint={
            canManageProducts
              ? 'Créez vos tables pour prendre les commandes en salle. Le point de vente reste disponible pour le comptoir.'
              : 'Votre patron n’a pas encore créé les tables. Vous pouvez encaisser au point de vente.'
          }
        />
        {formulaireTable(false)}
        {/* Une salle vide n'empêche pas une commande à emporter : sans ce
            bouton, un restaurant sans table ne pouvait rien créer du tout. */}
        <button
          onClick={openTakeaway}
          disabled={busy}
          className="w-full rounded-xl border-2 border-dashed border-slate-300 py-2.5 text-sm font-medium text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-60"
        >
          + Commande à emporter
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* Résumé du jour : couverts, additions, CA, ticket moyen par couvert. */}
      {stats && stats.additions > 0 && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span><strong>{stats.covers}</strong> couvert{stats.covers > 1 ? 's' : ''}</span>
          <span>· {stats.additions} addition{stats.additions > 1 ? 's' : ''}</span>
          <span>· CA {formatCFA(stats.revenue)}</span>
          {stats.covers > 0 && (
            <span className="font-medium text-slate-700">· {formatCFA(stats.revenue / stats.covers)} par couvert</span>
          )}
        </div>
      )}

      {/* La salle est installée : on doit pouvoir y ajouter une table, pas
          seulement au premier écran. Le formulaire est replié pour ne pas
          voler de place aux tuiles. */}
      {canManageProducts && !nouvelleTableOuverte && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setNouvelleTableOuverte(true)}
          className="gap-1.5"
          aria-label="Ajouter une table"
        >
          <Plus className="h-4 w-4" /> Ajouter une table
        </Button>
      )}
      {nouvelleTableOuverte && (
        <>
          {formulaireTable(true)}
          <button
            onClick={() => setNouvelleTableOuverte(false)}
            className="text-xs text-slate-500 underline"
          >
            Annuler
          </button>
        </>
      )}

      {/* ── Addition encaissée ── */}
      {closed && (
        <Card className="border-emerald-200 bg-emerald-50" role="status">
          <CardContent className="p-4 space-y-1">
            <p className="text-sm font-semibold text-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Addition encaissée
            </p>
            <p className="text-xs text-emerald-700">
              {formatCFA(closed.total)}
              {closed.invoice ? ` · facture ${closed.invoice}` : ''}
              {closed.perShare !== closed.total ? ` · ${formatCFA(closed.perShare)} par part` : ''}
              {closed.paid < closed.total ? ` · ${formatCFA(closed.paid)} versés, ${formatCFA(closed.total - closed.paid)} à recouvrer` : ''}
              {closed.tip > 0 ? ` · pourboire ${formatCFA(closed.tip)} (hors CA)` : ''}
            </p>
            <button
              onClick={() => setClosed(null)}
              className="text-xs text-emerald-700 underline"
            >
              Fermer
            </button>
          </CardContent>
        </Card>
      )}

      {/* ── Plan de la salle ── */}
      {tables.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {tables.map((t) => {
            const libre = !t.order_id;
            const minutes = minutesDepuis(t.opened_at);
            const actif = t.order_id === orderId;
            return (
              <button
                key={t.id}
                onClick={() => {
                  // Chaque table repart d'une carte complète : la recherche de la
                  // table précédente ne doit pas filtrer celle-ci, et le plat
                  // armé pour l'autre table ne doit pas y être ajouté d'un tap.
                  viderSaisie();
                  setClosed(null);
                  if (libre) { void openOrder(t.id); return; }
                  setOuverte({ tableId: t.id, nom: t.name, client: t.customer_name });
                  setOrderId(t.order_id);
                }}
                disabled={busy}
                className={`text-left rounded-xl border-2 p-3 transition-colors disabled:opacity-60 ${
                  actif
                    ? 'border-indigo-500 bg-indigo-50'
                    : libre
                      ? 'border-slate-200 bg-white hover:border-emerald-300'
                      : t.status === 'bill_requested'
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-indigo-200 bg-white hover:border-indigo-300'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-800 text-sm truncate">{t.name}</span>
                  {!t.is_active && <Badge className="bg-slate-100 text-slate-500 text-[10px] py-0">fermée</Badge>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                  {libre ? (
                    <><span className="text-emerald-600 font-medium">Libre</span></>
                  ) : (
                    <>
                      <span className={t.status === 'bill_requested' ? 'text-amber-700 font-medium' : 'text-indigo-600 font-medium'}>
                        {STATUT_LIBELLE[t.status ?? 'open']}
                      </span>
                      {minutes !== null && <><span>·</span><Clock className="h-3 w-3" /><span>{minutes} min</span></>}
                    </>
                  )}
                </div>
                {!libre && (
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-sm font-bold text-indigo-600">{formatCFA(t.order_total)}</span>
                    {t.seats && <span className="text-[10px] text-slate-400">{t.seats} pl.</span>}
                  </div>
                )}
                {t.customer_name && (
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">{t.customer_name}</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── À emporter ── */}
      {prises.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            À emporter en cours
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {prises.map((p) => {
              const minutes = minutesDepuis(p.opened_at);
              const actif = p.id === orderId;
              return (
                <button
                  key={p.id}
                  aria-label={`Reprendre la commande à emporter${
                    p.customer_name ? ` de ${p.customer_name}` : ''
                  }`}
                  onClick={() => {
                    // Même geste qu'une tuile de table : carte complète, puis
                    // on rouvre LA commande, sans en créer une seconde.
                    viderSaisie();
                    setClosed(null);
                    setOuverte({ tableId: '', nom: 'À emporter', client: p.customer_name });
                    setOrderId(p.id);
                  }}
                  disabled={busy}
                  className={`text-left rounded-xl border-2 p-3 transition-colors disabled:opacity-60 ${
                    actif
                      ? 'border-indigo-500 bg-indigo-50'
                      : p.status === 'bill_requested'
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-indigo-200 bg-white hover:border-indigo-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-800 text-sm truncate">
                      À emporter
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                    <span
                      className={
                        p.status === 'bill_requested'
                          ? 'text-amber-700 font-medium'
                          : 'text-indigo-600 font-medium'
                      }
                    >
                      {STATUT_LIBELLE[p.status]}
                    </span>
                    {minutes !== null && (
                      <>
                        <span>·</span>
                        <Clock className="h-3 w-3" />
                        <span>{minutes} min</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1.5 text-sm font-bold text-indigo-600">
                    {formatCFA(totalPrise(p))}
                  </div>
                  {p.customer_name && (
                    <div className="text-[11px] text-slate-500 truncate mt-0.5">
                      {p.customer_name}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {orderId === null && (
        <button
          onClick={openTakeaway}
          disabled={busy}
          className="w-full rounded-xl border-2 border-dashed border-slate-300 py-2.5 text-sm font-medium text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors disabled:opacity-60"
        >
          + Commande à emporter
        </button>
      )}

      {/* ── Commande ouverte ── */}
      {orderId && tableOuverte && (
        <Card className="border-indigo-200">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 text-sm">
                {tableOuverte.name}
                {tableOuverte.customer_name ? ` · ${tableOuverte.customer_name}` : ''}
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setOrderId(null); setOuverte(null); setLines([]); viderSaisie(); setActionTable(null); }}
              >
                Fermer le panneau
              </Button>
            </div>

            {/* Déplacer / fusionner : deux gestes du service en salle. */}
            <div className="flex flex-wrap items-center gap-2">
              {tableOuverte.id !== '' && (
                <button
                  type="button"
                  onClick={() => setActionTable(actionTable === 'transfer' ? null : 'transfer')}
                  disabled={busy}
                  className="text-xs font-medium text-slate-600 hover:text-indigo-600 underline disabled:opacity-50"
                >
                  Déplacer
                </button>
              )}
              <button
                type="button"
                onClick={() => setActionTable(actionTable === 'merge' ? null : 'merge')}
                disabled={busy}
                className="text-xs font-medium text-slate-600 hover:text-indigo-600 underline disabled:opacity-50"
              >
                Fusionner
              </button>
              {actionTable === 'transfer' && (
                <select
                  aria-label="Déplacer vers la table"
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => { if (e.target.value) void transferer(e.target.value); }}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                >
                  <option value="">Choisir une table libre…</option>
                  {tables
                    .filter((t) => !t.order_id && t.id !== tableOuverte.id)
                    .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {actionTable === 'merge' && (
                <select
                  aria-label="Fusionner une autre commande"
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => { if (e.target.value) void fusionner(e.target.value); }}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                >
                  <option value="">Fusionner une autre commande…</option>
                  {tables
                    .filter((t) => t.order_id && t.order_id !== orderId)
                    .map((t) => <option key={t.order_id as string} value={t.order_id as string}>{t.name}</option>)}
                  {prises
                    .filter((p) => p.id !== orderId)
                    .map((p) => <option key={p.id} value={p.id}>À emporter{p.customer_name ? ` · ${p.customer_name}` : ''}</option>)}
                </select>
              )}
            </div>

            {/* Couverts : nombre de clients à table, pour le ticket moyen. */}
            <div className="flex items-center gap-2">
              <label htmlFor="covers" className="text-xs font-medium text-slate-600">Couverts</label>
              <input
                id="covers"
                type="number"
                min="1"
                max="200"
                inputMode="numeric"
                value={covers}
                onChange={(e) => setCovers(e.target.value)}
                onBlur={enregistrerCovers}
                placeholder="—"
                aria-label="Nombre de couverts"
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* Lignes */}
            {linesLoading ? (
              <p className="text-sm text-slate-500 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
              </p>
            ) : lines.length === 0 ? (
              <p className="text-sm text-slate-500 py-3 text-center">
                Aucun plat commandé. Choisissez ci-dessous.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {lines.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => cycleLine(l)}
                      className="shrink-0"
                      aria-label={`État de ${l.name} : ${l.status === 'new' ? 'à envoyer' : l.status === 'sent' ? 'envoyé' : 'servi'}. Changer.`}
                      title={l.status === 'new' ? 'À envoyer' : l.status === 'sent' ? 'Envoyé' : 'Servi'}
                    >
                      <Badge
                        className={
                          l.status === 'new'
                            ? 'bg-slate-100 text-slate-600 hover:bg-slate-100'
                            : l.status === 'sent'
                              ? 'bg-amber-100 text-amber-700 hover:bg-amber-100'
                              : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                        }
                      >
                        {l.status === 'new' ? 'À envoyer' : l.status === 'sent' ? 'Envoyé' : 'Servi'}
                      </Badge>
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800 truncate">
                        {formatQty(l.quantity)} × {l.name}
                        {l.modifier && (
                          <span className="ml-1 text-xs text-indigo-600">
                            ({l.modifier})
                          </span>
                        )}
                      </div>
                      {l.note && <div className="text-xs text-amber-700 truncate">{l.note}</div>}
                    </div>
                    <span className={`text-sm font-medium whitespace-nowrap ${l.is_offered ? 'text-emerald-700' : 'text-slate-700'}`}>
                      {/* Le supplément entre dans le montant de la ligne : c'est
                          ce que close_table_order() additionne. */}
                      {l.is_offered
                        ? 'Offert'
                        : formatCFA(
                            Number(l.quantity) * (Number(l.unit_price) + Number(l.extra_price ?? 0))
                          )}
                    </span>
                    {canManageProducts && (
                      <button
                        type="button"
                        onClick={() => void toggleOffert(l)}
                        disabled={busy}
                        aria-pressed={l.is_offered}
                        className={`shrink-0 text-xs underline ${l.is_offered ? 'text-emerald-700' : 'text-slate-400 hover:text-slate-600'}`}
                      >
                        {l.is_offered ? 'Annuler offert' : 'Offert'}
                      </button>
                    )}
                    {/* Partage par article : à quel convive appartient la ligne. */}
                    <select
                      aria-label={`Part de ${l.name}`}
                      value={l.split_part ?? 1}
                      disabled={busy}
                      onChange={(e) => void setLinePart(l, Number(e.target.value))}
                      className="shrink-0 rounded border border-slate-200 bg-white text-xs px-1 py-0.5 text-slate-600"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>P{n}</option>
                      ))}
                    </select>
                    {/* Quantité modifiable APRÈS l'ajout — voir setLineQty.
                        type="text" et non "number" : un champ number REJETTE la
                        virgule, il vide la saisie au lieu de la prendre — exactement
                        le défaut corrigé à la caisse (POSModule). Ici c'est pire
                        encore : le champ n'était pas vide, il retombait dans
                        onBlur → setLineQty('') et affichait « La quantité doit être
                        un nombre supérieur à zéro » à qui tapait « 1,2 ». Or
                        min="0.25" disait pourtant que les fractions étaient
                        attendues. inputMode="decimal" garde le pavé numérique.
                        Le filtrage est fait par setLineQty, qui refuse tout ce qui
                        n'est pas un nombre positif. */}
                    <Input
                      type="text"
                      inputMode="decimal"
                      defaultValue={String(l.quantity)}
                      disabled={busy}
                      aria-label={`Quantité de ${l.name}`}
                      onBlur={(e) => {
                        const v = lireMontant(e.target.value);
                        // Champ vide, illisible, ou inchangé : on remet la
                        // valeur courante. Sinon on tente l'écriture, et on
                        // remet la valeur si la validation ou la base refuse —
                        // le champ ne montre jamais un nombre rejeté.
                        if (v === null || v === Number(l.quantity)) {
                          e.target.value = String(l.quantity);
                          return;
                        }
                        void setLineQty(l, e.target.value).then((ok) => {
                          if (!ok) e.target.value = String(l.quantity);
                        });
                      }}
                      className="w-16 text-right shrink-0"
                    />
                    <button
                      onClick={() => setARetirer(l)}
                      aria-label={`Retirer ${l.name} de la commande`}
                      className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-b-lg">
                  <span className="text-sm font-medium text-slate-600">Total</span>
                  <span className="font-bold text-indigo-600">{formatCFA(totalLignes)}</span>
                </div>
              </div>
            )}

            {/* Encaissement */}
            {lines.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={imprimerTicket}
                    disabled={busy || lines.length === 0}
                    className="gap-1.5"
                  >
                    <ChefHat className="h-3.5 w-3.5" /> Imprimer le ticket cuisine
                  </Button>

                  {!splitOpen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { // 2 parts par défaut : c'est le cas le plus fréquent (« on est deux »), et
                      // l'utilisateur ajuste immédiatement s'il est trois.
                      setSplitCount(2); setSplitOpen(true); }}
                      className="gap-1.5"
                    >
                      <Users className="h-3.5 w-3.5" /> Partager l&apos;addition
                    </Button>
                  ) : null}
                </div>

                {splitOpen && (
                  <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600">Répartir en</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSplitCount((n) => Math.max(2, n - 1))}
                          aria-label="Moins de parts"
                          className="h-11 w-11 rounded-lg border border-slate-200 text-slate-600"
                        >
                          −
                        </button>
                        <span className="font-semibold text-slate-800 w-6 text-center">{splitCount}</span>
                        <button
                          onClick={() => setSplitCount((n) => Math.min(20, n + 1))}
                          aria-label="Plus de parts"
                          className="h-11 w-11 rounded-lg border border-slate-200 text-slate-600"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatCFA(part)} par personne. L&apos;addition reste{' '}
                      <strong>{formatCFA(totalLignes)}</strong> : une seule vente est
                      écrite, le partage est pour l&apos;affichage.
                    </p>
                    <button
                      onClick={() => setSplitOpen(false)}
                      className="text-xs text-slate-500 hover:text-slate-700 underline"
                    >
                      Annuler le partage
                    </button>
                  </div>
                )}

                {/* Totaux par convive (partage par article). */}
                {partsTotaux.length > 1 && (
                  <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                    {partsTotaux.map(([p, t]) => (
                      <span key={p}>P{p} : <strong className="text-slate-800">{formatCFA(t)}</strong></span>
                    ))}
                  </div>
                )}

                {/* Pourboire : laissé sur la table, hors application. On le note pour le
                    savoir, sans l'ajouter au chiffre d'affaires — sinon les
                    rapports mensuels surestimeraient le CA, et les frais
                    seraient calculés sur une recette qui n'a jamais eu lieu. */}
                <div className="flex items-center gap-2">
                  <label htmlFor="tip" className="text-xs font-medium text-slate-600 shrink-0">
                    Pourboire
                  </label>
                  <Input
                    id="tip"
                    value={tip}
                    onChange={(e) => setTip(Math.max(0, lireMontant(e.target.value) ?? 0))}
                    placeholder="0"
                    inputMode="decimal"
                    className="w-24"
                  />
                  <span className="text-xs text-slate-500">
                    {tip > 0 ? `total ${formatCFA(aPayer + tip)}` : 'laisser en espèces'}
                  </span>
                </div>

                {/* Remise sur l'addition : patron/manager seulement. */}
                {canManageProducts && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="remise" className="text-xs font-medium text-slate-600 shrink-0">
                      Remise
                    </label>
                    <Input
                      id="remise"
                      value={remise}
                      onChange={(e) => setRemise(e.target.value)}
                      placeholder="0"
                      inputMode="decimal"
                      aria-label="Remise (F)"
                      className="w-24"
                    />
                    <span className="text-xs text-slate-500">à payer {formatCFA(aPayer)}</span>
                  </div>
                )}

                {/* Paiement multiple : plusieurs moyens sur une même addition. */}
                <button
                  type="button"
                  onClick={() => {
                    const suivant = !multiPaiement;
                    setMultiPaiement(suivant);
                    if (suivant) {
                      setPayment('cash');
                      if (paiements.length === 0) {
                        setPaiements([
                          { method: 'cash', amount: String(aPayer) },
                          { method: 'momo', amount: '' },
                        ]);
                      }
                    }
                  }}
                  aria-pressed={multiPaiement}
                  className={`text-xs font-medium underline ${multiPaiement ? 'text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {multiPaiement ? 'Revenir à un paiement simple' : 'Paiement multiple (plusieurs moyens)'}
                </button>

                {multiPaiement && (
                  <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                    {paiements.map((x, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select
                          aria-label={`Moyen du paiement ${i + 1}`}
                          value={x.method}
                          onChange={(e) => setPaiements((p) => p.map((y, j) => (j === i ? { ...y, method: e.target.value as 'cash' | 'momo' } : y)))}
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs"
                        >
                          <option value="cash">Espèces</option>
                          <option value="momo">Mobile Money</option>
                        </select>
                        <Input
                          value={x.amount}
                          onChange={(e) => setPaiements((p) => p.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))}
                          inputMode="decimal"
                          placeholder="Montant"
                          aria-label={`Montant du paiement ${i + 1}`}
                          className="w-28"
                        />
                        <button
                          type="button"
                          onClick={() => setPaiements((p) => p.filter((_, j) => j !== i))}
                          aria-label={`Retirer le paiement ${i + 1}`}
                          className="text-slate-400 hover:text-red-500"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setPaiements((p) => [...p, { method: 'cash', amount: '' }])}
                        className="text-xs text-indigo-600 hover:text-indigo-800 underline"
                      >
                        + Ajouter un moyen
                      </button>
                      <span className="text-xs text-slate-500">
                        {formatCFA(paiements.reduce((n, x) => n + (lireMontant(x.amount) ?? 0), 0))} / {formatCFA(aPayer)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {!multiPaiement && (
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                    {(['cash', 'momo', 'credit'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setPayment(m)}
                        aria-pressed={payment === m}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                          payment === m ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600'
                        }`}
                      >
                        {m === 'cash' ? 'Espèces' : m === 'momo' ? 'Mobile Money' : 'Crédit'}
                      </button>
                    ))}
                  </div>
                  )}

                  {!multiPaiement && payment === 'credit' && (
                    <div className="w-full flex flex-col sm:flex-row gap-2">
                      <Input
                        value={creditPhone}
                        onChange={(e) => setCreditPhone(e.target.value)}
                        inputMode="tel"
                        placeholder="Téléphone du client (obligatoire)"
                        aria-label="Téléphone du client (crédit)"
                        className="flex-1"
                      />
                      <Input
                        value={creditAdvance}
                        onChange={(e) => setCreditAdvance(e.target.value)}
                        inputMode="decimal"
                        placeholder="Acompte versé (F)"
                        aria-label="Acompte versé"
                        className="sm:w-48"
                      />
                    </div>
                  )}

                  {/* Tout membre de l'équipe encaisse (voir la décision
                      documentée plus haut) : plus de branche « seul le patron ». */}
                  <Button
                    onClick={closeOrder}
                    disabled={closing}
                    className="bg-emerald-700 hover:bg-emerald-800 gap-2"
                  >
                    {closing
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> Encaissement…</>
                      : <><CheckCircle2 className="h-4 w-4" /> {payment === 'credit' ? 'Céder à crédit' : 'Encaisser'} {formatCFA(aPayer)}</>}
                  </Button>
                </div>
              </div>
            )}

            {/* Ajout */}
            {/* Menu du jour : le patron règle la carte d'ici, ou depuis Recettes.
          Un plat servi tous les jours garde menu_days = null. */}
      {peutReglerCarte && platChoisi && (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          <p className="text-xs font-medium text-slate-700">
            Servi le…{' '}
            <span className="text-slate-500">
              {(() => {
                const jours = (platChoisi as { menu_days?: number[] | null }).menu_days ?? null;
                // Reflète l'état réel : « tous les jours » ou la liste des jours
                // cochés. Un titre figé sur « tous les jours par défaut » mentait
                // dès qu'on décochait un jour.
                if (jours === null) return 'tous les jours';
                return JOURS.filter((j) => jours.includes(j.valeur)).map((j) => j.court).join(' · ');
              })()}
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {JOURS.map((j) => {
              const jours = ((platChoisi as { menu_days?: number[] | null }).menu_days ?? null);
              const actif = jours === null || jours.includes(j.valeur);
              return (
                <button
                  key={j.valeur}
                  type="button"
                  aria-pressed={actif}
                  onClick={async () => {
                    const base = jours ?? JOURS.map((x) => x.valeur);
                    const suivant = actif ? base.filter((d) => d !== j.valeur) : [...base, j.valeur];
                    // Retirer le DERNIER jour ne doit pas tout cocher : `null`
                    // veut dire « tous les jours ». On refuse plutôt que de
                    // transformer « seulement le vendredi » en « tous les jours ».
                    if (suivant.length === 0) {
                      setError('Un plat doit être servi au moins un jour. Laissez au moins un jour coché.');
                      return;
                    }
                    const value = suivant.length === 7 ? null : suivant;
                    // Écriture optimiste, mais AVEC retour arrière. Sans lui,
                    // un échec (réseau, policy) laissait l'écran dire que la
                    // carte avait changé alors que la base n'avait rien pris :
                    // le patron croyait son plat retiré du jour, le serveur le
                    // proposait encore — et le test de recette suivant
                    // confirmait « carte du jour OK » puisque c'est l'écran qui
                    // mentait, pas la base.
                    const avant = platChoisi;
                    setPlatChoisi({ ...platChoisi, menu_days: value });
                    const { error: errJours } = await db
                      .from('products')
                      .update({ menu_days: value })
                      .eq('id', platChoisi.id);
                    if (errJours) {
                      setPlatChoisi(avant);
                      setError(
                        `La carte du jour n'a pas été enregistrée : ${errJours.message}`,
                      );
                      return;
                    }
                    await onChanged?.();
                  }}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    actif
                      ? 'border-emerald-500 bg-emerald-600 text-white'
                      : 'border-slate-200 bg-white text-slate-500'
                  }`}
                >
                  {j.court}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Carte du jour active : des plats du catalogue peuvent ne pas être servis
              aujourd'hui. Il faut pouvoir les proposer quand même — le client
              demande précisément celui qui n'est pas au menu. */}
            {!menuDuJour && (
              <p className="text-[11px] text-amber-700">
                Toute la carte est proposée, y compris les plats non servis
                aujourd&apos;hui.
              </p>
            )}

            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Chercher un plat…"
                  aria-label="Chercher un plat à commander"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Effacer la recherche de plat"
                    className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setMenuDuJour((v) => !v)}
                  aria-pressed={menuDuJour}
                  title={menuDuJour
                    ? 'Carte du jour : seuls les plats servis aujourd\'hui sont proposés'
                    : 'Toute la carte est proposée, y compris les plats du jour'}
                  className={`shrink-0 rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    menuDuJour
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-500'
                  }`}
                >
                  Carte du jour
                </button>
              </div>
              <div className="flex gap-2">
                <Input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="Qté"
                  aria-label="Quantité"
                  className="w-24"
                />
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note cuisine (ex: peu épicé)"
                  aria-label="Note cuisine"
                />
              </div>
              {resultats.length === 0 ? (
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <PackageX className="h-3.5 w-3.5" /> Aucun produit ne correspond. Ajoutez-le depuis l&apos;onglet Stock.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {resultats.map((p) => {
                    const v = vendable(p);
                    return (
                      <button
                        key={p.id}
                        // Un premier clic sélectionne le plat et charge ses
                        // options ; un second l'ajoute. Ajouter d'emblée
                        // donnerait une ligne sans cuisson — le serveur
                        // corrigerait à la main, et le ticket cuisine serait faux.
                        onClick={() => {
                          // Rupture : on le dit tout de suite, au lieu de laisser
                          // composer la commande puis échouer à l'encaissement.
                          if (!v) {
                            setError(`« ${p.name} » est en rupture de stock. Réapprovisionnez-le, ou donnez-lui une recette (onglet Recettes).`);
                            return;
                          }
                          if (platChoisi?.id === p.id) { void addLine(p); return; }
                          setPlatChoisi(p);
                          setModSelection('');
                        }}
                        disabled={busy}
                        aria-pressed={platChoisi?.id === p.id}
                        aria-disabled={!v || undefined}
                        className={`rounded-lg border px-2 py-2 text-left disabled:opacity-60 ${
                          platChoisi?.id === p.id
                            ? 'border-indigo-400 bg-indigo-50'
                            : v
                              ? 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40'
                              : 'border-slate-200 bg-slate-50'
                        }`}
                      >
                        <span className={`block text-xs font-medium truncate ${v ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{p.name}</span>
                        <span className={`block text-xs ${v ? 'text-indigo-600' : 'text-red-500 font-medium'}`}>
                          {v ? formatCFA(p.price_sell) : 'Rupture de stock'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Options du plat sélectionné, puis validation */}
              {platChoisi && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
                  <p className="text-xs font-medium text-slate-700">
                    {platChoisi.name}
                  </p>

                  {modifiersLoading ? (
                    <p className="text-xs text-slate-500">Chargement des options…</p>
                  ) : modifiers.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      Aucune option pour ce plat.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {modifiers.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setModSelection(m.id)}
                          aria-pressed={modSelection === m.id}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            modSelection === m.id
                              ? 'border-indigo-500 bg-indigo-600 text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'
                          }`}
                        >
                          {m.name}
                          {Number(m.extra_price) > 0 && ` +${formatCFA(m.extra_price)}`}
                          {m.is_required && <span className="ml-1 opacity-80">(obligatoire)</span>}
                        </button>
                      ))}
                    </div>
                  )}

                  {modifiers.some((m) => m.is_required) && !modSelection && (
                    <p className="text-xs text-amber-700">
                      Choisissez l&apos;option obligatoire avant d&apos;ajouter le plat.
                    </p>
                  )}

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => addLine(platChoisi)}
                      disabled={busy || (modifiers.some((m) => m.is_required) && !modSelection)}
                      className="bg-indigo-600 hover:bg-indigo-700 gap-2"
                    >
                      {busy
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Plus className="h-4 w-4" />}
                      Ajouter à la commande
                    </Button>
                    <button
                      onClick={() => { setPlatChoisi(null); setModSelection(''); }}
                      className="text-xs text-slate-500 hover:text-slate-700 underline"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Le stock n'est pas touché ici : c'est la règle que le test vérifie. */}
            <p className="text-[11px] text-slate-500">
              <CheckCircle2 className="h-3 w-3 inline -mt-0.5 mr-1" />
              Le stock n&apos;est décrémenté qu&apos;à la clôture de l&apos;addition.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Détail d'une table occupée, sans commande ouverte dans le panneau ── */}
      {!orderId && tables.some((t) => t.order_id) && (
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Touchez une table occupée pour ouvrir sa commande.
        </p>
      )}

      <ConfirmDialog
        open={!!aRetirer}
        title="Retirer cet article ?"
        message={<p>« {aRetirer?.name} » sera retiré de la commande.</p>}
        confirmLabel="Retirer"
        destructive
        onConfirm={() => { const l = aRetirer; setARetirer(null); if (l) void removeLine(l); }}
        onCancel={() => setARetirer(null)}
      />
    </div>
  );
}