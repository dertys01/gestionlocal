-- ─── Formules : menus composés ────────────────────────────────────────────
--
-- Une « formule » est un produit (entrée + plat + dessert + boisson à prix
-- composé) dont le client choisit les composants. Le produit porte
-- is_formule = true ; il est vendu au prix de la formule, et ses composants
-- choisis sont figés sur la ligne de commande (pour la cuisine) ET sur la
-- ligne de vente (pour le stock).
--
-- Stock : une formule n'a pas de recette statique — elle ne se stocke pas. Ce
-- sont ses COMPOSANTS qui sortent du stock. Le déclencheur
-- sale_items_consume_ingredients() est étendu pour traiter les composants
-- comme des ingrédients de la formule : un composant qui est un plat se déplie
-- en ses ingrédients, un composant qui est un article stocké est décrémenté
-- directement. create_sale() ne touche donc jamais au stock de la formule
-- elle-même.

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_formule boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN products.is_formule IS
  'Menu composé : le client choisit dans chaque groupe. Ne se stocke pas — ce sont ses composants qui sortent du stock.';

-- ── Groupes d'une formule : « Entrée », « Plat », « Dessert », « Boisson » ──
CREATE TABLE IF NOT EXISTS formule_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  formule_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  min_select  int NOT NULL DEFAULT 1 CHECK (min_select >= 0),
  max_select  int NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT formule_groups_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT formule_groups_range CHECK (min_select <= max_select),
  CONSTRAINT formule_groups_unique_name UNIQUE (formule_id, name)
);
CREATE INDEX IF NOT EXISTS idx_formule_groups_formule ON formule_groups(formule_id, sort_order);

-- ── Choix d'un groupe : les plats/boissons proposés, avec leur supplément ──
CREATE TABLE IF NOT EXISTS formule_group_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES formule_groups(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  extra_price numeric(12,2) NOT NULL DEFAULT 0
                CHECK (extra_price >= -1000000 AND extra_price <= 1000000),
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT formule_group_items_unique UNIQUE (group_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_formule_group_items_group ON formule_group_items(group_id, sort_order);

ALTER TABLE formule_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "formule_groups_read" ON formule_groups;
CREATE POLICY "formule_groups_read" ON formule_groups
  FOR SELECT USING (owner_id = get_business_owner_id());
DROP POLICY IF EXISTS "formule_groups_write" ON formule_groups;
CREATE POLICY "formule_groups_write" ON formule_groups
  FOR ALL
  USING (owner_id = get_business_owner_id() AND can_manage_products())
  WITH CHECK (owner_id = get_business_owner_id() AND can_manage_products());

ALTER TABLE formule_group_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "formule_group_items_read" ON formule_group_items;
CREATE POLICY "formule_group_items_read" ON formule_group_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM formule_groups g
       WHERE g.id = formule_group_items.group_id
         AND g.owner_id = get_business_owner_id()
    )
  );
DROP POLICY IF EXISTS "formule_group_items_write" ON formule_group_items;
CREATE POLICY "formule_group_items_write" ON formule_group_items
  FOR ALL
  USING (
    can_manage_products() AND EXISTS (
      SELECT 1 FROM formule_groups g
       WHERE g.id = formule_group_items.group_id
         AND g.owner_id = get_business_owner_id()
    )
  )
  WITH CHECK (
    can_manage_products() AND EXISTS (
      SELECT 1 FROM formule_groups g
       WHERE g.id = formule_group_items.group_id
         AND g.owner_id = get_business_owner_id()
    )
  );

-- ── Composants choisis, figés sur la ligne de commande ──
-- Format : [{"group":"Plat","product_id":"…","name":"Poulet braisé","extra_price":0}]
ALTER TABLE restaurant_order_items ADD COLUMN IF NOT EXISTS components jsonb;
COMMENT ON COLUMN restaurant_order_items.components IS
  'Composants choisis d''une formule (entrée/plat/dessert/boisson), figés à la commande.';

-- ── Composants portés jusqu''à la ligne de vente (consommation de stock) ──
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS components jsonb;
COMMENT ON COLUMN sale_items.components IS
  'Composants d''une formule vendue : le déclencheur de stock les consomme comme des ingrédients.';


-- ── Déclencheur de stock, étendu aux composants de formule ──
-- (remplace la version de migration_recipes.sql)
CREATE OR REPLACE FUNCTION sale_items_consume_ingredients()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row     record;
  v_stock   numeric(12,3);
  v_nom     text;
BEGIN
  FOR v_row IN
    WITH RECURSIVE arbre(ingredient_id, needed, prof) AS (
      SELECT r.ingredient_id, r.needed, 1
        FROM (
          -- Racine 1 : les ingrédients directs, à la quantité VENDUE.
          SELECT ri.ingredient_id, ri.quantity * NEW.quantity AS needed
            FROM recipe_ingredients ri
           WHERE ri.dish_id = NEW.product_id
          UNION ALL
          -- Racine 2 : les composants d'une formule. Chaque composant est traité
          -- comme un « ingrédient » de la formule, à la quantité vendue : un
          -- composant qui est un plat se déplie en ses ingrédients, un composant
          -- qui est un article stocké est décrémenté directement (c'est une feuille).
          SELECT (c->>'product_id')::uuid, NEW.quantity
            FROM jsonb_array_elements(COALESCE(NEW.components, '[]'::jsonb)) c
        ) AS r
      UNION ALL
      -- Descente : un ingrédient qui a lui-même une recette se déplie.
      SELECT ri.ingredient_id, a.needed * ri.quantity, a.prof + 1
        FROM recipe_ingredients ri
        JOIN arbre a ON ri.dish_id = a.ingredient_id
       WHERE a.prof < 10
    )
    -- Seules les feuilles sont consommées : un nœud qui porte une recette
    -- est un plat, pas un stock.
    SELECT a.ingredient_id, sum(a.needed) AS needed
      FROM arbre a
     WHERE NOT EXISTS (
       SELECT 1 FROM recipe_ingredients r WHERE r.dish_id = a.ingredient_id
     )
     GROUP BY a.ingredient_id
  LOOP
    SELECT p.stock_qty, p.name INTO v_stock, v_nom
      FROM products p
     WHERE p.id = v_row.ingredient_id
       -- RLS filtre ici : un ingrédient d'un autre restaurant est invisible et
       -- ne sera donc jamais décrémenté. C'est le comportement voulu.
       AND p.user_id = get_business_owner_id()
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF v_stock < v_row.needed THEN
      RAISE EXCEPTION 'Stock insuffisant pour l''ingrédient « % » (disponible : %, nécessaire : %)',
        v_nom, v_stock, v_row.needed USING ERRCODE = '23514';
    END IF;

    UPDATE products SET stock_qty = stock_qty - v_row.needed WHERE id = v_row.ingredient_id;

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    )
    SELECT p.user_id, p.id, p.name, 'sale', -v_row.needed, v_stock, v_stock - v_row.needed, NEW.sale_id
      FROM products p
     WHERE p.id = v_row.ingredient_id;

  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_consume_recipe ON sale_items;
CREATE TRIGGER sale_items_consume_recipe
  AFTER INSERT ON sale_items
  FOR EACH ROW EXECUTE FUNCTION sale_items_consume_ingredients();

-- ── create_sale : composants de formule + formule non stockée ──
-- (remplace la version de migration_offline_sales.sql)
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL,
  p_client_ref     text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner      uuid;
  v_sale_id    uuid;
  v_ids        uuid[];
  v_qtys       numeric(12,3)[];
  v_agreed     numeric(12,2)[];   -- prix convenu, NULL = prix catalogue
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_annee      text;
  v_max_issued int;
  v_name       text;
  v_list       numeric(12,2);     -- prix catalogue (référence)
  v_price      numeric(12,2);     -- prix réellement facturé
  v_cost       numeric(12,2);
  v_stock      numeric(12,3);
  -- Quantité totale demandée pour un produit, toutes lignes confondues : c'est
  -- elle qu'on compare au stock, pas la quantité d'une ligne prise isolément.
  v_demande    numeric(12,3);
  v_qty        numeric(12,3);
  -- Le produit est-il un plat (produit avec recette) ? Un plat ne se stocke pas :
  -- ni contrôle, ni décrément — voir la boucle plus bas.
  v_est_plat   boolean;
  v_total      numeric(12,2) := 0;
  v_discount   numeric(12,2) := 0;
  v_at_loss    int := 0;
  -- Composants d'une formule, alignés sur v_ids/v_qtys/v_agreed.
  v_comps      jsonb[];
  v_formule    boolean;
  -- Vente déjà enregistrée pour ce client_ref (rejeu hors-ligne) : on la
  -- renvoie telle quelle au lieu d'en créer une seconde.
  v_existing   jsonb;
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- ── Idempotence : vente hors-ligne rejouée ──────────────────
  -- Le client_ref vient de la caisse. S'il a déjà servi pour cette boutique,
  -- la vente existe : on la renvoie au lieu d'en créer une seconde. C'est ce
  -- qui rend le rejeu sûr quand la première tentative a abouti mais que la
  -- réponse s'est perdue (réseau coupé juste après le COMMIT).
  IF p_client_ref IS NOT NULL THEN
    SELECT jsonb_build_object(
             'id',              s.id,
             'invoice_number',  s.invoice_number,
             'total_amount',    s.total_amount,
             'discount_amount', 0,
             'at_loss_count',   0
           )
      INTO v_existing
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_ref = p_client_ref
     LIMIT 1;

    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  -- 'credit' est accepté ici mais n'est pas un encaissement : la vente est
  -- créée, le stock part, et c'est record_credit_sale() qui la marque non
  -- encaissée et rattache le téléphone. Sans ce filet, un appel direct avec
  -- 'credit' produirait une vente comptée comme encaissée sans dette derrière.
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit', 'mixed') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  IF p_payment_method = 'credit' AND current_setting('credit.internal', true) IS DISTINCT FROM '1' THEN
    -- Garde-fou : create_sale() est exécutable par tout client authentifié. Un
    -- appel direct avec 'credit' créerait une vente comptée comme encaissée,
    -- sans dette derrière — exactement le trou que cette fonction comble.
    --
    -- record_credit_sale() pose credit.internal = '1' le temps de l'appel. Un
    -- GUC n'est pas modifiable par un client SQL ordinaire : seule une fonction
    -- SECURITY DEFINER peut le poser, et celle-ci l'est.
    RAISE EXCEPTION 'Utilisez record_credit_sale() pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  -- ── Valider chaque ligne AVANT toute écriture ──
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
       OR (replace(e->>'quantity', ',', '.'))::numeric > 1000000
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE e ? 'unit_price'
      AND (e->>'unit_price' !~ '^[0-9]+(\.[0-9]{1,2})?$'
           OR (e->>'unit_price')::numeric <= 0)
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  -- ── Valider les composants d'une formule ──
  -- Chaque composant doit être un produit de la formule vendue : sinon un
  -- appelant pourrait faire sortir du stock un article hors formule.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE e ? 'components'
      AND jsonb_typeof(e->'components') <> 'array'
  ) THEN
    RAISE EXCEPTION 'Composants de formule invalides' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'components', '[]'::jsonb)) AS c
     WHERE COALESCE(c->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
        OR NOT EXISTS (
             SELECT 1 FROM formule_group_items fgi
               JOIN formule_groups fg ON fg.id = fgi.group_id
              WHERE fg.formule_id = (e->>'product_id')::uuid
                AND fgi.product_id = (c->>'product_id')::uuid
           )
  ) THEN
    RAISE EXCEPTION 'Un composant ne fait pas partie de la formule' USING ERRCODE = '22023';
  END IF;

  -- ── Agréger par (produit, prix) ──
  --
  -- L'agrégation se fait par produit ET par prix convenu, pas par produit seul.
  -- La version d'avant gardait MIN(unit_price) et REFUSAIT deux prix pour un même
  -- article — refus qui protégeait d'une sous-facturation, puisque le MIN perdait
  -- la différence. Mais le restaurant a le cas légitime : le même plat commandé
  -- deux fois avec deux options (une double portion, puis « bien cuit »). Cette
  -- ligne doit survivre à son prix.
  --
  -- Deux lignes au MÊME prix fusionnent toujours : 2 × « bien cuit » redeviennent
  -- une ligne de quantité 2, ce qui est le panier du comptoir.
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1), coalesce(components::text, '')),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1), coalesce(components::text, '')),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1), coalesce(components::text, '')),
         array_agg(components ORDER BY product_id, coalesce(unit_price, -1), coalesce(components::text, ''))
    INTO v_ids, v_qtys, v_agreed, v_comps
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price,
             -- Composants d'une formule (sinon tableau vide). Ils entrent dans la
             -- clé d'agrégation : deux formules au même prix mais de composition
             -- différente ne doivent pas fusionner en une seule ligne.
             COALESCE(e->'components', '[]'::jsonb) AS components
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3, 4
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  --
  -- Le contrôle porte sur la quantité TOTALE par produit, pas sur chaque ligne :
  -- deux lignes du même produit verrouillent la même rangée, et vérifier 1 puis 1
  -- laisserait passer 2 sur un stock de 1 — l'erreur n'apparaîtrait qu'ensuite,
  -- en contrainte CHECK, avec un message que personne ne sait traduire.
  --
  -- UN PRODUIT QUI A UNE RECETTE EST UN PLAT, et la règle est différente : sa
  -- disponibilité vient de ses INGRÉDIENTS, pas de son propre stock. C'est ce
  -- que migration_recipes.sql dit depuis le début — « un plat se cuisine, il ne
  -- se stocke pas » — et create_sale() le contredisait : un plat à 0 (sa valeur
  -- naturelle) était refusé à la vente avec « Stock insuffisant pour « Riz gras »
  -- (disponible : 0, demandé : 1) », alors que ses ingrédients étaient là. Aucun
  -- plat du catalogue d'exemple n'était donc servable, et le blocage venait de
  -- la caisse, pas de la cuisine.
  --
  -- Le contrôle et le décrément sont donc sautés pour un plat ; c'est le
  -- déclencheur sale_items_consume_recipe qui refuse, ingredients vides, avec
  -- le bon message (« Stock insuffisant pour l'ingrédient « Riz blanc » »).
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty, p.is_formule
      INTO v_name, v_list, v_cost, v_stock, v_formule
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    -- Un plat — ou une formule — ne se stocke pas : sa disponibilité vient de
    -- ses ingrédients (et, pour la formule, de ses composants).
    v_est_plat := COALESCE(v_formule, false) OR EXISTS (
      SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]
    );

    IF NOT v_est_plat THEN
      SELECT COALESCE(SUM(u.q), 0) INTO v_demande
        FROM unnest(v_qtys) WITH ORDINALITY AS u(q, n)
       WHERE u.n >= v_i AND v_ids[u.n] = v_ids[v_i];

      IF v_stock < v_demande THEN
        RAISE EXCEPTION 'Stock insuffisant pour « % » (disponible : %, demandé : %)',
          v_name, v_stock, v_demande USING ERRCODE = '23514';
      END IF;
    END IF;

    v_price := COALESCE(v_agreed[v_i], v_list);

    v_total    := v_total + v_price * v_qtys[v_i];
    v_discount := v_discount + (v_list - v_price) * v_qtys[v_i];

    IF v_price < v_cost THEN
      v_at_loss := v_at_loss + 1;
    END IF;
  END LOOP;

  IF v_discount < 0 THEN
    v_discount := 0;
  END IF;

  -- ── Numéro de facture : incrément atomique (Pro uniquement) ──
  -- Plan EFFECTIF, comme current_org_plan() : essai Starter actif, période
  -- prépayée non échue. Un Pro échu ne numérote plus — la même vérité que les
  -- rapports, qui sont déjà verrouillés pour lui.
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    v_annee := to_char(now(), 'YYYY');

    -- Réalignement AVANT de numéroter, dans la transaction de la vente.
    --
    -- La ligne organisation est verrouillée (FOR UPDATE) : deux caisses qui
    -- encaissent au même instant sont sérialisées ici, donc deux ventes ne
    -- peuvent pas lire le même compteur ni demander le même numéro suivant.
    --
    -- Le contrôle porte sur l'ANNÉE, pas sur toutes les factures : janvier
    -- repart légitimement à 1 (FAC-2026-00001 ≠ FAC-2027-00001 pour la
    -- contrainte d'unicité), et c'est ce qui rend inoffensive une facture de
    -- janvier saisie à la main.
    SELECT COALESCE(o.invoice_counter, 0),
           (SELECT COALESCE(MAX(substr(s.invoice_number, 10)::int), 0)
              FROM sales s
             WHERE s.user_id = o.id
               AND s.invoice_number ~ ('^FAC-' || v_annee || '-[0-9]+$'))
      INTO v_counter, v_max_issued
      FROM organizations o
     WHERE o.id = v_owner
     FOR UPDATE;

    -- Un compteur volontairement avancé n'est jamais reculé.
    IF v_counter < v_max_issued THEN
      v_counter := v_max_issued;
    END IF;

    -- Premier numéro libre à partir de v_counter + 1.
    --
    -- Après le réalignement ci-dessus, cette boucle tourne en principe zéro
    -- fois : elle ne sert que du cas résiduel — un numéro au bon gabarit mais
    -- hors suite (facture reprise d'un autre outil, compteur remis en arrière à
    -- la main). Mieux vaut une facture au numéro suivant qu'une violation
    -- d'unicité illisible à l'écran du commerçant. Bornée, elle ne boucle pas.
    --
    -- Le compteur est ensuite posé sur le numéro RÉELLEMENT retenu : il reste
    -- ainsi la vérité, et la vente suivante repart de là.
    FOR v_i IN 0 .. 1000 LOOP
      v_invoice := 'FAC-' || v_annee || '-' || lpad((v_counter + v_i + 1)::text, 5, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM sales s
         WHERE s.user_id = v_owner
           AND s.invoice_number = v_invoice
      );
    END LOOP;

    UPDATE organizations
       SET invoice_counter = substr(v_invoice, 10)::int
     WHERE id = v_owner;
  END IF;

  -- ── En-tête de vente ──
  -- amount_received est ce qui est réellement rentré, et c'est la seule colonne
  -- qui décide du chiffre d'affaires. Une vente espèces ou MoMo vaut son prix :
  -- le client a payé, la monnaie a été rendue, le net encaissé est bien
  -- total_amount. Une vente à crédit est écrite à 0, puis record_credit_sale()
  -- y pose l'acompte — la seule fonction qui sait de combien il est.
  --
  -- Ce n'est pas de la copie : c'est ce qui garantit qu'un rapport en base de
  -- caisse ne peut pas diverger de la caisse. Sans cela, une vente espèces
  -- enregistrée à 0 disparaîtrait du chiffre d'affaires.
  INSERT INTO sales (
    user_id, total_amount, payment_method, client_name, note, invoice_number,
    amount_received, client_ref
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice,
    CASE WHEN p_payment_method = 'credit' THEN 0 ELSE v_total END,
    p_client_ref
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty, p.is_formule
      INTO v_name, v_list, v_cost, v_stock, v_formule
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price, components
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list, v_comps[v_i]
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT COALESCE(v_formule, false)
       AND NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
      UPDATE products SET stock_qty = stock_qty - v_qty WHERE id = v_ids[v_i];

      INSERT INTO stock_logs (
        user_id, product_id, product_name, movement_type,
        quantity_change, stock_before, stock_after, reference_id
      ) VALUES (
        v_owner, v_ids[v_i], v_name, 'sale',
        -v_qty, v_stock, v_stock - v_qty, v_sale_id
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'invoice_number',  v_invoice,
    'total_amount',    v_total,
    'discount_amount', v_discount,
    'at_loss_count',   v_at_loss
  );
END;
$$;


-- ── close_table_order : porte les composants de formule ──
-- (remplace la version de migration_restaurant_discount.sql)
DROP FUNCTION IF EXISTS close_table_order(uuid, text, numeric, integer, text, text, numeric, jsonb);
CREATE OR REPLACE FUNCTION public.close_table_order(p_order_id uuid, p_payment_method text, p_amount_paid numeric DEFAULT NULL::numeric, p_split_count integer DEFAULT 1, p_client_phone text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_tip numeric DEFAULT 0, p_payments jsonb DEFAULT NULL::jsonb, p_discount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_order    restaurant_orders%ROWTYPE;
  v_items    jsonb;
  v_sale     jsonb;
  v_sale_id  uuid;
  v_total    numeric(12,2);
  v_net      numeric(12,2);
  v_paid     numeric(12,2);
  v_tip      numeric(12,2);
  v_discount numeric(12,2);
  v_table    text;
  v_multi    boolean := false;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF v_owner <> auth.uid()
     AND NOT EXISTS (
       SELECT 1 FROM business_members bm
        WHERE bm.member_id = auth.uid()
          AND bm.owner_id = v_owner
     ) THEN
    RAISE EXCEPTION 'Seul le patron, un manager ou un membre de l''équipe peut encaisser cette addition'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order
    FROM restaurant_orders
   WHERE id = p_order_id AND owner_id = v_owner
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'closed' THEN
    RAISE EXCEPTION 'Cette addition est déjà soldée' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash','momo','credit') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;
  IF p_split_count IS NULL OR p_split_count < 1 OR p_split_count > 20 THEN
    RAISE EXCEPTION 'Nombre de parts invalide' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM restaurant_order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'Aucun plat à encaisser sur cette table' USING ERRCODE = '22023';
  END IF;

  v_tip := round(COALESCE(p_tip, 0), 2);
  IF v_tip < 0 THEN
    RAISE EXCEPTION 'Le pourboire ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_table FROM restaurant_tables WHERE id = v_order.table_id;
  v_table := COALESCE(v_table, 'à emporter');

  -- Les lignes OFFERTES sont exclues de la vente (elles restent sur la
  -- commande, pour l'historique et la cuisine) : create_sale() refuse un prix
  -- à 0, et c'est un garde-fou qu'on ne veut pas lever.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id, 'quantity', a.quantity, 'unit_price', a.unit_price,
           'components', COALESCE(a.components, '[]'::jsonb))), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3) AS quantity,
             (i.unit_price + i.extra_price)::numeric(12,2) AS unit_price,
             i.components
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id AND NOT i.is_offered
       GROUP BY i.product_id, (i.unit_price + i.extra_price), i.components
    ) AS a;

  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Tout est offert : il n''y a rien à encaisser' USING ERRCODE = '22023';
  END IF;

  -- Remise : patron/manager uniquement (c'est de l'argent qui sort).
  v_discount := round(COALESCE(p_discount, 0), 2);
  IF v_discount < 0 THEN
    RAISE EXCEPTION 'La remise ne peut pas être négative' USING ERRCODE = '22023';
  END IF;
  IF v_discount > 0 AND NOT can_manage_products() THEN
    RAISE EXCEPTION 'Seul le patron ou un manager peut accorder une remise'
      USING ERRCODE = '42501';
  END IF;
  IF v_discount > v_total THEN
    RAISE EXCEPTION 'La remise (% F) dépasse l''addition (% F)', v_discount, v_total
      USING ERRCODE = '22023';
  END IF;
  v_net := v_total - v_discount;

  IF p_payments IS NOT NULL
     AND jsonb_typeof(p_payments) = 'array'
     AND jsonb_array_length(p_payments) > 0 THEN
    IF p_payment_method = 'credit' THEN
      RAISE EXCEPTION 'Le crédit ne se combine pas avec un paiement multiple'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_payments) e
       WHERE COALESCE(e->>'method', '') NOT IN ('cash', 'momo')
          OR COALESCE(e->>'amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$'
          OR (e->>'amount')::numeric <= 0
    ) THEN
      RAISE EXCEPTION 'Paiement invalide' USING ERRCODE = '22023';
    END IF;
    IF (SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(p_payments) e) <> v_net THEN
      RAISE EXCEPTION 'La somme des paiements doit égaler l''addition (% F)', v_net
        USING ERRCODE = '22023';
    END IF;
    v_multi := true;
  END IF;

  IF p_payment_method = 'credit' THEN
    IF btrim(COALESCE(p_client_phone, '')) = '' THEN
      RAISE EXCEPTION 'Un numéro est requis pour une addition à crédit' USING ERRCODE = '22023';
    END IF;
    v_sale := record_credit_sale(
      v_items,
      COALESCE(NULLIF(btrim(v_order.customer_name), ''), 'Client table'),
      p_client_phone,
      COALESCE(p_note, 'Table ' || v_table),
      COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0)
    );
  ELSE
    v_sale := create_sale(
      v_items, CASE WHEN v_multi THEN 'mixed' ELSE p_payment_method END,
      NULLIF(btrim(COALESCE(v_order.customer_name, '')), ''),
      COALESCE(p_note, 'Table ' || v_table)
    );
  END IF;

  v_sale_id := (v_sale->>'id')::uuid;

  IF v_multi THEN
    INSERT INTO sale_payments (sale_id, method, amount)
    SELECT v_sale_id, e->>'method', (e->>'amount')::numeric
      FROM jsonb_array_elements(p_payments) e;
  END IF;

  -- La remise se pose APRÈS la vente : create_sale() facture les lignes, la
  -- remise est une décision d'encaissement. On la trace dans discount_amount.
  IF v_discount > 0 THEN
    UPDATE sales
       SET total_amount = v_net,
           amount_received = CASE WHEN payment_method = 'credit' THEN amount_received ELSE v_net END,
           discount_amount = COALESCE(discount_amount, 0) + v_discount
     WHERE id = v_sale_id;
  END IF;

  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_net THEN
      RAISE EXCEPTION 'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_net
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_net;
  END IF;

  UPDATE restaurant_orders
     SET status = 'closed', closed_at = now(), sale_id = v_sale_id,
         split_count = p_split_count, payment_method = p_payment_method,
         amount_paid = v_paid, tip = v_tip
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_net,
    'amount_paid',    v_paid,
    'discount',       v_discount,
    'tip',            v_tip,
    'total_with_tip', v_net + v_tip,
    'split_count',    p_split_count,
    'per_share',      round(v_net / p_split_count, 2)
  );
END;
$function$;

