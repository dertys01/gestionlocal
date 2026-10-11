-- ============================================================================
--  GESTIONLOCAL — SCHÉMA COMPLET
--  À coller dans : Supabase Dashboard → SQL Editor → New query → Run
--
--  Les 31 migrations concaténées (plus schema.sql), dans l'ordre
--  d'application — le même ordre que le harnais supabase/tests/.
--  Ce fichier est pratique pour partir d'une base vide ; sur une base
--  existante, préfère la migration concernée seule.
--
--  ⚠ Ordre obligatoire. migration_team.sql avant migration_saas.sql (la
--    policy « Employé lit l'org de son patron » référence business_members) ;
--    migration_profitability.sql après migration_sales_rpc.sql (create_sale()
--    écrit sale_items.unit_cost) ; migration_profitability_fix.sql après
--    migration_profitability.sql.
--    migration_security.sql DOIT fermer la série des migrations de sécurité :
--    elle pose le verrou de organizations.plan, le RLS de rate_limits,
--    l'index unique de subscriptions et les policies de business_members.
--    migration_ca_caisse.sql vient EN DERNIER : elle aligne
--    get_sales_summary() sur la base de caisse (SUM(amount_received)).
--
--  Rejouable : peut être exécuté plusieurs fois sans effet de bord.
-- ============================================================================


-- ============================================================
--  ⬇ schema.sql
-- ============================================================

-- ============================================================
-- SCHEMA MVP AppGestionLocalBusiness
-- ============================================================
-- ⚠️ HISTORIQUE — ne plus exécuter seul. L'état courant du schéma est défini
-- par l'ordre complet : schema.sql → … → migration_roles.sql →
-- migration_security.sql (c'est migration_security.sql qui fait foi).
-- ============================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE : products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sku           TEXT,                        -- code-barres / référence
  price_buy     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  price_sell    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stock_qty     INTEGER NOT NULL DEFAULT 0,
  min_stock_level INTEGER NOT NULL DEFAULT 5,
  category      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sales
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',  -- 'cash' | 'momo'
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sale_items
-- ============================================================
CREATE TABLE IF NOT EXISTS sale_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,               -- snapshot du nom au moment de la vente
  quantity      INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL,
  subtotal      NUMERIC(12, 2) NOT NULL
);

-- ============================================================
-- TABLE : stock_logs  (audit de tous les mouvements)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,
  movement_type TEXT NOT NULL,               -- 'sale' | 'restock' | 'adjustment'
  quantity_change INTEGER NOT NULL,          -- négatif pour une vente
  stock_before  INTEGER NOT NULL,
  stock_after   INTEGER NOT NULL,
  reference_id  UUID,                        -- sale_id si movement_type = 'sale'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_logs ENABLE ROW LEVEL SECURITY;

-- products
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sales
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sale_items : accessible si la vente appartient à l'utilisateur
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (SELECT 1 FROM sales WHERE sales.id = sale_items.sale_id AND sales.user_id = auth.uid())
  );

-- stock_logs
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- TRIGGER : met à jour updated_at sur products
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- DROP préalable : sans lui, la seconde exécution échoue en 42710
-- « trigger already exists » et interrompt le script en cours de route.
DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONNÉES DE TEST (optionnel)
-- ============================================================
-- INSERT INTO products (user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level, category)
-- VALUES (auth.uid(), 'Samsung Galaxy A05', 'SM-A055F', 55000, 72000, 8, 3, 'smartphones');

-- ============================================================
--  ⬇ migration_team.sql
-- ============================================================

-- ============================================================
-- MIGRATION : Équipe & Journal d'activité
-- ============================================================
-- ⚠️ HISTORIQUE — ses policies FOR ALL ont été remplacées par migration_roles.sql
-- puis migration_security.sql. Ne plus exécuter seul.
-- ============================================================

-- Table membres de l'équipe
CREATE TABLE IF NOT EXISTS business_members (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'employee',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, member_id)
);

-- Journal d'activité
CREATE TABLE IF NOT EXISTS activity_logs (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id          UUID NOT NULL,
  actor_email       TEXT NOT NULL,
  actor_name        TEXT,
  action            TEXT NOT NULL,
  description       TEXT NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs    ENABLE ROW LEVEL SECURITY;

-- business_members : le patron gère ses membres
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
CREATE POLICY "owner_manage_members" ON business_members
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- business_members : chaque employé voit son propre lien
DROP POLICY IF EXISTS "member_view_own" ON business_members;
CREATE POLICY "member_view_own" ON business_members
  FOR SELECT USING (auth.uid() = member_id);

-- activity_logs : insert libre (actor = soi-même)
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
CREATE POLICY "activity_insert" ON activity_logs
  FOR INSERT WITH CHECK (auth.uid() = actor_id);

-- activity_logs : le patron et ses employés peuvent lire
DROP POLICY IF EXISTS "activity_read" ON activity_logs;
CREATE POLICY "activity_read" ON activity_logs
  FOR SELECT USING (
    auth.uid() = business_owner_id OR
    EXISTS (
      SELECT 1 FROM business_members
      WHERE owner_id = business_owner_id AND member_id = auth.uid()
    )
  );

-- Fonction : retourne le user_id du patron (pour employé → owner_id, pour patron → lui-même)
CREATE OR REPLACE FUNCTION get_business_owner_id()
RETURNS UUID AS $$
  SELECT COALESCE(
    (SELECT owner_id FROM business_members WHERE member_id = auth.uid() LIMIT 1),
    auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Mise à jour des politiques RLS existantes pour supporter les employés

DROP POLICY IF EXISTS "user_products" ON products;
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

-- ============================================================
--  ⬇ migration_saas.sql
-- ============================================================

-- ============================================================
-- MIGRATION SaaS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- ─── 1. TABLE ORGANIZATIONS ─────────────────────────────────
-- id = auth.uid() du patron (aucune migration de données requise :
-- les colonnes user_id existantes sont déjà l'org_id)
CREATE TABLE IF NOT EXISTS organizations (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  logo_url    text,
  plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  timezone    text NOT NULL DEFAULT 'Africa/Porto-Novo',
  currency    text NOT NULL DEFAULT 'XOF',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_org_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();

-- RLS
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit sa propre org" ON organizations;
CREATE POLICY "Patron lit sa propre org" ON organizations
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Employé lit l'org de son patron" ON organizations;
CREATE POLICY "Employé lit l'org de son patron" ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM business_members
      WHERE member_id = auth.uid() AND owner_id = organizations.id
    )
  );

DROP POLICY IF EXISTS "Patron modifie sa propre org" ON organizations;
CREATE POLICY "Patron modifie sa propre org" ON organizations
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
CREATE POLICY "Patron crée son org" ON organizations
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ─── 2. TABLE SUBSCRIPTIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       text UNIQUE,
  stripe_subscription_id   text UNIQUE,
  plan                     text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  status                   text NOT NULL DEFAULT 'active',
  current_period_end       timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit ses abonnements" ON subscriptions;
CREATE POLICY "Patron lit ses abonnements" ON subscriptions
  FOR SELECT USING (org_id = auth.uid());

-- Seul le service role peut écrire (via webhook Stripe)
DROP POLICY IF EXISTS "Service role gère les abonnements" ON subscriptions;
CREATE POLICY "Service role gère les abonnements" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- ─── 3. ONBOARDING FLAG ─────────────────────────────────────
-- Ajouter une colonne onboarding_done à organizations (ALTER idempotent)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_done boolean DEFAULT false;

-- ─── 4. CRÉER UNE ORG POUR LES UTILISATEURS EXISTANTS ───────
-- (exécuter une seule fois — idempotent grâce à ON CONFLICT DO NOTHING)
INSERT INTO organizations (id, name, slug, plan, onboarding_done)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
  lower(regexp_replace(
    COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
    '[^a-z0-9]', '-', 'g'
  )) || '-' || left(u.id::text, 8),
  'free',
  true  -- utilisateurs existants = onboarding déjà fait
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = u.id
);

-- ============================================================
--  ⬇ migration_plan_limits.sql
-- ============================================================

-- ============================================================
-- MIGRATION PLAN LIMITS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Enforce les limites de produits au niveau DB (inviolable)
-- ============================================================

CREATE OR REPLACE FUNCTION check_product_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  org_plan text;
  product_count int;
  plan_limit int;
BEGIN
  SELECT plan INTO org_plan FROM organizations WHERE id = NEW.user_id;

  SELECT COUNT(*) INTO product_count
  FROM products WHERE user_id = NEW.user_id;

  plan_limit := CASE org_plan
    WHEN 'free'    THEN 30
    WHEN 'starter' THEN 200
    WHEN 'pro'     THEN 2147483647
    ELSE 30
  END;

  IF product_count >= plan_limit THEN
    RAISE EXCEPTION 'Limite de produits atteinte pour le plan % (max %). Passez à un plan supérieur.', org_plan, plan_limit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_product_limit ON products;
CREATE TRIGGER enforce_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_limit();

-- ============================================================
--  ⬇ migration_invoices.sql
-- ============================================================

-- ============================================================
-- MIGRATION INVOICES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- Champs facturation dans organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ifu             text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address         text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_counter integer NOT NULL DEFAULT 0;

-- Nom du client optionnel sur une vente (pour facture normalisée)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_name text;

-- ============================================================
--  ⬇ migration_webhook_logs.sql
-- ============================================================

-- ============================================================
-- MIGRATION WEBHOOK LOGS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Table pour tracer les événements Stripe reçus en prod
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     text UNIQUE NOT NULL,
  event_type   text NOT NULL,
  org_id       text,
  status       text NOT NULL DEFAULT 'received',  -- received | processed | error
  error        text,
  received_at  timestamptz DEFAULT now()
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- Pas de lecture publique : accessible uniquement via service role key

-- ============================================================
--  ⬇ migration_indexes.sql
-- ============================================================

-- ============================================================
-- MIGRATION INDEXES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- products
CREATE INDEX IF NOT EXISTS idx_products_user_id     ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_name        ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);

-- sales
CREATE INDEX IF NOT EXISTS idx_sales_user_id        ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at     ON sales(created_at DESC);

-- sale_items
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id   ON sale_items(sale_id);

-- stock_logs
CREATE INDEX IF NOT EXISTS idx_stock_logs_product_id ON stock_logs(product_id);

-- activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_owner_id   ON activity_logs(business_owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);

-- ============================================================
--  ⬇ migration_sales_rpc.sql
-- ============================================================

-- ============================================================
-- MIGRATION VENTE TRANSACTIONNELLE — GestionLocal
-- À exécuter dans Supabase SQL Editor
--
-- Remplace le flux client (INSERT sales + INSERT sale_items + boucle
-- sequentielle UPDATE products / INSERT stock_logs) par une unique
-- fonction atomique. Corrige :
--   * les ventes partiellement appliquees (stock non decremente alors que
--     l'UI affichait « Vente enregistree ») ;
--   * les lost updates entre deux caisses (lecture-modification-ecriture) ;
--   * les 2N allers-retours reseau d'un panier de N lignes (1 seul) ;
--   * le compteur de facture lu-modifie-ecrit depuis le client.
-- ============================================================

-- ─── 1. Numéro de facture persisté sur la vente ─────────────
-- Avant, le numéro n'était jamais stocké : il était calculé à l'impression
-- depuis un compteur en base, si bien que deux factures imprimées depuis le
-- même état de page portaient le même numéro, et qu'aucune facture n'était
-- rattachée à sa vente.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_number text;

-- ⚠ L'unicité est PAR BOUTIQUE, pas globale.
--
-- Le compteur (organizations.invoice_counter) appartient à une boutique, mais
-- l'index portait sur la seule colonne invoice_number : les deux premières
-- boutiques Pro de la plateforme produisaient toutes deux « FAC-2026-00001 », et
-- la seconde se faisait refuser sa vente. Sa caisse était morte — le défaut le
-- plus grave possible chez un client payant. Reproduit avant correction : la
-- boutique B ne pouvait plus encaisser.
--
-- Ce n'est pas seulement un choix technique : la numérotation des factures est
-- une séquence par contribuable, pas par pays. Deux commerces différents ont
-- chacun leur première facture au numéro 1, et c'est légal. L'unicité globale
-- n'avait aucun sens.
--
-- Le DROP est nécessaire : CREATE UNIQUE INDEX IF NOT EXISTS ne remplace pas
-- un index déjà présent, il en laisse un autre — la correction ne s'appliquerait
-- jamais sur une base existante.
DROP INDEX IF EXISTS idx_sales_invoice_number;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_number
  ON sales(user_id, invoice_number) WHERE invoice_number IS NOT NULL;

-- ─── 2. Filet de sécurité sur le stock ─────────────────────
-- NOT VALID : la contrainte est bien appliquée aux INSERT/UPDATE futurs,
-- mais on ne scanne pas l'existant (le plan peut contenir des données
-- négatives à cause de l'ancien flux client non transactionnel).
-- Après avoir nettoyé :  ALTER TABLE products VALIDATE CONSTRAINT products_stock_qty_non_negative;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_qty_non_negative;
ALTER TABLE products ADD CONSTRAINT products_stock_qty_non_negative
  CHECK (stock_qty >= 0) NOT VALID;

-- ─── 3. Rate limiting distribué ────────────────────────────
-- Remplace le compteur en mémoire de /api/register, qui était recréé vide à
-- chaque invocation serverless et ne limitait donc rien en production.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        text PRIMARY KEY,
  count      integer NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL
);

-- Nettoyage opportuniste : supprime les lignes expirées lors de l'appel suivant.
CREATE OR REPLACE FUNCTION bump_rate_limit(
  p_key             text,
  p_max             integer,
  p_window_seconds  integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    timestamptz := now();
  v_count  integer;
BEGIN
  -- Verrou de ligne : deux inscriptions simultanées depuis la même IP
  -- sérialisent ici au lieu de lire/écrire en même temps.
  INSERT INTO rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + make_interval(secs => p_window_seconds))
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
                  WHEN rate_limits.reset_at <= v_now THEN 1
                  ELSE rate_limits.count + 1
                END,
        reset_at = CASE
                     WHEN rate_limits.reset_at <= v_now
                       THEN v_now + make_interval(secs => p_window_seconds)
                     ELSE rate_limits.reset_at
                   END
  RETURNING count INTO v_count;

  RETURN v_count > p_max;
END;
$$;

-- Purge des compteurs expirés (appelable par un cron ; sans effet ici).
CREATE OR REPLACE FUNCTION purge_rate_limits()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM rate_limits WHERE reset_at <= now() RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION bump_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bump_rate_limit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION purge_rate_limits() TO service_role;

-- ─── 4. Politique DELETE manquante sur le journal ──────────
-- activity_logs n'avait qu'une policy INSERT et une policy SELECT : la purge
-- des logs de plus de 90 jours ne pouvait donc jamais aboutir.
DROP POLICY IF EXISTS "activity_prune" ON activity_logs;
DROP POLICY IF EXISTS "activity_prune" ON activity_logs;
CREATE POLICY "activity_prune" ON activity_logs
  FOR DELETE USING (auth.uid() = business_owner_id);

-- ─── 5. Fonction create_sale ───────────────────────────────
-- Retourne l'identifiant de la vente, son numéro de facture (Pro) et son
-- total — tous trois calculés côté serveur, pour que le client affiche
-- exactement ce qui a été enregistré.
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
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
  v_qtys       int[];
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_name       text;
  v_price      numeric(12,2);
  v_cost       numeric(12,2);
  v_stock      int;
  v_qty        int;
  v_total      numeric(12,2) := 0;
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  -- ── Valider chaque quantité AVANT toute écriture ──
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+$'
       OR (e->>'quantity')::int < 1
       OR (e->>'quantity')::int > 100000
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  -- ── Agréger par produit ──
  -- Indispensable : sans cela un panier contenant deux fois le même article
  -- passerait la vérification de stock ligne par ligne (5 >= 4, puis 5 >= 4)
  -- avant de décrémenter de 8 et de rendre le stock négatif.
  SELECT array_agg(product_id ORDER BY product_id),
         array_agg(quantity   ORDER BY product_id)
    INTO v_ids, v_qtys
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             SUM((e->>'quantity')::int)::int AS quantity
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  -- FOR UPDATE sérialise les caisses concurrentes sur les mêmes articles.
  -- Les verrous sont conservés jusqu'au COMMIT, donc la seconde boucle relit
  -- des valeurs stables.
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_price, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    IF v_stock < v_qtys[v_i] THEN
      RAISE EXCEPTION 'Stock insuffisant pour « % » (disponible : %, demandé : %)',
        v_name, v_stock, v_qtys[v_i] USING ERRCODE = '23514';
    END IF;

    -- Le prix facturé est celui de la base, jamais celui transmis par le client.
    v_total := v_total + v_price * v_qtys[v_i];
  END LOOP;

  -- ── Numéro de facture : incrément atomique (Pro uniquement) ──
  -- `UPDATE ... RETURNING` pose un verrou de ligne : deux caisses qui
  -- impriment en parallèle obtiennent deux numéros distincts.
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    UPDATE organizations
       SET invoice_counter = invoice_counter + 1
     WHERE id = v_owner
    RETURNING invoice_counter INTO v_counter;

    v_invoice := 'FAC-' || to_char(now(), 'YYYY') || '-' || lpad(v_counter::text, 5, '0');
  END IF;

  -- ── En-tête de vente ──
  INSERT INTO sales (
    user_id, total_amount, payment_method, client_name, note, invoice_number
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_price, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty, v_price, v_price * v_qty, v_cost
    );

    UPDATE products SET stock_qty = stock_qty - v_qty WHERE id = v_ids[v_i];

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    ) VALUES (
      v_owner, v_ids[v_i], v_name, 'sale',
      -v_qty, v_stock, v_stock - v_qty, v_sale_id
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id',             v_sale_id,
    'invoice_number', v_invoice,
    'total_amount',   v_total
  );
END;
$$;

-- Seuls les utilisateurs authentifiés peuvent encaisser.
REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION create_sale(jsonb, text, text, text) IS
  'Enregistre une vente de façon atomique : lignes, décrément de stock et journal. '
  'Lève une exception si le stock est insuffisant — dans ce cas rien n''est écrit.';

-- ============================================================
--  ⬇ migration_roles.sql
-- ============================================================

-- ============================================================
-- MIGRATION RÔLES & MULTI-TENANT — GestionLocal
-- À exécuter dans Supabase SQL Editor (après migration_team.sql)
--
-- Corrige trois failles d'autorisation :
--
--  1. Un employé héritait du tenant complet via get_business_owner_id() :
--     la policy "user_products" était un ALL, donc une caissière pouvait
--     `DELETE FROM products` ou `UPDATE products SET price_sell = 1`
--     depuis devtools, alors que l'UI annonce l'inverse
--     (OnboardingWizard : « ✗ Modifier les produits »).
--
--  2. `activity_logs.business_owner_id` n'était pas validé à l'insertion :
--     n'importe quel utilisateur authentifié pouvait forger une entrée
--     dans le journal d'une autre organisation.
--
--  3. Un employé pouvait se créer sa propre organisation
--     (INSERT organizations ... WITH CHECK (auth.uid() = id)) et donc
--     forker ses données hors du tenant de son patron.
-- ============================================================

-- ─── 1. search_path sur la fonction existante ───────────────
-- SECURITY DEFINER sans search_path figé : un objet créé dans un schema
-- contrôlé par un attaquant pourrait prendre le dessus.
-- CREATE OR REPLACE et non DROP/CREATE : les policies RLS de migration_team.sql
-- dépendent de cette fonction, un DROP serait refusé (« other objects depend
-- on it »). La signature est inchangée, les attributs sont modifiables ainsi.
CREATE OR REPLACE FUNCTION get_business_owner_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT owner_id FROM business_members WHERE member_id = auth.uid() LIMIT 1),
    auth.uid()
  );
$$;

-- ─── 2. Un membre appartient à un seul business ──────────────
-- La contrainte UNIQUE(owner_id, member_id) autorisait un même compte dans
-- plusieurs organisations. SupabaseProvider résout l'appartenance avec un
-- maybeSingle() : au-delà d'une ligne, la requête échoue, l'erreur est
-- avalée par un catch{}, ownerId reste null et l'app affiche
-- « Configuration requise », avec un chemin qui crée une nouvelle organisation.
DO $$
DECLARE
  duplicated integer;
BEGIN
  SELECT count(*) INTO duplicated FROM (
    SELECT member_id FROM business_members
     GROUP BY member_id HAVING count(*) > 1
  ) AS d;

  IF duplicated > 0 THEN
    RAISE EXCEPTION
      'Migration annulée : % compte(s) appartiennent à plusieurs organisations. '
      'Supprimez les liens superflus de business_members puis relancez.',
      duplicated;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_members_member_id
  ON business_members(member_id);

-- ─── 3. Droits d'écriture sur le catalogue ──────────────────
-- Vrai si l'utilisateur est le patron du tenant résolu, ou un membre dont le
-- rôle est 'owner' ou 'manager' (porte de sortie pour étoffer le modèle).
CREATE OR REPLACE FUNCTION can_manage_products()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT get_business_owner_id() = auth.uid()
      OR EXISTS (
        SELECT 1 FROM business_members
         WHERE member_id = auth.uid()
           AND owner_id = get_business_owner_id()
           AND role IN ('owner', 'manager')
      );
$$;

-- Lecture : tout le tenant, comme avant.
--
-- "user_products" vient de migration_team.sql et est déclarée FOR ALL : la
-- laisser en place maintiendrait l'accès en écriture du séparé. C'est
-- imperatif, pas défensif — les policies RLS s'additionnent (OR), elles ne se
-- remplacent pas.
DROP POLICY IF EXISTS "user_products"  ON products;
DROP POLICY IF EXISTS "products_read"  ON products;
DROP POLICY IF EXISTS "products_read" ON products;
CREATE POLICY "products_read" ON products
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager uniquement.
DROP POLICY IF EXISTS "products_insert" ON products;
DROP POLICY IF EXISTS "products_insert" ON products;
CREATE POLICY "products_insert" ON products
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "products_update" ON products;
DROP POLICY IF EXISTS "products_update" ON products;
CREATE POLICY "products_update" ON products
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "products_delete" ON products;
DROP POLICY IF EXISTS "products_delete" ON products;
CREATE POLICY "products_delete" ON products
  FOR DELETE USING (can_manage_products());

-- ─── 4. Journal d'activité : le tenant est imposé par la base ─
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
CREATE POLICY "activity_insert" ON activity_logs
  FOR INSERT WITH CHECK (
    actor_id = auth.uid()
    AND business_owner_id = get_business_owner_id()
  );

-- ─── 5. Un employé ne peut pas créer sa propre organisation ─
DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
CREATE POLICY "Patron crée son org" ON organizations
  FOR INSERT WITH CHECK (
    auth.uid() = id
    AND NOT EXISTS (SELECT 1 FROM business_members WHERE member_id = auth.uid())
  );

-- ============================================================
--  ⬇ migration_plan_gate.sql
-- ============================================================

-- ============================================================
-- VERROU DE PLAN CÔTÉ SERVEUR
-- À exécuter dans Supabase SQL Editor
--
-- LE TROU
--   Les écrans Rapports, Prévisions et Dettes sont verrouillés par un test de
--   plan dans le navigateur : le menu affiche un cadenas, et un client en plan
--   gratuit est redirigé vers Paramètres. C'est vrai, et c'est sans valeur.
--
--   Le verrou est côté client, donc contournable en une ligne depuis la console
--   du navigateur :
--
--     supabase.rpc('get_product_profitability')
--
--   La clé anon est publique — elle est dans le bundle JS, que le navigateur
--   télécharge. Un concurrent, un-client, ou un Stall qui veut voir la marge de
--   la boutique d'à côté n'a rien à faire de plus. Il n'est même pas nécessaire
--   d'être connecté : il suffit d'être le propriétaire de sa boutique, ce que
--   l'inscription en plan gratuit donne en trente secondes. La RLS isole les
--   boutiques entre elles, donc il ne verra que SES chiffres — mais il verra
--   tous les chiffres payants, gratuitement.
--
-- CE QUE CELA FAIT PERDRE
--   Le plan Starter vend 3 000 FCFA/mois, le Pro 9 000. Si les rapports sont
--   accessibles à tous, personne n'a de raison de payer : c'est le produit
--   entier qui devient gratuit. Le cadenas dans le menu continuait de dire le
--   contraire.
--
-- LE PRINCIPE
--   Une règle de monétisation ne peut pas vivre dans le navigateur. Le plan est
--   relu en base, à chaque appel, et l'appel est refusé si le plan ne suit pas.
--   Le client ne fait que refléter la décision — il n'est plus l'arbitre.
--
-- ⚠ Ce n'est PAS une sécurité de confidentialité : la RLS s'en charge, et elle
--   fonctionne. C'est une règle commerciale, et c'est précisément le genre de
--   règle qu'un client contourne sans le vouloir, en gardant un onglet ouvert
--   d'un essai terminé. Le contrôle doit être là où la décision se prend.
--
-- CE QUI N'EST PAS VERROUILLÉ, ET POURQUOI
--   La caisse, le stock, les ventes, l'équipe, les invitations, les dettes.
--   Un client doit pouvoir VENDRE : c'est l'application. Verrouiller la
--   vente décourage, il faut donc laisser passer tout ce qui fait tourner le
--   commerce, et ne verrouiller que ce qui est un avantage payant.
--
-- DEUX COUCHES, VOLONTAIREMENT : le plan et les limites restent aussi dans le
--   client (PLAN_LIMITS), pour afficher des cadenas et des messages sans
--   aller-retour réseau. Cette migration ne le remplace pas, elle le renforce :
--   si les deux divergent un jour, c'est la base qui tranche.
-- ============================================================

-- ─── 1. Lire le plan de la boutique ────────────────────────
-- La source de vérité est organizations.plan, déjà utilisée par le trigger de
-- limite de produits : le contrôle de plan ne peut pas utiliser une autre
-- colonne, sinon les deux se désynchronisent.
--
-- COALESCE sur 'free' : une organisation sans plan est traitée comme gratuit.
-- Le doute doit coûter cher au vendeur, jamais au client.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.plan FROM organizations o WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan de la boutique appelante. Défaut « free » : en cas de doute, un client '
  'est traité comme gratuit. SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 2. Exiger une fonctionnalité ──────────────────────────
-- Lève une exception si le plan ne permet pas p_feature. Le message est en
-- français et nomme le plan à prendre : c'est ce que le client affiche quand
-- l'appel échoue, et un message technique serait incompréhensible pour un
-- commerçant.
--
-- VOLATILE, et c'est délibéré : la fonction lève une exception, donc elle n'est
-- pas « pure ». Une fonction STABLE serait susceptible d'être évaluée une seule
-- fois par le planificateur, ou écartée s'il juge le résultat inutilisable —
-- deux façons discrètes de laisser passer un client en plan gratuit.
--
-- SECURITY INVOKER : elle ne fait que lire organizations, dont la RLS renvoie
-- la ligne de l'appelant. Rien à contourner.
CREATE OR REPLACE FUNCTION require_feature(p_feature text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_plan    text;
  v_requis  text;
  v_rang_plan   int;
  v_rang_requis int;
BEGIN
  -- Les mêmes quotas que PLAN_LIMITS côté client. Les tenir à jour à deux
  -- endroits est un risque assumé : c'est la base qui tranche, donc un oubli
  -- côté client ne donne accès à rien.
  v_requis := CASE p_feature
    WHEN 'reports'   THEN 'starter'   -- rentabilité, charges, dettes
    WHEN 'forecast'  THEN 'pro'       -- prévisions de réapprovisionnement
    WHEN 'exportCsv' THEN 'starter'
    ELSE NULL
  END;

  -- Fonctionnalité inconnue : on refuse. Une faute de frappe dans le nom ne
  -- doit pas se traduire par un accès accordé.
  IF v_requis IS NULL THEN
    RAISE EXCEPTION 'Fonctionnalité inconnue : %', p_feature USING ERRCODE = '22023';
  END IF;

  -- CONTEXTE SANS UTILISATEUR = CONFIANCE, PAS PLAN GRATUIT.
  --
  -- Aucun utilisateur résolu ne signifie pas un client gratuit : cela veut dire
  -- clé service_role, script d'administration, migration, ETL. Ces contextes
  -- sont déjà de confiance maximale — ils ont tous les droits sur toutes les
  -- boutiques — donc les bloquer au motif du plan n'aurait aucun sens.
  --
  -- Ce n'est pas une brèche : le rôle anon n'a aucun droit d'exécution sur ces
  -- fonctions (les GRANT vont à authenticated et service_role), et un appel
  -- authentifié a toujours un claim `sub`. Seuls service_role et les scripts
  -- arrivent ici avec un propriétaire NULL.
  IF get_business_owner_id() IS NULL THEN
    RETURN true;
  END IF;

  v_plan := current_org_plan();

  -- Comparaison par rang plutôt que par liste : ajouter un plan plus tard ne
  -- demande pas de réécrire les conditions. Les rangs sont mis dans des
  -- variables car un CASE nu comme opérande de comparaison n'est pas accepté
  -- par le parseur PL/pgSQL — il s'arrête sur « syntax error at end of input »,
  -- sans nommer la ligne fautive.
  v_rang_plan := CASE v_plan
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  v_rang_requis := CASE v_requis
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  IF v_rang_plan < v_rang_requis THEN
    RAISE EXCEPTION
      'La fonctionnalité « % » nécessite le plan % (plan actuel : %).',
      p_feature, v_requis, v_plan
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION require_feature(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION require_feature(text) TO authenticated;
GRANT EXECUTE ON FUNCTION require_feature(text) TO service_role;

COMMENT ON FUNCTION require_feature(text) IS
  'Lève une exception si le plan de la boutique ne permet pas la fonctionnalité. '
  'À appeler dans les fonctions payantes : le contrôle de plan ne peut pas '
  'vivre dans le navigateur, où un simple appel RPC le contourne.';


-- ─── 3. Les quantités vendues, pour les Prévisions ────────
-- Nouvelle fonction, et pas un simple verrou sur la requête existante : le
-- module Prévisions lisait sale_items ligne à ligne pour compter lui-même les
-- quantités vendues. Il ramenait donc TOUTES les lignes de vente de la période
-- dans le navigateur d'un client en plan gratuit — le chiffre d'affaires, jour
-- par jour, produit par produit. Un verrou posé sur l'écran n'aurait protégé
-- que l'affichage ; il fallait protéger les données.
--
-- La fonction retourne le même agrégat, calculé en base. Un client gratuit
-- reçoit une erreur, pas le chiffre d'affaires des trois derniers mois.
--
-- SECURITY INVOKER : l'isolation vient de la RLS de sale_items et sales. Le
-- contrôle de plan est ajouté, ce qui est une autre question.
DROP FUNCTION IF EXISTS get_units_sold_since(integer);
CREATE FUNCTION get_units_sold_since(p_days integer DEFAULT 30)
RETURNS TABLE (
  product_id uuid,
  quantity   numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- Le garde s'exécute avant l'agrégat : un client sans le plan ne voit pas
  -- les quantités, même agrégées. `true` pour laisser passer la ligne, et
  -- l'exception est levée par require_feature() si le plan ne suffit pas.
  SELECT si.product_id, SUM(si.quantity)
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE (SELECT true FROM require_feature('forecast'))
     -- Borne basse : un nombre négatif ou absurde ne doit pas transformer la
     -- requête en plein scan de l'historique du client.
     AND p_days BETWEEN 1 AND 3650
     AND s.created_at >= now() - make_interval(days => p_days)
   GROUP BY si.product_id;
$$;

REVOKE ALL ON FUNCTION get_units_sold_since(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO service_role;

COMMENT ON FUNCTION get_units_sold_since(integer) IS
  'Quantités vendues par produit sur les N derniers jours, agrégées en base. '
  'Remplace la lecture ligne à ligne de sale_items : le client ne reçoit plus '
  'l''historique complet. Exige le plan pro (fonctionnalité forecast).';

-- ============================================================
--  ⬇ migration_price_override.sql
-- ============================================================

-- ============================================================
-- PRIX NÉGOCIÉ — create_sale() ignorait le prix convenu
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   create_sale() recalcule le total côté serveur à partir de
--   products.price_sell, et refuse tout prix transmis par le client. C'était un
--   choix délibéré — un client ne doit pas pouvoir facturer 1 FCFA. Mais dans un
--   marché où « c'est le dernier prix » est la règle, l'impossibilité de
--   modifier un prix n'est pas une protection : c'est un blocage. Un
--   commerçant ne note pas la vente, il la refuse ou il vend sous le prix
--   en espèces, hors de l'application.
--
-- CE QUE CELA CHANGE
--   Chaque ligne de panier peut porter un prix convenu. Le prix catalogue
--   reste la référence et n'est jamais modifié : il est enregistré dans
--   sale_items.list_price, ce qui rend chaque remise traçable.
--
-- CE QUE CELA N'OUVRE PAS
--   Rien qui vaille le prix d'achat. La vente à perte reste possible — un
--   commerçant a le droit de se tromper, ou d'écouler un stock aging — mais
--   elle est signalée dans Rentabilité au lieu de disparaître dans le chiffre
--   d'affaires. Bloquer une vente à perte empêcherait de solder un stock, ce qui
--   est précisément le moment où le commerçant en a besoin.
--
--   Le risque réel d'un prix envoyé par le client n'est pas le client
--   malveillant, c'est la caisse qui cache du chiffre. La parade est la
--   traçabilité, pas le verrou : list_price + agrégat des remises dans le
--   rapport.
-- ============================================================

-- ─── 1. Le prix catalogue, mémorisé ───────────────────────
-- Sans cette colonne, une remise se perdait définitivement : le prix catalogue
-- aurait été écrasé et la marge historique recalculée au prix d'aujourd'hui,
-- exactement le défaut que unit_cost corrigeait déjà pour le coût.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS list_price numeric(12,2);

-- ─── 2. create_sale() accepte un prix convenu ─────────────
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
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
  v_qtys       int[];
  v_agreed     numeric(12,2)[];   -- prix convenu, NULL = prix catalogue
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_name       text;
  v_list       numeric(12,2);     -- prix catalogue (référence)
  v_price      numeric(12,2);     -- prix réellement facturé
  v_cost       numeric(12,2);
  v_stock      int;
  v_qty        int;
  v_total      numeric(12,2) := 0;
  v_discount   numeric(12,2) := 0;
  v_at_loss    int := 0;
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  -- ── Valider chaque ligne AVANT toute écriture ──
  -- unit_price est facultatif. S'il est présent il doit être un nombre
  -- strictement positif : 0 reviendrait à donner le stock, ce qu'aucun
  -- marchandage ne justifie.
  --
  -- Le contrôle est fait en trois temps, et non par un seul motif regex :
  -- `^[0-9]+(\.[0-9]{1,2})?$` accepte « 0 », et COALESCE(liste, prix) aurait
  -- alors traité la ligne comme sans remise. Une vente gratuite doit être
  -- refusée, pas traitée comme une absence de prix.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+$'
       OR (e->>'quantity')::int < 1
       OR (e->>'quantity')::int > 100000
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

  -- ── Agréger par produit ──
  -- Les quantités s'additionnent. Les prix convenus ne s'additionnent pas : deux
  -- lignes du même article à deux prix différents sont ambiguës, et prendre le
  -- minimum ou le maximum ouvrirait la porte à un panier truqué. On refuse.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (e->>'product_id')::uuid AS product_id
        FROM jsonb_array_elements(p_items) AS e
       WHERE e ? 'unit_price'
       GROUP BY 1
      HAVING count(DISTINCT e->>'unit_price') > 1
    ) AS conflit
  ) THEN
    RAISE EXCEPTION 'Deux prix différents pour le même article : regroupez la ligne'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(product_id ORDER BY product_id),
         array_agg(quantity   ORDER BY product_id),
         array_agg(unit_price ORDER BY product_id)
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             SUM((e->>'quantity')::int)::int AS quantity,
             -- min() ne sert qu'à satisfaire NOT NULL : le contrôle ci-dessus a
             -- déjà garanti qu'il n'y a qu'une valeur distincte.
             MIN((e->>'unit_price')::numeric) AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  -- FOR UPDATE sérialise les caisses concurrentes sur les mêmes articles.
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    IF v_stock < v_qtys[v_i] THEN
      RAISE EXCEPTION 'Stock insuffisant pour « % » (disponible : %, demandé : %)',
        v_name, v_stock, v_qtys[v_i] USING ERRCODE = '23514';
    END IF;

    -- Prix convenu si fourni, sinon prix catalogue. La quantité est multipliée
    -- par le prix unitaire convenu : « 3 pieces a 6000 chacune » ne se négocie
    -- pas sur le total, la ligne est déjà agrégée.
    v_price := COALESCE(v_agreed[v_i], v_list);

    v_total    := v_total + v_price * v_qtys[v_i];
    v_discount := v_discount + (v_list - v_price) * v_qtys[v_i];

    -- Signalé, pas bloqué : voir l'en-tête. La vente reste enregistrée et le
    -- rapport indique ce qui a été concessionné.
    IF v_price < v_cost THEN
      v_at_loss := v_at_loss + 1;
    END IF;
  END LOOP;

  IF v_discount < 0 THEN
    v_discount := 0;
  END IF;

  -- ── Numéro de facture : incrément atomique (Pro uniquement) ──
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    UPDATE organizations
       SET invoice_counter = invoice_counter + 1
     WHERE id = v_owner
    RETURNING invoice_counter INTO v_counter;

    v_invoice := 'FAC-' || to_char(now(), 'YYYY') || '-' || lpad(v_counter::text, 5, '0');
  END IF;

  -- ── En-tête de vente ──
  INSERT INTO sales (
    user_id, total_amount, payment_method, client_name, note, invoice_number
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    UPDATE products SET stock_qty = stock_qty - v_qty WHERE id = v_ids[v_i];

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    ) VALUES (
      v_owner, v_ids[v_i], v_name, 'sale',
      -v_qty, v_stock, v_stock - v_qty, v_sale_id
    );
  END LOOP;

  -- discount_amount et at_loss_count permettent à l'appelant d'afficher un avert
  -- sans relire les lignes.
  RETURN jsonb_build_object(
    'id',             v_sale_id,
    'invoice_number', v_invoice,
    'total_amount',   v_total,
    'discount_amount', v_discount,
    'at_loss_count',  v_at_loss
  );
END;
$$;

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION create_sale(jsonb, text, text, text) IS
  'Enregistre une vente de façon atomique. Chaque ligne peut porter un prix '
  'convenu (unit_price) ; le prix catalogue est alors conservé dans '
  'sale_items.list_price pour que la remise reste traçable. Deux prix '
  'différents pour le même article sont refusés.';

-- ============================================================
--  ⬇ migration_weighted_sales.sql
-- ============================================================

-- ============================================================
-- VENTE AU POIDS — quantités fractionnaires
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   products.stock_qty, sale_items.quantity et stock_logs.quantity_change sont
--   des INTEGER, et create_sale() valide la quantité par `^[0-9]+$`. Une boutique
--   ne peut donc pas vendre 1,2 kg de riz.
--
--   Au Bénin, tout se vend au poids : le riz, l'huile, le sucre, le lait en
--   poudre, les tomates. Un commerçant qui sort son téléphone pour un article
--   qu'il vend toute la journée sort son téléphone, et rien de plus. La vente
--   part en espèces, hors de l'application, et la caisse n'a plus aucune idée de
--   ce qui s'est vendu.
--
-- CE QUE CELA CHANGE
--   Les quantités passent en NUMERIC(12,3). Trois décimales suffisent : 1,250 kg
--   se pèse au gramme près, et au-delà on mesure autrement.
--
--   Un champ products.unit accompagne la quantité, pour que l'écran affiche
--   « 1,2 kg » et non « 1,2 ». L'unité n'affecte aucun calcul : la quantité
--   reste un nombre dans l'unité du produit. C'est ce qui permet de garder un
--   seul stock par produit, ce qu'un stock en kg et un stock en pièce
--   obligeraient à scinder.
--
-- ⚠ Un produit vendu en sachet et en kilogrammes doit être DEUX produits.
--   C'est le choix classique des petites caisses, et l'alternative — deux
--   unités et un facteur de conversion — double la surface d'erreur pour un
--   besoin rare. Le commercçant crée « Riz (sachet 50kg) » et « Riz (au kilo) ».
--
-- Les montants ne changent pas : price_buy et price_sell restent des prix
-- UNITAIRES dans l'unité du produit. « Riz » à 750 F le kilo, pas 37 500 F
-- le quintal.
-- ============================================================

-- ─── 1. Unité de vente ────────────────────────────────────
-- Valeurs libres et non constraintes : les unités d'un marché ne sont pas
-- prévisibles, et une contrainte refusant « botte » ou « calabash » ferait
-- échouer une saisie légitime. Le défaut est « pce » (pièce), qui couvre
-- l'essentiel du catalogue.
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'pce';


-- ─── 2. Quantités fractionnaires ───────────────────────────
-- NUMERIC(12,3) : 999 999 999,999 avant saturation. Un stock en sacs de riz
-- comme un stock en kilos tiennent largement dedans.
--
-- ⚠ products_with_supplier doit être supprimée AVANT, et le défaut n'apparaît
--   que sur une base déjà peuplée. Sur une base neuve, la vue est créée par
--   migration_suppliers.sql, qui passe APRÈS ce fichier : l'ALTER réussit, et le
--   test ne voit jamais le problème. Sur une base où la vue existe déjà, l'ALTER
--   échoue en 0A000 « cannot alter type of a column used by a view or rule » et
--   le script s'interrompt avant les migrations suivantes.
--
DROP VIEW IF EXISTS products_with_supplier;

-- Les vues du module restaurant dépendent elles aussi de products : recipe_costs
-- et restaurant_menu_today lisent son stock et son prix. Sans ce DROP, le même
-- ALTER échoue en 0A000 sur une base où ces vues existent déjà — c'est-à-dire
-- sur toute base ayant déjà reçu les sprints 15 et 17, c'est-à-dire la nôtre.
DROP VIEW IF EXISTS recipe_costs;
DROP VIEW IF EXISTS restaurant_menu_today;

-- ⚠ Le type n'est changé QUE si la colonne est encore entière : le refaire
--   échoue en 0A000 pour la même raison.
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_name = 'sale_items' AND column_name = 'quantity';

  IF v_type = 'integer' THEN
    ALTER TABLE sale_items   ALTER COLUMN quantity TYPE NUMERIC(12,3);
    ALTER TABLE products     ALTER COLUMN stock_qty TYPE NUMERIC(12,3);
    ALTER TABLE products     ALTER COLUMN min_stock_level TYPE NUMERIC(12,3);
    ALTER TABLE stock_logs   ALTER COLUMN quantity_change TYPE NUMERIC(12,3),
                              ALTER COLUMN stock_before     TYPE NUMERIC(12,3),
                              ALTER COLUMN stock_after      TYPE NUMERIC(12,3);
  END IF;
END;
$$;

-- Recréation de la vue, dans le MÊME fichier.
--
--⚠ S'appuyer sur migration_suppliers.sql pour la reconstruire ne suffit pas :
--   ce fichier est réappliqué seul (le test de rejouabilité le fait pour rétablir
--   la dernière version de create_sale()), et supprime alors la vue sans que
--   rien ne la remette. Le catalogue devient invisible, sans aucune
--   erreur — le pire genre de panne. Un fichier de migration doit être
--   autonome : il répare ce qu'il casse.
--
-- La création est conditionnelle : sur une base neuve, ni la table suppliers ni
-- la colonne products.supplier_id n'existent encore, et la vue échouerait.
DO $$
BEGIN
  IF to_regclass('public.suppliers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'products' AND column_name = 'supplier_id') THEN
    EXECUTE $vue$
      CREATE OR REPLACE VIEW products_with_supplier
      WITH (security_invoker = true)
      AS
      SELECT
        p.id,
        p.user_id,
        p.name,
        p.sku,
        p.category,
        p.price_buy,
        p.price_sell,
        p.stock_qty,
        p.min_stock_level,
        p.is_active,
        p.created_at,
        p.supplier_id,
        s.name AS supplier_name,
        s.phone AS supplier_phone
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
    $vue$;

    EXECUTE $c$
      COMMENT ON VIEW products_with_supplier IS
        'Catalogue avec le fournisseur principal. Les produits sans fournisseur '
        'sont conservés. security_invoker : l''isolation vient de la RLS de '
        'products et suppliers, pas d''une vue qui la contournerait.'
    $c$;

    EXECUTE $g$ REVOKE ALL ON products_with_supplier FROM PUBLIC $g$;
    EXECUTE $g$ GRANT SELECT ON products_with_supplier TO authenticated $g$;
    EXECUTE $g$ GRANT SELECT ON products_with_supplier TO service_role $g$;
  END IF;
END;
$$;

-- La contrainte de stock non négatif survit au changement de type, mais on la
-- recrée proprement : ALTER COLUMN TYPE réécrit la table et une contrainte
-- NOT VALID peut ne plus être garantie.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_qty_non_negative;
ALTER TABLE products ADD CONSTRAINT products_stock_qty_non_negative
  CHECK (stock_qty >= 0) NOT VALID;


-- ─── 3. create_sale() accepte les fractions ───────────────
-- Le motif passe de `^[0-9]+$` à une décimale optionnelle. Point ou virgule :
-- un clavier de téléphone au Bénin saisit « 1,2 » aussi souvent que « 1.2 ».
-- La virgule est remplacée avant conversion, sinon (e->>'quantity')::numeric
-- échoue sur « 1,2 » et la vente est refusée pour une raison invisible.
--
-- Borne haute : 1 000 000. Un ticket à plus d'un million d'unités est une
-- saisie erronée, pas une vente.
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
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
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  -- 'credit' est accepté ici mais n'est pas un encaissement : la vente est
  -- créée, le stock part, et c'est record_credit_sale() qui la marque non
  -- encaissée et rattache le téléphone. Sans ce filet, un appel direct avec
  -- 'credit' produirait une vente comptée comme encaissée sans dette derrière.
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
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
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
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
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    v_est_plat := EXISTS (
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
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    UPDATE organizations
       SET invoice_counter = invoice_counter + 1
     WHERE id = v_owner
    RETURNING invoice_counter INTO v_counter;

    v_invoice := 'FAC-' || to_char(now(), 'YYYY') || '-' || lpad(v_counter::text, 5, '0');
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
    amount_received
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice,
    CASE WHEN p_payment_method = 'credit' THEN 0 ELSE v_total END
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
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

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON COLUMN products.unit IS
  'Unité de vente : pce, kg, L, botte, sachet, tabla. Affichage seulement — '
  'la quantité reste un nombre dans cette unité. Un produit vendu en sachet et '
  'au kilo doit être deux produits.';

-- ============================================================
--  ⬇ migration_credit.sql
-- ============================================================

-- ============================================================
-- CRÉDIT CLIENT — le carnet de dette
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   « Je te dois 5 000, tu me paieras au prochain marché » représente une part
--   considérable du chiffre d'affaires d'une boutique de quartier. Aujourd'hui
--   create_sale() n'accepte que 'cash' et 'momo' : il n'y a aucune place pour une
--   dette, et le carnet papier reste la seule source de vérité. La caisse ne sait
--   rien de ce qu'elle a cédé, et ne peut pas le réclamer.
--
-- LE CHOIX COMPTABLE — RECETTE À L'ENCAISSEMENT
--   Une vente à crédit N'ENTRE PAS dans le chiffre d'affaires tant qu'elle n'est
--   pas réglée. C'est la solution prudente : un chiffre d'affaires gonflé par
--   des dettes qu'on ne recouvrera pas donne une fausse lecture de la santé du
--   commerce — et l'écran « Charges » calcule un résultat net à partir de ce
--   chiffre. Un commerçant qui accorde 200 000 F de crédit se verrait ruiner sur
--   le papier.
--
--   Conséquence assumée : les dettes apparaissent nulle part dans les rapports.
--   Elles ont leur propre écran, qui est le bon endroit pour les suivre.
--
--   Le STOCK, lui, part immédiatement. La marchandise quitte la boutique, et
--   Prévisions doit savoir qu'elle n'est plus là — sinon il recommandera de
--   commander du stock déjà cédé.
--
-- CE QUI DISTINGUE LE STOCK DE L'ARGENT
--   `sales.settled` sépare les deux : FALSE = les unités sont parties, l'argent
--   n'est pas rentré. Les rapports de CA et de marge filtrent sur settled = true ;
--   les quantités vendues comptent toutes, car c'est un fait physique.
--
-- ⚠ DEFAULT TRUE, et c'est volontaire : toutes les ventes existantes sont cash
--   ou MoMo, donc encaissées. Sans ce défaut, le changement de colonne ferait
--   disparaître tout l'historique du chiffre d'affaires.
-- ============================================================

-- ─── 1. Vente encaissée ou non ─────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS settled boolean NOT NULL DEFAULT true;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS client_phone text;

COMMENT ON COLUMN sales.settled IS
  'FALSE = vente à crédit : le stock est parti, l''argent n''est pas rentré. '
  'Les rapports de chiffre d''affaires et de marge ne comptent que settled = true. '
  'Défaut TRUE : les ventes cash et MoMo sont encaissées par nature.';

-- Un numéro de téléphone est l'identité réelle d'un client d'informel — le nom
-- change, « Maman Koffi » se mariera. La dette s'y rattache.
--
-- NOT VALID : la contrainte ne vérifie que les lignes neuves. Les ventes cash et
-- MoMo existantes ont settled = true, donc la colonne client_phone reste NULL
-- pour toutes — les valider retroactivement n'aurait aucun sens.
--
-- DROP préalable : une contrainte s'ajoute avec ALTER TABLE ADD CONSTRAINT, qui
-- n'a pas de IF NOT EXISTS. Sans ce DROP, la seconde exécution échoue en
-- 42710 et interrompt le script.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_credit_needs_phone;
ALTER TABLE sales ADD CONSTRAINT sales_credit_needs_phone
  CHECK (settled OR client_phone IS NOT NULL) NOT VALID;

-- Index partiel : seules les ventes à crédit portent un numéro, et c'est
-- ~10 % des lignes sur un commerce qui prête.
CREATE INDEX IF NOT EXISTS idx_sales_credit
  ON sales(user_id, created_at DESC) WHERE NOT settled;

CREATE INDEX IF NOT EXISTS idx_sales_settled
  ON sales(user_id, settled, created_at DESC);


-- ─── 2. Les dettes ─────────────────────────────────────────

-- Un numéro par boutique : deux fiches pour le même numéro scinderait la dette
-- en deux et le commerçant croirait avoir deux débiteurs.
CREATE TABLE IF NOT EXISTS customer_debts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  name        text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer_debts_phone_unique UNIQUE (user_id, phone),
  -- Le stock de chiffres suffit : la comparaison se fait sur la forme, pas sur
  -- le format. '+229 97 00 00 00' et '22997000000' désignent le même client.
  CONSTRAINT customer_debts_phone_digits CHECK (phone ~ '^[0-9]{8,15}$')
);

ALTER TABLE customer_debts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "debts_read" ON customer_debts;
CREATE POLICY "debts_read" ON customer_debts
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_insert" ON customer_debts;
CREATE POLICY "debts_insert" ON customer_debts
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_update" ON customer_debts;
CREATE POLICY "debts_update" ON customer_debts
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_delete" ON customer_debts;
CREATE POLICY "debts_delete" ON customer_debts
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_customer_debts_user ON customer_debts(user_id);

DROP TRIGGER IF EXISTS customer_debts_updated_at ON customer_debts;
CREATE TRIGGER customer_debts_updated_at
  BEFORE UPDATE ON customer_debts
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();


-- ─── 3. Les versements ────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id    uuid NOT NULL REFERENCES customer_debts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount     numeric(12,2) NOT NULL,
  day        date NOT NULL,
  method     text NOT NULL DEFAULT 'cash',
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT credit_payments_method_valid   CHECK (method IN ('cash', 'momo'))
);

ALTER TABLE credit_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_read" ON credit_payments;
CREATE POLICY "payments_read" ON credit_payments
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "payments_insert" ON credit_payments;
CREATE POLICY "payments_insert" ON credit_payments
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

-- Suppression interdite : effacer un versement ferait réapparaître une dette
-- déjà encaissée. On ne corrige que par un nouveau versement.
DROP POLICY IF EXISTS "payments_delete" ON credit_payments;
CREATE POLICY "payments_delete" ON credit_payments
  FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS idx_credit_payments_debt ON credit_payments(debt_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_credit_payments_user ON credit_payments(user_id, day DESC);

-- ============================================================
--  ⬇ migration_partial_payment.sql
-- ============================================================

-- ============================================================
-- ACOMPTE — le client paie une partie, reste devoir l'autre
-- À exécuter dans Supabase SQL Editor
--
-- LE MANQUE
--   « Laisse-moi 50 000 sur 130 000, je passe demain » est le geste le plus
--   courant d'une boutique de quartier — plus courant que le crédit total. Or le
--   choix « Crédit » signifiait 100 % à découvert : impossible d'enregistrer un
--   acompte. Le commerçant devait soit tout encaisser (et inventer un montant),
--   soit tout laisser à découvert (et laisser le client avec plus de dette que
--   ce qu'il doit). Aucune des deux ne décrit la réalité.
--
-- LA RÈGLE
--   Une seule colonne decide de tout : sales.amount_received, ce qui est
--   RÉELLEMENT rentré. Le chiffre d'affaires vaut SUM(amount_received), point.
--   Il n'existe plus aucun filtre « vente encaissée ou non » dans les rapports :
--   un rapport en base de caisse n'a pas besoin de savoir si une vente est
--   soldée, seulement ce qu'elle a rapporté.
--
--   Pour une vente espèces ou MoMo, amount_received = total_amount : le client
--   a payé, la monnaie a été rendue, le net encaissé est bien le prix. Pour un
--   crédit sans acompte, 0. Pour un crédit avec acompte, l'acompte.
--
--   La dette d'un client devient alors triviale et juste par construction :
--
--     reste dû = SUM(total_amount - amount_received) sur ses ventes non soldées
--
--   C'est vrai par définition, sans soustraire un journal de versements dont la
--   répartition sur les ventes n'était pas tracée. Les versements restent
--   enregistré dans credit_payments — c'est l'historique, la date, le moyen de
--   paiement — mais plus l'état de la dette.
--
-- ⚠ DEFAULT 0 puis remplissage : la colonne ne doit pas valoir total_amount par
--   défaut, sinon la recette à l'encaissement disparaît d'un coup. Le remplissage
--   est fait juste après, vente par vente, FIFO compris.
-- ============================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS amount_received numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN sales.amount_received IS
  'Ce qui est réellement rentré pour cette vente. Le chiffre d''affaires vaut '
  'SUM(amount_received) sur la periode : c''est de la base de caisse, donc la '
  'caisse et le chiffre d''affaires ne peuvent pas diverger. Égal à '
  'total_amount pour une vente espèces ou MoMo. Pour un crédit, l''acompte puis '
  'les versements, dans cet ordre.';


-- ─── Remplissage des ventes déjà enregistrées ──────────────
-- Le cas n'est pas théorique : une boutique en essai a déjà des ventes. Sans
-- remplissage, une vente espèces ancienne vaudrait 0 encaissé et disparaîtrait
-- du chiffre d'affaires.
--
-- Les ventes cash et MoMo sont intégralement encaissées par nature : c'est
-- exact, pas une approximation. Les ventes à crédit soldées l'étaient par le
-- FIFO de migration_credit_fns.sql : leur montant a été couvert.
--
-- Les ventes à crédit ouvertes sont plus délicates : des versements ont pu être
-- enregistrés pour ce client sans que leur répartition sur ses ventes ait été
-- tracée — l'ancienne version de pay_customer_debt() déduisait la dette d'un
-- cumul, sans garder la trace de ce qui couvrait quoi. On reconstitue donc la
-- répartition en FIFO, avec exactement la même règle que la fonction. C'est la
-- seule écriture compatible : sinon le solde affiché au commerçant changerait du
-- jour au lendemain, le pire moment pour perdre sa confiance.
--
-- ⚠ La boucle porte sur un client, puis sur ses ventes. L'inverse n'est pas
--   possible : référencer v_sale dans la requête qui remplit le curseur v_sale
--   est interdit — « record v_sale is not assigned yet ». Deux boucles
--   imbriquées, parce qu'il faut un reliquat par client.
DO $$
DECLARE
  v_client  record;
  v_sale    record;
  v_restant numeric(12,2);
  v_montant numeric(12,2);
BEGIN
  -- Ventes cash et MoMo : intégralement encaissées.
  UPDATE sales
     SET amount_received = total_amount
   WHERE payment_method IN ('cash', 'momo');

  -- Ventes à crédit déjà soldées : couvertes.
  UPDATE sales
     SET amount_received = total_amount
   WHERE payment_method = 'credit' AND settled;

  -- Ventes à crédit ouvertes : on redistribue les versements, client par client.
  --
  -- Le test sur credit_payments évite un plantage sur une base neuve, où la
  -- table n'existe pas encore et où il n'y a de toute façon rien à
  -- redistribuer.
  IF to_regclass('public.credit_payments') IS NULL THEN
    RETURN;
  END IF;

  FOR v_client IN
    SELECT DISTINCT user_id, client_phone
      FROM sales
     WHERE payment_method = 'credit'
       AND NOT settled
       AND client_phone IS NOT NULL
  LOOP
    -- Tout ce que ce client a versé, tous droits confondus.
    v_restant := COALESCE(
      (SELECT SUM(cp.amount)
         FROM credit_payments cp
         JOIN customer_debts d ON d.id = cp.debt_id
        WHERE d.user_id = v_client.user_id
          AND d.phone = v_client.client_phone), 0);

    FOR v_sale IN
      SELECT s.id, s.total_amount
        FROM sales s
       WHERE s.user_id = v_client.user_id
         AND s.client_phone = v_client.client_phone
         AND NOT s.settled
       ORDER BY s.created_at ASC
    LOOP
      EXIT WHEN v_restant <= 0;

      v_montant := LEAST(v_restant, v_sale.total_amount);

      -- On ne marque pas settled ici. Le soldage est le travail de
      -- pay_customer_debt(), et le faire aussi ici créerait deux endroits qui
      -- décident de la même chose — dont un qui s'exécute une fois, à la
      -- migration, et ne se rejouera jamais.
      UPDATE sales SET amount_received = v_montant WHERE id = v_sale.id;
      v_restant := v_restant - v_montant;
    END LOOP;
  END LOOP;
END;
$$;

-- Contrôle d'intégrité : une vente ne peut pas avoir reçu plus que son prix.
-- Un bug de répartition se verrait ici immédiatement, plutôt que dans un
-- chiffre d'affaires faux trois mois plus tard.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_amount_received_sane;
ALTER TABLE sales ADD CONSTRAINT sales_amount_received_sane
  CHECK (amount_received >= 0 AND amount_received <= total_amount);


-- ─── Le défaut qui rend la colonne infalsifiable ───────────
-- Une vente espèces porte DEFAULT 0 sur amount_received, parce que c'est la
-- seule valeur correcte pour un crédit. Mais une insertion directe en SQL —
-- import, script de reprise, migration future, un test — ne passe pas par
-- create_sale(), et laisserait donc amount_received à 0 sur une vente
-- entièrement payée. Conséquence : une vente de 20 000 F qui disparaît du
-- chiffre d'affaires sans lever la moindre erreur, et la caisse ne tombe plus
-- d'accord avec le rapport.
--
-- Le trigger referme la faille sans changer le défaut : si la vente n'est pas à
-- crédit et que rien n'a été renseigné, ce qui est rentré ne peut être que le
-- prix. create_sale() continue d'écrire la colonne explicitement, donc il n'y a
-- pas de double règle — le trigger ne rattrape que ce qui a été oublié.
--
-- ⚠ Un trigger de ce type ne peut pas être « après coup » : il doit être
--   AVANT INSERT. Et il ne touche pas au crédit, dont le montant dépend de
--   l'acompte versé — seul record_credit_sale() sait de combien il est.
--
-- La fonction est créée AVANT le trigger : PostgreSQL ne vérifie pas l'existence
-- de la fonction au CREATE TRIGGER, il échoue seulement à la première insertion.
-- Sur une base neuve, la migration se termine donc « avec succès » et la
-- première vente échoue — l'erreur la plus différée et la plus coûteuse.
CREATE OR REPLACE FUNCTION fill_amount_received()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Vente à crédit : la valeur par défaut 0 est la bonne. Ne rien faire, et
  -- surtout ne pas deviner — un acompte est une information, pas une
  -- déduction.
  IF NEW.payment_method = 'credit' THEN
    RETURN NEW;
  END IF;

  -- Le total peut être NULL sur une insertion partielle, d'où le COALESCE.
  IF COALESCE(NEW.amount_received, 0) = 0 THEN
    NEW.amount_received := COALESCE(NEW.total_amount, 0);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fill_amount_received() IS
  'Renseigne amount_received sur une vente non crédit si elle a été omise. '
  'Sans ce trigger, une insertion directe en SQL laisserait une vente payée à 0 '
  'et la ferait disparaître du chiffre d''affaires sans erreur. Le crédit est '
  'laissé à 0 : seul record_credit_sale() connaît l''acompte.';

DROP TRIGGER IF EXISTS sales_fill_amount_received ON sales;
CREATE TRIGGER sales_fill_amount_received
  BEFORE INSERT ON sales
  FOR EACH ROW
  EXECUTE FUNCTION fill_amount_received();

-- ============================================================
--  ⬇ migration_profitability.sql
-- ============================================================

-- ============================================================
-- MIGRATION PRODUITS ARCHIVÉS + MARGE — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_roles.sql
--
-- 1. Archivage : la suppression définitive d'un produit est impossible dès
--    qu'il a été vendu (sale_items.product_id et stock_logs.product_id
--    référencent products sans ON DELETE CASCADE). Le message d'erreur
--    proposait « désactivez-le », mais aucune colonne n'existait : le chemin
--    était un cul-de-sac. Un produit vendu était donc immortel.
--
-- 2. Coût au moment de la vente : la marge n'était calculable qu'en
--    recoupant le prix d'achat actuel par nom de produit — donc fausse dès
--    qu'un prix changeait. On fige le coût dans sale_items.
-- ============================================================

-- ─── 1. Archivage des produits ─────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Un produit ne peut être archivé que s'il n'a jamais été vendu : sinon on
-- perdrait la cohérence de l'historique.
CREATE OR REPLACE FUNCTION archive_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner  uuid := get_business_owner_id();
  v_sold   integer;
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_sold FROM sale_items WHERE product_id = p_product_id;
  IF v_sold > 0 THEN
    RAISE EXCEPTION 'Impossible d''archiver : ce produit apparaît dans % vente(s). '
      'Mettez son stock à 0 et renommez-le « % (épuisé) ».', v_sold,
      (SELECT name FROM products WHERE id = p_product_id)
      USING ERRCODE = '23503';
  END IF;

  UPDATE products
     SET is_active = false, archived_at = now()
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

-- Restauration (l'UI d'archivage n'existe pas encore, mais la porte reste ouverte).
CREATE OR REPLACE FUNCTION restore_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  UPDATE products
     SET is_active = true, archived_at = NULL
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION archive_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_product(uuid) TO authenticated;
REVOKE ALL ON FUNCTION restore_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_product(uuid) TO authenticated;

-- ─── 2. Coût figé au moment de la vente ────────────────────
-- Sans ce snapshot, la marge d'hier se recalculait avec le prix d'achat
-- d'aujourd'hui : silencieusement fausse.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_id_archived uuid;

-- Remplissage rétroactif des lignes existantes.
UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = si.product_id
  FROM products p
 WHERE p.id = si.product_id AND si.unit_cost IS NULL;

-- Empêche de modifier un coût après coup (traçabilité comptable).
CREATE OR REPLACE FUNCTION freeze_sale_item_cost()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.unit_cost IS DISTINCT FROM NEW.unit_cost
     AND OLD.sale_id IS NOT NULL THEN
    RAISE EXCEPTION 'Le coût au moment de la vente est figé (produit %, vente %)',
      OLD.product_name, OLD.sale_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 3. Rentabilité par produit ───────────────────────────
--
-- Fonction et non vue : une VUE PostgREST s'exécute avec les droits de son
-- propriétaire et contourne la RLS de products. Filtrer explicitement par
-- get_business_owner_id() serait le remède, mais cela casse dès qu'aucun
-- utilisateur n'est résolu (clé service role : auth.uid() est NULL, vue vide),
-- et oblige à dupliquer la règle de tenancy.
--
-- Une fonction SECURITY INVOKER s'exécute avec les droits de l'appelant :
-- PostgREST applique donc les policies RLS de products et de sale_items, qui
-- gèrent déjà l'isolation. Aucun filtre à maintenir ici.
--
-- ⚠ DROP avant CREATE : la signature de retour a changé (avg_sold_price,
--   discount_given, units_sold_at_loss pour le prix négocié). PostgreSQL refuse
--   en 42P13 de remplacer une fonction dont le type de retour diffère — les
--   paramètres OUT font partie de la signature. Le DROP doit précéder, sinon
--   le script s'interrompt et le reste de la migration n'est pas appliqué.
DROP FUNCTION IF EXISTS get_product_profitability();

CREATE FUNCTION get_product_profitability()
RETURNS TABLE (
  id                 uuid,
  name               text,
  category           text,
  unit_cost          numeric(12,2),
  unit_price         numeric(12,2),
  stock_qty          integer,
  units_sold         bigint,
  revenue            numeric,
  cost_of_goods      numeric,
  gross_profit       numeric,
  margin_pct         numeric,
  -- Prix moyen réellement encaissé. Diffère de unit_price (catalogue courant)
  -- dès qu'une vente a été négociée : c'est ce prix-là qui a rapporté.
  avg_sold_price     numeric(12,2),
  -- Total concédé sur le produit, en FCFA.
  discount_given     numeric,
  -- Volume vendu sous le prix d'achat, en unités. Non nul = du stock écoulé
  -- à perte, ce qu'un commerçant doit voir sans que la vente soit bloquée.
  units_sold_at_loss bigint,
  -- Montant cédé à crédit et non encore encaissé, sur ce produit. N'entre pas
  -- dans revenue ni gross_profit : la recette à l'encaissement est le choix
  -- prudent, sinon un commerçant qui prête verrait son chiffre d'affaires
  -- gonflé par une dette qu'il ne recouvrera peut-être jamais.
  unsettled_credit numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.name,
    p.category,
    COALESCE(p.price_buy, 0)                     AS unit_cost,
    p.price_sell                                 AS unit_price,
    p.stock_qty,
    -- FAIT PHYSIQUE : tout ce qui est sorti, y compris cédé à crédit. Prévisions
    -- s'en sert pour estimer la rotation, et la marchandise est bien partie.
    COALESCE(SUM(si.quantity), 0)                AS units_sold,
    -- FAIT FINANCIER : ce qui est réellement rentré, au prorata de l'acompte.
    --
    -- Une vente de 130 000 dont 50 000 sont versés compte pour 50 000. Pas
    -- 130 000 (le commerçant n'a pas encaissé le reste) ni 0 (il a bien reçu
    -- 50 000, sa caisse ne peut pas être en désaccord avec son chiffre
    -- d'affaires). C'est de la base de caisse, appliquée ligne par ligne.
    --
    -- Le ratio est NULLIF sur total_amount : une vente gratuite — prix 0 —
    -- donnerait une division par zéro, et ferait échouer toute la requête.
    -- COALESCE le ramène à 0, ce qui est correct : rien n'a été encaissé.
    COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS revenue,
    -- Le coût suit la même clé. Reconnaître la recette sans son coût donnerait
    -- une marge qui monte à chaque vente à crédit, ce qui est l'inverse de la
    -- réalité : le coût de la marchandise est engagé dès qu'elle sort.
    COALESCE(SUM(si.unit_cost * si.quantity * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS cost_of_goods,
    COALESCE(SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS gross_profit,
    -- Le taux de marge est insensible au prorata : le ratio s'annule. Une vente
    -- à moitié encaissée affiche donc le VRAI taux de marge du produit, et non un
    -- taux dégradé par un encaissement partiel. C'est ce qu'un commerçant veut
    -- savoir : « sur ce produit, je gagne combien ».
    CASE
      WHEN COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0) > 0
        THEN ROUND(
          100 * SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 1)
      ELSE NULL
    END                                          AS margin_pct,
    -- Prix moyen RÉALISÉ par unité : chiffre d'affaires encaissé divisé par
    -- quantité vendue. Sur une vente à moitié payée, c'est la moitié du prix
    -- catalogue — c'est ce que le client a réellement payé pour ces unités.
    CASE
      WHEN COALESCE(SUM(si.quantity), 0) > 0
        THEN ROUND(
          SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.quantity), 2)
      ELSE NULL
    END                                          AS avg_sold_price,
    -- list_price est NULL sur les ventes antérieures au prix négocié : on
    -- traite l'absence comme « pas de remise » plutôt que de fausser l'écart.
    COALESCE(SUM(
      (COALESCE(si.list_price, si.unit_price) - si.unit_price) * si.quantity
    ), 0)                                        AS discount_given,
    COALESCE(SUM(si.quantity) FILTER (
      WHERE si.unit_cost IS NOT NULL AND si.unit_price < si.unit_cost
    ), 0)                                        AS units_sold_at_loss,
    -- Informatif : ce qui reste dû sur ce produit. N'entre dans aucun total.
    --
    -- ⚠ La parenthèse de SUM se ferme AVANT le FILTER : c'est SUM(expr) FILTER
    --   (WHERE ...), pas SUM(expr FILTER (WHERE ...)). La seconde forme est un
    --   « syntax error at or near "FILTER" » sans indication de ligne, et le
    --   message ne dit rien de la parenthèse mal placée. Compter les parenthèses ne suffit
    --   pas : elles sont équilibrées dans les deux écritures.
    COALESCE(SUM(si.subtotal * (1 - COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)))
                 FILTER (WHERE NOT s.settled), 0) AS unsettled_credit
  FROM products p
  LEFT JOIN sale_items si ON si.product_id = p.id
  -- La jointure sur sales est nécessaire pour lire amount_received. LEFT JOIN
  -- et non INNER : les produits sans vente doivent apparaître avec des zéros.
  LEFT JOIN sales s ON s.id = si.sale_id
  -- VERROU DE PLAN. Le cadenas du menu ne protège rien : cette fonction est
  -- appelable directement en RPC, et l'appel ne respecte aucun plan côté
  -- client. Sans cette condition, un client en plan gratuit obtient sa
  -- rentabilité — prix d'achat, prix de vente, marge unitaire — en appelant
  -- depuis la console du navigateur. Il paie 0 F ce qui vaut 3 000 F/mois.
  --
  -- `SELECT true FROM require_feature('reports')` renvoie true si le plan
  -- suffit, et lève une exception sinon. require_feature est VOLATILE, donc le
  -- planificateur ne peut pas l'écarter ni la calculer une fois pour toutes.
  -- Voir migration_plan_gate.sql.
  WHERE p.is_active
    AND (SELECT true FROM require_feature('reports'))
  -- Les produits archivés restent hors du tableau de bord : leur historique
  -- est conservé en base, ils ne sont plus pilotés.
  GROUP BY p.id, p.name, p.category, p.price_buy, p.price_sell, p.stock_qty;
$$;

COMMENT ON FUNCTION get_product_profitability() IS
  'Rentabilité par produit. L''isolation repose sur la RLS de products (SECURITY INVOKER). '
  'sale_items.unit_cost, figé au moment de la vente, fait foi pour l''historique.';

REVOKE ALL ON FUNCTION get_product_profitability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO authenticated;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO service_role;

-- ============================================================
--  ⬇ migration_expenses.sql
-- ============================================================

-- ============================================================
-- MIGRATION DÉPENSES — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_profitability.sql
--
-- Le chiffre d'affaires ne prouve rien : 457 000 FCFA de CA peuvent
-- correspondre à un commerce déficitaire si le loyer, les salaires et
-- l'électricité ne sont pas saisis. Ce module enregistre les charges et
-- calcule le résultat net.
--
--   1. expense_categories — plan de comptes par organisation
--   2. expenses           — les charges
--   3. get_cash_flow()    — résultat par jour
--
-- Choix : le jour d'une dépense est calculé par le client et stocké en
-- `date`. Les ventes restent horodatées en timestamptz et sont ramenées au
-- jour via le fuseau de l'organisation. C'est le seul endroit où les deux
-- representations coexistent ; get_cash_flow() fait la conversion.
-- ============================================================

-- ─── 1. Plan de comptes ────────────────────────────────────
-- Par organisation, et non global : deux boutiques n'ont pas les mêmes
-- charges, et une catégorie partagée exposerait le nom des comptes de l'une
-- à l'autre via les policies.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  icon       text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expense_categories_org_name_key UNIQUE (user_id, name)
);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

-- Séparée par organisation : chaque boutique voit son seul plan de comptes.
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
CREATE POLICY "expense_categories_read" ON expense_categories
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
CREATE POLICY "expense_categories_write" ON expense_categories
  FOR ALL USING (can_manage_products() AND user_id = get_business_owner_id())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

-- Jeu de comptes par défaut, créé à la première visite du module.
--
-- Aucun paramètre : le tenant est résolu par get_business_owner_id(), comme
-- partout ailleurs. Une signature exposant p_owner permettrait à un client
-- d'appeler le seed pour l'organisation d'un autre.
--
-- ON CONFLICT DO NOTHING porte sur (user_id, name) : rejouer la migration
-- ou revenir dans l'application ne duplique rien.
CREATE OR REPLACE FUNCTION seed_expense_categories()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  INSERT INTO expense_categories (user_id, name, icon, sort_order) VALUES
    (v_owner, 'Loyer',            'building', 10),
    (v_owner, 'Salaires',         'users',    20),
    (v_owner, 'Électricité',      'zap',      30),
    (v_owner, 'Eau',              'droplet',  40),
    (v_owner, 'Transport',        'truck',    50),
    (v_owner, 'Communication',    'wifi',     60),
    (v_owner, 'Fournitures',      'package',  70),
    (v_owner, 'Entretien',        'tool',     80),
    (v_owner, 'Impôts et taxes',  'receipt',  90),
    (v_owner, 'Crédit bancaire',  'credit-card', 100),
    (v_owner, 'Autre',            'dots',     999)
  ON CONFLICT (user_id, name) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION seed_expense_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO service_role;

-- ─── 2. Les dépenses ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category   text NOT NULL,
  label      text NOT NULL,               -- ex : « Loyer janvier »
  amount     numeric(12,2) NOT NULL,
  day        date NOT NULL,               -- date locale de la boutique
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Une charge négative fausserait le résultat net.
  CONSTRAINT expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT expenses_label_not_blank CHECK (length(btrim(label)) > 0)
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- Lecture : tout le tenant, comme les ventes.
DROP POLICY IF EXISTS "expenses_read" ON expenses;
DROP POLICY IF EXISTS "expenses_read" ON expenses;
CREATE POLICY "expenses_read" ON expenses
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue.
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
CREATE POLICY "expenses_insert" ON expenses
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
CREATE POLICY "expenses_update" ON expenses
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_delete" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;
CREATE POLICY "expenses_delete" ON expenses
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_expenses_user_day     ON expenses(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_id, category);

-- ─── 3. Résultat journalier ────────────────────────────────
-- SECURITY INVOKER : l'isolation vient de la RLS de sales et expenses.
-- Aucune règle de tenancy dupliquée.
-- get_cash_flow() est redéfinie plus loin, avec un type de retour différent :
-- PostgreSQL refuse « cannot change return type of existing function » sur un
-- CREATE OR REPLACE. Le DROP rend ce fichier rejouable sur une base qui porte
-- déjà la version corrigée de la section 8 de migration_security.sql — version
-- que le harnais rétablit en fin de rejouabilité.
DROP FUNCTION IF EXISTS get_cash_flow(date, date);

CREATE OR REPLACE FUNCTION get_cash_flow(p_from date, p_to date)
RETURNS TABLE (
  day          date,
  revenue      numeric,
  expenses     numeric,
  net          numeric,
  transactions bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    -- Fuseau de l'organisation, avec repli sur celui du pays si absent.
    SELECT COALESCE(
             (SELECT o.timezone FROM organizations o
               WHERE o.id = get_business_owner_id()),
             'Africa/Porto-Novo'
           ) AS tz
  ),
  sales_by_day AS (
    SELECT
      (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date AS d,
      -- Base de caisse, sans exception : le chiffre d'affaires est ce qui est
      -- réellement rentré, et amount_received est la seule colonne qui le sait.
      -- Une vente espèces vaut son prix, une vente à crédit vaut son acompte,
      -- et un règlement encaissé aujourd'hui sur une vente d'hier est
      -- imputé... à la date de la vente, pas à celle du versement.
      --
      -- Ce dernier point est un choix, et il faut le dire : le résultat net est
      -- rattaché à la journée où la vente a eu lieu, même si l'argent est rentré
      -- trois semaines plus tard. Rattacher au jour du versement donnerait un
      -- résultat net qui bouge le jour où le client paie, sur une journée où
      -- aucune vente n'a été faite — impossible à lire pour un commerçant, et
      -- sans rapport avec ce que sa caisse contient réellement.
      SUM(s.amount_received) AS revenue,
      COUNT(*)              AS tx
    FROM sales s
    WHERE (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date
          BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  expenses_by_day AS (
    SELECT x.day AS d, SUM(x.amount) AS spent
    FROM expenses x
    WHERE x.day BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT
    COALESCE(s.d, x.d)                                AS day,
    COALESCE(s.revenue, 0)                            AS revenue,
    COALESCE(x.spent, 0)                              AS expenses,
    COALESCE(s.revenue, 0) - COALESCE(x.spent, 0)     AS net,
    COALESCE(s.tx, 0)                                 AS transactions
  FROM sales_by_day s
  FULL OUTER JOIN expenses_by_day x ON s.d = x.d
  -- VERROU DE PLAN. Même raison que get_product_profitability() : l'appel RPC
  -- contourne le cadenas du menu. Ici, ce que le client gratuit lirait est le
  -- résultat net par jour — exactement ce qui se trouve au bas de la page
  -- « Charges », la ligne que le plan vend.
  -- require_feature est VOLATILE : elle ne peut être ni écartée ni mise en
  -- cache par le planificateur. FULL OUTER JOIN produit toujours au moins une
  -- ligne, donc le garde est toujours atteint.
  WHERE (SELECT true FROM require_feature('reports'))
  ORDER BY 1;
$$;

COMMENT ON FUNCTION get_cash_flow(date, date) IS
  'Résultat journalier : CA − charges. L''isolation vient de la RLS de sales '
  'et expenses (SECURITY INVOKER). Repli sur Africa/Porto-Novo si la timezone '
  'de l''organisation est absente.';

REVOKE ALL ON FUNCTION get_cash_flow(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO service_role;

-- ─── 4. Signature obsolète ─────────────────────────────────
-- La version initiale de cette migration exposait
-- seed_expense_categories(p_owner uuid). PostgREST ne la faisait pas
-- correspondre à un appel sans argument (« Could not find the function … without
-- parameters »). Elle est remplacée ci-dessus ; on retire l'ancienne pour ne
-- pas laisser deux fonctions au même nom.
DROP FUNCTION IF EXISTS seed_expense_categories(uuid);

-- ============================================================
--  ⬇ migration_invitations.sql
-- ============================================================

-- ============================================================
-- MIGRATION INVITATIONS — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_expenses.sql
--
-- L'ajout d'un employé demandait au patron d'inventer un mot de passe et de
-- le transmettre par un canal non chiffré (WhatsApp, papier). C'est le chemin
-- le plus probable pour qu'un accès client soit compromis, et cela suppose
-- aussi que le commerce possède déjà une boîte mail.
--
-- On remplace ceflux par une invitation :
--
--   1. Le patron saisit l'email, reçoit un lien à transmettre
--   2. L'employé ouvre le lien, choisit son propre mot de passe
--   3. redeem_invitation() lie le compte à la boutique, de façon atomique
--
-- Le jeton ne transite jamais par l'API en clair après la création : il est
-- stocké tel quel, comme un secret à usage unique. La table est par ailleurs
-- inaccessible au client (RLS + RLS du patron), donc seul le service_role la
-- lit.
-- ============================================================

-- ─── 1. Les invitations ────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager')),
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employee_invitations_email_lower CHECK (email = lower(btrim(email))),
  CONSTRAINT employee_invitations_token_len   CHECK (length(token) >= 32)
);

ALTER TABLE employee_invitations ENABLE ROW LEVEL SECURITY;

-- Le patron voit et gère ses invitations. Un employé n'en a pas : get_business_owner_id()
-- renverrait son patron, il pourrait donc lire les invitations de la boutique
-- et s'inviter lui-même. On vérifie explicitement qu'il est le patron.
DROP POLICY IF EXISTS "invitations_owner_read" ON employee_invitations;
DROP POLICY IF EXISTS "invitations_owner_read" ON employee_invitations;
CREATE POLICY "invitations_owner_read" ON employee_invitations
  FOR SELECT USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "invitations_owner_write" ON employee_invitations;
DROP POLICY IF EXISTS "invitations_owner_write" ON employee_invitations;
CREATE POLICY "invitations_owner_write" ON employee_invitations
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Index sur owner_id : le patron liste ses invitations à chaque affichage.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_owner
  ON employee_invitations(owner_id, created_at DESC);

-- ─── 2. Remboursement atomique ──────────────────────────────
-- L'employé s'inscrit depuis un lien ; cette fonction consume l'invitation et
-- crée le lien de membre en une transaction. FOR UPDATE sérialise deux
-- usages simultanés du même lien : le second reçoit "déjà utilisée" au lieu de
-- créer un second membre.
--
-- SECURITY DEFINER est nécessaire : l'appelant n'est pas encore membre de la
-- équipe, donc la policy member_view_own ne lui accorde rien. La fonction
-- est révoquée au public et accordée au service_role, qui est le seul à
-- l'appeler (la route d'acceptation, via la clé service role).
CREATE OR REPLACE FUNCTION redeem_invitation(
  p_token       text,
  p_member_id   uuid,
  p_member_name text
)
RETURNS TABLE (owner_id uuid, email text, member_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv employee_invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv
    FROM employee_invitations
    WHERE token = p_token
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette invitation est introuvable ou a été révoquée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette invitation a déjà été utilisée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Cette invitation a expiré. Demandez un nouveau lien à votre patron.'
      USING ERRCODE = 'P0002';
  END IF;

  -- L'email saisi doit être celui invité : sinon un lien peut être intercepté
  -- et réutilisé pour s'attribuer la boutique.
  -- La colonne est qualifiée : « email » seul serait ambigu entre auth.users et
  -- la table RETURNS (owner_id, email, member_name).
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = p_member_id
      AND lower(btrim(u.email)) = v_inv.email
  ) THEN
    RAISE EXCEPTION 'Ce lien invite uniquement %', v_inv.email
      USING ERRCODE = 'P0002';
  END IF;

  IF length(btrim(p_member_name)) = 0 THEN
    RAISE EXCEPTION 'Le nom est obligatoire.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO business_members (owner_id, member_id, member_name, role)
  SELECT v_inv.owner_id, p_member_id, btrim(p_member_name), v_inv.role
  WHERE NOT EXISTS (
    SELECT 1 FROM business_members x
    WHERE x.owner_id = v_inv.owner_id AND x.member_id = p_member_id
  );

  UPDATE employee_invitations ei SET accepted_at = now() WHERE ei.id = v_inv.id;

  RETURN QUERY SELECT v_inv.owner_id, v_inv.email, btrim(p_member_name);
END;
$$;

REVOKE ALL ON FUNCTION redeem_invitation(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_invitation(text, uuid, text) TO service_role;

COMMENT ON FUNCTION redeem_invitation(text, uuid, text) IS
  'Consomme une invitation et lie le compte à la boutique. Vérifie que le compte '
  'correspond à l''email invité, refuse une invitation déjà utilisée ou expirée. '
  'Appelée uniquement par le service_role.';

COMMENT ON TABLE employee_invitations IS
  'Invitations d''équipe en attente. Le jeton est un secret à usage unique, '
  'expirant après 7 jours ; il est transmis au patron pour un envoi WhatsApp '
  'ou tout autre canal, jamais par email.';

-- ─── 3. Nettoyage ───────────────────────────────────────────
-- Les invitations acceptées ne servent plus à rien. Sans cette étape la table
-- grossit indéfiniment et conserve des emails d'employés partis.
-- Le token étant consommé et l'email de l'employé devenu inutile, la suppression est sans
-- risque : l'invitation n'a plus de valeur d'accès.
--
-- À appeler périodiquement (pg_cron côté Supabase, ou à la main) :
--
--   SELECT purge_accepted_invitations();
--
CREATE OR REPLACE FUNCTION purge_accepted_invitations(p_days int DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM employee_invitations
    WHERE accepted_at IS NOT NULL
      AND accepted_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_accepted_invitations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_accepted_invitations(int) TO service_role;

-- ============================================================
--  ⬇ migration_profitability_fix.sql
-- ============================================================

-- ============================================================
-- CORRECTIF MARGE — create_sale() ne figeait pas le coût
-- À exécuter dans Supabase SQL Editor
--
-- SYMPTÔME
--   Rapports → Rentabilité affiche « coût des marchandises 0 F », une marge
--   brute égale au chiffre d'affaires, un taux de 100 % et un tiret « — »
--   dans la colonne % de chaque produit.
--
-- CAUSE
--   sale_items.unit_cost est à NULL sur toutes les ventes.
--
--   L'ordre d'application des migrations masque le problème :
--     · migration_sales_rpc.sql     définit create_sale()
--     · migration_profitability.sql AJOUTE la colonne unit_cost, remplit
--                                  l'existant, et pose un trigger qui interdit
--                                  de la modifier ensuite
--
--   La deuxième migration ne redéfinit pas create_sale(). Or la version de
--   create_sale() déployée à l'époque écrivait déjà invoice_number mais pas
--   encore unit_cost. Chaque vente depuis lors a donc inséré une ligne sans
--   coût — et le trigger de figeage a ensuite interdit toute correction, ce
--   qui est le comportement voulu pour une comptabilité mais masque ici un
--   déploiement incomplet.
--
--   Ce n'est pas une erreur de saisie : un produit sans prix d'achat donnerait
--   0, jamais NULL. Le NULL prouve que la colonne n'était pas fournie.
--
-- CORRECTIF — deux parties
--   1. Ce fichier : remplir unit_cost des lignes existantes, puis recréer le
--      trigger de figeage.
--   2. migration_sales_rpc.sql, à réappliquer juste après : il redéfinit
--      create_sale() pour qu'il fige désormais le coût.
--
-- ⚠ L'étape 1 utilise le prix d'achat d'AUJOURD'HUI, pas celui du jour de la
--   vente : le historique devient approximatif. Acceptable pour des ventes de
--   test du jour. Sur une boutique avec de l'antériorité, il faut ressaisir
--   les coûts historiques.
-- ============================================================

-- ─── 1. Remplissage des coûts manquants ───────────────────
-- Le trigger interdit toute modification d'un coût déjà figé ; il refuse donc
-- aussi le remplissage des lignes vides. On le retire, on remplit, on le recrée.

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;

UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = COALESCE(si.product_id_archived, si.product_id)
  FROM products p
 WHERE p.id = si.product_id
   AND si.unit_cost IS NULL;

-- Un produit supprimé (archivé puis retiré du catalogue) ne laisse plus de
-- ligne à rejoindre : sa vente historique reste sans coût, donc comptée à
-- 100 % de marge. Le signaler vaut mieux qu'un zéro silencieux.
--
-- SELECT p.name, count(*) AS ventes_sans_cout
--   FROM sale_items si
--   LEFT JOIN products p ON p.id = si.product_id
--  WHERE si.unit_cost IS NULL
--  GROUP BY p.name;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 2. create_sale() doit de nouveau figer le coût ───────
-- Réappliquez migration_sales_rpc.sql juste après ce fichier. Il est
-- idempotent (CREATE OR REPLACE partout) et redéfinit create_sale() avec
-- l'insertion de unit_cost qui manquait à la version déployée.
--
-- Vérification après coup :
--
--   SELECT count(*) FILTER (WHERE unit_cost IS NULL) AS sans_cout,
--          count(*) AS total
--     FROM sale_items;

-- ============================================================
--  ⬇ migration_suppliers.sql
-- ============================================================

-- ============================================================
-- MIGRATION FOURNISSEURS — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_profitability_fix.sql
--
-- Où s'en fournisseurs trouve-t-il sa valeur, dans un marché où l'informel
-- domine ? Trois usages concrets, par ordre d'importance :
--
--   1. Retrouver le prix. Un commerçant qui achète à un grossiste de Cokhan
--      veut savoir où il s'est fourni le mois dernier et à quel prix. Sans
--      fournisseur, products.price_buy est écrasé à chaque nouveau prix et
--      l'historique d'achat disparaît.
--
--   2. Savoir qui appeler quand un stock baisse. Prévisions → rupture
--      indique « commander », mais pas « auprès de qui ».
--
--   3. Évaluer la dépendance. Un commerce dont 80 % du chiffre d'affaires
--      vient d'un seul fournisseur est en danger ; l'application ne peut pas
--      le dire aujourd'hui.
--
-- ⚠ Ce que ce n'est PAS : ni un registre de conformité MECeF/DGI, ni une
--   comptabilité fournisseurs. Aucun montant d'achat, aucune échéance, aucun
--   règlement n'est enregistré ici. Pour l'informel, le relevé de prix et le
--   carnet suffisent ; une facture normalisée reste le vrai chantier, et il
--   est traité séparément.
--
-- Choix : un fournisseur par produit, et non une table de liaison.
-- Un article a un fournisseur principal ; le prix d'achat est unique dans
-- products. Une table de liaison supposerait plusieurs prix d'achat
-- simultanés, que le modèle ne sait pas représenter. Si un jour un même
-- article arrive à deux prix selon le fournisseur, c'est deux articles.
-- ============================================================

-- ─── 1. Les fournisseurs ──────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  address     text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Un fournisseur porte un nom : « Adresse email invalide » dans ce champ
  -- déplacerait la faute vers une donnée de contact.
  CONSTRAINT suppliers_name_not_blank CHECK (length(btrim(name)) > 0)
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

-- Par organisation, comme le plan de comptes des charges. Deux boutiques
-- n'ont pas les mêmes grossistes, et un catalogue partagé exposerait l'un à
-- l'autre via les policies.
DROP POLICY IF EXISTS "suppliers_read" ON suppliers;
DROP POLICY IF EXISTS "suppliers_read" ON suppliers;
CREATE POLICY "suppliers_read" ON suppliers
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue produits.
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;
DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;
CREATE POLICY "suppliers_delete" ON suppliers
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_suppliers_user_name ON suppliers(user_id, name);

-- La liste des fournisseurs est affichée par ordre alphabétique à chaque
-- ouverture du formulaire produit : l'index couvre ce tri.
-- DROP avant CREATE : sans lui, la seconde exécution échoue en 42710
-- « trigger already exists », ce qui interromp le script en cours de route.
DROP TRIGGER IF EXISTS suppliers_updated_at ON suppliers;
CREATE TRIGGER suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();

-- ─── 2. Rattachement du produit ────────────────────────────
-- ON DELETE SET NULL, et non CASCADE : supprimer un fournisseur ne doit pas
-- supprimer les articles qui en dépendent. Le produit perd son fournisseur et
-- garde son prix d'achat, son stock et son historique de ventes.
--
-- C'est le même arbitrage que l'archivage produit : dans un commerce réel,
-- on ne supprime pas un fournisseur, on l'oublie. La suppression reste
-- possible depuis l'écran Fournisseurs, avec confirmation explicite.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

-- Index partiel : seuls les articles rattachés sont indexés, ce qui reste
-- négligeable sur un catalogue de quelques milliers.
CREATE INDEX IF NOT EXISTS idx_products_supplier
  ON products(supplier_id) WHERE supplier_id IS NOT NULL;

-- ─── 3. Un fournisseur ne peut pas être volé d'une autre boutique ─
-- La RLS de products vérifie user_id = get_business_owner_id() : elle protège
-- le PRODUIT, jamais le fournisseur auquel il est rattaché. Un patron pouvait
-- donc écrire l'identifiant d'un fournisseur d'une autre boutique dans sa
-- colonne supplier_id — la contrainte de clé étrangère l'accepte, puisque
-- l'identifiant existe bien.
--
-- Ce n'est pas une question de propreté : la vue products_with_supplier fait
-- un LEFT JOIN, et la jointure rattacherait alors ce fournisseur à l'écran. La
-- RLS de suppliers masque le nom (ligne invisible, valeur NULL), mais le
-- principe d'isolation est rompu et l'UUID se devine par force brute.
--
-- Une contrainte CHECK ne peut pas consulter une autre table ; seul un trigger
-- le peut. SECURITY DEFINER parce que l'appelant n'a pas à lire suppliers.
CREATE OR REPLACE FUNCTION check_product_supplier_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supplier_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM suppliers s
        WHERE s.id = NEW.supplier_id
          AND s.user_id = NEW.user_id
     ) THEN
    RAISE EXCEPTION 'Ce fournisseur n''appartient pas à votre boutique'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION check_product_supplier_tenant() FROM PUBLIC;

DROP TRIGGER IF EXISTS products_supplier_same_tenant ON products;
CREATE TRIGGER products_supplier_same_tenant
  BEFORE INSERT OR UPDATE OF supplier_id ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_supplier_tenant();

-- ─── 4. Vue : articles et fournisseur d'un coup ───────────
-- Évite au formulaire produit deux requêtes et un raccordement manuel. Les
-- produits sans fournisseur sont conservés (LEFT JOIN) : ils sont la majorité
-- au démarrage, et les filtrer les ferait disparaître.
--
-- SECURITY INVOKER : l'isolation vient de la RLS de products et suppliers.
-- Une vue en SECURITY DEFINER contournerait les policies et exposerait le
-- catalogue d'un autre tenant — c'est précisément ce qu'on a déjà corrigé
-- pour la rentabilité.
CREATE OR REPLACE VIEW products_with_supplier
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.sku,
  p.category,
  p.price_buy,
  p.price_sell,
  p.stock_qty,
  p.min_stock_level,
  p.is_active,
  p.created_at,
  p.supplier_id,
  s.name AS supplier_name,
  s.phone AS supplier_phone
FROM products p
LEFT JOIN suppliers s ON s.id = p.supplier_id;

COMMENT ON VIEW products_with_supplier IS
  'Catalogue avec le fournisseur principal. Les produits sans fournisseur sont '
  'conservés. security_invoker : l''isolation vient de la RLS de products et '
  'suppliers, pas d''une vue qui la contournerait.';

REVOKE ALL ON products_with_supplier FROM PUBLIC;
GRANT SELECT ON products_with_supplier TO authenticated;
GRANT SELECT ON products_with_supplier TO service_role;

-- ─── 5. Diagnostic ────────────────────────────────────────
-- Vérifier que le trigger a bien été créé une seule fois :
--
--   SELECT count(*) AS triggers
--     FROM pg_trigger WHERE tgname = 'suppliers_updated_at';

-- ============================================================
--  ⬇ migration_credit_fns.sql
-- ============================================================

-- ============================================================
-- CRÉDIT CLIENT — fonctions
-- À exécuter après migration_credit.sql
--
-- Trois opérations :
--   1. record_credit_sale()  — une vente à crédit et sa fiche client
--   2. pay_customer_debt()   — un encaissement, soldant les ventes par ordre
--                              d'ancienneté
--   3. get_customer_debts()  — le solde par client
--
-- L'ordre d'ancienneté est le bon ordre en informel : la dette la plus vieille
-- est celle qu'il faut relancer en premier, et le commerçant ne raisonne pas
-- par vente mais par « ce qu'il me doit au total ».
-- ============================================================

-- ─── 1. Normaliser un numéro ──────────────────────────────
-- '+229 97 00 00 00', '22997000000' et '97000000' désignent le même client.
-- Sans cela, « +229 97… » et « 97… » créeraient deux dettes distinctes pour une
-- seule personne, et le commerçant croirait avoir deux débiteurs.
--
-- IMMUTABLE et sans accès table : accordable au client, qui normalise avant
-- d'envoyer, sans aller-retour réseau à chaque saisie.
CREATE OR REPLACE FUNCTION normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits text;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  -- 8 chiffres = numéro local béninois, on préfixe l'indicatif pays.
  IF length(v_digits) = 8 THEN
    v_digits := '229' || v_digits;
  END IF;

  IF length(v_digits) < 8 OR length(v_digits) > 15 THEN
    RETURN NULL;
  END IF;

  RETURN v_digits;
END;
$$;

REVOKE ALL ON FUNCTION normalize_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO service_role;


-- ─── 2. Enregistrer une vente à crédit ────────────────────
-- Séparée de create_sale() volontairement : la vente à crédit a des contraintes
-- propres — téléphone obligatoire, pas de recette immédiate — et les mélanger
-- dans une fonction déjà surchargée rendrait les deux chemins illisibles.
--
-- La vente passe par create_sale() avec payment_method = 'credit', puis on
-- marque settled = false. Le stock est donc décrémenté exactement comme pour
-- une vente cash : la marchandise est partie.
--
-- p_advance est l'acompte : ce que le client donne sur-le-champ. Laissé vide ou
-- à 0, c'est un crédit total — le comportement d'origine. C'est le cas le plus
-- courant en boutique de quartier : « donne-moi 50 000, je passe demain ».
--
-- L'acompte est enregistré comme un versement dans credit_payments, avec la
-- date du jour. C'est ce qui permet de dire au client, sur WhatsApp ou au
-- comptoir, « tu as déjà payé 50 000 » sans que personne ait à recalculer. Il ne
-- sert PAS à calculer la dette : celle-ci se lit dans amount_received.
--
-- SECURITY DEFINER : l'appelant n'est pas encore connu de la boutique, et
-- create_sale() l'est déjà.
CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items        jsonb,
  p_client_name  text,
  p_client_phone text,
  p_note         text DEFAULT NULL,
  p_advance      numeric(12,2) DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_phone   text;
  v_sale    jsonb;
  v_sale_id uuid;
  v_debt_id uuid;
  v_total   numeric(12,2);
  v_name    text;
  v_avance  numeric(12,2);
  v_du      numeric(12,2);
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF btrim(COALESCE(p_client_name, '')) = '' THEN
    RAISE EXCEPTION 'Indiquez le nom du client' USING ERRCODE = '22023';
  END IF;

  v_phone := normalize_phone(p_client_phone);
  IF v_phone IS NULL THEN
    -- Sans numéro, la dette n'est rattachable à personne et la relance WhatsApp
    -- devient impossible. On refuse plutôt que d'accepter une dette orpheline
    -- qu'on ne pourra pas suivre.
    RAISE EXCEPTION 'Le numéro de téléphone est obligatoire pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  -- Un acompte négatif serait un remboursement, et un remboursement est un
  -- autre geste : il se fait sur l'écran Dettes, pas en cassant la vente. Un
  -- acompte supérieur au prix, de même — c'est un trop-perçu, pas un acompte.
  v_avance := round(COALESCE(p_advance, 0), 2);
  IF v_avance < 0 THEN
    RAISE EXCEPTION 'L''avance versée ne peut pas être négative' USING ERRCODE = '22023';
  END IF;

  -- Le nom va avec la vente : c'est ce que le commerçant voit sur son reçu, même
  -- si le client change ensuite de nom d'enregistrement.
  v_name := btrim(p_client_name);

  -- create_sale() fait le travail lourd : atomicité, stock, coût figé, prix
  -- négocié. On passe par lui plutôt que de dupliquer.
  --
  -- credit.internal lève le garde-fou qui refuse 'credit' : sans lui,
  -- create_sale() ne pourrait pas être appelé avec ce moyen de paiement. Le GUC
  -- est remis à NULL juste après — la transaction l'annulerait de toute façon,
  -- mais le laisser posé ferait passer une vente à crédit encodée en dur pour un
  -- appel direct suivant, dans la même session.
  PERFORM set_config('credit.internal', '1', true);
  v_sale := create_sale(p_items, 'credit', v_name, p_note);
  PERFORM set_config('credit.internal', NULL, true);
  v_sale_id := (v_sale->>'id')::uuid;
  v_total := (v_sale->>'total_amount')::numeric(12,2);

  IF v_avance > v_total THEN
    RAISE EXCEPTION
      'L''avance versée (% F) dépasse le prix de la vente (% F)', v_avance, v_total
      USING ERRCODE = '22023';
  END IF;

  -- amount_received porte ce qui est réellement rentré : c'est la seule colonne
  -- qui décide du chiffre d'affaires. settled reste dérivé — il ne sert plus
  -- qu'à l'indexation des dettes en cours.
  UPDATE sales
     SET amount_received = v_avance,
         settled = (v_avance >= v_total),
         client_phone = v_phone
   WHERE id = v_sale_id;

  -- Fiche client créée à la première dette, réutilisée ensuite. ON CONFLICT DO
  -- UPDATE garde le nom à jour : « Maman Koffi » devient « Mme Koffi ».
  INSERT INTO customer_debts (user_id, phone, name)
  VALUES (v_owner, v_phone, v_name)
  ON CONFLICT (user_id, phone) DO UPDATE
    SET name = EXCLUDED.name,
        updated_at = now();

  SELECT id INTO v_debt_id
    FROM customer_debts
   WHERE user_id = v_owner AND phone = v_phone;

  -- L'acompte entre aussi dans l'historique des versements. Pas pour calculer la
  -- dette — ça, c'est amount_received — mais pour que la question « il m'a déjà
  -- donné combien ? » ait une réponse datée, avec son moyen de paiement. C'est
  -- aussi ce que l'écran Dettes affiche en « versements », et ce qu'un client
  -- conteste éventuellement.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note)
    VALUES (v_debt_id, v_owner, v_avance, current_date, 'cash',
            'Acompte versé à la vente');
  END IF;

  v_du := v_total - v_avance;

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'total_amount',    v_total,
    -- Reste à recouvrer, renvoyé pour que l'écran n'ait pas à le recalculer et
    -- risquer un arrondi différent de celui de la base.
    'amount_advance',  v_avance,
    'amount_due',      v_du,
    'invoice_number',  v_sale->>'invoice_number',
    'debt_id',         v_debt_id,
    'client_phone',    v_phone
  );
END;
$$;

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO service_role;

-- L'ancienne version à quatre arguments est retirée. CREATE OR REPLACE ajoute
-- bien le paramètre p_advance, mais sur une base où la version à quatre
-- arguments a déjà été créée, celle-ci reste : PostgREST la verrait et
-- mapperait l'appel sur l'ancienne, sans l'acompte. Deux fonctions de même nom
-- et d'arités différentes, c'est le piège qui rend les erreurs illisibles.
DROP FUNCTION IF EXISTS record_credit_sale(jsonb, text, text, text);

COMMENT ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) IS
  'Vente à crédit. p_advance est l''acompte versé sur-le-champ : laissé vide ou '
  'à 0, c''est un crédit total. L''acompte compte au chiffre d''affaires le jour '
  'même et réduit d''autant la dette. Le stock part dans tous les cas.';


-- ─── 3. Encaisser un versement ────────────────────────────
-- Solde les ventes les plus anciennes d'abord. Un règlement partiel est la
-- norme : « je te paye 3 000 sur les 8 000 ».
--
-- L'algorithme est volontairement simple : on parcourt les ventes non soldées par
-- ancienneté, et on rembourse chacune du reliquat de trésorerie. Ce qui reste à
-- la fin est la dette. Une version plus savante répartirait au prorata, mais le
-- commerçant ne raisonne pas en tantimes de ventes — il veut « ce qui reste ».
--
-- Le surplus va au crédit du client : il n'est ni perdu ni compté en recette. Le
-- commerce l'inscrit en dette fournisseur, qui est une autre fonctionnalité.
--
-- SECURITY DEFINER : le solde croise sales et credit_payments sur le numéro de
-- téléphone, ce qu'aucune policy RLS ne peut exprimer.
CREATE OR REPLACE FUNCTION pay_customer_debt(
  p_debt_id uuid,
  p_amount  numeric(12,2),
  p_method  text DEFAULT 'cash',
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner        uuid;
  v_phone        text;
  v_user_id      uuid;
  v_restant      numeric(12,2);
  v_avant        numeric(12,2);
  -- Ce qui manque sur la vente en cours de traitement. Différent de v_restant,
  -- qui est le reliquat de trésorerie : les deux se confondent vite, et les
  -- confondre ferait solder une vente par de l'argent destiné à une autre.
  v_du           numeric(12,2);
  v_reglees      int := 0;
  v_sale         record;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- Sans FOR UPDATE explicite ici, deux caisses encaissant en même temps
  -- pourraient toutes deux solder la même vente. Verrou de ligne sur la fiche.
  SELECT phone, user_id INTO v_phone, v_user_id
    FROM customer_debts
   WHERE id = p_debt_id
   FOR UPDATE;

  IF NOT FOUND OR v_user_id <> v_owner THEN
    -- Message identique à « introuvable » : un patron ne doit pas pouvoir
    -- deviner l'existence d'une fiche d'un autre tenant.
    RAISE EXCEPTION 'Client introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant de versement invalide' USING ERRCODE = '22023';
  END IF;

  IF p_method IS NULL OR p_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_method USING ERRCODE = '22023';
  END IF;

  -- Solde avant versement : ce qui manque sur les ventes ouvertes de ce client.
  -- Une simple somme de Differences, juste par construction. La version
  -- précédente soustrayait un cumul de versements d'un cumul de prix, et
  -- reconstituait la répartition dans la boucle — deux calculs à tenir d'accord,
  -- donc une occasion de diverger. Ici il n'y a rien à reconstituer.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_avant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  IF v_avant <= 0 THEN
    RAISE EXCEPTION 'Ce client n''a pas de dette en cours' USING ERRCODE = '22023';
  END IF;

  INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note)
  VALUES (p_debt_id, v_owner, p_amount, current_date, p_method,
          NULLIF(btrim(COALESCE(p_note, '')), ''));

  -- Répartit le versement sur les ventes ouvertes, de la plus ancienne à la plus
  -- récente. Chaque vente reçoit ce qui lui manque, pas plus.
  --
  -- On boucle sur un curseur simple, sans FOR UPDATE : le verrou utile est posé
  -- sur la fiche client plus haut, ce qui sérialise deux caisses encaissant pour
  -- le même client. Verrouiller aussi chaque ligne ici n'apporte rien et, dans un
  -- FOR ... LOOP PL/pgSQL, n'itère pas sur la snapshot attendue.
  --
  -- Le reliquat porte aussi les acomptes déjà versés à la vente : c'est
  -- amount_received qui dit ce qui a été couvert, pas le montant de ce versement.
  -- C'est ce qui rend le calcul insensible à l'ordre des appels — deux versements
  -- de 8 000 puis 12 000 soldent une vente de 20 000, comme un seul de 20 000.
  v_restant := p_amount;

  FOR v_sale IN
    SELECT s.id, s.total_amount, s.amount_received
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_phone = v_phone
       AND NOT s.settled
     ORDER BY s.created_at ASC
  LOOP
    EXIT WHEN v_restant <= 0;

    -- Ce qui manque sur CETTE vente, l'acompte éventuel étant déjà déduit.
    v_du := v_sale.total_amount - v_sale.amount_received;

    IF v_restant >= v_du THEN
      UPDATE sales
         SET amount_received = total_amount,
             settled = true
       WHERE id = v_sale.id;
      v_restant := v_restant - v_du;
      v_reglees := v_reglees + 1;
    ELSE
      -- Paiement partiel : la vente reste ouverte, et ce reliquat devient du
      -- chiffre d'affaires encaissé dès aujourd'hui.
      UPDATE sales SET amount_received = amount_received + v_restant WHERE id = v_sale.id;
      v_restant := 0;
    END IF;
  END LOOP;

  -- Solde final : ce qui n'a pas couvert une vente entière reste dû.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_restant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  UPDATE customer_debts SET updated_at = now() WHERE id = p_debt_id;

  RETURN jsonb_build_object(
    'debt_id',        p_debt_id,
    'amount_paid',    p_amount,
    'balance_before', v_avant,
    'balance_after',  GREATEST(v_restant, 0),
    'sales_settled',  v_reglees
  );
END;
$$;

REVOKE ALL ON FUNCTION pay_customer_debt(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay_customer_debt(uuid, numeric, text, text) TO authenticated;


-- ─── 4. Les soldes ────────────────────────────────────────
-- Fonction plutôt que vue : le solde se lit dans sales.amount_received, et une
-- vue SECURITY DEFINER contournerait la RLS de sales.
-- SECURITY INVOKER : l'isolation vient de la RLS de sales et customer_debts.
--
-- Le solde est une somme de différences : ce qui manque sur chaque vente ouverte.
-- Les versements n'y entrent pas. C'est la conséquence directe de l'acompte — si
-- le prix est 130 000, l'acompte 50 000 et le reste 80 000, la dette est 80 000
-- parce que amount_received vaut 50 000, pas parce qu'on a soustrait 50 000 d'un
-- journal. Un seul calcul, aucune répartition à reconstituer.
--
-- ⚠ DROP avant CREATE, et c'est obligatoire : ajouter total_paid au RETURNS
--   TABLE change le type de retour. Les paramètres OUT font partie de la
--   signature, donc PostgreSQL refuse en 42P13 « cannot change return type of
--   existing function » et interrompt le script AU MILIEU — les GRANT et les
--   COMMENT qui suivent ne sont jamais appliqués, et la fonction reste celle
--   d'avant. C'est l'erreur 42P13 déjà documentée dans le README, rencontrée
--   une fois de plus parce que le piège est réel et non théorique.
DROP FUNCTION IF EXISTS get_customer_debts();

CREATE FUNCTION get_customer_debts()
RETURNS TABLE (
  debt_id         uuid,
  phone           text,
  name            text,
  total_due       numeric,
  last_sale_at    timestamptz,
  sales_count     bigint,
  oldest_sale_at  timestamptz,
  payments_count  bigint,
  last_payment_at date,
  -- Ce que le client a déjà versé sur ses ventes en cours. Affiché à côté du
  -- solde : « 130 000 dont 50 000 déjà payés » est plus parlant qu'un 80 000
  -- nu, et c'est la phrase à prononcer au comptoir.
  total_paid      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                 AS total_paid,
      COUNT(*)                               AS sales_count,
      MAX(s.created_at)                      AS last_sale_at,
      MIN(s.created_at)                      AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  ), soldes AS (
    SELECT
      d.id,
      d.user_id,
      d.phone,
      d.name,
      GREATEST(COALESCE(u.total_due, 0), 0) AS total_due,
      u.last_sale_at,
      COALESCE(u.sales_count, 0) AS sales_count,
      u.oldest_sale_at,
      COALESCE(u.total_paid, 0) AS total_paid,
      (SELECT COUNT(*) FROM credit_payments cp2 WHERE cp2.debt_id = d.id) AS payments_count,
      (SELECT MAX(cp3.day) FROM credit_payments cp3 WHERE cp3.debt_id = d.id) AS last_payment_at
    FROM customer_debts d
    LEFT JOIN dues u ON u.user_id = d.user_id AND u.client_phone = d.phone
  )
  SELECT s.id, s.phone, s.name, s.total_due, s.last_sale_at, s.sales_count,
         s.oldest_sale_at, s.payments_count, s.last_payment_at, s.total_paid
    FROM soldes s
   WHERE s.user_id = get_business_owner_id()
     -- VERROU DE PLAN. Le carnet de dette fait partie des rapports : c'est ce
     -- qui est vendu avec le plan Starter. Sans ce garde, un client en plan
     -- gratuit liste ses débiteurs en appelant la fonction en RPC, alors que le
     -- cadenas de l'onglet l'en empêche dans l'interface.
     --
     -- Le solde d'un client n'est pas une information anodine : c'est la liste
     -- des personnes qui doivent de l'argent à la boutique, avec leur numéro de
     -- téléphone. Le RLS protège le voisin, pas le plan.
     AND (SELECT true FROM require_feature('reports'))
     -- Une dette soldée n'a plus rien à réclamer. Sans ce critère, la fiche
     -- persiste et l'écran montre un client à 0 F comme s'il devait de l'argent.
     AND s.total_due > 0
   ORDER BY s.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION get_customer_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_customer_debts() TO authenticated;

COMMENT ON FUNCTION get_customer_debts() IS
  'Soldes débiteurs, du plus ancien au plus récent. Le solde est la somme de ce '
  'qui manque sur chaque vente ouverte (total_amount - amount_received), donc il '
  'intègre les acomptes versés à la vente. total_paid indique ce qui a déjà été '
  'versé sur ces ventes. Une dette soldée n''apparaît plus. Le client est '
  'identifié par son numéro de téléphone, pas par son nom.';

COMMENT ON FUNCTION pay_customer_debt(uuid, numeric, text, text) IS
  'Enregistre un versement et le répartit sur les ventes à crédit les plus '
  'anciennes d''abord. Un règlement partiel est la norme, et il devient du '
  'chiffre d''affaires encaissé dès le jour même. Le surplus reste au crédit du '
  'client : il n''est ni perdu ni compté en recette.';

-- ============================================================
--  ⬇ migration_beta_program.sql
-- ============================================================

-- ============================================================
-- PROGRAMME BÊTA — 10 comptes en accès complet
-- À exécuter dans Supabase SQL Editor
--
-- LE BESOIN
--   Tester en grandeur nature, avec des gens qui ne sont pas le développeur.
--   Dix amis s'inscrivent, ils ouvrent l'application, ils la cassent, et ils
--   disent ce qui manque. C'est le seul moyen de trouver les défauts qu'aucun
--   test automatique ne voit — un prix qui ne s'affiche pas sur un petit
--   écran, un libellé que personne ne comprend, un geste que la caissière ne
--   fait pas parce qu'il n'y est pas.
--
-- POURQUOI UN TRIGGER ET PAS L'APPLICATION
--   Trois chemins créent une organisation : /api/register, la page
--   /register en deux étapes, et l'onboarding de la page d'accueil. Les
--   modifier tous serait trois endroits à tenir d'accord, et le quatrième
--   chemin oublié donnerait un compte gratuit sans qu'on le voie.
--
--   Le trigger est le seul point par où passe toute création de boutique. Il
--   s'applique donc partout, y compris aux chemins qu'on n'a pas prévus, et il
--   ne demande aucune modification de l'application.
--
-- UNE PLACE, PAS UNE PROMESSE
--   Le programme est un budget de 10 places, pas un code d'accès. Il n'y a rien
--   à distribuer et donc rien à trouver : le 11e compte s'inscrit normalement,
--   en gratuit. Une fois les 10 pris, le programme est fermé et le comportement
--   redevient exactement celui d'une inscription normale.
--
--   Fermer définitivement :  SELECT close_beta_program();
--   Changer le nombre de places : UPDATE beta_program SET slots_total = 20;
--   Tout révoquer d'un coup : SELECT revoke_all_beta();
--
-- CE QUI N'EST PAS FAIT, ET POURQUOI
--   Pas de date d'expiration. Une date non appliquée par un trigger planifié
--   est pire qu'aucune date : on croit que l'accès s'arrêtera tout seul, et il
--   ne s'arrête pas. Le budget est fermé par une commande explicite, donc ce
--   qui est promis est ce qui se produit.
--
--   Pas d'accès « illimité » distinct. Un compte bêta est un compte Pro. Une
--   neuvième façon de dire « actif » serait une neuvième source de vérité.
-- ============================================================

-- ─── 1. Le budget ─────────────────────────────────────────
-- Une seule ligne, contrainte à l'identifiant 1 : il n'y a pas de deuxième
-- ligne à créée, donc pas d'état ambigu sur « combien de places restent ».
CREATE TABLE IF NOT EXISTS beta_program (
  id           int PRIMARY KEY DEFAULT 1,
  -- Modifiable à tout moment par un simple UPDATE. 10 par défaut, ce qui est la
  -- demande initiale.
  slots_total  int  NOT NULL DEFAULT 10,
  slots_used   int  NOT NULL DEFAULT 0,
  open         boolean NOT NULL DEFAULT true,
  -- Rappel de pourquoi le programme existe, et jusqu'à quand. Servira au moment
  -- de décider quoi faire des comptes bêta.
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT beta_program_singleton   CHECK (id = 1),
  CONSTRAINT beta_program_cap_positif CHECK (slots_total >= 0),
  -- L'invariant central : impossible d'avoir servi plus de places que le budget.
  -- Une inscription concurrente qui chercherait à dépasser le plafond violerait
  -- cette contrainte et la transaction entière serait annulée, plutôt que de
  -- laisser un onzième compte Pro.
  CONSTRAINT beta_program_dans_le_budget CHECK (slots_used >= 0 AND slots_used <= slots_total)
);

INSERT INTO beta_program (id, slots_total, note)
VALUES (1, 10, 'Dix comptes en accès Pro pour les tests en conditions réelles.')
ON CONFLICT (id) DO UPDATE
  SET note = EXCLUDED.note;
-- ⚠ ON CONFLICT ne touche PAS slots_used : rejouer la migration ne doit pas
--   réinitialiser le compteur, sinon une réapplication donnerait 10 places
--   neuves et le programme ne se fermerait jamais.


-- ─── 2. Qui a eu une place ────────────────────────────────
-- Pas seulement un journal : cette table est l'outil de travail du test. Les
-- colonnes de retour existent pour ça, sinon l'information se perd dans des
-- messages privés et ne sert à rien.
CREATE TABLE IF NOT EXISTS beta_access (
  user_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email      text,
  plan       text NOT NULL DEFAULT 'pro' CHECK (plan IN ('free', 'starter', 'pro')),
  granted_at timestamptz NOT NULL DEFAULT now(),

  -- Le matériau du debriefing, écrit au fil de l'eau.
  avis       text,   -- ce que la personne a dit, en ses mots
  bugs       text,   -- ce qui ne marche pas, avec la façon de reproduire
  manques    text,   -- ce qui manque, ce qu'elle aurait aimé avoir
  teste_le   date,

  CONSTRAINT beta_access_one_row_per_shop CHECK (user_id IS NOT NULL)
);

COMMENT ON TABLE beta_access IS
  'Comptes bêta et retours associés. Les colonnes avis / bugs / manques sont le '
  'point d''accumulation des retours de test : à remplir au fil des tests, puis '
  'à relire dans cet ordre pour décider quoi corriger.';

-- Aucune policy : ces tables sont des outils d'administration. Le trigger qui
-- écrit dedans est SECURITY DEFINER, donc il n'en a pas besoin, et le client
-- n'a rien à y voir. Un testeur ne doit pas pouvoir élargir son accès lui-même.
ALTER TABLE beta_program  ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_access   ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_program  FORCE ROW LEVEL SECURITY;
ALTER TABLE beta_access   FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_beta_access_granted ON beta_access(granted_at DESC);

-- ─── 3. L'attribution ─────────────────────────────────────
-- Le travail est partagé par deux triggers, et ce n'est pas un détail de style :
-- beta_access référence organizations, donc la ligne doit EXISTER avant d'y
-- écrire. Un seul trigger BEFORE — le plus naturel, puisque c'est lui qui
-- modifie NEW.plan — violerait la clé étrangère à chaque inscription, ce que
-- PostgreSQL refuse avec « insert or update on table beta_access violates
-- foreign key constraint ».
--
--   BEFORE INSERT  consomme une place et passe NEW.plan à 'pro'
--   AFTER  INSERT  enregistre la fiche, maintenant que la boutique existe
--
-- La décision est transmise par un GUC, remis à NULL dans tous les cas. Le motif
-- est le même que credit.internal dans create_sale() : un état de session, donc
-- non modifiable par un client SQL ordinaire, qui ne laisse rien entre deux
-- requêtes. Si le trigger AFTER levait une exception, l'INSERT entier serait
-- annulé — Trigger et transaction, donc aucune place consommée sans boutique.
--
-- Le point clé de la consommation : un UPDATE unique, gardé par une condition, et
-- non un SELECT suivi d'un UPDATE.
--
-- Deux inscriptions simultanées lisent toutes deux slots_used = 9 et se croient
-- toutes deux autorisées. Avec un seul UPDATE ... WHERE slots_used <
-- slots_total, PostgreSQL reverifie la condition apres avoir pris le verrou de
-- ligne : la seconde transaction voit slots_used = 10, ne modifie aucune ligne,
-- et l'INSERT ne consomme aucune place. C'est ce qui rend le plafond exact sous
-- concurrence, sans SERIALIZABLE ni reessai.
CREATE OR REPLACE FUNCTION beta_claim_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pris int;
BEGIN
  PERFORM set_config('beta.granted', '0', true);

  -- Programme fermé : on ne touche à rien.
  IF NOT EXISTS (SELECT 1 FROM beta_program WHERE id = 1 AND open) THEN
    RETURN NEW;
  END IF;

  UPDATE beta_program
     SET slots_used = slots_used + 1,
         updated_at = now()
   WHERE id = 1
     AND open
     AND slots_used < slots_total;

  GET DIAGNOSTICS v_pris = ROW_COUNT;

  -- Plus de place : la boutique est créée en gratuit, sans aucune trace. C'est
  -- le comportement normal d'une inscription, pas une erreur — le onzième ami
  -- doit pouvoir s'inscrire, simplement sans l'accès complet.
  IF v_pris = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('beta.granted', '1', true);
  NEW.plan := 'pro';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION beta_record_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email   text;
  v_accorde text;
BEGIN
  -- La décision est LUE avant d'être effacée. L'inverse — effacer puis lire —
  -- lirait toujours NULL, donc aucune fiche ne serait jamais écrite, et le
  -- programme accorderait l'accès sans rien enregistrer : le pire des deux
  -- mondes, puisque le plafond serait consommé sans que personne sache à qui.
  v_accorde := current_setting('beta.granted', true);
  PERFORM set_config('beta.granted', NULL, true);

  IF v_accorde IS DISTINCT FROM '1' THEN
    RETURN NULL;
  END IF;

  -- L'email est sur auth.users, pas sur organizations. Le sous-requête tolère son
  -- absence : une organisation créée hors du flux d'inscription (script,
  -- importation) reçoit une place sans email, ce qui reste identifiable par
  -- l'identifiant.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.id;

  INSERT INTO beta_access (user_id, email, plan)
  VALUES (NEW.id, v_email, 'pro')
  ON CONFLICT (user_id) DO UPDATE
    SET plan = EXCLUDED.plan;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION beta_claim_slot() IS
  'Consomme une place du budget bêta et passe la boutique en Pro. Sans quoi la '
  'boutique est créée en gratuit. L''attribution est atomique : sous '
  'concurrence, le plafond reste exact.';

COMMENT ON FUNCTION beta_record_access() IS
  'Enregistre la fiche bêta, après coup : beta_access référence organizations, la '
  'ligne doit donc exister avant. Ne fait rien si aucune place n''a été '
  'consommée par beta_claim_slot().';

DROP TRIGGER IF EXISTS trg_beta_claim_slot ON organizations;
CREATE TRIGGER trg_beta_claim_slot
  BEFORE INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_claim_slot();

DROP TRIGGER IF EXISTS trg_beta_record_access ON organizations;
CREATE TRIGGER trg_beta_record_access
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_record_access();

-- ─── 4. Commandes d'administration ────────────────────────
-- Ce que le propriétaire du projet executera. Elles sont en SQL et non dans
-- l'application : ce sont des decisions de gestion, pas des fonctionnalites.

-- Ferme le programme. Les comptes deja servis gardent leur acces : fermer
-- arrete les inscriptions, ca ne retire rien a ceux qui sont deja testes.
CREATE OR REPLACE FUNCTION close_beta_program()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET open = false,
         updated_at = now(),
         note = COALESCE(note, '') || ' — programme clos.'
   WHERE id = 1;
$$;

-- Rouvre, et ajuste le budget. Pratique pour une deuxieme vague de testeurs.
CREATE OR REPLACE FUNCTION set_beta_slots(p_total int)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET slots_total = p_total,
         open = true,
         updated_at = now()
   WHERE id = 1;
$$;

-- Retombe tout le monde en gratuit et vide le compteur. Le geste de fermeture
-- reelle : sans lui, dix boutiques Pro continueraient d'etre Pro indefiniment.
-- Les commentaires de retour sont conserves : ils sont le prix du test.
CREATE OR REPLACE FUNCTION revoke_all_beta()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE organizations o
     SET plan = 'free'
   WHERE o.id IN (SELECT user_id FROM beta_access);

  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE beta_access SET plan = 'free';
  UPDATE beta_program
     SET slots_used = 0,
         open = false,
         updated_at = now()
   WHERE id = 1;

  -- %s et non %d : le spécificateur « d » de format() n'est pas accepté par
  -- toutes les versions de PostgreSQL, et l'échec ici serait bien pire que la
  -- révision : une commande d'administration qui ne compile pas.
  RETURN format('%s boutique(s) repassée(s) en gratuit. Les retours sont conservés.', v_n::text);
END;
$$;

-- Etat du programme, en une ligne.
CREATE OR REPLACE FUNCTION beta_status()
RETURNS TABLE (
  open        boolean,
  slots_total int,
  slots_used  int,
  remaining   int,
  granted     bigint,
  note        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.open, b.slots_total, b.slots_used,
         GREATEST(b.slots_total - b.slots_used, 0),
         (SELECT count(*) FROM beta_access WHERE plan = 'pro'),
         b.note
    FROM beta_program b
   WHERE b.id = 1;
$$;

REVOKE ALL ON FUNCTION close_beta_program()   FROM PUBLIC;
REVOKE ALL ON FUNCTION set_beta_slots(int)    FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_all_beta()      FROM PUBLIC;
REVOKE ALL ON FUNCTION beta_status()          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION beta_status() TO service_role;

-- Les trois commandes d'ecriture restent reservees : elles se lancent depuis le
-- SQL Editor, ou le service role. Aucun client ne doit pouvoir fermer le
-- programme, ajouter des places, ni remettre dix boutiques en gratuit.
GRANT EXECUTE ON FUNCTION close_beta_program()   TO service_role;
GRANT EXECUTE ON FUNCTION set_beta_slots(int)    TO service_role;
GRANT EXECUTE ON FUNCTION revoke_all_beta()      TO service_role;

-- ============================================================
--  ⬇ migration_sales_summary.sql
-- ============================================================

-- ============================================================
-- MIGRATION : Synthèse des ventes
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Rapports et Historique additionnaient les ventes côté JavaScript : ils
-- téléchargeaient sales + sale_items(*) sur TOUTE la période demandée, puis
-- faisaient les comptes dans le navigateur.
--
-- Le rendu, lui, était déjà borné — 20 lignes par page sur l'historique, lots
-- de 50 sur les charges. Ce qui n'avait aucune borne, c'est le téléchargement.
--
--   free     30 jours
--   starter  365 jours
--   pro      Infinity      <- et le programme bêta donne l'accès complet
--
-- Sur pro, la requête grandit sans limite pendant toute la vie de la boutique,
-- et c'est précisément le cas des boutiques bêta.
--
-- Les agrégats PostgREST sont refusés sur ce projet (PGRST123 « Use of
-- aggregate functions is not allowed ») : aucun contournement possible sans
-- SQL.
--
-- Deux précautions, et aucune n'est cosmétique :
--
--   · Base de calcul. Les rapports additionnent sales.total_amount, le prix
--     de vente. get_cash_flow() additionne amount_received, l'argent
--     réellement entré — les crédits y valent leur acompte. Les deux sont
--     justes : ils ne mesurent pas la même chose. Réutiliser get_cash_flow()
--     aurait changé les chiffres affichés à l'écran.
--
--   · Fuseau. Le client calcule les jours avec new Date().getDate(), donc
--     dans LE FUSEAU DU NAVIGATEUR, alors que SQL calcule dans celui de la
--     session. Décaler d'une case, c'est décaler les barres du graphique.
--     Le fuseau passe donc en paramètre.
-- ============================================================


-- ─── 1. Synthèse journalière ──────────────────────────────
-- Une ligne par jour de vente, et non une seule ligne de période : le client
-- regroupe ensuite en jours/semaines/mois avec la même bucketKey() qu'avant,
-- donc la forme du graphique ne bouge pas.
CREATE OR REPLACE FUNCTION get_sales_summary(
  p_from date,
  p_to   date,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  day     date,
  revenue numeric,
  cash    numeric,
  momo    numeric,
  tx      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (s.created_at AT TIME ZONE p_tz)::date                       AS day,
    COALESCE(SUM(s.total_amount), 0)                             AS revenue,
    COALESCE(SUM(CASE WHEN s.payment_method = 'cash'
                      THEN s.total_amount ELSE 0 END), 0)        AS cash,
    COALESCE(SUM(CASE WHEN s.payment_method = 'momo'
                      THEN s.total_amount ELSE 0 END), 0)        AS momo,
    COUNT(*)                                                     AS tx
  FROM sales s
  -- Bornes exprimées en instants, pas en dates : une condition du type
  -- `(created_at AT TIME ZONE p_tz)::date BETWEEN` n'est pas sargable, elle
  -- forcerait Postgres à relire toute la table du client — on aurait déplacé
  -- le coût sans le supprimer. Ces deux bornes décrivent exactement la même
  -- période que le GROUP BY, transition d'heure d'été comprise.
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION get_sales_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO service_role;


-- ─── 2. Produits les plus vendus ──────────────────────────
-- Le top 6 par quantité, calculé sur sale_items : c'est ce que faisait
-- côte client `sort().slice(0, 6)` en parcourant toutes les lignes de vente.
CREATE OR REPLACE FUNCTION get_top_products(
  p_from  date,
  p_to    date,
  p_tz    text DEFAULT 'UTC',
  p_limit int  DEFAULT 6
)
RETURNS TABLE (
  product_name text,
  qty          numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT si.product_name,
         COALESCE(SUM(si.quantity), 0) AS qty
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY si.product_name
  -- Clé de départage : deux produits ex aequo affichaient un ordre arbitraire
  -- côté client, qui changeait d'un rendu à l'autre.
  ORDER BY COALESCE(SUM(si.quantity), 0) DESC, si.product_name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 100);
$$;

REVOKE ALL ON FUNCTION get_top_products(date, date, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO service_role;


-- Pas de garde de plan sur ces deux fonctions, contrairement à
-- get_cash_flow() : elles n'additionnent que des lignes que l'appelant peut
-- déjà SELECTer sous RLS. Le plafond de plan sur les rapports reste appliqué
-- à l'écran, comme il l'était avant — ajouter la garde ici couperait
-- l'historique des ventes aux comptes gratuits, qui n'ont jamais été privés
-- de leur propre total.
--
-- ─── Note sur les REVOKE ───────────────────────────────────
-- Ils ciblent `anon` explicitement, pas seulement PUBLIC, et ce n'est pas de
-- la prudence en l'air. Supabase pose des privilèges par défaut DIRECTS sur
-- anon, authenticated et service_role (ALTER DEFAULT PRIVILEGES) : le grant
-- ne vient pas de PUBLIC. `REVOKE ... FROM PUBLIC` seul y laisse donc la clé
-- anonyme parfaitement capable d'appeler la fonction — ce qui est exactement
-- ce qui est arrivé en production à 33 des 35 fonctions du schéma public,
-- malgré des REVOKE écrits partout dans les migrations. Vérifié en base le
-- 03/10/2026.

-- ============================================================
--  ⬇ migration_security.sql
-- ============================================================

-- ============================================================
-- MIGRATION : Durcissement sécurité
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Sept trous, du plus rapide au plus structurant :
--
--   1. rate_limits sans RLS      — le compteur d'inscription est effaçable
--                                   par n'importe quel client, clé anon en
--                                   main : `DELETE /rest/v1/rate_limits` et on
--                                   repasse à l'inscription illimitée.
--   2. organizations.plan libre  — n'importe quel client passe sa boutique en
--                                   Pro sans payer. current_org_plan(),
--                                   require_feature(), check_product_limit()
--                                   et la facturation Pro lisent tous cette
--                                   colonne.
--   3. subscriptions sans UNIQUE(org_id) — l'upsert du webhook échoue en
--                                   silence (supabase-js renvoie {error}, la
--                                   route ne le lit pas), le portail
--                                   abonnement répond 404 et un client Stripe
--                                   est recréé à chaque achat.
--   4. business_members FOR ALL  — un utilisateur peut rattacher un compte
--                                   arbitraire à son équipe : la victime voit
--                                   son tenant basculer chez l'attaquant.
--   5. sales / sale_items / stock_logs FOR ALL — créées sans clause FOR, donc
--                                   pour les quatre commandes. Un employé
--                                   pouvait UPDATE et DELETE les ventes de la
--                                   boutique, et le journal des stocks.
--   6. suppression de compte cassée — deux pannes de bout en bout relevées dans
--                                   les logs Auth : l'API renvoyait 500 sur
--                                   toute lecture d'utilisateur, et la
--                                   suppression d'un compte pourvu de ventes
--                                   échouait sur une FK.
--   7. la clé anon appelle tout   — Supabase accorde EXECUTE aux rôles anon,
--                                   authenticated et service_role au MOMENT DE
--                                   LA CRÉATION de chaque fonction
--                                   (ALTER DEFAULT PRIVILEGES). Le grant vient
--                                   du rôle, pas de PUBLIC : un
--                                   `REVOKE ... FROM PUBLIC`, écrit partout
--                                   dans les migrations, ne lui retire rien.
--                                   Constat en base le 03/10/2026 : 33 des 35
--                                   fonctions du schéma public répondaient à
--                                   la seule clé publique du navigateur, dont
--                                   20 en SECURITY DEFINER. Vérifié par appel
--                                   réel, la clé anonyme obtenait beta_status()
--                                   — réservée au service_role — et
--                                   close_beta_program(), SECURITY DEFINER
--                                   sans la moindre garde, aurait pu fermer le
--                                   programme bêta pour toutes les boutiques.
--
-- Le point 4 est refermé ici à deux niveaux (policy + trigger) et un troisième
-- dans l'application : la suppression du compte Auth en cascade n'est plus
-- appelée par /api/employees/[id].
--
-- Rejouable : IF NOT EXISTS / DROP … IF EXISTS / CREATE OR REPLACE partout.
-- Doit rester la DERNIÈRE migration du dossier supabase/ : c'est elle qui
-- ferme les failles ouvertes plus tôt, et les rejouer après l'aurait
-- taries.


-- ─── 1. rate_limits : hors portée du client ────────────────
-- bump_rate_limit() est SECURITY DEFINER et appartient au propriétaire de la
-- table. Sans FORCE, le propriétaire échappe à la RLS et la fonction continue
-- de tourner ; anon et authenticated, eux, se heurtent à l'absence totale de
-- policy — c'est le déni pur, pour SELECT comme pour DELETE.
--
-- FORCE ROW LEVEL SECURITY n'est volontairement PAS posée : elle soumettrait
-- aussi le propriétaire, donc bump_rate_limit() et purge_rate_limits(). Le
-- jour où le propriétaire de la table n'est plus le owner de la fonction, le
-- rate limit casserait — en silence, puisque l'appel est en fail-open.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Aucune policy n'est créée : c'est le principe. Le service role, qui a
-- BYPASSRLS, est le seul à y accéder — et il n'y accède que par les deux
-- fonctions ci-dessus.


-- ─── 2. organizations.plan : verrouillé hors Stripe ────────
-- Deux couches, parce qu'une seule peut disparaître :
--   • le trigger refuse toute MODIFICATION de plan venant du navigateur ;
--   • les privilèges interdisent même de NOMMER la colonne plan.
-- Les deux sont indépendants : rejouer une GRANT ALL (ce que fait le harnais
-- de test, et ce que fait Supabase à la création d'une table) ne défait pas le
-- trigger.
CREATE OR REPLACE FUNCTION organizations_reject_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Plan inchangé : on laisse passer updated_at, onboarding_done, name, etc.
  IF NEW.plan IS NOT DISTINCT FROM OLD.plan THEN
    RETURN NEW;
  END IF;

  -- Deux rôles légitimes modifient le plan :
  --   • service_role — le webhook Stripe, seul détenteur du vrai plan ;
  --   • le rôle de l'éditeur SQL (postgres, supabase_admin) — vous, avec
  --     TEST_ACTIVER_PRO.sql ou close_beta_program().
  -- anon et authenticated sont les deux seuls rôles atteignables depuis le
  -- navigateur : PostgREST n'en autorise pas d'autre avec la clé anon. C'est
  -- donc une liste de négation, et non d'autorisation — le rôle exact de
  -- l'éditeur SQL varie selon les projets Supabase, une liste blanche le
  -- casserait sans prévenir.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Le plan ne peut être modifié que par le paiement Stripe.'
    USING ERRCODE = '42501',
          HINT = 'Passez par le portail abonnement dans Paramètres, ou par TEST_ACTIVER_PRO.sql côté SQL Editor.';
END;
$$;

DROP TRIGGER IF EXISTS organizations_plan_guard ON organizations;
CREATE TRIGGER organizations_plan_guard
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_reject_plan_change();

-- La colonne par défaut est déjà 'free' : les INSERT du client nommaient
-- plan:'free' inutilement, ce qui les aurait fait échouer ici. Les deux
-- insertions de src/ ont été corrigées en même temps que cette migration.
--
-- Les valeurs écrites par un trigger échappent au contrôle de privilège (il ne
-- porte que sur les colonnes citées dans la requête) : beta_claim_slot()
-- continue donc de passer les dix comptes bêta en Pro.
REVOKE INSERT, UPDATE ON organizations FROM anon, authenticated;
GRANT INSERT  (id, name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;
GRANT UPDATE (name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;

-- Ni plan, ni invoice_counter, ni created_at : le premier est Stripe, le
-- deuxième est incrémenté par create_sale() en SECURITY DEFINER, les derniers
-- sont à la base.


-- ─── 3. subscriptions : une ligne par organisation ─────────
-- Le webhook fait upsert(..., { onConflict: 'org_id' }) depuis le tout premier
-- jour. PostgreSQL refuse un ON CONFLICT sans contrainte correspondante, et
-- supabase-js renvoie l'erreur dans { error } sans jamais la lever — l'échec
-- était donc totalement invisible.

-- Déduplication préalable : si une base a déjà reçu deux abonnements pour la
-- même org (par un insert direct, puisqu'échouer l'upsert), l'index refuserait
-- d'être créé. On garde la ligne la plus récente.
DELETE FROM subscriptions s
USING subscriptions k
WHERE s.org_id = k.org_id
  AND s.id <> k.id
  AND (COALESCE(k.updated_at, k.created_at, 'epoch'::timestamptz), k.id)
    > (COALESCE(s.updated_at, s.created_at, 'epoch'::timestamptz), s.id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_org
  ON subscriptions (org_id);


-- ─── 4. business_members : lecture seule pour le client ────
-- La policy « owner_manage_members » était FOR ALL : un utilisateur pouvait
-- insérer (owner_id = soi, member_id = <uuid arbitraire>) et rattacher n'importe
-- quel compte à son équipe. Or :
--   • le tenant de la victime bascule chez l'attaquant (get_business_owner_id()
--     privilégie l'appartenance à une équipe) ;
--   • l'attaquant acquiert alors le droit de supprimer ce membre.
-- Aucune écriture client n'existe dans src/ : les insertions passent par
-- redeem_invitation() en SECURITY DEFINER, les suppressions par les routes API
-- en service role. La policy n'avait donc aucune raison d'être en écriture.
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
DROP POLICY IF EXISTS "owner_manage_members_select" ON business_members;
CREATE POLICY "owner_manage_members_select" ON business_members
  FOR SELECT USING (auth.uid() = owner_id);

-- Seconde couche : un compte qui possède déjà SA boutique ne peut devenir
-- membre d'une autre. Sans cela, inviter un patron détourne son tenant — et
-- supprimer ce lien, puis le compte Auth, détruisait sa boutique entière (tous
-- les ON DELETE CASCADE partent de auth.users).
--
-- SECURITY DEFINER indispensable : en RLS, une interrogation d'organizations
-- filtrée par la policy du candidat ne verrait pas la boutique d'un inconnu, et
-- la garde passerait exactement là où elle doit bloquer.
CREATE OR REPLACE FUNCTION business_members_reject_owner_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.member_id) THEN
    RAISE EXCEPTION 'Ce compte possède déjà sa propre boutique et ne peut pas rejoindre une autre équipe.'
      USING ERRCODE = '23514',
            HINT = 'Invitez un autre compte, ou transférez d''abord la boutique.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION business_members_reject_owner_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_members_reject_owner_member() TO authenticated, service_role;

DROP TRIGGER IF EXISTS business_members_guard ON business_members;
CREATE TRIGGER business_members_guard
  BEFORE INSERT OR UPDATE ON business_members
  FOR EACH ROW EXECUTE FUNCTION business_members_reject_owner_member();


-- ─── 5. sales / sale_items / stock_logs : lecture pour le client ──
-- Ces trois policies ont été créées SANS clause FOR, ce qui vaut FOR ALL. Leur
-- prédicat est `user_id = get_business_owner_id()`, qui pour un employé
-- renvoie le PATRON : l'employé passait donc dans le USING comme dans le
-- WITH CHECK, et pouvait faire UPDATE et DELETE sur les ventes de la boutique.
-- Effacer la journée, effacer sa propre trace dans le journal des stocks —
-- depuis le navigateur, avec la seule clé anon.
--
-- Les policies RLS s'additionnent (OR) et ne se remplacent pas : il faut
-- bien DROP l'ancienne, sinon elle reste en place.
--
-- Aucune écriture client n'existe sur sales ni sale_items — tout passe par
-- create_sale(), record_credit_sale() et pay_customer_debt(), toutes en
-- SECURITY DEFINER. Ces fonctions tournent en propriétaire des tables et
-- contourneront donc la RLS ; le client n'a besoin que du SELECT.
--
-- stock_logs, lui, EST écrit par le client (réapprovisionnement,
-- inventaire). L'INSERT reste ouvert, mais sous le même garde-fou que les
-- dépenses et les dettes : can_manage_products(). Il est déjà exigé par
-- products_update, donc rien qui marchait ne cesse de marcher.

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales_select" ON sales;
CREATE POLICY "user_sales_select" ON sales
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items_select" ON sale_items;
CREATE POLICY "user_sale_items_select" ON sale_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs_select" ON stock_logs;
CREATE POLICY "user_stock_logs_select" ON stock_logs
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_stock_logs_insert" ON stock_logs;
CREATE POLICY "user_stock_logs_insert" ON stock_logs
  FOR INSERT WITH CHECK (
    user_id = get_business_owner_id()
    AND can_manage_products()
  );
-- Ni UPDATE ni DELETE : le journal des stocks est inaltérable. Une correction
-- se fait par un nouveau mouvement, jamais en réécrivant l'ancien.


-- ─── 6. Suppression de compte : deux blocages de bout en bout ──
-- Relevés dans les logs Auth (source `auth_logs`), qui nomment les deux causes
-- au mot près.
--
-- a) `GET /admin/users` → 500 « converting NULL to string is unsupported »
--    GoTrue lit confirmation_token dans un string Go non nullable : NULL lève
--    une erreur, '' passe. Un compte créé par le formulaire d'inscription a
--    '' ; un compte inséré à la main dans auth.users a laissé les colonnes jeton
--    à NULL. Une seule ligne suffisait : la liste des comptes ET la fiche d'un
--    compte devenaient illisibles, donc leur suppression depuis le Dashboard
--    aussi. Le PATCH ne touche que les lignes incomplètes.
--
-- b) `DELETE /admin/users/{id}` → 500 « delete on table "products" violates
--    foreign key constraint "sale_items_product_id_fkey" »
--    La suppression d'un compte remonte en cascade vers products AVANT sales
--    (l'ordre suit celui de création des contraintes, soit products avant sales
--    dans schema.sql). products partait donc quand sale_items le référençait
--    encore, et NO ACTION renvoyait l'erreur.
--    Rien n'est assoupli : la règle de suppression reste NO ACTION. Seule la
--    VÉRIFICATION est différée à la fin de la transaction, où sale_items a
--    disparu via sale_id (déjà en CASCADE). Une suppression isolée d'un produit
--    reste donc refusée, exactement comme avant.
--
-- Rejouable : COALESCE ne réécrit rien quand la valeur est déjà correcte, et
-- ALTER CONSTRAINT réappliqué sur la même valeur ne change rien.

UPDATE auth.users
   SET confirmation_token      = COALESCE(confirmation_token, ''),
       recovery_token          = COALESCE(recovery_token, ''),
       email_change_token_new  = COALESCE(email_change_token_new, ''),
       email_change            = COALESCE(email_change, '')
 WHERE confirmation_token IS NULL
    OR recovery_token IS NULL
    OR email_change_token_new IS NULL
    OR email_change IS NULL;

ALTER TABLE sale_items
  ALTER CONSTRAINT sale_items_product_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE stock_logs
  ALTER CONSTRAINT stock_logs_product_id_fkey DEFERRABLE INITIALLY DEFERRED;


-- ─── 7. La clé anon ne doit plus rien appeler ───────────────
--
-- 33 des 35 fonctions du schéma public répondaient à la seule clé publique du
-- navigateur, dont 20 en SECURITY DEFINER. Deux mécanismes, et il faut les
-- traiter tous les deux :
--
--   · Supabase accorde EXECUTE à anon, authenticated et service_role au moment
--     de la CRÉATION de chaque fonction (ALTER DEFAULT PRIVILEGES). Le grant
--     vient du rôle, donc un `REVOKE ... FROM PUBLIC` — écrit partout dans les
--     migrations — ne lui retire rien.
--   · PostgreSQL accorde par ailleurs EXECUTE à PUBLIC sur toute fonction
--     dont l'ACL n'a pas été touchée. anon hérite de ce droit comme de tout
--     autre : vérifié, c'était le cas de 12 fonctions (update_updated_at,
--     check_product_limit, fill_amount_received, purge_rate_limits…).
--
-- Aucun chemin de l'application n'en avait besoin — vérifié fonction par
-- fonction :
--
--   · les huit routes API construisent leur client avec la service role,
--     l'unique exception étant /api/register qui n'utilise le client anon que
--     pour auth.signInWithPassword ;
--   · src/proxy.ts appelle bump_rate_limit() et purge_rate_limits() en fetch
--     direct, avec la service role ;
--   · les modules du tableau de bord ne se montrent qu'après
--     `if (!user) return <LoginPage />` — donc jamais en rôle anon ;
--   · les trois pages publiques (inscription, invitation, réinitialisation)
--     n'appellent que GoTrue, jamais une fonction SQL.
--
-- Deux exceptions, et elles ne sont pas des indulgences. Les policies RLS
-- appellent get_business_owner_id() et can_manage_products(), et une policy
-- s'évalue sous le rôle de l'appelant : sans EXECUTE, une lecture non
-- authentifiée renverrait « permission denied for function » au lieu de zéro
-- ligne. Pour anon, les deux renvoient NULL, donc faux — aucun accès n'est
-- concédé, seul le code de retour changerait.
--
-- `authenticated` n'est PAS re-granté en bloc : ce serait rouvrir
-- close_beta_program(), set_beta_slots() et revoke_all_beta() à n'importe quel
-- client connecté. Les migrations concernées accordent déjà EXECUTE à qui de
-- droit, et le harnais vérifie en 22b que les douze fonctions que le
-- navigateur appelle réellement le restent.
--
-- Les ALTER DEFAULT PRIVILEGES doublent le REVOKE sur ALL : sans eux, la
-- prochaine migration créerait une fonction et lui rouvrirait la porte
-- d'elle-même.
--
-- Rejouable : REVOKE et GRANT sont idempotents.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

GRANT EXECUTE ON FUNCTION get_business_owner_id() TO anon;
GRANT EXECUTE ON FUNCTION can_manage_products()   TO anon;

-- ─── 8. get_cash_flow() : le résultat net déduit le coût des ventes ──────
--
-- L'écran « Charges » affichait « Résultat net = CA − charges ». Le calcul
-- tient entre les chiffres montrés — et il est faux. Il oublie ce que la
-- marchandise a coûté. Relevé en production sur 30 jours :
--
--     chiffre d'affaires                     1 349 400 F
--     coût des marchandises vendues            953 756 F   ← absent
--     charges de structure                     188 200 F
--     résultat affiché                       1 161 200 F   (86,1 %)
--     résultat réel                            207 444 F   (15,4 %)
--
-- L'écart est exactement le coût d'achat : le commerçant paraissait 5,6 fois
-- plus riche qu'il n'était. Un taux de marge nette de 86 % n'existe dans aucun
-- commerce de détail — 15 % est la marque d'une boutique saine. « CA − charges »
-- n'est ni le résultat net ni la marge brute : il lui manque le CMV.
--
-- Le coût vient de sale_items.unit_cost, figé à la vente par
-- freeze_sale_item_cost() : l'historique ne bouge pas quand le prix d'achat est
-- corrigé aujourd'hui. Il est proratisé sur amount_received / total_amount,
-- exactement comme le CA — une vente à crédit ne doit débiter que la part
-- encaissée, sinon ventes et coûts ne seraient pas sur la même base et le
-- résultat fausserait dans les deux sens.
--
-- Une colonne s'ajoute, rien ne se supprime : le client lit les champs par leur
-- nom, un champ de plus est donc sans effet sur le code antérieur.
--
-- DROP puis CREATE, et non CREATE OR REPLACE : PostgreSQL refuse de changer le
-- type de retour d'une fonction existante (« cannot change return type of
-- existing function »). Rejouable : le IF EXISTS et le GRANT en fin de section.

DROP FUNCTION IF EXISTS get_cash_flow(date, date);

CREATE FUNCTION get_cash_flow(p_from date, p_to date)
RETURNS TABLE (
  day          date,
  revenue      numeric,
  cogs         numeric,
  expenses     numeric,
  net          numeric,
  transactions bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    -- Fuseau de l'organisation, avec repli sur celui du pays si absent.
    SELECT COALESCE(
             (SELECT o.timezone FROM organizations o
               WHERE o.id = get_business_owner_id()),
             'Africa/Porto-Novo'
           ) AS tz
  ),
  sales_by_day AS (
    SELECT
      (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date AS d,
      -- Base de caisse, sans exception : le chiffre d'affaires est ce qui est
      -- réellement rentré, et amount_received est la seule colonne qui le sait.
      -- Une vente espèces vaut son prix, une vente à crédit vaut son acompte.
      SUM(s.amount_received) AS rev,
      COUNT(*)               AS tx
    FROM sales s
    WHERE (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date
          BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  -- Le même prorata que le CA, appliqué au coût figé à la vente. Les deux
  -- colonnes sortent donc sur une base identique, ce qui est la condition pour
  -- qu'une soustraction ait un sens.
  items_by_day AS (
    SELECT
      (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date AS d,
      SUM(si.unit_cost * si.quantity * CASE
             WHEN s.total_amount > 0 THEN s.amount_received / s.total_amount
             ELSE 0
           END) AS cost
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE si.unit_cost IS NOT NULL
      AND (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date
          BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  expenses_by_day AS (
    SELECT x.day AS d, SUM(x.amount) AS spent
    FROM expenses x
    WHERE x.day BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  -- Journées vues par au moins un des deux flux. Un jour sans vente mais avec
  -- charge doit apparaître : c'est ce que faisait le FULL OUTER JOIN. Une
  -- UNION de jours puis trois LEFT JOIN donne le même résultat sans que la
  -- couverture dépendre de l'ordre des jointures, et le garde de plan reste
  -- atteint dès qu'une ligne existe — comme avant.
  jours AS (
    SELECT d FROM sales_by_day
    UNION
    SELECT d FROM expenses_by_day
  )
  SELECT
    j.d                                              AS day,
    COALESCE(s.rev, 0)                               AS revenue,
    COALESCE(i.cost, 0)                              AS cogs,
    COALESCE(x.spent, 0)                             AS expenses,
    COALESCE(s.rev, 0) - COALESCE(i.cost, 0)
      - COALESCE(x.spent, 0)                         AS net,
    COALESCE(s.tx, 0)                                AS transactions
  FROM jours j
  LEFT JOIN sales_by_day    s ON s.d = j.d
  LEFT JOIN items_by_day    i ON i.d = j.d
  LEFT JOIN expenses_by_day x ON x.d = j.d
  -- VERROU DE PLAN. Même raison que get_product_profitability() : l'appel RPC
  -- contourne le cadenas du menu. Ici, ce que le client gratuit lirait est le
  -- résultat net par jour — exactement ce qui se trouve au bas de la page
  -- « Charges », la ligne que le plan vend.
  -- require_feature est VOLATILE : elle ne peut être ni écartée ni mise en
  -- cache par le planificateur. Aucune ligne = aucun chiffre divulgué.
  WHERE (SELECT true FROM require_feature('reports'))
  ORDER BY 1;
$$;

COMMENT ON FUNCTION get_cash_flow(date, date) IS
  'Résultat journalier : CA − coût des marchandises vendues − charges. '
  'Le CMV provient de sale_items.unit_cost figé à la vente, proraté sur '
  'amount_received comme le CA. L''isolation vient de la RLS de sales et '
  'expenses (SECURITY INVOKER). Repli sur Africa/Porto-Novo si la timezone '
  'de l''organisation est absente.';

REVOKE ALL ON FUNCTION get_cash_flow(date, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_cash_flow(date, date) TO authenticated;
GRANT  EXECUTE ON FUNCTION get_cash_flow(date, date) TO service_role;

-- ============================================================
--  ⬇ migration_webhook_claim.sql
-- ============================================================

-- ============================================================
-- MIGRATION WEBHOOK CLAIM — GestionLocal
-- A exécuter dans Supabase SQL Editor, après migration_webhook_logs.sql
--
-- Idempotence du webhook Stripe : la lecture puis l'upsert de webhook_events
-- n'étaient pas atomiques. Deux livraisons concurrentes du même event_id
-- pouvaient toutes deux lire status <> 'processed' et retraiter l'événement
-- (double upsert d'abonnement, double changement de plan). claim_webhook_event
-- sérialise la prise en charge : un seul appelant gagne le droit de traiter.
-- ============================================================

CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_event_id text,
  p_event_type text,
  p_org_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed boolean;
BEGIN
  WITH upserted AS (
    INSERT INTO webhook_events (event_id, event_type, org_id, status)
    VALUES (p_event_id, p_event_type, p_org_id, 'processing')
    ON CONFLICT (event_id) DO UPDATE
      SET status = 'processing', error = NULL
      -- 'received' : tentative précédente interrompue avant le traitement.
      -- 'error'    : Stripe rejoue justement celui-là.
      -- 'processing' et 'processed' ne se reclaiment jamais : un appelant
      -- concurrent ou un événement déjà traité est court-circuité.
      WHERE webhook_events.status IN ('received', 'error')
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM upserted) INTO claimed;
  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION claim_webhook_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_webhook_event(text, text, text) TO service_role;

-- ============================================================
--  ⬇ migration_fk_indexes.sql
-- ============================================================

-- ============================================================
-- MIGRATION : index couvrant les clés étrangères
-- A exécuter dans Supabase SQL Editor
--
-- L'advisor Supabase signale deux FK sans index couvrant : sale_items.product_id
-- et stock_logs.user_id. Sans eux, une jointure ou une suppression en cascade
-- fait un seq scan de la table à chaque requête.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_user_id ON stock_logs(user_id);

-- ============================================================
--  ⬇ migration_domain.sql
-- ============================================================

-- ============================================================
-- MIGRATION DOMAINE — GestionLocal
-- A exécuter dans Supabase SQL Editor, après migration_security.sql
--
-- Un compte, deux domaines : commerce (caisse comptoir) et restauration
-- (salle, tables, commande ouverte).
--
-- Le domaine est un PARAMÈTRE D'AFFICHAGE, jamais un privilège : il ne touche
-- ni aux RLS, ni aux plans, ni aux limites de produits. Un restaurateur reste
-- soumis aux mêmes quotas qu'un commerçant — c'est ce qui rend la bascule entre
-- les deux domaines sans risque.
--
-- Les organizations existantes sont en commerce : DEFAULT 'retail' et aucune
-- valeur forcée, donc le backfill est inutile.
-- ============================================================

-- La colonne d'abord : la contrainte porte sur elle.
-- ADD COLUMN IF NOT EXISTS est indispensable, le harnais rejoue ce fichier.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'retail';

-- ⚠ LE GRANT EST INDISPENSABLE, et c'est un piège que cette migration
--   s'infligeait elle-même.
--
--   migration_security.sql a verrouillé organizations en accordant les droits
--   COLONNE par colonne (plan en SELECT seul, pour qu'un client ne puisse pas
--   écrire `plan = 'pro'`). Dès qu'il existe des droits de colonne, PostgreSQL
--   n'accorde plus rien au niveau TABLE : une colonne ajoutée ensuite par
--   ADD COLUMN naît donc SANS droit d'écriture, même pour le patron.
--
--   Résultat en recette du 04/10/2026 : l'écran « Quelle est votre activité ? »
--   répondait « permission denied for table organizations » et l'inscription
--   restait bloquée. Le test SQL ne le voyait pas — le harnais tourne en
--   postgres, qui contourne les privilèges.
GRANT UPDATE (domain) ON organizations TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_domain_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_domain_check
      CHECK (domain IN ('retail', 'restaurant'));
  END IF;
END;
$$;

-- Index inutile : le domaine est lu avec la ligne, jamais filtré en masse.

-- ============================================================
--  ⬇ migration_restaurant_tables.sql
-- ============================================================

-- ============================================================
-- MIGRATION RESTAURATION : TABLES & COMMANDE OUVERTE
-- À exécuter dans Supabase SQL Editor, après migration_domain.sql
--
-- Le service d'un restaurant n'est pas un encaissement : c'est une commande
-- qui vit, sur une table, avant d'être soldée. On l'ajoute SANS toucher aux
-- ventes : `sales` reste la seule source de vérité du chiffre d'affaires, et
-- une table n'est qu'un conteneur de commande.
--
-- Découpage :
--   restaurant_tables  la salle (nom, zone, places, active)
--   restaurant_orders  une commande ouverte, avec son état d'avancement
--   restaurant_order_items  les lignes : plat, quantité, prix convenu,
--                           note cuisine, état (à envoyer / envoyé / servi)
--
-- Multi-tenant : tout passe par get_business_owner_id(), comme le reste.
-- Un employé encaisse en salle : il écrit dans les commandes, il ne décide
-- ni de la salle (écriture patron + manager uniquement).
-- ============================================================

-- ─── 1. La salle ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  zone        text NOT NULL DEFAULT 'Salle',
  seats       int,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_tables_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_tables_owner
  ON restaurant_tables(owner_id, name);

-- ─── 2. La commande ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  table_id     uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  -- null = commande à emporter : elle n'occupe aucune table.
  customer_name text,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'bill_requested', 'closed')),
  -- Acomptes déjà encaissés sur une table, avant la clôture. L'addition du
  -- Sprint 14 les déduira du solde : sans cette colonne, un acompte était
  -- un encaissement invisible dans la commande.
  amount_paid  numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  opened_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  -- La vente écrite à la clôture : relie la commande au chiffre d'affaires
  -- sans le dupliquer. `sales.id` est un uuid, la FK tient.
  sale_id      uuid REFERENCES sales(id) ON DELETE SET NULL,

  CONSTRAINT restaurant_orders_closed_at CHECK (
    (status = 'closed' AND closed_at IS NOT NULL) OR (status <> 'closed' AND closed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_restaurant_orders_open
  ON restaurant_orders(owner_id, opened_at DESC)
  WHERE status <> 'closed';

-- Une seule commande ouverte par table. Sans cet index unique, deux serveurs
-- ouvraient deux tickets sur la même table et l'addition aurait totalisé les
-- deux — l'erreur la plus coûteuse du métier, et la plus difficile à voir.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_restaurant_orders_open_table
  ON restaurant_orders(table_id)
  WHERE status <> 'closed';

-- ─── 3. Les lignes de commande ──────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),
  -- Prix convenu comme au POS : le patron de la table négocie.
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  -- Note cuisine : « peu épicé », « sans oignon », « à emporter ». Volontairement
  -- du texte libre : un serveur tape vite, une liste déroulante l'arrêterait.
  note        text,
  -- new = à envoyer en cuisine · sent = parti · served = servi
  status      text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'sent', 'served')),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_order_items_note_len CHECK (note IS NULL OR length(note) <= 300)
);

-- Le supplément du modificateur est POSÉ ICI, pas dans
-- migration_restaurant_finitions.sql : la vue restaurant_floor, définie plus
-- bas dans ce fichier, l'additionne. Le créer plus loin ferait échouer ce
-- fichier lui-même sur une base neuve (« column r.extra_price does not exist »),
-- et avec lui toutes les migrations suivantes.
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS modifier text;
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS extra_price numeric(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_order
  ON restaurant_order_items(order_id, status);

-- ─── 4. RLS ─────────────────────────────────────────────────
-- Pattern du reste du projet : get_business_owner_id() résout le tenant, que
-- l'appelant soit le patron ou un employé de sa boutique.
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "restaurant_tables_read" ON restaurant_tables;
CREATE POLICY "restaurant_tables_read" ON restaurant_tables
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire la salle est une décision de patron ou de manager, pas de caissier :
-- réorganiser les tables pendant le service n'appartient pas à un employé.
DROP POLICY IF EXISTS "restaurant_tables_write" ON restaurant_tables;
DROP POLICY IF EXISTS "restaurant_tables_manage" ON restaurant_tables;
CREATE POLICY "restaurant_tables_manage" ON restaurant_tables
  FOR ALL
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_tables.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_tables.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  );

-- Un employé encaisse : il ouvre une commande (INSERT) et travaille ses lignes.
-- Il ne MODIFIE ni ne clôture la commande elle-même.
--
-- Deux policies distinctes plutôt qu'un FOR ALL : un FOR ALL donnerait au
-- caissier l'UPDATE, donc le droit de solder une addition — c'est-à-dire
-- d'écrire (ou non) la vente du patron.
DROP POLICY IF EXISTS "restaurant_orders_read" ON restaurant_orders;
CREATE POLICY "restaurant_orders_read" ON restaurant_orders
  FOR SELECT USING (owner_id = get_business_owner_id());

DROP POLICY IF EXISTS "restaurant_orders_attach_table" ON restaurant_orders;
CREATE POLICY "restaurant_orders_attach_table" ON restaurant_orders
  FOR UPDATE
  USING (status = 'open' AND table_id IS NULL)
  WITH CHECK (status = 'open' AND table_id IS NOT NULL);

-- Table_id NULL = commande à emporter, sans table. Chez un maquis, le service à
-- emporter fait la moitié du chiffre d'affaires : interdire cette ligne
-- condamnait le serveur à inventer une table, ou à faire encaisser au comptoir.
-- Aucune limite sur leur nombre : l'index unique ne porte que sur table_id,
-- qui est NULL ici.
DROP POLICY IF EXISTS "restaurant_orders_takeaway" ON restaurant_orders;
CREATE POLICY "restaurant_orders_takeaway" ON restaurant_orders
  FOR INSERT WITH CHECK (
    owner_id = get_business_owner_id()
    AND status = 'open'
    AND closed_at IS NULL
  );

-- Clôture et avancement (bill_requested) : patron ou manager seulement.
DROP POLICY IF EXISTS "restaurant_orders_update" ON restaurant_orders;
CREATE POLICY "restaurant_orders_update" ON restaurant_orders
  FOR UPDATE
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_orders.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_orders.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  );

-- Personne ne supprime une commande : elle s'annule en revenant au statut
-- ouvert ou se clôture. Une suppression laisserait une table occupée sans
-- commande, et le total du service disparaîtrait sans trace.
DROP POLICY IF EXISTS "restaurant_orders_no_delete" ON restaurant_orders;
CREATE POLICY "restaurant_orders_no_delete" ON restaurant_orders
  FOR DELETE USING (false);

DROP POLICY IF EXISTS "restaurant_order_items_read" ON restaurant_order_items;
CREATE POLICY "restaurant_order_items_read" ON restaurant_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "restaurant_order_items_write" ON restaurant_order_items;
CREATE POLICY "restaurant_order_items_write" ON restaurant_order_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
        AND ro.status <> 'closed'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
        AND ro.status <> 'closed'
    )
  );

-- ─── 5. Vue de la salle ─────────────────────────────────────
-- Le plan de tables a besoin de l'état sans N requêtes : tables libres /
-- occupées / addition demandée, et le montant de la commande en cours.
-- WITH (security_invoker) dès la création et non par ALTER : sur une vue déjà
-- existante, un ALTER VIEW ... SET ne serait pas rejouable sans DROP.
CREATE OR REPLACE VIEW restaurant_floor
WITH (security_invoker = true)
AS
SELECT
  t.id,
  t.owner_id,
  t.name,
  t.zone,
  t.seats,
  t.is_active,
  o.id   AS order_id,
  o.status,
  o.customer_name,
  o.opened_at,
  o.amount_paid,
  -- Le supplément du modificateur compte dans le total de la table : c'est le
  -- montant que la table va payer. Sans lui, la tuile affichait 9 000 F pour
  -- une addition de 12 000 F — et l'encaissement aurait porté sur 12 000.
  COALESCE(
    (SELECT sum(i.quantity * (i.unit_price + i.extra_price))
       FROM restaurant_order_items i WHERE i.order_id = o.id),
    0
  ) AS order_total
FROM restaurant_tables t
LEFT JOIN restaurant_orders o
  ON o.table_id = t.id AND o.status <> 'closed';

COMMENT ON VIEW restaurant_floor IS
  'Plan des tables avec l''état de la commande en cours et son montant. '
  'security_invoker : les policies des tables sous-jacentes restent la seule '
  'source d''autorisation, une vue ne doit jamais les contourner.';

REVOKE ALL ON restaurant_floor FROM anon;
GRANT SELECT ON restaurant_floor TO authenticated, service_role;
-- ─── Un nom de table est unique parmi les tables actives ────────────────
--
-- Trouvé en recette le 05/10/2026 : rien n'empêchait de créer deux « Table 1 ».
-- Le plan affichait alors deux tuiles identiques, et surtout le TICKET DE CUISINE
-- et le REÇU n'imprimaient que « Table 1 » — le plongeur ne savait plus quelle
-- table les deux portions attendaient.
--
-- Le nom est comparé en minuscules et sans espaces aux extrémités : « table 1 »
-- et « Table 1  » sont la même table, et c'est ce que le serveur tape.
--
-- PARTIEL (WHERE is_active) : une table archivée libère son nom. Sans cela, on
-- ne pourrait plus jamais réutiliser « Table 5 » après avoir démonté la table.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_owner_name_uniq
  ON restaurant_tables (owner_id, lower(btrim(name)))
  WHERE is_active;

-- ============================================================
--  ⬇ migration_table_checkout.sql
-- ============================================================

-- ============================================================
-- MIGRATION RESTAURATION : CLÔTURE D'ADDITION
-- À exécuter dans Supabase SQL Editor, après migration_restaurant_tables.sql
--
-- Le Sprint 13 a créé la commande qui vit sur sa table. Elle ne vendait rien :
-- `sales` restait la seule source de vérité du chiffre d'affaires, donc une
-- table servie n'était dans AUCUN rapport. Ce sprint la relie au comptoir.
--
-- close_table_order() fait trois choses dans UNE transaction :
--   1. transforme les lignes de commande en articles de vente
--   2. passe par create_sale() — donc décrément de stock, coût figé, prix
--      convenu, numéro de facture, journal : aucune logique dupliquée
--   3. clôture la commande et la rattache à la vente écrite
--
-- L'addition partagée ne crée pas N ventes. Dans un restaurant, trois
-- convives à 12 000 F sont UNE vente de 36 000 F : le fractionnement sert à
-- afficher le compte de chacun, jamais à gonfler le chiffre d'affaires.
--
-- Ce que le fractionnement n'est PAS :
--   - un encaissement en N fois (chaque fois une vente distincte fausserait
--     les rapports de rentabilité, qui comptent par vente) ;
--   - un droit de encaisser seulement une part : qui paie pour toute la table ?
--     La table est soldée quand le TOTAL est réglé.
-- ============================================================

-- ─── 1. Colonnes de clôture ─────────────────────────────────
-- part_count : combien de parts l'addition est répartie en (1 = table entière).
ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS split_count int NOT NULL DEFAULT 1
  CHECK (split_count BETWEEN 1 AND 20);

ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS payment_method text
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'momo', 'credit'));

-- Le ticket de cuisine s'imprime à la commande, pas à la clôture : la cuisine
-- a déjà cuisine quand l'addition arrive. On note donc ce qui est parti.
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- ─── 2. Ticket de cuisine ───────────────────────────────────
-- Une vue, pas une table : le ticket est une LECTURE de la commande au moment
-- où la cuisine l'imprime. Le stocker dupliquerait l'état et pourrait diverger
-- de la commande — exactement ce que le stock figé à la vente évite pour le coût.
--
-- DROP avant CREATE : cette vue est REPRISE plus tard par
-- migration_restaurant_finitions.sql, qui y ajoute la colonne `modifier`. Un
-- CREATE OR REPLACE ne peut pas retirer une colonne — « cannot drop columns
-- from view » — et le harnais rejoue ce fichier sur une base déjà corrigée.
DROP VIEW IF EXISTS restaurant_kitchen_ticket;

CREATE VIEW restaurant_kitchen_ticket
WITH (security_invoker = true)
AS
SELECT
  ro.id            AS order_id,
  t.name           AS table_name,
  t.zone           AS zone,
  ro.opened_at,
  i.id             AS item_id,
  p.name           AS product_name,
  i.quantity,
  i.note,
  i.status,
  i.created_at
FROM restaurant_orders ro
LEFT JOIN restaurant_tables t ON t.id = ro.table_id
JOIN restaurant_order_items i ON i.order_id = ro.id
JOIN products p ON p.id = i.product_id
-- Une commande close n'a plus de cuisine à faire : son ticket est clos.
WHERE ro.status <> 'closed';

COMMENT ON VIEW restaurant_kitchen_ticket IS
  'Ticket de cuisine : les plats d''une commande, SANS PRIX. Une cuisine ne '
  'connaît pas les tarifs. security_invoker : les policies des tables '
  'sous-jacentes restent la seule autorisation.';

REVOKE ALL ON restaurant_kitchen_ticket FROM anon;
GRANT SELECT ON restaurant_kitchen_ticket TO authenticated, service_role;

-- ─── 3. Clôture ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_table_order(
  p_order_id      uuid,
  p_payment_method text,
  p_amount_paid   numeric(12,2) DEFAULT NULL,
  p_split_count   int          DEFAULT 1,
  p_client_phone  text         DEFAULT NULL,
  p_note          text         DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_order    restaurant_orders%ROWTYPE;
  v_items    jsonb;
  v_sale     jsonb;
  v_sale_id  uuid;
  v_total    numeric(12,2);
  v_paid     numeric(12,2);
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- ── Le rôle, explicitement ──
  -- SECURITY DEFINER s'exécute avec les droits du propriétaire de la fonction :
  -- les policies de restaurant_orders sont donc IGNORÉES. Sans ce contrôle, un
  -- simple caissier du tenant pourrait appeler la fonction et solder une
  -- addition, c'est-à-dire écrire la vente du patron. La policy de mise à jour
  -- ne protège plus rien ici — c'est la fonction qui protège.
  -- Le patron n'est PAS membre de sa propre boutique : il n'a pas de ligne dans
  -- business_members. Le test doit donc accepter le propriétaire lui-même, ou un
  -- membre de rôle owner/manager.
  IF v_owner <> auth.uid()
     AND NOT EXISTS (
       SELECT 1 FROM business_members bm
        WHERE bm.member_id = auth.uid()
          AND bm.owner_id = v_owner
          AND bm.role IN ('owner', 'manager')
     ) THEN
    RAISE EXCEPTION 'Seul le patron ou un manager peut encaisser une addition'
      USING ERRCODE = '42501';
  END IF;

  -- ── Verrouiller la commande ──
  -- FOR UPDATE sérialise deux clôtures simultanées de la même table : sans lui,
  -- les deux écrivent une vente et le total de l'addition est doublé.
  SELECT * INTO v_order
    FROM restaurant_orders
   WHERE id = p_order_id
     AND owner_id = v_owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'closed' THEN
    RAISE EXCEPTION 'Cette addition est déjà soldée' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  IF p_split_count IS NULL OR p_split_count < 1 OR p_split_count > 20 THEN
    RAISE EXCEPTION 'Nombre de parts invalide' USING ERRCODE = '22023';
  END IF;

  -- ── La commande doit avoir des plats ──
  IF NOT EXISTS (SELECT 1 FROM restaurant_order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'Aucun plat à encaisser sur cette table' USING ERRCODE = '22023';
  END IF;

  -- ── Les lignes deviennent des articles de vente ──
  -- create_sale() refuse deux prix différents pour le même article — c'est
  -- justifié au comptoir, où deux lignes du même produit ne peuvent être que
  -- la même commande. Sur une table, c'est différent : le patron négocie, et
  -- « un poulet à 4 000 puis un autre à 4 500 » est une chose réelle. On
  -- regroupe donc par produit et on retient le prix le plus bas : c'est la
  -- remise que la table a obtenue, appliquée à toutes les lignes de ce plat.
  --
  -- Le total est recalculé à partir de ce regroupement, jamais à partir d'une
  -- somme de lignes : les deux doivent coïncider, sinon la facture et l'écran
  -- montreraient deux montants différents.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id,
           'quantity',   a.quantity,
           'unit_price', a.unit_price
         )), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3)            AS quantity,
             min(i.unit_price)::numeric(12,2)          AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id
       GROUP BY i.product_id
    ) AS a;

  -- ── Encaissement ──
  -- create_sale() fait le travail lourd : atomicité, stock, coût figé, numéro
  -- de facture, journal. On l'appelle, on ne le réécrit pas.
  IF p_payment_method = 'credit' THEN
    -- Vente à crédit : elle passe par record_credit_sale(), qui rattache le
    -- client et gère l'acompte. Sans elle, create_sale('credit') refuse (le
    -- garde-fou credit.internal) et la dette n'existerait pas.
    IF btrim(COALESCE(p_client_phone, '')) = '' THEN
      RAISE EXCEPTION 'Un numéro est requis pour une addition à crédit' USING ERRCODE = '22023';
    END IF;

    v_sale := record_credit_sale(
      v_items,
      COALESCE(NULLIF(btrim(v_order.customer_name), ''), 'Client table'),
      p_client_phone,
      COALESCE(p_note, format('Table %s', COALESCE((SELECT name FROM restaurant_tables WHERE id = v_order.table_id), 'à emporter'))),
      COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0)
    );
  ELSE
    v_sale := create_sale(
      v_items,
      p_payment_method,
      NULLIF(btrim(COALESCE(v_order.customer_name, '')), ''),
      COALESCE(p_note, format('Table %s', COALESCE((SELECT name FROM restaurant_tables WHERE id = v_order.table_id), 'à emporter')))
    );
  END IF;

  v_sale_id := (v_sale->>'id')::uuid;

  -- ── Ce qui a été réellement encaissé ──
  -- Une addition espèces est soldée en totalité ; un acompte a pu être versé
  -- avant (amount_paid) et le reste est donné maintenant. Le crédit déduit ce
  -- qu'il a reçu, on ne fait donc qu'y ajouter ce qui est versé ici.
  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_total THEN
      RAISE EXCEPTION
        'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_total + COALESCE(p_amount_paid, 0);
  END IF;

  -- ── Clôture ──
  -- status, closed_at et sale_id ensemble : la contrainte de
  -- migration_restaurant_tables.sql l'exige, et sale_id relie la commande à la
  -- vente sans la dupliquer.
  UPDATE restaurant_orders
     SET status = 'closed',
         closed_at = now(),
         sale_id = v_sale_id,
         split_count = p_split_count,
         payment_method = p_payment_method,
         amount_paid = v_paid
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_total,
    'amount_paid',    v_paid,
    'split_count',    p_split_count,
    -- Le compte de chaque part, arrondi au franc. Le reste éventuel porte sur
    -- la dernière part : une addition de 100 F en 3 ne peut pas donner
    -- 33,33 × 3 = 99,99 et perdre 1 F sans que personne ne sache où il est passé.
    'per_share',      round(v_total / p_split_count, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) TO authenticated;

-- La version à 7 arguments de migration_restaurant_finitions.sql est retirée
-- avant ce CREATE : les deux signatures coexistant, un appel à 4 arguments
-- devient ambigu (« function close_table_order(unknown, unknown, unknown,
-- integer) is not unique ») et AUCUN ne s'exécute. Ce DROP est la contrepartie
-- de celui que fait migration_restaurant_finitions.sql sur la version à
-- 6 arguments — les deux migrations se nettoient donc mutuellement, dans
-- l'ordre, quelle que soit la base sur laquelle le harnais repart.
DROP FUNCTION IF EXISTS close_table_order(uuid, text, numeric, int, text, text, numeric);

COMMENT ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) IS
  'Solde une addition de table : transforme les lignes en vente via create_sale(), '
  'puis clôture la commande. Le fractionnement ne multiplie PAS les ventes — trois '
  'convives à 12 000 F font une vente de 36 000 F, répartie en 3 parts pour '
  'l''affichage seulement.';

-- ─── 4. Marquer « parti en cuisine » ────────────────────────
-- Un service en salle doit pouvoir dire « c'est parti » sans passer par
-- l'interface : c'est une action de terrain, elle se fait d'un geste.
-- La ligne doit être 'new' : on ne ré-expédie pas un plat déjà servi, et on ne
-- touche pas une commande close.
CREATE OR REPLACE FUNCTION send_order_items(p_order_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_sent  int;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM restaurant_orders
     WHERE id = p_order_id AND owner_id = v_owner AND status <> 'closed'
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà soldée' USING ERRCODE = 'P0002';
  END IF;

  UPDATE restaurant_order_items
     SET status = 'sent', sent_at = now()
   WHERE order_id = p_order_id
     AND status = 'new';

  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION send_order_items(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_order_items(uuid) TO authenticated;

-- ============================================================
--  ⬇ migration_recipes.sql
-- ============================================================

-- ============================================================
-- MIGRATION RESTAURATION : RECETTES ET COÛT DE MATIÈRE
-- À exécuter dans Supabase SQL Editor, après migration_table_checkout.sql
--
-- LE PROBLÈME
--   L'application ne vend que des produits finis. « Poulet braisé » est un
--   produit à 4 500 F, et sa marge affichée est 4 500 − prix_achat. Or un
--   patron ne rachète pas de « poulet braisé » : il rachète du poulet, du riz,
--   de l'huile. Sans recette, sa rentabilité est une fiction — et c'est
--   précisément le KPI d'un restaurant.
--
-- CE QUE CELA CHANGE
--   Un produit peut avoir une RECETTE : une liste d'ingrédients, avec la
--   quantité nécessaire pour UNE portion. Le coût d'un plat devient la somme
--   des coûts de ses ingrédients, et il part de là pour chaque ingredient :
--
--     Riz blanc (recette : 300 g riz, 1 c. huile)
--       └─ Poulet braisé (recette : 150 g riz, 1 c. huile, 200 g poulet)
--
--   Le riz des deux est additionné : vendre un poulet consomme ce que les
--   deux plats demandent. Une recette peut donc contenir un autre plat.
--
-- MISE EN ŒUVRE — deux déclencheurs, pas une réécriture de create_sale()
--   1. sale_items_set_unit_cost   AVANT INSERT : le coût figé de la ligne est
--      le coût de la RECETTE quand le produit en a une, sinon le prix
--      d'achat. `unit_cost` étant figé à la vente, la rentabilité historique
--      reste vraie même si la recette change demain — c'est le principe déjà
--      posé par migration_profitability.sql, appliquée au plat.
--   2. sale_items_consume_ingredients APRÈS INSERT : les stocks
--      d'ingrédients sont décrémentés, et le journal écrit.
--
--   Pourquoi un déclencheur et non une nouvelle create_sale() ? Réécrire cette
--   fonction — 150 lignes, le cœur de la caisse — pour y ajouter deux lignes
--   serait le moyen le plus sûr de la casser. Le déclencheur s'exécute DANS la
--   transaction de la vente : s'il lève, tout est annulé, vente comprise. On
--   obtient l'atomicité recherchée sans toucher au chemin critique.
--
-- ⚠ CE QUE CELA NE FAIT PAS
--   Le stock d'un PLAT n'est pas décrémenté par la recette : un plat se
--   cuisine, il ne se stocke pas. C'est aussi pour cela que create_sale()
--   (migration_weighted_sales.sql) NE CONTRÔLE PAS et NE DÉCRÉMENTE PAS le
--   stock d'un produit qui a une recette : sa disponibilité vient d'ici, et son
--   propre stock n'est qu'un champ libre pour un patron qui veut suivre ses
--   plats en portions.
--
--   Ces deux règles ont d'abord été écrites séparément, et create_sale()
--   contredisait celle-ci : un plat à 0 — sa valeur naturelle — était refusé à
--   la vente. Trouvé en recette navigateur le 05/10/2026, sur un maquis neuf.
-- ============================================================

-- ─── 1. Les recettes ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  dish_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Quantité d'ingrédient pour UNE portion du plat.
  quantity      numeric(12,3) NOT NULL CHECK (quantity > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (dish_id, ingredient_id),
  -- Un plat ne peut pas être son propre ingrédient, direct ou indirect :
  -- « poulet braisé composé de poulet braisé » créerait une boucle infinie
  -- dans le calcul de coût. La détection du cycle DIRECT est ici ; celle des
  -- cycles INDIRECTS est faite par add_recipe_ingredient(), qui refuse une
  -- fermeture de boucle — une contrainte SQL ne peut pas remonter l'arbre.
  CONSTRAINT recipe_ingredients_no_self CHECK (dish_id <> ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_dish
  ON recipe_ingredients(dish_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ingredient
  ON recipe_ingredients(ingredient_id);

-- ─── 2. RLS ─────────────────────────────────────────────────
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

-- Lecture : tout membre du tenant voit les recettes. C'est nécessaire au
-- calcul de coût affiché dans les rapports.
DROP POLICY IF EXISTS "recipes_read" ON recipe_ingredients;
CREATE POLICY "recipes_read" ON recipe_ingredients
  FOR SELECT USING (
    get_business_owner_id() IN (
      SELECT p.user_id FROM products p WHERE p.id = recipe_ingredients.dish_id
    )
  );

-- Écriture : patron ou manager, comme la salle. Un caissier peut vendre un
-- plat, il ne réécrit pas la carte.
DROP POLICY IF EXISTS "recipes_write" ON recipe_ingredients;
CREATE POLICY "recipes_write" ON recipe_ingredients
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM products p
       WHERE p.id = recipe_ingredients.dish_id
         AND p.user_id = get_business_owner_id()
         AND can_manage_products()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM products p
       WHERE p.id = recipe_ingredients.dish_id
         AND p.user_id = get_business_owner_id()
         AND can_manage_products()
    )
  );

-- ─── 3. Le coût d'un produit ────────────────────────────────
-- Récursif : un plat peut contenir un plat. La profondeur est bornée à 10
-- niveaux — au-delà, c'est une erreur de saisie, pas une recette.
--
-- SECURITY INVOKER : elle ne fait que lire products et recipe_ingredients,
-- dont les policies garantissent l'isolation. Une fonction SECURITY DEFINER
-- ici laisserait un restaurant lire les coûts d'un autre.
CREATE OR REPLACE FUNCTION product_cost(
  p_product_id uuid,
  p_depth      int DEFAULT 0
)
RETURNS numeric(12,2)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cost   numeric(12,2);
  v_direct numeric(12,2);
BEGIN
  IF p_depth > 10 THEN
    -- Plutôt qu'une erreur, on s'arrête : une recette circulaire ne doit pas
    -- rendre la page Rentabilité inutilisable. Le coût renvoie alors 0 pour le
    -- niveau fautif, ce qui signale un problème sans bloquer la vente.
    RETURN 0;
  END IF;

  SELECT COALESCE(sum(r.quantity * product_cost(r.ingredient_id, p_depth + 1)), 0)
    INTO v_direct
    FROM recipe_ingredients r
   WHERE r.dish_id = p_product_id;

  IF v_direct > 0 THEN
    RETURN round(v_direct, 2);
  END IF;

  SELECT COALESCE(price_buy, 0) INTO v_cost FROM products WHERE id = p_product_id;
  RETURN round(COALESCE(v_cost, 0), 2);
END;
$$;

REVOKE ALL ON FUNCTION product_cost(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_cost(uuid, int) TO authenticated, service_role;

COMMENT ON FUNCTION product_cost(uuid, int) IS
  'Coût de revient d''une portion : somme des ingrédients (récursif) si le '
  'produit a une recette, sinon son prix d''achat. Profondeur bornée à 10 pour '
  'qu''une recette circulaire ne boucle pas.';

-- ─── 4. Coût figé sur la ligne de vente ─────────────────────
-- AVANT INSERT : remplace le prix d'achat par le coût de recette quand le
-- produit en a une. Sans ce déclencheur, la marge d'un plat resterait
-- 4 500 − prix_achat, c'est-à-dire exactement le problème qu'on voulait
-- résoudre.
CREATE OR REPLACE FUNCTION sale_items_set_unit_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_recette numeric(12,2);
BEGIN
  IF NEW.unit_cost IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT product_cost(NEW.product_id) INTO v_recette;

  -- Un produit SANS recette rend price_buy : on ne touche à rien, c'est déjà
  -- ce que create_sale() a posé. Sans ce test, une vente de 0 F se verrait
  -- attribuer un coût arbitraire.
  IF v_recette > 0 THEN
    NEW.unit_cost := v_recette;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_apply_recipe_cost ON sale_items;
CREATE TRIGGER sale_items_apply_recipe_cost
  BEFORE INSERT ON sale_items
  FOR EACH ROW EXECUTE FUNCTION sale_items_set_unit_cost();

-- ─── 5. Décrément des ingrédients ───────────────────────────
-- APRÈS INSERT : chaque ingrédient de la recette part, et le journal est
-- écrit. Le trigger lève si un ingrédient manque — ce qui annule TOUTE la
-- vente, ligne d'en-tête comprise : commander 5 plats dont il manque le poulet
-- doit échouer, pas créer une vente sans plat.
--
-- LE DÉCRÉMENT EST RÉCURSIF, EXACTEMENT COMME LE COÛT. La première version
-- ne descendait qu'un niveau : elle prenait le plat intermédiaire pour un
-- ingrédient et décrémentait SON stock, dont la valeur naturelle est 0.
-- Deux issues, toutes deux fausses, selon que ce stock existe :
--   · il vaut 0 (le cas normal d'un plat) → la vente est REFUSÉE, en nommant
--     un « ingrédient » qui n'en est pas, alors que le riz est plein ;
--   · il est positif → la vente passe, en décrémentant un plat qui n'existe
--     pas en stock et en laissant le riz intact : l'inventaire ment.
-- La promesse écrite plus haut — « vendre un poulet consomme ce que les deux
-- plats demandent » — n'était tenue que par le COÛT. Vérifié par les tests
-- 25n / 25o / 25p.
--
-- Où s'arrête l'arbre : aux FEUILLES, c'est-à-dire aux produits qui n'ont
-- pas eux-mêmes de recette. Un produit qui en a une n'est pas du stock, c'est
-- un plat intermédiaire — même règle que create_sale(), qui ne touche pas au
-- stock d'un produit récette (migration_weighted_sales.sql). Sans cette
-- distinction, un menu contenant un plat ferait deux fois le même calcul :
-- décrémenter l'intermédiaire ET ses propres ingrédients.
--
-- La profondeur est bornée à 10, comme dans product_cost(). Les cycles sont
-- refusés à l'écriture par add_recipe_ingredient(), mais une ligne posée à la
-- main pourrait en créer un : la borne garantit que le déclencheur termine
-- toujours, plutôt que de boucler au cœur de la transaction de vente.
--
-- Le même ingrédient peut apparaître dans deux plats vendus sur la même
-- vente : chaque déclencheur le décrémente. L'ordre n'a pas d'importance,
-- l'addition est commutative, et le verrou de ligne de chaque produit
-- sérialise les écritures concurrentes.
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
      -- Racine : les ingrédients directs, à la quantité VENDUE.
      SELECT ri.ingredient_id, ri.quantity * NEW.quantity, 1
        FROM recipe_ingredients ri
       WHERE ri.dish_id = NEW.product_id
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

-- ─── 6. Écriture de recette, avec refus des cycles ──────────
-- Le client ne peut pas écrire directement : il doit passer par cette
-- fonction. Elle refuse l'ajout qui fermerait une boucle
-- (« poulet braisé » composé de « riz blanc » qui contient déjà le poulet
-- braisé), ce que la contrainte CHECK ne peut pas voir.
CREATE OR REPLACE FUNCTION add_recipe_ingredient(
  p_dish_id       uuid,
  p_ingredient_id uuid,
  p_quantity      numeric(12,3)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Seul le patron ou un manager peut modifier une recette'
      USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantité d''ingrédient invalide' USING ERRCODE = '22023';
  END IF;

  -- Les deux produits doivent exister ET être du tenant : un ingrédient d'un
  -- autre restaurant ne serait jamais décrémenté (RLS), et la marge mentirait.
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_dish_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Plat introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_ingredient_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Ingrédient introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Cycle direct.
  IF p_dish_id = p_ingredient_id THEN
    RAISE EXCEPTION 'Un plat ne peut pas être son propre ingrédient' USING ERRCODE = '22023';
  END IF;

  -- Cycle indirect : l'ingrédient proposé CONTIENT-il déjà le plat ?
  -- Exemple : « poulet sauté » (plat) contient « poulet braisé ». Si on
  -- voulait ajouter « poulet braisé » à la recette de « poulet braisé » avec
  -- « poulet sauté » comme ingrédient, la boucle serait
  -- braisé → sauté → braisé.
  --
  -- On descend donc de l'ingrédient vers SES ingrédients (dish_id = a.id),
  -- et non l'inverse : remonter trouverait qui utilise l'ingrédient, ce qui
  -- répond à une autre question et laisse passer le cycle réel.
  IF EXISTS (
    WITH RECURSIVE arbre(id, prof) AS (
      SELECT p_ingredient_id, 0
      UNION ALL
      SELECT ri.ingredient_id, a.prof + 1
        FROM recipe_ingredients ri
        JOIN arbre a ON ri.dish_id = a.id
       WHERE a.prof < 10
    )
    SELECT 1 FROM arbre WHERE id = p_dish_id
  ) THEN
    RAISE EXCEPTION 'Cet ingrédient contient déjà ce plat : la recette formerait un cercle'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO recipe_ingredients (dish_id, ingredient_id, quantity)
  VALUES (p_dish_id, p_ingredient_id, p_quantity)
  ON CONFLICT (dish_id, ingredient_id)
  DO UPDATE SET quantity = EXCLUDED.quantity;
END;
$$;

REVOKE ALL ON FUNCTION add_recipe_ingredient(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_recipe_ingredient(uuid, uuid, numeric) TO authenticated;

-- ─── 7. Vue : marge par plat ────────────────────────────────
-- Le coût de recette et le prix de vente sur une seule ligne. C'est ce que
-- l'écran Recettes affiche, et ce qui distingue un restaurant d'un commerce :
-- le coût vient de la recette, pas d'un prix d'achat posé à la main.
-- DROP puis CREATE : la colonne `stock_qty` est insérée ENTRE price_sell et
-- unit_cost, et PostgreSQL refuse de réordonner les colonnes d'une vue
-- existante (« cannot change name of view column unit_cost to stock_qty »).
-- La vue ne porte aucun état : la recréer est sans risque.
DROP VIEW IF EXISTS recipe_costs;

CREATE VIEW recipe_costs
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.category,
  p.price_sell,
  -- stock_qty : la recette sert à deux choses — calculer la marge, et dire au
  -- patron « cet ingrédient ne suffit pas pour une portion ». Sans le stock,
  -- l'écran Recettes ne peut pas afficher l'alerte de rupture. La colonne a
  -- manque à la première version : l'écran affichait « column recipe_costs.
  -- stock_qty does not exist » puis, pire, un état vide « aucun plat ».
  p.stock_qty,
  p.unit,
  product_cost(p.id)                          AS unit_cost,
  round(p.price_sell - product_cost(p.id), 2) AS margin,
  CASE WHEN product_cost(p.id) > 0
       THEN round(100 * (p.price_sell - product_cost(p.id)) / p.price_sell, 1)
       ELSE NULL END                          AS margin_pct,
  (SELECT count(*) FROM recipe_ingredients r WHERE r.dish_id = p.id) AS ingredient_count
FROM products p
WHERE p.is_active;

COMMENT ON VIEW recipe_costs IS
  'Coût de revient et marge par produit. Le coût vient de la recette quand elle '
  'existe, du prix d''achat sinon. security_invoker : l''isolation reste celle '
  'des policies de products et recipe_ingredients.';

REVOKE ALL ON recipe_costs FROM anon;
GRANT SELECT ON recipe_costs TO authenticated, service_role;

-- ============================================================
--  ⬇ migration_restaurant_finitions.sql
-- ============================================================

-- ============================================================
-- MIGRATION RESTAURATION : MODIFICATEURS, PLATS DU JOUR, POURBOIRE
-- À exécuter dans Supabase SQL Editor, après migration_recipes.sql
--
-- Sprint 16 — les finitions qui font la différence entre « une caisse qui
-- gère des plats » et « une caisse de restaurant ».
--
-- 1. MODIFICATEURS
--    « Poulet braisé », c'est trois plats différents : bien cuit, à point,
--    saignant. Sans option, le serveur note sur un ticket papier et le prix
--    facturé ne correspond pas à ce qui a été servi. Un modificateur porte
--    donc un NOM et un supplément — la cuisson ne coûte pas plus cher, mais
--    « double portion » ou « avec fromage » si.
--
-- 2. PLATS DU JOUR
--    Un restaurant ne sert pas la même carte tous les jours. Un plat absent de
--    l'offre du jour doit disparaître de la liste de commande : le garder
--    visible, c'est proposer un plat qu'on ne cuisine pas. `is_daily_special`
--    est un drapeau simple — pas une planification par jour de la semaine, qui
--    serait une vraie gestion de carte et mérite son propre écran.
--
-- 3. POURBOIRE
--    Au Bénin, le pourboire se laisse en espèces sur la table et n'arrive
--    jamais dans la caisse. Il n'est ni une recette ni un coût : c'est une
--    manne, encaissée hors application. On le note pour le savoir, sans
--    l'ajouter au chiffre d'affaires — sinon les rapports mensuels
--    surestimeraient le CA, et le patron paierait ses fees sur une recette
--    qu'il n'a pas eue.
--
-- Le ticket de cuisine garde son prix : une cuisine ne connaît pas les tarifs.
-- Les modificateurs y apparaissent en toutes lettres, par contre — « bien
-- cuit » sans prix est précisément l'information utile.
-- ============================================================

-- ─── 1. Modificateurs ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_modifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Supplément facturé, jamais négatif : « sans lactose » ne rapporte pas.
  extra_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_price >= 0),
  -- Un modificateur peut être obligatoire (cuisson) ou au choix (sauce). Une
  -- cuisson obligatoire refusée à la commande bloquerait la vente : c'est le
  -- rôle du serveur, pas d'une contrainte SQL.
  is_required boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_modifiers_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_product_modifiers_product
  ON product_modifiers(product_id);

ALTER TABLE product_modifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "modifiers_read" ON product_modifiers;
CREATE POLICY "modifiers_read" ON product_modifiers
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire la carte : patron ou manager, comme les recettes et la salle.
DROP POLICY IF EXISTS "modifiers_write" ON product_modifiers;
CREATE POLICY "modifiers_write" ON product_modifiers
  FOR ALL
  USING (
    owner_id = get_business_owner_id() AND can_manage_products()
  )
  WITH CHECK (
    owner_id = get_business_owner_id() AND can_manage_products()
  );

-- ─── 2. Choix du client sur une ligne de commande ───────────
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS modifier text;

ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS extra_price numeric(12,2) NOT NULL DEFAULT 0;

-- ADD COLUMN IF NOT EXISTS est sans effet sur une colonne EXISTANTE : le CHECK
-- voyage avec elle. On garde donc les contraintes dans des blocs IF EXISTS,
-- séparés — c'est la seule forme rejouable ici, un ADD CONSTRAINT n'ayant pas
-- d'équivalent idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_items_extra_price_check'
  ) THEN
    ALTER TABLE restaurant_order_items
      ADD CONSTRAINT restaurant_order_items_extra_price_check CHECK (extra_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_items_modifier_len'
  ) THEN
    ALTER TABLE restaurant_order_items
      ADD CONSTRAINT restaurant_order_items_modifier_len
      CHECK (modifier IS NULL OR length(modifier) <= 120);
  END IF;
END;
$$;

-- ─── 3. Plat du jour ────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_daily_special boolean NOT NULL DEFAULT false;

-- ─── 4. Pourboire ───────────────────────────────────────────
ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS tip numeric(12,2) NOT NULL DEFAULT 0 CHECK (tip >= 0);

-- ─── 5. Le ticket de cuisine, avec les modificateurs ────────
-- DROP puis CREATE, et non CREATE OR REPLACE : la nouvelle colonne `modifier`
-- est insérée AU MILIEU de la liste (après `note`), et PostgreSQL refuse de
-- renommer une colonne existante — « cannot change name of view column status
-- to modifier ». C'est la seule raison du DROP ; la vue ne porte aucun état.
DROP VIEW IF EXISTS restaurant_kitchen_ticket;

CREATE VIEW restaurant_kitchen_ticket
WITH (security_invoker = true)
AS
SELECT
  ro.id            AS order_id,
  t.name           AS table_name,
  t.zone           AS zone,
  ro.opened_at,
  i.id             AS item_id,
  p.name           AS product_name,
  i.quantity,
  i.note,
  i.modifier,
  i.status,
  i.created_at
FROM restaurant_orders ro
LEFT JOIN restaurant_tables t ON t.id = ro.table_id
JOIN restaurant_order_items i ON i.order_id = ro.id
JOIN products p ON p.id = i.product_id
WHERE ro.status <> 'closed';

REVOKE ALL ON restaurant_kitchen_ticket FROM anon;
GRANT SELECT ON restaurant_kitchen_ticket TO authenticated, service_role;

COMMENT ON COLUMN restaurant_order_items.modifier IS
  'Modificateur choisi (cuisson, sauce, portion). Affiché tel quel au ticket de '
  'cuisine, SANS son prix : une cuisine ne connaît pas les tarifs.';

COMMENT ON COLUMN restaurant_orders.tip IS
  'Pourboire laissé sur la table. Informatif : il n''entre NI dans le chiffre '
  'd''affaires NI dans les recettes, c''est une manne encaissée hors application.';

-- ─── 6. Clôture : pourboire et modificateurs ────────────────
-- Le prix unitaire d'une ligne devient prix + supplément : c'est ce qui est
-- réellement servi. Le modificateur ne change que le prix, pas le stock
-- décrémenté — un supplément de fromage consomme le fromage, mais ce lien
-- ingredients n'est pas modélisé ici (les recettes le couvrent déjà).
CREATE OR REPLACE FUNCTION close_table_order(
  p_order_id       uuid,
  p_payment_method text,
  p_amount_paid    numeric(12,2) DEFAULT NULL,
  p_split_count    int          DEFAULT 1,
  p_client_phone   text         DEFAULT NULL,
  p_note           text         DEFAULT NULL,
  p_tip            numeric(12,2) DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_order   restaurant_orders%ROWTYPE;
  v_items   jsonb;
  v_sale    jsonb;
  v_sale_id uuid;
  v_total   numeric(12,2);
  v_paid    numeric(12,2);
  v_tip     numeric(12,2);
  v_table   text;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- SECURITY DEFINER ignore les policies : le rôle se vérifie ici.
  --
  -- L'ADMINISTRATION de la salle est réservée au patron et aux managers — pas
  -- question de donner ce pouvoir à un caissier.
  --
  -- L'ENCAISSEMENT, en revanche, est ouvert à quiconque est dans l'équipe. La
  -- règle était ici plus stricte que sur la caisse, et c'était une incohérence
  -- coûteuse : create_sale() n'examine pas le rôle — un caissier encaisse au
  -- comptoir tous les jours — alors qu'il ne pouvait pas solder une table dont
  -- il venait de servir les plats. Dans un maquis, le personnel est employé :
  -- il ramasse l'argent, et il ne pouvait pas l'écrire. Le patron devait solder
  -- une addition après l'autre, ce qui est exactement le mode de
  -- fonctionnement que le logiciel était censé supprimer.
  --
  -- Ce que la vente reste patronale dans TOUS les cas : ci-dessous,
  -- create_sale() écrit la vente avec user_id = v_owner, jamais avec
  -- l'identifiant de celui qui appuie sur le bouton. Ouvrir l'encaissement au
  -- caissier ne déplace donc ni le chiffre d'affaires, ni le crédit de la vente,
  -- ni les commissions éventuelles. Il lui donne seulement le geste qu'il
  -- fait déjà au comptoir.
  --
  -- Le montant facturé est lu dans les LIGNES DE COMMANDE, jamais reçu du
  -- client : un caissier ne peut pas faire encaisser 100 F en appelant la
  -- fonction, le montant à payer est celui qui était affiché à l'écran.
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

  -- Un pourboire négatif ou absurde (10 fois l'addition) est une faute de
  -- saisie. Le plafond est large mais fini : personne ne laisse 500 000 F
  -- de pourboire sur une table à 20 000 F.
  v_tip := round(COALESCE(p_tip, 0), 2);
  IF v_tip < 0 THEN
    RAISE EXCEPTION 'Le pourboire ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_table FROM restaurant_tables WHERE id = v_order.table_id;
  v_table := COALESCE(v_table, 'à emporter');

  -- Le prix unitaire inclut le supplément du modificateur.
  --
  -- Regroupement par (produit, PRIX EFFECTIF), jamais par produit seul.
  -- L'ancien code faisait min(unit_price + extra_price) par produit : deux
  -- lignes du MÊME plat avec deux options différentes — une double portion
  -- puis « bien cuit » — étaient fusionnées, et seul le supplément le moins
  -- cher survivait. Une table à 10 500 F était encaissée 9 000 F, sans que
  -- l'écran et le reçu divergent : ils divergeaient du prix affiché.
  --
  -- La fusion reste juste quand elle doit l'être : deux lignes du même plat au
  -- MÊME prix (deux « bien cuit ») redeviennent une ligne de quantité 2, ce que
  -- create_sale() exige — il refuse deux prix différents pour un même article.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id, 'quantity', a.quantity, 'unit_price', a.unit_price)), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3) AS quantity,
             (i.unit_price + i.extra_price)::numeric(12,2) AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id
       GROUP BY i.product_id, (i.unit_price + i.extra_price)
    ) AS a;

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
      v_items, p_payment_method,
      NULLIF(btrim(COALESCE(v_order.customer_name, '')), ''),
      COALESCE(p_note, 'Table ' || v_table)
    );
  END IF;

  v_sale_id := (v_sale->>'id')::uuid;

  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_total THEN
      RAISE EXCEPTION 'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_total;
  END IF;

  UPDATE restaurant_orders
     SET status = 'closed', closed_at = now(), sale_id = v_sale_id,
         split_count = p_split_count, payment_method = p_payment_method,
         amount_paid = v_paid, tip = v_tip
   WHERE id = p_order_id;

  -- Le pourboire est HORS du total_amount de la vente : une manne n'est pas
  -- une recette. Le renvoyer à part permet à l'écran de dire « 36 000 + 5 000
  -- de pourboire » sans que la caisse ne compte 41 000.
  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_total,
    'amount_paid',    v_paid,
    'tip',            v_tip,
    'total_with_tip', v_total + v_tip,
    'split_count',    p_split_count,
    'per_share',      round(v_total / p_split_count, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) TO authenticated;

-- La version à 6 arguments est RETIRÉE : PostgREST résout par NOMBRE
-- d'arguments, et deux signatures proches créeraient une ambiguïté silencieuse
-- (« function close_table_order(...) is not unique »). Seule la 7-arg reste.
DROP FUNCTION IF EXISTS close_table_order(uuid, text, numeric, int, text, text);

COMMENT ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) IS
  'Solde une addition : les lignes (modificateur inclus) deviennent une vente via '
  'create_sale(), la commande est close. Le fractionnement n''écrit QU''une vente. '
  'Le pourboire est enregistré mais HORS du chiffre d''affaires : c''est une '
  'manne, pas une recette.';

-- ─── 7. Réservations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  -- Le premier slot sert : « 12h30 » plutôt que « 2026-10-04 12:30 », le patron
  -- n'a qu'un service par jour à retenir.
  slot_at      timestamptz NOT NULL,
  party_size   int NOT NULL DEFAULT 2 CHECK (party_size > 0),
  phone        text,
  table_id     uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  -- confirmed = le patron a appelé · seated = le client est arrivé · done = parti
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'seated', 'done', 'no_show')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_reservations_name_len CHECK (length(btrim(customer_name)) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_reservations_slot
  ON restaurant_reservations(owner_id, slot_at)
  WHERE status NOT IN ('done', 'no_show');

ALTER TABLE restaurant_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reservations_read" ON restaurant_reservations;
CREATE POLICY "reservations_read" ON restaurant_reservations
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire une réservation n'est pas un acte de gestion : un caissier prend
-- les réservations au téléphone. Il ne les annule pas pour autant — une
-- résiliation est une décision du patron.
DROP POLICY IF EXISTS "reservations_write" ON restaurant_reservations;
CREATE POLICY "reservations_write" ON restaurant_reservations
  FOR ALL
  USING (owner_id = get_business_owner_id())
  WITH CHECK (owner_id = get_business_owner_id());

-- ============================================================
--  ⬇ migration_menu_days.sql
-- ============================================================

-- ============================================================
-- MIGRATION RESTAURATION : CARTE PAR JOUR DE LA SEMAINE
-- À exécuter dans Supabase SQL Editor, après migration_restaurant_finitions.sql
--
-- `is_daily_special` (Sprint 16) est un drapeau simple : il dit « servi
-- aujourd'hui », et rien de plus. Un vrai restaurant ne sert pas le même plat
-- le mardi et le vendredi — le poisson le vendredi, la viande le samedi, le
-- poulet braisé tous les jours. Un simple booléen oblige le patron à
-- modifier la carte chaque matin, ce qu'il ne fera pas : la carte affichée
-- proposerait des plats qu'on ne cuisine pas.
--
-- menu_days : un tableau de jours de semaine, 0 = dimanche … 6 = samedi.
-- NULL = tous les jours — c'est le cas d'un plat de base, et le défaut, pour
-- qu'un plat créé depuis Stock (hors module restaurant) reste disponible sans
-- avoir à le configurer.
--
-- Le choix se fait dans l'interface par cases à cocher, jamais par une saisie
-- de nombres : un patron ne pense pas « 3, 4 et 5 ».
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS menu_days int[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_menu_days_valid'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_menu_days_valid
      CHECK (menu_days IS NULL OR (
        cardinality(menu_days) BETWEEN 1 AND 7
        AND menu_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
      ));
  END IF;
END;
$$;

COMMENT ON COLUMN products.menu_days IS
  'Jours de service, 0 = dimanche … 6 = samedi. NULL = tous les jours. '
  'Une carte qui propose un plat non servi est pire qu''une carte courte : '
  'le client commande ce qu''il voit.';

-- ─── Vue de la carte du jour ─────────────────────────────────
-- La salle ne liste QUE ce qui se cuisine aujourd'hui. Sans elle, chaque
-- commande du service passe par un filtre côté navigateur, et une tablesans
-- filtre — un export, un script, l'écran d'inventaire — proposerait à tort le
-- plat du mardi le mardi matin.
CREATE OR REPLACE VIEW restaurant_menu_today
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.category,
  p.price_sell,
  p.stock_qty,
  p.unit,
  p.is_daily_special,
  p.menu_days,
  -- NULL = tous les jours. extract(dow) donne 0 pour dimanche.
  (p.menu_days IS NULL
    OR (extract(dow FROM now())::int) = ANY (p.menu_days)) AS servi_aujourdhui,
  (SELECT count(*) FROM recipe_ingredients r WHERE r.dish_id = p.id) AS ingredient_count,
  product_cost(p.id) AS unit_cost
FROM products p
WHERE p.is_active;

COMMENT ON VIEW restaurant_menu_today IS
  'Carte du jour : les plats servis AUJOURD''HUI. security_invoker : '
  'l''isolation reste celle des policies de products.';

REVOKE ALL ON restaurant_menu_today FROM anon;
GRANT SELECT ON restaurant_menu_today TO authenticated, service_role;

-- ============================================================
--  ⬇ migration_ca_caisse.sql
-- ============================================================

-- ═══ Base de caisse : une seule définition du chiffre d'affaires ═══
--
-- Trouvé en recette navigateur le 04/10/2026 : deux écrans de la même
-- application, le même jour, la même boutique, deux chiffres d'affaires
-- différents — 42 300 F sur « Ventes » et « Rapports → Ventes », 34 300 F sur
-- « Rapports → Rentabilité ». L'écart valait exactement la dette non réglée.
--
-- La cause tient en une ligne : get_sales_summary() comptait
-- SUM(total_amount) — ce qui a été FACTURÉ — là où get_cash_flow() et
-- get_product_profitability() comptent SUM(amount_received), ce qui est
-- réellement ENCAISSÉ. Chacune des deux versions était justifiée dans son
-- fichier, et incompatible avec l'autre.
--
-- Ce qui tranche n'est pas une préférence : c'est une phrase que
-- l'application affiche déjà au commerçant, sur l'écran Dettes —
--
--   « Une vente à crédit n'entre pas dans le chiffre d'affaires : elle y
--     entre quand vous encaissez. Le stock, lui, est sorti dès la vente. »
--
-- Deux écrans sur trois contredisaient cette phrase. On aligne le troisième
-- sur elle. La base de caisse est aussi celle que la rentabilité et le
-- résultat net utilisaient déjà, et la seule qui ne bouge pas le jour où un
-- client paye trois semaines plus tard.
--
-- Rappel du choix, identique à celui de migration_expenses.sql : un règlement
-- encaissé aujourd'hui sur une vente d'hier est imputé à la DATE DE LA VENTE.
-- Rattacher au jour du versement donnerait un résultat net qui bouge un jour
-- où aucune vente n'a eu lieu — impossible à lire pour un commerçant, et sans
-- rapport avec ce que sa caisse contient réellement.


-- ─── 1. Les versements doivent dire QUELLE vente ils soldent ──────────────
--
-- Deuxième volet du même défaut, trouvé dans la même recette. Un règlement
-- de dette encaissé en espèces n'apparaissait dans AUCUN total : ni « Espèces »
-- ni « Mobile Money ». Le commerçant qui reçoit 8 000 F en liquide d'un client
-- voyait son chiffre d'affaires diminuer ce jour-là.
--
-- credit_payments ne portait que debt_id : rattacher un règlement à une vente
-- demandait de rejouer ici la répartition FIFO — un second calcul de la même
-- règle, qui divergerait à la première évolution de pay_customer_debt(). La
-- répartition est déjà faite dans cette fonction, vente par vente, à
-- l'instant où elle a lieu. Il suffisait de l'y écrire.
--
-- Une vente peut être soldée par plusieurs versements, et un versement peut
-- solder plusieurs ventes (les plus anciennes d'abord). D'où une ligne par
-- couple : amount est la part du règlement qui couvre CETTE vente, pas le
-- règlement entier.
--
-- gesture_id sert à retrouver le geste derrière ces lignes. L'écran Dettes
-- affiche « 3 ventes, 2 versements » : sans lui, un règlement qui solde trois
-- ventes d'un coup serait compté trois fois, et l'historique annoncerait au
-- client plus de passages en caisse qu'il n'en a fait. Une valeur par défaut
-- aléatoire donne une ligne par geste pour l'historique déjà en base — ce qui
-- est exact, ces gestes n'ayant jamais été ventilés.

ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS sale_id uuid
  REFERENCES sales(id) ON DELETE CASCADE;

ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS gesture_id uuid
  NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_credit_payments_sale ON credit_payments(sale_id)
  WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_payments_gesture ON credit_payments(gesture_id);

COMMENT ON COLUMN credit_payments.sale_id IS
  'Vente que ce règlement solde. NULL = acompte à la vente antérieur à cette '
  'migration, ou versement supérieur à la dette (crédit restant au client). '
  'C''est ce lien qui permet de répartir un règlement en espèces ou en MoMo sur '
  'le jour de la vente — sans lui, l''argent reçu d''un client pour solder sa '
  'dette ne rattachait à aucun total de caisse.';

COMMENT ON COLUMN credit_payments.gesture_id IS
  'Identifiant du geste de caisse. Plusieurs lignes peuvent partager le même '
  'gesture quand un règlement solde plusieurs ventes : c''est un versement, '
  'ventilé. L''écran Dettes compte les DISTINCT gesture_id pour ne pas '
  'annoncer au client plus de versements qu''il n''en a faits.';


-- ─── 2. La synthèse, en base de caisse ────────────────────────────────────
--
-- Le type de retour ne change pas : CREATE OR REPLACE suffit, et les deux
-- appelants (Historique des ventes, Rapports) n'ont rien à modifier.
--
-- Les versements sont agrégés par vente AVANT la jointure, jamais dans une
-- sous-requête corrélée : sales.id n'est ni groupé ni agrégé, et Postgres
-- refuserait la requête. Un LEFT JOIN sur un CTE déjà réduit à une ligne par
-- vente donne le même résultat, sans dépendre du nombre de règlements.

CREATE OR REPLACE FUNCTION get_sales_summary(
  p_from date,
  p_to   date,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  day     date,
  revenue numeric,
  cash    numeric,
  momo    numeric,
  tx      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bornes AS (
    SELECT (p_from::timestamp AT TIME ZONE p_tz) AS debut,
           ((p_to + 1)::timestamp AT TIME ZONE p_tz) AS fin
  ),
  ventes AS (
    SELECT s.id,
           (s.created_at AT TIME ZONE p_tz)::date AS jour,
           s.amount_received,
           s.payment_method
      FROM sales s, bornes b
     WHERE s.created_at >= b.debut
       AND s.created_at <  b.fin
  ),
  -- Une ligne par vente, pas par règlement : sans cela un client qui solde
  -- trois dettes en un geste compterait ses versements trois fois dans le
  -- chiffre d'affaires.
  reglements AS (
    SELECT cp.sale_id,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'cash'), 0) AS cash,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'momo'), 0) AS momo
      FROM credit_payments cp
     WHERE cp.sale_id IS NOT NULL
     GROUP BY 1
  )
  SELECT
    v.jour                                                  AS day,
    -- Ce qui est réellement rentré, pas ce qui a été facturé : amount_received
    -- est la seule colonne qui distingue « j'ai vendu 9 000 » de « j'ai reçu
    -- 1 000 maintenant ».
    COALESCE(SUM(v.amount_received), 0)                     AS revenue,
    -- Les deux parts sortent du même montant que le total, et les règlements de
    -- dettes s'y ajoutent par LEUR moyen : un client qui solde sa dette en
    -- espèces a bien donné des espèces. Avant, ce cash-là n'entrait nulle part,
    -- et les modes de paiement ne correspondaient pas au chiffre d'affaires
    -- affiché juste au-dessus — sur la même carte.
    COALESCE(SUM(v.amount_received) FILTER (WHERE v.payment_method = 'cash'), 0)
      + COALESCE(SUM(r.cash), 0)                           AS cash,
    COALESCE(SUM(v.amount_received) FILTER (WHERE v.payment_method = 'momo'), 0)
      + COALESCE(SUM(r.momo), 0)                           AS momo,
    COUNT(*)                                                AS tx
  FROM ventes v
  LEFT JOIN reglements r ON r.sale_id = v.id
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION get_sales_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO service_role;

COMMENT ON FUNCTION get_sales_summary(date, date, text) IS
  'Chiffre d''affaires en BASE DE CAISSE : somme de amount_received, pas de '
  'total_amount. Une vente à crédit n''y entre qu''à l''encaissement de ce qui a '
  'été versé, rattaché au jour de la vente. Même base que get_cash_flow() et '
  'get_product_profitability() — trois écrans ne doivent pas afficher trois '
  'chiffres pour la même journée. cash et momo incluent les règlements de '
  'dettes, par leur moyen de paiement.';


-- ─── 3. Les versements qui alimentent cette répartition ───────────────────
--
-- record_credit_sale() : l'acompte est versé À LA VENTE, il connaît donc la
-- vente qu'il couvre. pay_customer_debt() : c'est la boucle de répartition
-- qui sait, pour chaque tour, combien va à quelle vente.
--
-- L'acompte gagne p_advance_method. Il était écrit en « cash » par défaut —
-- un moyen déduit, jamais choisi : l'argent réellement reçu à la vente peut
-- être en espèces comme en MoMo, et sa part de caisse doit suivre le vrai
-- geste du client. Le défaut reste « cash » : un appel qui ne précise pas
-- p_advance_method (l'acompte d'une table n'a pas de moyen enregistré en base)
-- reçoit « cash ».
--
-- DROP de l'ancienne arité AVANT la nouvelle : CREATE OR REPLACE crée une
-- surcharge au lieu de remplacer, et PostgREST continuerait à servir la
-- version à cinq arguments — le client n'enverrait jamais son champ (README,
-- section « paramètre ajouté »).

DROP FUNCTION IF EXISTS record_credit_sale(jsonb, text, text, text, numeric);

CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items          jsonb,
  p_client_name    text,
  p_client_phone   text,
  p_note           text          DEFAULT NULL,
  p_advance        numeric(12,2) DEFAULT 0,
  p_advance_method text          DEFAULT 'cash'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_name     text;
  v_phone    text;
  v_avance   numeric(12,2);
  v_total    numeric(12,2);
  v_du       numeric(12,2);
  v_sale     jsonb;
  v_sale_id  uuid;
  v_debt_id  uuid;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_client_name IS NULL OR btrim(p_client_name) = '' THEN
    RAISE EXCEPTION 'Indiquez le nom du client' USING ERRCODE = '22023';
  END IF;
  v_name := btrim(p_client_name);

  v_phone := normalize_phone(p_client_phone);
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Le numéro de téléphone est obligatoire pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  IF p_advance IS NULL OR p_advance < 0 THEN
    RAISE EXCEPTION 'L''avance versée ne peut pas être négative' USING ERRCODE = '22023';
  END IF;
  v_avance := p_advance;

  -- Le moyen n'est lu que s'il y a acompte : sans argent reçu, la ligne de
  -- versement n'existe pas. Même garde-fou que credit_payments_method_valid,
  -- mais levé AVANT create_sale() — le stock n'est pas encore sorti et la
  -- vente n'existe pas, donc rien à annuler.
  IF v_avance > 0
     AND (p_advance_method IS NULL OR p_advance_method NOT IN ('cash', 'momo')) THEN
    RAISE EXCEPTION 'Moyen de paiement de l''acompte invalide : %', p_advance_method
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('credit.internal', '1', true);
  v_sale := create_sale(p_items, 'credit', v_name, p_note);
  PERFORM set_config('credit.internal', NULL, true);
  v_sale_id := (v_sale->>'id')::uuid;
  v_total := (v_sale->>'total_amount')::numeric(12,2);

  IF v_avance > v_total THEN
    RAISE EXCEPTION
      'L''avance versée (% F) dépasse le prix de la vente (% F)', v_avance, v_total
      USING ERRCODE = '22023';
  END IF;

  -- amount_received porte ce qui est réellement rentré : c'est la seule colonne
  -- qui décide du chiffre d'affaires. settled reste dérivé — il ne sert plus
  -- qu'à l'indexation des dettes en cours.
  UPDATE sales
     SET amount_received = v_avance,
         settled = (v_avance >= v_total),
         client_phone = v_phone
   WHERE id = v_sale_id;

  -- Fiche client créée à la première dette, réutilisée ensuite. ON CONFLICT DO
  -- UPDATE garde le nom à jour : « Maman Koffi » devient « Mme Koffi ».
  INSERT INTO customer_debts (user_id, phone, name)
  VALUES (v_owner, v_phone, v_name)
  ON CONFLICT (user_id, phone) DO UPDATE
    SET name = EXCLUDED.name,
        updated_at = now();

  SELECT id INTO v_debt_id
    FROM customer_debts
   WHERE user_id = v_owner AND phone = v_phone;

  -- L'acompte entre aussi dans l'historique des versements. Pas pour calculer la
  -- dette — ça, c'est amount_received — mais pour que la question « il m'a déjà
  -- donné combien ? » ait une réponse datée, avec son moyen de paiement. C'est
  -- aussi ce que l'écran Dettes affiche en « versements », et ce qu'un client
  -- conteste éventuellement.
  --
  -- sale_id renseigné : l'acompte couvre CETTE vente, et sa part de caisse
  -- suit le moyen choisi à la vente — p_advance_method, plus « cash » déduit.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id)
    VALUES (v_debt_id, v_owner, v_avance, current_date, p_advance_method,
            'Acompte versé à la vente', v_sale_id);
  END IF;

  v_du := v_total - v_avance;

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'total_amount',    v_total,
    -- Reste à recouvrer, renvoyé pour que l'écran n'ait pas à le recalculer et
    -- risquer un arrondi différent de celui de la base.
    'amount_advance',  v_avance,
    'amount_due',      v_du,
    'invoice_number',  v_sale->>'invoice_number',
    'debt_id',         v_debt_id,
    'client_phone',    v_phone
  );
END;
$$;

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text) TO service_role;

COMMENT ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text) IS
  'Vente à crédit. p_advance est l''acompte versé sur-le-champ (0 = crédit '
  'total), p_advance_method son moyen — cash ou momo, choisi à la vente. '
  'L''acompte compte au chiffre d''affaires le jour même, réduit la dette et '
  'ventile sa part de caisse selon ce moyen. Le stock part dans tous les cas.';


CREATE OR REPLACE FUNCTION pay_customer_debt(
  p_debt_id uuid,
  p_amount  numeric(12,2),
  p_method  text DEFAULT 'cash',
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner        uuid;
  v_phone        text;
  v_user_id      uuid;
  v_restant      numeric(12,2);
  v_avant        numeric(12,2);
  -- Ce qui manque sur la vente en cours de traitement. Différent de v_restant,
  -- qui est le reliquat de trésorerie : les deux se confondent vite, et les
  -- confondre ferait solder une vente par de l'argent destiné à une autre.
  v_du           numeric(12,2);
  v_part         numeric(12,2);
  v_reglees      int := 0;
  v_sale         record;
  v_note         text;
  v_gesture      uuid := gen_random_uuid();
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- Sans FOR UPDATE explicite ici, deux caisses encaissant en même temps
  -- pourraient toutes deux solder la même vente. Verrou de ligne sur la fiche.
  SELECT phone, user_id INTO v_phone, v_user_id
    FROM customer_debts
   WHERE id = p_debt_id
   FOR UPDATE;

  IF NOT FOUND OR v_user_id <> v_owner THEN
    -- Message identique à « introuvable » : un patron ne doit pas pouvoir
    -- deviner l'existence d'une fiche d'un autre tenant.
    RAISE EXCEPTION 'Client introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant de versement invalide' USING ERRCODE = '22023';
  END IF;

  IF p_method IS NULL OR p_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_method USING ERRCODE = '22023';
  END IF;

  -- Solde avant versement : ce qui manque sur les ventes ouvertes de ce client.
  -- Une simple somme de différences, juste par construction. La version
  -- précédente soustrayait un cumul de versements d'un cumul de prix, et
  -- reconstituait la répartition dans la boucle — deux calculs à tenir d'accord,
  -- donc une occasion de diverger. Ici il n'y a rien à reconstituer.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_avant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  IF v_avant <= 0 THEN
    RAISE EXCEPTION 'Ce client n''a pas de dette en cours' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(btrim(COALESCE(p_note, '')), '');

  -- Répartit le versement sur les ventes ouvertes, de la plus ancienne à la plus
  -- récente. Chaque vente reçoit ce qui lui manque, pas plus.
  --
  -- On boucle sur un curseur simple, sans FOR UPDATE : le verrou utile est posé
  -- sur la fiche client plus haut, ce qui sérialise deux caisses encaissant pour
  -- le même client. Verrouiller aussi chaque ligne ici n'apporte rien et, dans
  -- un FOR ... LOOP PL/pgSQL, n'itère pas sur la snapshot attendue.
  --
  -- Le reliquat porte aussi les acomptes déjà versés à la vente : c'est
  -- amount_received qui dit ce qui a été couvert, pas le montant de ce versement.
  -- C'est ce qui rend le calcul insensible à l'ordre des appels — deux versements
  -- de 8 000 puis 12 000 soldent une vente de 20 000, comme un seul de 20 000.
  --
  -- UN ENREGISTREMENT DE VERSEMENT PAR VENTE SOLDÉE, amount valant la part qui
  -- la couvre. C'est ce qui rattache l'argent reçu au bon jour et au bon moyen
  -- dans le chiffre d'affaires : avant, un règlement en espèces encaissé sur une
  -- dette n'entrait dans aucun total, et le jour où le client payait, la caisse
  -- du commerçant paraissait diminuer. Un geste peut donc donner plusieurs
  -- lignes — même montant, même note : un règlement, ventilé sur ce qu'il solde.
  v_restant := p_amount;

  FOR v_sale IN
    SELECT s.id, s.total_amount, s.amount_received
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_phone = v_phone
       AND NOT s.settled
     ORDER BY s.created_at ASC
  LOOP
    EXIT WHEN v_restant <= 0;

    -- Ce qui manque sur CETTE vente, l'acompte éventuel étant déjà déduit.
    v_du := v_sale.total_amount - v_sale.amount_received;
    IF v_du <= 0 THEN
      CONTINUE;
    END IF;

    IF v_restant >= v_du THEN
      v_part := v_du;
      UPDATE sales
         SET amount_received = total_amount,
             settled = true
       WHERE id = v_sale.id;
      v_restant := v_restant - v_du;
      v_reglees := v_reglees + 1;
    ELSE
      -- Paiement partiel : la vente reste ouverte, et ce reliquat devient du
      -- chiffre d'affaires encaissé dès aujourd'hui.
      v_part := v_restant;
      UPDATE sales SET amount_received = amount_received + v_restant WHERE id = v_sale.id;
      v_restant := 0;
    END IF;

    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id, gesture_id)
    VALUES (p_debt_id, v_owner, v_part, current_date, p_method, v_note, v_sale.id, v_gesture);
  END LOOP;

  -- Ce qui dépasse la dette restant due reste au client. Enregistré sans
  -- sale_id : il ne solde aucune vente, et ne doit donc entrer dans aucun total.
  IF v_restant > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id, gesture_id)
    VALUES (p_debt_id, v_owner, v_restant, current_date, p_method, v_note, NULL, v_gesture);
  END IF;

  -- Solde final : ce qui n'a pas couvert une vente entière reste dû.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_restant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  UPDATE customer_debts SET updated_at = now() WHERE id = p_debt_id;

  RETURN jsonb_build_object(
    'debt_id',        p_debt_id,
    'amount_paid',    p_amount,
    'balance_before', v_avant,
    'balance_after',  GREATEST(v_restant, 0),
    'sales_settled',  v_reglees
  );
END;
$$;

REVOKE ALL ON FUNCTION pay_customer_debt(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay_customer_debt(uuid, numeric, text, text) TO authenticated;


-- ─── 4. Le nombre de versements reste un nombre de gestes ─────────────────
--
-- La répartition ventile un règlement en une ligne par vente soldée.
-- get_customer_debts() comptait les LIGNES et affichait le résultat sous le
-- mot « versements » : un règlement soldant trois ventes serait annoncé au
-- client comme trois versements. Il compte désormais les gestes.
--
-- Cette fonction était définie par migration_credit_fns.sql, dont on ne
-- rejoue pas l'intégralité : seule la clause payments_count change.

CREATE OR REPLACE FUNCTION get_customer_debts()
RETURNS TABLE (
  debt_id         uuid,
  phone           text,
  name            text,
  total_due       numeric,
  last_sale_at    timestamptz,
  sales_count     bigint,
  oldest_sale_at  timestamptz,
  payments_count  bigint,
  last_payment_at date,
  -- Ce que le client a déjà versé sur ses ventes en cours. Affiché à côté du
  -- solde : « 130 000 dont 50 000 déjà payés » est plus parlant qu'un 80 000
  -- nu, et c'est la phrase à prononcer au comptoir.
  total_paid      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                 AS total_paid,
      COUNT(*)                               AS sales_count,
      MAX(s.created_at)                      AS last_sale_at,
      MIN(s.created_at)                      AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  ), soldes AS (
    SELECT
      d.id,
      d.user_id,
      d.phone,
      d.name,
      GREATEST(COALESCE(u.total_due, 0), 0) AS total_due,
      u.last_sale_at,
      COALESCE(u.sales_count, 0) AS sales_count,
      u.oldest_sale_at,
      COALESCE(u.total_paid, 0) AS total_paid,
      -- DISTINCT gesture_id, et non COUNT(*) : un règlement qui solde
      -- plusieurs ventes est ventilé en autant de lignes, et cet écran
      -- annonce « X versements » au client. Compter les lignes lui
      -- annoncerait plus de passages en caisse qu'il n'en a réellement faits.
      (SELECT COUNT(DISTINCT cp2.gesture_id) FROM credit_payments cp2
        WHERE cp2.debt_id = d.id) AS payments_count,
      (SELECT MAX(cp3.day) FROM credit_payments cp3 WHERE cp3.debt_id = d.id) AS last_payment_at
    FROM customer_debts d
    LEFT JOIN dues u ON u.user_id = d.user_id AND u.client_phone = d.phone
  )
  SELECT s.id, s.phone, s.name, s.total_due, s.last_sale_at, s.sales_count,
         s.oldest_sale_at, s.payments_count, s.last_payment_at, s.total_paid
    FROM soldes s
   WHERE s.user_id = get_business_owner_id()
     -- VERROU DE PLAN. Le carnet de dette fait partie des rapports : c'est ce
     -- qui est vendu avec le plan Starter. Sans ce garde, un client en plan
     -- gratuit liste ses débiteurs en appelant la fonction en RPC, alors que le
     -- cadenas de l'onglet l'en empêche dans l'interface.
     --
     -- Le solde d'un client n'est pas une information anodine : c'est la liste
     -- des personnes qui doivent de l'argent à la boutique, avec leur numéro de
     -- téléphone. Le RLS protège le voisin, pas le plan.
     AND (SELECT true FROM require_feature('reports'))
     -- Une dette soldée n'a plus rien à réclamer. Sans ce critère, la fiche
     -- persiste et l'écran montre un client à 0 F comme s'il devait de l'argent.
     AND s.total_due > 0
   ORDER BY s.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION get_customer_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_customer_debts() TO authenticated;


-- ─── 5. Les versements antérieurs sont rattachés à la vente qu'ils soldent ─
--
-- Sur une base déjà en service, credit_payments.sale_id est NULL partout. Le
-- chiffre d'affaires reste juste — il compte amount_received, renseigné depuis
-- migration_partial_payment.sql — mais les règlements passés n'entrent dans
-- aucune répartition par moyen de paiement. Ce manque ne se voit que sur
-- l'historique, se corrige à la prochaine saisie, et ne vaut pas un
-- inventaire.
--
-- Seuls les acomptes à la vente sont rattachables, et ils le sont sans
-- ambiguïté : la note le dit mot pour mot, et l'acompte a été versé LE JOUR DE
-- LA VENTE — c'est ce que signifie la note. D'où le rapprochement sur
-- (client, jour calendaire de la vente), en prenant la plus ancienne vente du
-- jour qui pouvait recevoir ce montant : c'est l'ordre FIFO que
-- pay_customer_debt() applique déjà.
--
-- Les règlements ordinaires, eux, ne sont PAS rattachés : sans trace de la
-- répartition à l'époque, il faudrait deviner, et une dette rattachée à la
-- mauvaise vente vaut moins qu'une dette dont la ventilation n'apparaît pas.
UPDATE credit_payments cp
   SET sale_id = (
     SELECT s.id
       FROM sales s
       JOIN customer_debts d ON d.id = cp.debt_id
      WHERE s.user_id = cp.user_id
        AND s.client_phone = d.phone
        AND (s.created_at AT TIME ZONE (
              SELECT o.timezone FROM organizations o WHERE o.id = s.user_id
            ))::date = cp.day
        AND s.amount_received >= cp.amount
      ORDER BY s.created_at ASC
      LIMIT 1
   )
 WHERE cp.sale_id IS NULL
   AND cp.note = 'Acompte versé à la vente';

-- ============================================================
--  ⬇ migration_facture_sequentielle.sql
-- ============================================================

-- ============================================================================
-- Facturation : une boutique ne doit jamais pouvoir être bloquée en vente.
-- ============================================================================
--
-- Le problème
-- -----------
-- Le numéro de facture vient de `organizations.invoice_counter`, incrémenté
-- par `create_sale()`. L'unicité est garantie par
-- `idx_sales_invoice_number (user_id, invoice_number)`.
--
-- Le compteur et les factures existantes sont deux informations distinctes, et
-- rien ne les rapprochait. Toute écriture d'une facture qui ne passe pas par
-- `create_sale()` désaligne le compteur :
--
--   - une facture saisie à la main (rattrapage après incident) ;
--   - une restauration de sauvegarde ;
--   - une reprise de données de migration ou d'import ;
--   - un compteur remis à zéro par une bascule de plan : le numéro n'existe
--     qu'au plan Pro, donc une boutique repassée en Starter puis revenue à Pro
--     repart de 1 alors que ses factures Pro sont toujours là.
--
-- Conséquence : `create_sale()` se prend une violation d'unicité, le
-- commerçant voit « La vente n'a pas été enregistrée », le stock n'est pas
-- décrémenté — et surtout il ne peut PLUS VENDRE. Aucun montant, aucun client,
-- aucune quantité ne débloque la boutique : seul un technicien peut. C'est le
-- seul endroit de l'application où une erreur de données rend l'outil
-- inutilisable, ce qui en fait le défaut le plus coûteux à laisser en place.
--
-- La correction, en deux temps
-- ----------------------------
-- 1. Une RÉPARATION des boutiques déjà désalignées (section 1). Elle n'écrit
--    que le compteur : idempotente, sans risque, exécutable sur une base en
--    production sans arrêt.
--
-- 2. create_sale() se RÉALIGNE lui-même avant de numéroter (section 2). Le
--    contrôle a lieu dans la transaction de la vente, sur la ligne de la
--    boutique déjà verrouillée : deux caisses qui encaissent en même temps ne
--    peuvent pas choisir le même numéro.
--
-- Lecture du numéro
-- -----------------
-- `substr(invoice_number, 10)` : le préfixe « FAC-AAAA- » occupe exactement
-- les 9 premiers caractères, la suite commence au 10ᵉ. La condition régulière
-- exige des chiffres sur toute la suite — une facture écrite dans un autre
-- format n'est pas comptée, elle ne peut donc pas faire échouer la
-- réparation. Le même découpage est utilisé partout, y compris dans
-- create_sale() : une seule lecture, donc un seul risque de divergence.
--
-- L'ANNÉE, et non toutes les factures : janvier repart légitimement à 1
-- (FAC-2026-00001 ≠ FAC-2027-00001 pour la contrainte d'unicité), et c'est ce
-- qui rend inoffensive une facture de janvier saisie à la main.
--
-- Cette migration est un COPIE de create_sale() avec, pour seule différence,
-- le bloc de numérotation. Toute autre evolution de la fonction doit venir
-- d'ici et non de migration_weighted_sales.sql, qui est antérieure.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Réparation des boutiques déjà bloquées
-- ────────────────────────────────────────────────────────────────────────────
UPDATE organizations o
   SET invoice_counter = GREATEST(
         o.invoice_counter,
         (SELECT COALESCE(MAX(substr(s.invoice_number, 10)::int), 0)
            FROM sales s
           WHERE s.user_id = o.id
             AND s.invoice_number ~ ('^FAC-' || to_char(now(), 'YYYY') || '-[0-9]+$'))
       )
 WHERE o.invoice_counter < (
         SELECT COALESCE(MAX(substr(s.invoice_number, 10)::int), 0)
           FROM sales s
          WHERE s.user_id = o.id
            AND s.invoice_number ~ ('^FAC-' || to_char(now(), 'YYYY') || '-[0-9]+$')
       );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. create_sale() : réalignement avant numérotation
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
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
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  -- 'credit' est accepté ici mais n'est pas un encaissement : la vente est
  -- créée, le stock part, et c'est record_credit_sale() qui la marque non
  -- encaissée et rattache le téléphone. Sans ce filet, un appel direct avec
  -- 'credit' produirait une vente comptée comme encaissée sans dette derrière.
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
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
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
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
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    v_est_plat := EXISTS (
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
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = v_owner;
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
    amount_received
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice,
    CASE WHEN p_payment_method = 'credit' THEN 0 ELSE v_total END
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
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

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

-- Ce que la personne qui lit cette migration dans l'éditeur SQL doit savoir :
-- elle redépose un verrou de vente, et elle débloque les boutiques concernées.
COMMENT ON FUNCTION public.create_sale(jsonb, text, text, text) IS
  'Enregistre une vente et retourne son numéro de facture. Le compteur est '
  'réaligné sur les factures déjà émises pour l''année courante : une boutique '
  'dont le compteur a été désaligné (facture saisie à la main, restauration, '
  'bascule de plan) peut à nouveau vendre au lieu d''échouer sur une violation '
  'd''unicité qui la bloquait définitivement.';

-- ============================================================
--  ⬇ migration_facture_plan_effectif.sql
-- ============================================================

-- ============================================================
-- migration_facture_plan_effectif.sql — la facture suit le plan EFFECTIF
-- À exécuter dans Supabase SQL Editor, APRÈS migration_facture_sequentielle.sql
-- ============================================================
--
-- BUG (cohérence de plan) : create_sale() lisait le plan BRUT
-- (`o.plan = 'pro'`) pour décider d'attribuer un numéro de facture, alors que
-- current_org_plan(), require_feature() et tous les écrans lisent le plan
-- EFFECTIF (essai Starter actif, période prépayée non échue).
--
-- Conséquence : une boutique Pro PRÉPAYÉE EXPIRÉE (plan = 'pro',
-- plan_valid_until dépassée) n'a plus accès aux rapports — require_feature la
-- refuse — mais continuait d'émettre des numéros « FAC-… » et le verrou client
-- peutDelivrerFacture() la croyait encore Pro, puisque le numéro existait.
-- Deux écrans de la même pièce qui ne disaient pas la même chose.
--
-- Ce que ça change : la décision de numéroter passe par le MÊME CASE que
-- current_org_plan() et check_product_limit() — plan effectif, essai et
-- échéance compris. Un essai Starter ne donne donc pas de facture (réservée au
-- Pro payé), et une période prépayée échue n'en donne plus.
--
-- Rejouable : CREATE OR REPLACE (signature inchangée), REVOKE/GRANT idempotents.
-- ============================================================

CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
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
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  -- 'credit' est accepté ici mais n'est pas un encaissement : la vente est
  -- créée, le stock part, et c'est record_credit_sale() qui la marque non
  -- encaissée et rattache le téléphone. Sans ce filet, un appel direct avec
  -- 'credit' produirait une vente comptée comme encaissée sans dette derrière.
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
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
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
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
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    v_est_plat := EXISTS (
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
    amount_received
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice,
    CASE WHEN p_payment_method = 'credit' THEN 0 ELSE v_total END
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
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

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

-- Ce que la personne qui lit cette migration dans l'éditeur SQL doit savoir :
-- elle redépose un verrou de vente, et elle débloque les boutiques concernées.
COMMENT ON FUNCTION public.create_sale(jsonb, text, text, text) IS
  'Enregistre une vente et retourne son numéro de facture. Le compteur est '
  'réaligné sur les factures déjà émises pour l''année courante : une boutique '
  'dont le compteur a été désaligné (facture saisie à la main, restauration, '
  'bascule de plan) peut à nouveau vendre au lieu d''échouer sur une violation '
  'd''unicité qui la bloquait définitivement.';

-- ============================================================
--  ⬇ migration_offline_sales.sql
-- ============================================================

-- ============================================================
-- migration_offline_sales.sql — ventes hors-ligne idempotentes (P7)
-- À exécuter APRÈS migration_facture_plan_effectif.sql
-- ============================================================
--
-- POURQUOI : la caisse doit pouvoir encaisser sans réseau. Une vente mise en
-- file hors-ligne est rejouée au retour de la connexion — mais sa première
-- tentative a pu aboutir (réponse perdue) : sans garde, le rejeu créerait une
-- SECONDE vente, donc un double décrément de stock et un double chiffre
-- d'affaires. C'est le risque n°1 d'un mode hors-ligne, et il se règle en base,
-- pas dans le navigateur.
--
-- COMMENT : `sales.client_ref` porte un identifiant généré par la caisse
-- (uuid), unique par boutique. `create_sale()` le reçoit en 5ᵉ paramètre
-- facultatif ; s'il a déjà servi, la fonction renvoie la vente EXISTANTE au
-- lieu d'en créer une autre. Le rejeu devient donc idempotent, quelle que soit
-- la cause (réponse perdue, double clic, deux onglets).
--
-- PÉRIMÈTRE : toute vente au comptoir — espèces, MoMo ET crédit (ce dernier
-- via record_credit_sale(), rendue idempotente par migration_offline_credit.sql).
--
-- Rejouable : IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ─── 1. La référence de vente, unique par boutique ──────────
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_ref text;

COMMENT ON COLUMN sales.client_ref IS
  'Identifiant de vente généré par la caisse, unique par boutique : rend le '
  'rejeu d''une vente hors-ligne idempotent. NULL pour les ventes en ligne.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_client_ref
  ON sales (user_id, client_ref) WHERE client_ref IS NOT NULL;

-- ─── 2. create_sale() prend la référence ────────────────────
-- La signature passe de 4 à 5 arguments : on DROP l'ancienne, sinon les deux
-- coexistent et un appel à 2 arguments (les défauts couvrent 3 à 5) devient
-- ambigu — « function create_sale(unknown, unknown) is not unique ».
DROP FUNCTION IF EXISTS create_sale(jsonb, text, text, text);

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
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
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
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
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
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    v_est_plat := EXISTS (
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

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
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

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.create_sale(jsonb, text, text, text, text) IS
  'Enregistre une vente et retourne son numéro de facture. Le compteur est '
  'réaligné sur les factures déjà émises pour l''année courante : une boutique '
  'dont le compteur a été désaligné (facture saisie à la main, restauration, '
  'bascule de plan) peut à nouveau vendre au lieu d''échouer sur une violation '
  'd''unicité qui la bloquait définitivement. p_client_ref rend le rejeu '
  'idempotent (vente hors-ligne) : une référence déjà utilisée renvoie la '
  'vente existante au lieu d''en créer une seconde.';

-- ============================================================
--  ⬇ migration_offline_credit.sql
-- ============================================================

-- ============================================================
-- migration_offline_credit.sql — vente à CRÉDIT hors-ligne idempotente (P7)
-- À exécuter APRÈS migration_offline_sales.sql
-- ============================================================
--
-- POURQUOI : `record_credit_sale()` crée la vente PUIS la dette (customer_debts,
-- credit_payments). Un rejeu hors-ligne dont la réponse s'est perdue doit
-- renvoyer la vente ET la dette existantes, sans en créer de secondes. La
-- référence `client_ref` (migration_offline_sales.sql) est le support de cette
-- idempotence ; ici, elle est vérifiée AVANT toute écriture — dette comprise.
--
-- La signature passe de 6 à 7 arguments : on DROP l'ancienne, sinon les deux
-- coexistent et les appels deviennent ambigus.
--
-- Rejouable : DROP IF EXISTS / CREATE OR REPLACE.
-- ============================================================

DROP FUNCTION IF EXISTS record_credit_sale(jsonb, text, text, text, numeric, text);

CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items          jsonb,
  p_client_name    text,
  p_client_phone   text,
  p_note           text          DEFAULT NULL,
  p_advance        numeric(12,2) DEFAULT 0,
  p_advance_method text          DEFAULT 'cash',
  p_client_ref     text          DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_name     text;
  v_phone    text;
  v_avance   numeric(12,2);
  v_total    numeric(12,2);
  v_du       numeric(12,2);
  v_sale     jsonb;
  v_sale_id  uuid;
  v_debt_id  uuid;
  v_invoice  text;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- ── Idempotence : rejeu d'une vente à crédit hors-ligne ─────
  -- La vente ET la dette ont pu être créées lors d'une tentative précédente
  -- dont la réponse s'est perdue. On renvoie l'existant plutôt que d'ajouter
  -- une seconde dette au carnet du client.
  IF p_client_ref IS NOT NULL THEN
    SELECT s.id, s.total_amount, s.amount_received, s.invoice_number, s.client_phone
      INTO v_sale_id, v_total, v_avance, v_invoice, v_phone
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_ref = p_client_ref
     LIMIT 1;
    IF v_sale_id IS NOT NULL THEN
      SELECT id INTO v_debt_id
        FROM customer_debts
       WHERE user_id = v_owner AND phone = v_phone;
      RETURN jsonb_build_object(
        'id',             v_sale_id,
        'total_amount',   v_total,
        'amount_advance', v_avance,
        'amount_due',     v_total - v_avance,
        'invoice_number', v_invoice,
        'debt_id',        v_debt_id,
        'client_phone',   v_phone
      );
    END IF;
  END IF;

  IF p_client_name IS NULL OR btrim(p_client_name) = '' THEN
    RAISE EXCEPTION 'Indiquez le nom du client' USING ERRCODE = '22023';
  END IF;
  v_name := btrim(p_client_name);

  v_phone := normalize_phone(p_client_phone);
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Le numéro de téléphone est obligatoire pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  IF p_advance IS NULL OR p_advance < 0 THEN
    RAISE EXCEPTION 'L''avance versée ne peut pas être négative' USING ERRCODE = '22023';
  END IF;
  v_avance := p_advance;

  -- Le moyen n'est lu que s'il y a acompte : sans argent reçu, la ligne de
  -- versement n'existe pas. Même garde-fou que credit_payments_method_valid,
  -- mais levé AVANT create_sale() — le stock n'est pas encore sorti et la
  -- vente n'existe pas, donc rien à annuler.
  IF v_avance > 0
     AND (p_advance_method IS NULL OR p_advance_method NOT IN ('cash', 'momo')) THEN
    RAISE EXCEPTION 'Moyen de paiement de l''acompte invalide : %', p_advance_method
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('credit.internal', '1', true);
  v_sale := create_sale(p_items, 'credit', v_name, p_note, p_client_ref);
  PERFORM set_config('credit.internal', NULL, true);
  v_sale_id := (v_sale->>'id')::uuid;
  v_total := (v_sale->>'total_amount')::numeric(12,2);

  IF v_avance > v_total THEN
    RAISE EXCEPTION
      'L''avance versée (% F) dépasse le prix de la vente (% F)', v_avance, v_total
      USING ERRCODE = '22023';
  END IF;

  -- amount_received porte ce qui est réellement rentré : c'est la seule colonne
  -- qui décide du chiffre d'affaires. settled reste dérivé — il ne sert plus
  -- qu'à l'indexation des dettes en cours.
  UPDATE sales
     SET amount_received = v_avance,
         settled = (v_avance >= v_total),
         client_phone = v_phone
   WHERE id = v_sale_id;

  -- Fiche client créée à la première dette, réutilisée ensuite. ON CONFLICT DO
  -- UPDATE garde le nom à jour : « Maman Koffi » devient « Mme Koffi ».
  INSERT INTO customer_debts (user_id, phone, name)
  VALUES (v_owner, v_phone, v_name)
  ON CONFLICT (user_id, phone) DO UPDATE
    SET name = EXCLUDED.name,
        updated_at = now();

  SELECT id INTO v_debt_id
    FROM customer_debts
   WHERE user_id = v_owner AND phone = v_phone;

  -- L'acompte entre aussi dans l'historique des versements. Pas pour calculer la
  -- dette — ça, c'est amount_received — mais pour que la question « il m'a déjà
  -- donné combien ? » ait une réponse datée, avec son moyen de paiement. C'est
  -- aussi ce que l'écran Dettes affiche en « versements », et ce qu'un client
  -- conteste éventuellement.
  --
  -- sale_id renseigné : l'acompte couvre CETTE vente, et sa part de caisse
  -- suit le moyen choisi à la vente — p_advance_method, plus « cash » déduit.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id)
    VALUES (v_debt_id, v_owner, v_avance, current_date, p_advance_method,
            'Acompte versé à la vente', v_sale_id);
  END IF;

  v_du := v_total - v_avance;

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'total_amount',    v_total,
    -- Reste à recouvrer, renvoyé pour que l'écran n'ait pas à le recalculer et
    -- risquer un arrondi différent de celui de la base.
    'amount_advance',  v_avance,
    'amount_due',      v_du,
    'invoice_number',  v_sale->>'invoice_number',
    'debt_id',         v_debt_id,
    'client_phone',    v_phone
  );
END;
$$;

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) TO service_role;

COMMENT ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) IS
  'Vente à crédit. p_advance est l''acompte versé sur-le-champ (0 = crédit '
  'total), p_advance_method son moyen — cash ou momo, choisi à la vente. '
  'L''acompte compte au chiffre d''affaires le jour même, réduit la dette et '
  'ventile sa part de caisse selon ce moyen. Le stock part dans tous les cas. '
  'p_client_ref rend le rejeu hors-ligne idempotent : une référence déjà '
  'utilisée renvoie la vente et la dette existantes.';

-- ============================================================
--  ⬇ migration_equipe_sans_service_role.sql
-- ============================================================

-- ============================================================================
-- Équipe : gérer ses employés sans clé service role
-- ============================================================================
--
-- Pourquoi
-- -------
-- Deux routes de l'application (/api/employees, /api/employees/[id]) et une
-- troisième (/api/invitations) utilisaient la clé `service_role`. Cette clé
-- contourne TOUTES les règles de sécurité de la base : la pose sur chaque
-- poste de développement et sur chaque build est un risque disproportionné
-- pour deux opérations — changer le rôle d'un employé, retirer un employé de
-- son équipe.
--
-- Le contournement n'était même pas nécessaire. migration_security.sql a
-- volontairement supprimé toute écriture client sur `business_members` :
--
--   DROP POLICY "owner_manage_members" ;  -- FOR ALL, trop large
--
-- et l'a remplacée par une lecture seule (`auth.uid() = owner_id`). Les
-- routes rechargeaient ensuite la clé service pour écrire quand même — donc
-- exactement ce que cette migration voulait empêcher.
--
-- Ce que fait cette migration
-- --------------------------
-- Deux fonctions SECURITY DEFINER, sur le modèle de `redeem_invitation()` que
-- le projet a déjà adopté : l'autorisation vit DANS la fonction, en un seul
-- endroit vérifiable, et la table reste sans écriture client. Un appel direct
-- sur `business_members` échoue toujours.
--
--   business_members_set_role(member_id, role)
--   business_members_remove(member_id)
--
-- `employee_invitations` n'a pas besoin de fonction : sa policy
-- `invitations_owner_write` est déjà FOR ALL sur `auth.uid() = owner_id`. Le
-- patron gère ses invitations avec sa propre session. C'est aussi ce qui rend
-- le contrôle « est-ce un patron ? » traître si on le fait naïvement (voir
-- plus bas, dans les routes).
--
-- Ce qui reste avec la clé
-- -------------------------
-- `/api/register` et `/api/invitations/accept` : créer un compte Auth, et
-- partager un limiteur entre les instances serverless. Ces deux opérations
-- n'ont pas de patron derrière elles — il n'existe pas encore de jeton, ou
-- l'appelant est anonyme. La clé y est légitime.
--
-- `/api/stripe/*` : abonnements et webhooks. Également légitime.
--
-- En revanche, `purge_accepted_invitations()` n'en avait pas besoin. Elle
-- effaçait les invitations de TOUTES les boutiques et n'était donc pas
-- exécutable par un client — ce qui la rendait, de fait, la raison d'être de
-- la clé dans l'écran Équipe. Elle est recentrée sur une boutique (section 3).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Changer le rôle d'un employé
-- ────────────────────────────────────────────────────────────────────────────
-- Le rôle decide de ce que le membre peut faire ; `migration_roles.sql` s'appuie
-- dessus. On le borne explicitement plutôt que de faire confiance à l'appelant.
CREATE OR REPLACE FUNCTION business_members_set_role(p_member_id uuid, p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ligne business_members%ROWTYPE;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('employee', 'manager') THEN
    RAISE EXCEPTION 'Rôle invalide : %', p_role USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ligne
    FROM business_members
   WHERE member_id = p_member_id AND owner_id = auth.uid();

  -- Absence de ligne : soit l'employé n'existe pas, soit il appartient à
  -- quelqu'un d'autre. Les deux cas rendent la même chose à l'appelant : on ne
  -- confirme pas l'existence d'une équipe qui n'est pas la sienne.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employé introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Un patron qui se retire lui-même de sa propre équipe disparaît de la
  -- boutique : get_business_owner_id() privilégie l'appartenance à une équipe,
  -- et le patron ne verrait plus rien de ce qu'il possède.
  IF v_ligne.member_id = v_ligne.owner_id THEN
    RAISE EXCEPTION 'Le patron ne peut pas modifier son propre rôle'
      USING ERRCODE = '22023';
  END IF;

  UPDATE business_members SET role = p_role WHERE id = v_ligne.id;
  RETURN true;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Retirer un employé de l'équipe
-- ────────────────────────────────────────────────────────────────────────────
-- On supprime le LIEN, jamais le compte Auth : organizations, products, sales et
-- stock_logs partent tous en ON DELETE CASCADE depuis auth.users. Supprimer le
-- compte détruisait donc la boutique entière du membre — ce qui est arrivé
-- dans le cas d'un patron invité comme employé ailleurs.
--
-- Le compte reste, sans lien : il ne voit plus rien et peut se reconnecter. Le
-- poste est bien libéré, puisque le plan compte membres + invitations en
-- attente.
CREATE OR REPLACE FUNCTION business_members_remove(p_member_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ligne business_members%ROWTYPE;
BEGIN
  SELECT * INTO v_ligne
    FROM business_members
   WHERE member_id = p_member_id AND owner_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employé introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_ligne.member_id = v_ligne.owner_id THEN
    RAISE EXCEPTION 'Le patron ne peut pas se retirer de sa propre équipe'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM business_members WHERE id = v_ligne.id;
  RETURN true;
END;
$function$;

-- `authenticated`, et non `service_role` : ce sont les clients, mais la
-- fonction vérifie elle-même que l'appelant est bien le patron concerné. Une
-- fonction en service_role serait plus simple à écrire et laisserait la porte
-- ouverte à quiconque masquerait son identité derrière la clé.
REVOKE ALL ON FUNCTION business_members_set_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION business_members_remove(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_members_set_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION business_members_remove(uuid) TO authenticated;

COMMENT ON FUNCTION business_members_set_role(uuid, text) IS
  'Change le rôle d''un membre de l''équipe. N''écrit que si l''appelant est le '
  'patron de cette équipe ; refuse le patron lui-même.';
COMMENT ON FUNCTION business_members_remove(uuid) IS
  'Retire un membre de l''équipe (supprime le lien, jamais le compte Auth). '
  'N''écrit que si l''appelant est le patron de cette équipe.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Le nettoyage des invitations-consommées redevient possible sans la clé
-- ────────────────────────────────────────────────────────────────────────────
-- Elle était appelée en « fire-and-forget » à chaque ouverture de l'écran
-- Équipe, depuis une route en clé service — d'où la présence de cette clé dans
-- le projet pour une opération de nettoyage, et un écran qui dépendait d'un
-- secret dont l'absence était silencieuse.
--
-- La fonction effaçait les invitations de TOUTES les boutiques, ce qui est
-- incompatible avec un droit d'exécution client : un utilisateur authentifié
-- purgerait les invitations de tout le monde. Elle est donc recentrée sur une
-- seule boutique, et le contrôle du propriétaire est fait DEDANS — la RLS ne
-- filtre pas un DELETE exécuté par une fonction SECURITY DEFINER.
--
-- C'est ce qui permet de la rappeler depuis la route, avec la session du
-- patron : le nettoyage redevient effectif sans clé service, ce qu'il n'était
-- plus du tout une fois l'appel retiré de la route.
DROP FUNCTION IF EXISTS purge_accepted_invitations(int);

CREATE OR REPLACE FUNCTION purge_accepted_invitations(p_owner_id uuid, p_days int DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  -- Sans cette garde, un patron pourrait passer l'identifiant d'un autre et
  -- effacer ses invitations : c'est le seul contrôle qui tient, puisque la
  -- fonction s'exécute avec les droits du propriétaire de la table.
  IF p_owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Purge refusée : ce n''est pas votre équipe'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM employee_invitations
    WHERE owner_id = p_owner_id
      AND accepted_at IS NOT NULL
      AND accepted_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION purge_accepted_invitations(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_accepted_invitations(uuid, int) TO authenticated;

COMMENT ON FUNCTION purge_accepted_invitations(uuid, int) IS
  'Supprime les invitations déjà consommées et expirées d''une boutique. '
  'N''agit que sur la boutique de l''appelant.';

-- ============================================================
--  ⬇ migration_onboarding_mode.sql
-- ============================================================

-- ============================================================
-- MIGRATION ONBOARDING & MODE SIMPLE — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_equipe_sans_service_role.sql
--
-- Sprints 17 et 18 (plan de lancement, sprints 12 et 13 du document
-- PLAN-TRAVAIL-GESTIONLOCAL.md) : une boutique neuve fait sa première vente en
-- moins de 4 minutes, puis ne voit que l'essentiel.
--
-- Trois colonnes d'affichage, aucune ne donne de droit :
--   • ui_mode         'beginner' (essentiel seulement) ou 'full' ;
--   • onboarding_step l'écran de l'assistant où le patron s'est arrêté — un
--                     rechargement de page ne le renvoie pas au début ;
--   • business_type   les 4 activités de l'inscription. `domain` reste la
--                     seule colonne qui décide des modules : épicerie, boutique
--                     et autre → 'retail', restaurant → 'restaurant'.
--
-- La fin de l'assistant reste `onboarding_done` (migration_saas.sql) : une
-- seconde colonne « onboarding_completed » dirait la même chose, et les deux
-- finiraient par se contredire.
--
-- Enfin, le carnet de dettes passe dans le plan gratuit (section 3).
-- ============================================================

-- ─── 1. Les colonnes ────────────────────────────────────────
--
-- ⚠ L'ORDRE DES DEUX INSTRUCTIONS SUR ui_mode EST LE CŒUR DE CETTE MIGRATION.
--
--   ADD COLUMN ... DEFAULT x remplit TOUTES les lignes existantes avec x. Écrire
--   directement DEFAULT 'beginner' masquerait Rapports, Équipe et Prévisions à
--   tous les clients actuels le jour du déploiement — ceux qui s'en servent.
--
--   La colonne naît donc à 'full' (les boutiques existantes gardent leur
--   interface), PUIS le défaut passe à 'beginner' pour les seules inscriptions
--   à venir. Rejouée, la première instruction ne fait rien (IF NOT EXISTS) et
--   la seconde est idempotente : aucune boutique ne change de mode au rejeu.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ui_mode text NOT NULL DEFAULT 'full';
ALTER TABLE organizations
  ALTER COLUMN ui_mode SET DEFAULT 'beginner';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS onboarding_step text,
  ADD COLUMN IF NOT EXISTS business_type text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_ui_mode_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_ui_mode_check
      CHECK (ui_mode IN ('beginner', 'full'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_business_type_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_business_type_check
      CHECK (business_type IS NULL
             OR business_type IN ('epicerie', 'boutique', 'restaurant', 'autre'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_onboarding_step_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_onboarding_step_check
      CHECK (onboarding_step IS NULL
             OR onboarding_step IN ('welcome', 'business', 'samples', 'first_sale', 'congrats'));
  END IF;
END;
$$;


-- ─── 2. Le droit d'écrire ces colonnes ─────────────────────
--
-- Même piège que migration_domain.sql : migration_security.sql accorde les
-- droits colonne par colonne, et une colonne ajoutée ensuite naît sans droit
-- d'écriture, même pour le patron. Sans ce GRANT, l'assistant répondrait
-- « permission denied for table organizations » dès son deuxième écran.
--
-- La RLS d'organizations limite déjà l'écriture à la ligne du patron : un
-- employé ne peut pas changer le mode de la boutique.
GRANT INSERT (ui_mode, onboarding_step, business_type) ON organizations TO authenticated;
GRANT UPDATE (ui_mode, onboarding_step, business_type) ON organizations TO authenticated;


-- ─── 3. Le carnet de dettes devient gratuit ────────────────
--
-- Le plan de lancement fait des dettes l'un des trois piliers du mode simple
-- (« caisse + dettes + stock »), et l'écran de félicitations propose « Voir mes
-- dettes clients » en premier. Une boutique gratuite qui suivait ce lien
-- tombait sur un cadenas : la fonction exigeait le plan Starter.
--
-- Règle retenue : récupérer son argent n'est pas un avantage payant. Les
-- rapports (rentabilité, charges, trésorerie) le restent, eux, et gardent leur
-- require_feature('reports').
--
-- Même signature et même type de retour que migration_ca_caisse.sql : seul le
-- verrou de plan disparaît, d'où CREATE OR REPLACE sans DROP.
CREATE OR REPLACE FUNCTION get_customer_debts()
RETURNS TABLE (
  debt_id         uuid,
  phone           text,
  name            text,
  total_due       numeric,
  last_sale_at    timestamptz,
  sales_count     bigint,
  oldest_sale_at  timestamptz,
  payments_count  bigint,
  last_payment_at date,
  total_paid      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                 AS total_paid,
      COUNT(*)                               AS sales_count,
      MAX(s.created_at)                      AS last_sale_at,
      MIN(s.created_at)                      AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  ), soldes AS (
    SELECT
      d.id,
      d.user_id,
      d.phone,
      d.name,
      GREATEST(COALESCE(u.total_due, 0), 0) AS total_due,
      u.last_sale_at,
      COALESCE(u.sales_count, 0) AS sales_count,
      u.oldest_sale_at,
      COALESCE(u.total_paid, 0) AS total_paid,
      (SELECT COUNT(DISTINCT cp2.gesture_id) FROM credit_payments cp2
        WHERE cp2.debt_id = d.id) AS payments_count,
      (SELECT MAX(cp3.day) FROM credit_payments cp3 WHERE cp3.debt_id = d.id) AS last_payment_at
    FROM customer_debts d
    LEFT JOIN dues u ON u.user_id = d.user_id AND u.client_phone = d.phone
  )
  SELECT s.id, s.phone, s.name, s.total_due, s.last_sale_at, s.sales_count,
         s.oldest_sale_at, s.payments_count, s.last_payment_at, s.total_paid
    FROM soldes s
   -- L'isolation entre boutiques reste là : c'est la RLS et ce filtre qui
   -- protègent la liste des débiteurs du voisin, pas le plan.
   WHERE s.user_id = get_business_owner_id()
     AND s.total_due > 0
   ORDER BY s.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION get_customer_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_customer_debts() TO authenticated;

-- ============================================================
--  ⬇ migration_telephone_benin.sql
-- ============================================================

-- ============================================================
-- MIGRATION TÉLÉPHONE BÉNIN À 10 CHIFFRES — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_onboarding_mode.sql
--
-- LE DÉFAUT
--   Depuis le 30 novembre 2024, les numéros mobiles béninois ont 10 chiffres :
--   « 01 » devant les 8 chiffres d'avant (97 00 00 01 → 01 97 00 00 01).
--   normalize_phone() ne préfixait l'indicatif 229 qu'aux numéros à 8 chiffres :
--   un numéro saisi au format actuel était enregistré « 0197000001 », sans
--   indicatif. Le bouton « Relancer » ouvrait alors wa.me/0197000001, que
--   WhatsApp ne reconnaît pas — la relance d'une dette échouait pour tout
--   client inscrit avec son numéro d'aujourd'hui.
--
-- LA RÈGLE
--   8 chiffres                  → 229 + numéro (ancien format, encore saisi)
--   10 chiffres commençant par 01 → 229 + numéro (format actuel)
--   le reste                    → inchangé (déjà international)
--
-- Le numéro reste la clé du client dans customer_debts (UNIQUE user_id, phone) :
-- la même règle doit s'appliquer à l'écriture ET aux lignes déjà en base, sinon
-- le même client aurait deux fiches selon le jour où il a été saisi.
-- ============================================================

-- Même signature et même type de retour que migration_credit_fns.sql :
-- CREATE OR REPLACE suffit.
CREATE OR REPLACE FUNCTION normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits text;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  -- 8 chiffres = ancien numéro local béninois.
  IF length(v_digits) = 8 THEN
    v_digits := '229' || v_digits;
  -- 10 chiffres en 01 = numéro béninois actuel, saisi sans indicatif.
  ELSIF length(v_digits) = 10 AND left(v_digits, 2) = '01' THEN
    v_digits := '229' || v_digits;
  END IF;

  IF length(v_digits) < 8 OR length(v_digits) > 15 THEN
    RETURN NULL;
  END IF;

  RETURN v_digits;
END;
$$;

REVOKE ALL ON FUNCTION normalize_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO service_role;


-- ─── Les numéros déjà enregistrés ──────────────────────────
--
-- Un client n'est corrigé que si la boutique n'a PAS déjà une fiche au format
-- international pour ce numéro : renommer la seconde violerait l'unicité, et
-- fusionner deux fiches (versements, historique) ne se fait pas en silence.
-- Ces cas restent tels quels ; le lien WhatsApp, lui, ajoute l'indicatif côté
-- application, donc la relance fonctionne quand même.
--
-- Les ventes d'abord, la fiche ensuite : get_customer_debts() rapproche les
-- deux par (user_id, numéro). Dans une même instruction, c'est la condition
-- NOT EXISTS sur la fiche cible qui décide, pour les deux tables.
-- Rejouable : une seconde exécution ne trouve plus rien à corriger.
UPDATE sales s
   SET client_phone = '229' || s.client_phone
 WHERE s.client_phone ~ '^01[0-9]{8}$'
   AND NOT EXISTS (
     SELECT 1 FROM customer_debts d
      WHERE d.user_id = s.user_id AND d.phone = '229' || s.client_phone
   );

UPDATE customer_debts d
   SET phone = '229' || d.phone
 WHERE d.phone ~ '^01[0-9]{8}$'
   AND NOT EXISTS (
     SELECT 1 FROM customer_debts x
      WHERE x.user_id = d.user_id AND x.phone = '229' || d.phone
   );

-- ============================================================
--  ⬇ migration_activation_funnel.sql
-- ============================================================

-- ============================================================
-- MIGRATION — Mesure du parcours d'activation — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_telephone_benin.sql
--
-- POURQUOI
--   Le pilote se pilote avec des chiffres : inscrits → assistant terminé →
--   première vente → ventes en semaine 2 → ventes en semaine 4. C'est la
--   mesure P3 de l'évaluation marketing : sans elle, on décide du plafond
--   gratuit, du prix et du mode hors ligne à l'aveugle, et le bilan du
--   vendredi du pilote devient une impression.
--
-- CE QU'ELLE FAIT
--   get_activation_funnel(p_from, p_to, p_now) renvoie UNE LIGNE par
--   boutique dont la date d'inscription LOCALE tombe dans [p_from, p_to] :
--
--     onboarding_done / onboarding_step   où s'est arrêté l'assistant
--     first_sale_at                       la première vente, quel que soit le jour
--     sales_week2 / sales_week4           ventes de la 2ᵉ / 4ᵉ semaine de vie,
--                                         en jours LOCAUX de la boutique :
--                                         [d0+7, d0+14) et [d0+21, d0+28)
--     mature_week2 / mature_week4         la fenêtre est-elle entièrement
--                                         écoulée depuis p_now ?
--
--   Le marqueur de maturité n'est pas un détail : une boutique inscrite
--   hier n'a pas de semaine 2, et sans ce marqueur elle compterait comme
--   « pas active » — le taux descendrait tout seul à mesure qu'on
--   enregistre des inscriptions, pour la seule raison qu'elles sont
--   récentes. Le script scripts/funnel.mjs divise donc par le nombre de
--   boutiques ÉVALUABLES, pas par le total.
--
--   Le jour se compte dans le fuseau de la boutique (Africa/Porto-Novo par
--   défaut), pas en UTC : une vente passée à 23 h 30 UTC sur un comptoir
--   béninois est déjà le lendemain pour celui qui tient le cahier.
--
-- SÉCURITÉ
--   La mesure lit TOUTES les boutiques — c'est son but. Ni la clé anon ni
--   un commerçant connecté ne doivent pouvoir l'appeler : elle est
--   réservée au service_role et à postgres (SQL Editor, scripts/), qui
--   travaillent hors RLS. SECURITY INVOKER par défaut : aucune porte
--   supplémentaire n'est ouverte, l'appelant reste soumis aux droits qu'il
--   a sur les tables.
--
-- Rejouable : CREATE OR REPLACE, REVOKE et GRANT sont idempotents.
-- ============================================================

CREATE OR REPLACE FUNCTION get_activation_funnel(
  p_from date,
  p_to date,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  org_id          uuid,
  org_name        text,
  org_created_at  timestamptz,
  org_timezone    text,
  plan            text,
  onboarding_done boolean,
  onboarding_step text,
  first_sale_at   timestamptz,
  sales_week2     integer,
  sales_week4     integer,
  mature_week2    boolean,
  mature_week4    boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cohort AS (
    SELECT o.id,
           o.name,
           o.created_at,
           o.timezone,
           o.plan,
           o.onboarding_done,
           o.onboarding_step,
           (o.created_at AT TIME ZONE o.timezone)::date AS d0
      FROM organizations o
     WHERE (o.created_at AT TIME ZONE o.timezone)::date BETWEEN p_from AND p_to
  )
  SELECT c.id,
         c.name,
         c.created_at,
         c.timezone,
         c.plan,
         c.onboarding_done,
         c.onboarding_step,
         -- La première vente sert à l'étape « première vente » du parcours :
         -- elle n'appartient à aucune fenêtre, on la cherche telle quelle.
         (SELECT MIN(s.created_at)
            FROM sales s WHERE s.user_id = c.id),
         -- 2ᵉ semaine de vie : jours locaux [d0+7, d0+14).
         (SELECT COUNT(*)::integer
            FROM sales s
           WHERE s.user_id = c.id
             AND (s.created_at AT TIME ZONE c.timezone)::date >= c.d0 + 7
             AND (s.created_at AT TIME ZONE c.timezone)::date <  c.d0 + 14),
         -- 4ᵉ semaine de vie : jours locaux [d0+21, d0+28).
         (SELECT COUNT(*)::integer
            FROM sales s
           WHERE s.user_id = c.id
             AND (s.created_at AT TIME ZONE c.timezone)::date >= c.d0 + 21
             AND (s.created_at AT TIME ZONE c.timezone)::date <  c.d0 + 28),
         (c.d0 + 14 <= (p_now AT TIME ZONE c.timezone)::date),
         (c.d0 + 28 <= (p_now AT TIME ZONE c.timezone)::date)
    FROM cohort c
   ORDER BY c.created_at;
$$;

-- Lecture transverse : réservée à ceux qui travaillent hors RLS.
-- Le REVOKE sur authenticated n'est pas un excès de prudence — sans lui,
-- la fonction naît Granted à authenticated (ALTER DEFAULT PRIVILEGES de
-- Supabase, maintenu par migration_security.sql section 7), et un
-- commerçant pourrait appeler la mesure des autres.
REVOKE ALL ON FUNCTION get_activation_funnel(date, date, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_activation_funnel(date, date, timestamptz)
  TO service_role;

-- ============================================================
--  ⬇ migration_display_mode.sql
-- ============================================================

-- ============================================================
-- MIGRATION — Mode d'ouverture de l'application — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_activation_funnel.sql
--
-- POURQUOI
--   P2 (application installable, 08/10/2026) et P3 (mesure du parcours)
--   se répondent : savoir que les pilotes s'inscrivent ne dit pas s'ils
--   ouvrent GestionLocal depuis l'icône installée sur leur écran d'accueil
--   ou depuis un onglet du navigateur. C'est l'hypothèse « la rétention
--   vient de l'icône » qui devient vérifiable, dans le même relevé que le
--   parcours d'activation.
--
-- CE QU'ELLE FAIT
--   • organizations.display_mode      'standalone' (application installée,
--                                     plein écran) ou 'navigateur' ;
--                                     NULL = jamais relevé.
--   • organizations.display_mode_at   quand ce mode a été relevé pour la
--                                     dernière fois — le mode change : le
--                                     patron installe l'app entre deux
--                                     visites, l'horodatage dit laquelle
--                                     des deux valeurs est la plus fraîche.
--   • get_activation_funnel() NE CHANGE PAS : le relevé du parcours se
--     sert de ces colonnes par une jointure (scripts/funnel.mjs). Changer
--     son type de retour obligerait à DROP + CREATE sur une fonction déjà
--     en production, pour la même information — inutilelement risqué.
--
--   SANS DÉFAUT, comme il se doit : « ADD COLUMN ... DEFAULT » remplirait
--   toutes les lignes existantes d'un mode qu'elles n'ont jamais eu (le
--   garde-fous du dépôt vaut pour toute colonne d'affichage). NULL veut
--   dire « pas encore relevé », et le relevé se fait tout seul à la
--   prochaine connexion du patron.
--
-- QUI ÉCRIT
--   Le client (SupabaseProvider), session patron seule, et seulement
--   quand le mode diffère de celui déjà stocké : une écriture par
--   changement de mode, pas une par visite. La RLS « Patron modifie sa
--   propre org » (migration_saas.sql) refuse déjà les employés — le
--   relevé est volontairement à la charge du seul commerçant que la
--   mesure suit.
--
-- SÉCURITÉ
--   • CHECK sur les deux valeurs : une valeur inconnue écraserait la
--     mesure sans jamais échouer visiblement.
--   • GRANT colonne par colonne : migration_security.sql a REVOKEt la
--     table en entier, une colonne ajoutée plus tard naît sans droit
--     d'écriture — même motif que migration_domain.sql et
--     migration_onboarding_mode.sql.
--
-- Rejouable : IF NOT EXISTS, garde de contrainte, GRANT idempotent.
-- ============================================================

-- ─── 1. Les colonnes ────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS display_mode text,
  ADD COLUMN IF NOT EXISTS display_mode_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_display_mode_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_display_mode_check
      CHECK (display_mode IS NULL
             OR display_mode IN ('standalone', 'navigateur'));
  END IF;
END;
$$;


-- ─── 2. Le droit d'écrire ces colonnes ───────────────────────
--
-- Sans ce GRANT, la première tentative du patron échouerait en
-- « permission denied for table organizations » — et l'échec serait
-- invisible : le client n'attend pas la réponse (écriture non
-- bloquante), la mesure resterait à NULL sans dire pourquoi.
GRANT UPDATE (display_mode, display_mode_at) ON organizations TO authenticated;

-- ============================================================
--  ⬇ migration_trial.sql
-- ============================================================

-- ============================================================
-- ESSAI GRATUIT DE 14 JOURS (Sprint 19 — freemium, plan 14)
-- À exécuter dans Supabase SQL Editor
--
-- L'essai Starter de 14 jours, sans carte, déclenché par un bouton
-- (décision : jamais automatique — c'est le commerçant qui choisit quand le
-- compte à rebours démarre, sinon il s'écoule pendant l'onboarding).
--
-- POURQUOI DEUX COLONNES ET PAS LE PLAN
--   organizations.plan est verrouillé : seul le webhook Stripe le change
--   (trigger organizations_reject_plan_change + privilèges colonne par
--   colonne). Écrire 'starter' dans plan pendant l'essai créerait un second
--   détenteur du même champ, et la fin d'essai — un retour en arrière du
--   plan — serait une modification que le trigger refuse au navigateur.
--   Le plan brut reste donc la VÉRITÉ CONTRACTUELLE (il paie ou non), et
--   l'essai vit à côté : current_org_plan() renvoie l'EFFET utile.
--
-- POURQUOI SANS GRANT CLIENT SUR LES COLONNES
--   GRANT UPDATE sur trial_ends_at reviendrait à laisser le patron écrire
--   la date de fin qu'il veut. La colonne naît sans droit d'écriture (le
--   piège de migration_domain, assumé ici : il est protecteur), et
--   start_free_trial() est SECURITY DEFINER — seule porte d'accès, avec ses
--   propres vérifications. Le SELECT reste de table : l'écran doit afficher
--   la date de fin.
--
-- UNE SEULE FOIS, POUR TOUJOURS
--   trial_started_at IS NULL est exigé : un essai expiré ne se relance pas.
--   Re-partir en essai à chaque essai terminé transformerait le gratuit en
--   illimité par rotation.
-- ============================================================

-- ─── 1. Colonnes ───────────────────────────────────────────
-- ADD COLUMN sans DEFAULT : aucune ligne existante ne se remplit. Le défaut
-- d'une colonne d'ajout s'applique à TOUTES les lignes — ici il n'y en a
-- d'ailleurs aucun : NULL est la valeur, pas un défaut à poser.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN organizations.trial_started_at IS
  'Début de l''essai Starter de 14 jours. NULL = jamais démarré ; il n''y en aura jamais deux.';
COMMENT ON COLUMN organizations.trial_ends_at IS
  'Fin de l''essai. Seul start_free_trial() l''écrit (SECURITY DEFINER, sans GRANT sur la colonne).';


-- ─── 2. current_org_plan() : l'effet de l'essai ────────────
-- Même signature, CREATE OR REPLACE autorisé (le type de retour ne change
-- pas). require_feature(), les appels de rapports et tout ce qui lit le plan
-- par cette fonction deviennent conscients de l'essai sans autre modification.
--
-- L'essai ne soulève QUE les boutiques gratuites : une boutique payante qui
-- aurait une fin d'essai résiduelle reste sur son plan — c'est le paiement
-- qui commande, pas l'essai.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
              ELSE o.plan
            END
       FROM organizations o
      WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan utile de la boutique appelante : plan payant, ou essai Starter actif. '
  'Défaut « free » en cas de doute. SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 3. start_free_trial() : la seule porte ────────────────
-- SECURITY DEFINER, parce que les colonnes trial n'ont aucun GRANT client :
-- la fonction est la seule à pouvoir les écrire, et elle vérifie elle-même
-- qui appelle. Un UPDATE direct du navigateur échoue sur les privilèges
-- avant même la RLS — deux couches, comme pour plan.
--
-- auth.uid() et non get_business_owner_id() : cette fonction-là renverrait
-- l'id du patron pour un employé aussi, et l'employé aurait pu démarrer
-- l'essai de la boutique de son patron. Ici, pas de ligne dont l'id est
-- l'appelant, pas d'essai.
--
-- VOLATILE, pour les mêmes raisons que require_feature() : elle lève une
-- exception, le planificateur ne doit pas la traiter comme pure.
CREATE OR REPLACE FUNCTION start_free_trial()
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan   text;
  v_debut  timestamptz;
  v_fin    timestamptz;
BEGIN
  SELECT plan, trial_started_at
    INTO v_plan, v_debut
    FROM organizations
   WHERE id = auth.uid();

  IF NOT FOUND THEN
    -- Pas de session, employé (l'id de l'appelant n'est pas une boutique) :
    -- dans les deux cas, aucun essai à démarrer. Le message nomme la cause
    -- la plus fréquente, celle du patron qui n'a pas de session.
    RAISE EXCEPTION 'Boutique introuvable : cette action est réservée au patron connecté.'
      USING ERRCODE = '22023';
  END IF;

  IF v_plan <> 'free' THEN
    RAISE EXCEPTION 'Votre boutique est déjà sur un plan payant : l''essai ne s''applique qu''en plan gratuit.'
      USING ERRCODE = '22023';
  END IF;

  IF v_debut IS NOT NULL THEN
    RAISE EXCEPTION 'L''essai gratuit de 14 jours n''est proposé qu''une fois par boutique.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE organizations
     SET trial_started_at = now(),
         trial_ends_at    = now() + interval '14 days'
   WHERE id = auth.uid()
  RETURNING trial_ends_at INTO v_fin;

  RETURN v_fin;
END;
$$;

REVOKE ALL ON FUNCTION start_free_trial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_free_trial() TO authenticated;
GRANT EXECUTE ON FUNCTION start_free_trial() TO service_role;

COMMENT ON FUNCTION start_free_trial() IS
  'Démarre l''essai Starter de 14 jours (une fois par boutique, plan gratuit '
  'seulement, patron seulement). Renvoie la date de fin. SECURITY DEFINER : '
  'seule porte d''écriture des colonnes trial, qui n''ont aucun GRANT client.';

-- ============================================================
--  ⬇ migration_mobilemoney.sql
-- ============================================================

-- ═══════════════════════════════════════════════════════════
--  MOBILE MONEY — périodes prépayées (Sprint 19)
-- ═══════════════════════════════════════════════════════════
--
-- Constat de l'évaluation : la cible ne paie pas par carte, et le Mobile
-- Money ne prélève pas automatiquement. On ne vend donc pas un abonnement
-- récurrent mais des PÉRIODES : 1, 3 ou 12 mois payés d'avance, avec une
-- échéance visible. Ce fichier pose la moitié base de données du dispositif ;
-- l'autre moitié (prestataire, appels réseau, pages de paiement) vit dans
-- src/lib/payments et src/app/api/payments — aucune clé, aucun appel externe
-- ici.
--
-- Ce que la base connaît :
--   • les COMMANDES (payment_orders) : quel plan, combien de temps, quel
--     montant convenu, quel prestataire, payée ou non ;
--   • leur ACTIVATION (activate_prepaid_plan) : la seule porte qui passe une
--     commande en « payée » et repousse l'échéance du plan ;
--   • l'ÉCHÉANCE (organizations.plan_valid_until) : un plan prépayé a une
--     fin, lisible par current_org_plan() que TOUT le reste du serveur
--     appelle déjà.
--
-- Ce que la base ne connaît PAS : FedaPay, PayDunya, les webhooks, les
-- signatures. Un webhook n'arrive jamais ici sans passer par la route
-- serveur correspondante, qui appelle activate_prepaid_plan() en service_role.
--
-- Le montant d'une commande est calculé par la route API à partir de la
-- configuration de prix (NEXT_PUBLIC_PLANS_CONFIG) — jamais reçu du
-- navigateur. payment_orders n'est pas insérable par le client : seul le
-- service_role écrit des commandes (voir la révocation plus bas), et
-- activate_prepaid_plan() ne regarde d'ailleurs ni amount ni currency pour
-- décider : seulement le plan et la durée, bornés par CHECK à la création.


-- ─── 1. L'échéance du plan ──────────────────────────────────
-- NULL = pas de fin : le gratuit est gratuit pour toujours, et l'abonnement
-- Stripe mensuel se renouvelle tout seul (son webhook ne touche jamais cette
-- colonne). Seul un paiement Mobile Money l'écrit.
--
-- Jamais de DEFAULT ici : une colonne d'organisation ajoutée avec défaut
-- remplit TOUTES les lignes existantes (règle du dépôt) — les boutiques déjà
-- en Pro se retrouveraient avec une échéance, donc une fin, qu'elles n'ont
-- pas payée.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_valid_until timestamptz;

COMMENT ON COLUMN organizations.plan_valid_until IS
  'Fin de la période prépayée (Mobile Money). NULL = aucune fin : gratuit, '
  'ou abonnement Stripe en cours. Écrit par activate_prepaid_plan() seul — '
  'absente des GRANT UPDATE côté client (migration_security.sql).';


-- ─── 2. current_org_plan() — le plan utile devient datable ──
-- CREATE OR REPLACE sans DROP : même type de retour (text), le harnais
-- rejoue migration_trial.sql puis ce fichier dans l'ORDER, chaque version
-- est un surcroît du précédent (essai, puis essai + échéance).
--
-- Les deux tests sont exclusifs et le restent :
--   • l'essai ne s'active que sur un plan BRUT gratuit (start_free_trial
--     refuse ailleurs) → la branche échéance, qui exige un plan brut
--     payant, ne peut jamais l'éteindre ;
--   • l'échéance ne regarde que les plans brut payants → un résidu
--     plan_valid_until sur une boutique redevenue gratuite n'y change rien.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN o.plan <> 'free'
                   AND o.plan_valid_until IS NOT NULL
                   AND o.plan_valid_until <= now() THEN 'free'
              WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
              ELSE o.plan
            END
       FROM organizations o
      WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan utile de la boutique appelante : période prépayée non échue, ou '
  'essai Starter actif, sinon le plan brut — « free » en cas de doute. '
  'SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 3. payment_orders — les commandes ──────────────────────
-- user_id : l'identifiant de la boutique (= identifiant auth du patron),
-- comme partout ailleurs dans le dépôt.
CREATE TABLE IF NOT EXISTS payment_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan          text NOT NULL CHECK (plan IN ('starter', 'pro')),
  period_months smallint NOT NULL CHECK (period_months IN (1, 3, 12)),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'XOF',
  provider      text NOT NULL,
  provider_ref  text,
  -- Jeton l'unique, généré côté serveur : c'est lui que le prestataire
  -- renverra dans son webhook, et il doit être devinable impossible.
  reference     text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Les commandes meurent toutes seules : pas de cron, l'activation refuse.
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  paid_at       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user
  ON payment_orders(user_id, created_at DESC);

DROP TRIGGER IF EXISTS payment_orders_updated_at ON payment_orders;
CREATE TRIGGER payment_orders_updated_at
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;

-- Patron lit SES commandes — et les siennes seulement :
-- user_id = auth.uid(), pas get_business_owner_id(). La seconde renverrait
-- l'id du patron pour un employé aussi, et un employé aurait lu les commandes
-- de la boutique (la route exige le patron en plus, deux couches comme pour
-- plan).
DROP POLICY IF EXISTS "orders_select_own" ON payment_orders;
CREATE POLICY "orders_select_own" ON payment_orders
  FOR SELECT USING (user_id = auth.uid());

-- Pas de policy UPDATE/DELETE : le navigateur ne passe JAMAIS une commande
-- en payée. Même sans policy, un UPDATE échouerait en silence (0 ligne) —
-- la section 37 du harnais le vérifie plutôt que de supposer.
--
-- Et pas d'INSERT non plus : les commandes naissent de la route API, qui
-- calcule le montant. Un INSERT direct ne mène nulle part (activate est
-- service_role) mais laisser le champ ouvert inviterait aux fausses
-- commandes dans la table d'historique des encaissements.
REVOKE INSERT, UPDATE, DELETE ON payment_orders FROM authenticated;

-- anon : aucune session, aucune commande. Les tables « navigateur » de ce
-- dépôt sont toutes révoquées à anon (cf. migration_plan_config.sql) — la
-- RLS seule ne dit rien à un rôle sans claim.
REVOKE ALL ON payment_orders FROM anon;


-- ─── 4. activate_prepaid_plan() — la seule porte ────────────
-- SECURITY DEFINER : appelée par la route webhook avec la clé service_role.
-- ACCORDER À authenticated reviendrait à offrir le plan à quiconque écrit
-- une référence au doigt — la fonction ne vérifie personne, c'est la route
-- qui vérifie la signature du prestataire et l'appartenance de la commande.
--
-- VOLATILE : elle écrit, et le planificateur ne doit pas la traiter comme
-- pure (même discipline que require_feature()).
--
-- Idempotence par construction : le passage pending → paid est atomique
-- (UPDATE ... WHERE status = 'pending'), les webhooks rejoués ne peuvent pas
-- ajouter deux périodes — ils retrouvent « déjà payée » et renvoient true.
CREATE OR REPLACE FUNCTION activate_prepaid_plan(p_reference text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order payment_orders%ROWTYPE;
BEGIN
  -- Les commandes mortes changent de statut pour l'histoire (une commande
  -- « pending » périmée ne doit pas traîner indéfiniment comme candidates),
  -- puis l'activation ne prend que des pending EN VIE.
  UPDATE payment_orders
     SET status = 'expired', updated_at = now()
   WHERE reference = p_reference
     AND status = 'pending'
     AND expires_at <= now();

  UPDATE payment_orders
     SET status = 'paid', paid_at = now(), updated_at = now()
   WHERE reference = p_reference
     AND status = 'pending'
   RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM payment_orders
       WHERE reference = p_reference AND status = 'paid'
    );
  END IF;

  -- Prolongation : renouveler le MÊME plan ajoute la période à la fin de
  -- celle en cours (acheter 1 mois en novembre puis 3 en décembre donne
  -- février, pas décembre + 3). Changer de plan démarre à maintenant : la
  -- période payée du plan précédent est perdue, et c'est écrit dans le
  -- commentaire plutôt que deviné.
  UPDATE organizations
     SET plan = v_order.plan,
         plan_valid_until = CASE
           WHEN plan = v_order.plan AND plan_valid_until > now()
             THEN plan_valid_until + make_interval(months => v_order.period_months)
           ELSE now() + make_interval(months => v_order.period_months)
         END
   WHERE id = v_order.user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM anon;
REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION activate_prepaid_plan(text) TO service_role;

COMMENT ON FUNCTION activate_prepaid_plan(text) IS
  'Passe une commande Mobile Money en « payée » et repousse l''échéance du '
  'plan (prolongation si même plan). Idempotente : les webhooks rejoués ne '
  'doublent rien. service_role uniquement — la vérification de la signature '
  'prestataire appartient à la route /api/payments/callback, pas ici.';

-- ============================================================
--  ⬇ migration_plan_config.sql
-- ============================================================

-- ============================================================
-- LIMITES DES PLANS CÔTÉ SERVEUR (Sprint 19 — freemium, plan 14)
-- À exécuter dans Supabase SQL Editor, APRÈS migration_trial.sql
--
-- CE QUE ÇA CORRIGE
--   Trois limites n'existaient que dans le navigateur : un simple
--   supabase.from('sales').select() dans la console passait outre
--   l'historique au-delà de la fenêtre de son plan, l'invitation d'un
--   employé au-delà du quota,
--   et le plafond produits lui-même ne dépendait que d'un CASE écrit dans
--   le code. Le dépôt est public : ces quotas sont désormais dans
--   plan_config, une table VIDE dans le dépôt, remplie par
--   scripts/sync-plan-config.mjs à partir de NEXT_PUBLIC_PLANS_CONFIG.
--   Le mécanisme ici, les valeurs nulle part ici.
--
-- LE SENS DE LA PORTE : FAIL-OPEN, DANS LES DEUX CAS
--   Une ligne absente de plan_config = pas de quota. Deux raisons, dans
--   l'ordre : le mécanisme ne devine jamais une valeur (un chiffre inventé
--   serait une offre publique par accident), et une configuration oubliée
--   doit coûter des ventes limitées, jamais des boutiques bloquées — le
--   premier écran d'un nouveau venu est l'assistant qui CRÉE des produits.
--   D'où l'ordre de déploiement, non négociable :
--     1. appliquer migration_trial.sql, puis ce fichier ;
--     2. node scripts/sync-plan-config.mjs   ← sans lui, aucun quota.
--
-- L'HISTOIRE QUI NE MEURT PAS : LES DETTES
--   §8 de l'évaluation : « Dettes + relance manuelle : oui » sur TOUS les
--   plans. Récupérer son argent n'est pas un avantage payant. La fenêtre
--   d'historique est donc contournée pour ce qui n'est pas soldé
--   (OR NOT settled) : une vente à crédit vieille de six mois reste lisible,
--   et get_customer_debts() — SECURITY INVOKER, qui lit sales — la retrouve.
--   Une fois la dette réglée, la vente redevient une ligne d'historique
--   comme les autres, et peut sortir de la fenêtre.
--
-- L'ESSAI ET L'ÉCHÉANCE COMPTENT POUR CE QU'ILS DONNENT
--   Les quotas lisent le plan EFFECTIF (essai Starter = quotas Starter ;
--   période prépayée écoulée = quotas gratuit), via le même CASE que
--   current_org_plan() : deux écrans de la même pièce. La colonne
--   plan_valid_until vient de migration_mobilemoney.sql, posée AVANT ce
--   fichier dans l'ORDER.
-- ============================================================

-- ─── 1. plan_config — les quotas, table vide dans le dépôt ───
-- Une clé par (plan, clé de quota). Les valeurs sont posées par
-- scripts/sync-plan-config.mjs ; ce fichier ne crée que le réceptacle.
CREATE TABLE IF NOT EXISTS plan_config (
  plan  text NOT NULL CHECK (plan IN ('free', 'starter', 'pro')),
  key   text NOT NULL,
  value int  NOT NULL,
  PRIMARY KEY (plan, key)
);

ALTER TABLE plan_config ENABLE ROW LEVEL SECURITY;

-- La valeur d'ILLIMITÉ se stocke en 2147483647 (l'ancien plafond Pro de
-- check_product_limit) : un int comme les autres, aucune valeur spéciale à
-- interpréter. Les calculs en date bornent ce nombre (voir
-- within_plan_history) pour ne jamais sortir du domaine des timestamps.
-- Le null du JSON devient cette valeur au moment de la synchronisation.

-- Lecture seule pour le navigateur... ou plutôt : AUCUNE lecture. Le seul
-- lecteur des quotas est within_plan_history(), qui tourne en SECURITY
-- DEFINER (voir section 2) — le navigateur n'a nul besoin de la table, ses
-- quotas affichés viennent de la configuration du build. RLS activée sans
-- policy = refus par défaut pour les deux rôles de navigateur, même si les
-- privilèges par défaut de Supabase (ALTER DEFAULT PRIVILEGES → ALL à la
-- création) les accordaient — privilèges ET policies, deux couches, comme
-- pour organizations.
REVOKE ALL ON plan_config FROM anon;
REVOKE ALL ON plan_config FROM authenticated;
GRANT ALL ON plan_config TO service_role;


-- ─── 2. within_plan_history() — la fenêtre d'historique ──────
-- Appelée par la politique de lecture de sales, ligne par ligne. STABLE :
-- le plan de la boutique ne bouge pas dans une requête.
--
-- SECURITY DEFINER, et c'est la clé de tout le reste : la fonction est
-- appelée depuis une POLICIE, dont le rôle courant est celui du lecteur —
-- y compris anon (visiteur déconnecté) et authenticated. Sans définition
-- propriétaire, elle mourrait sur les privilèges de plan_config (révoqués
-- à tous les navigateurs, section 1) : une ERREUR là où le déconnecté
-- obtenait un résultat vide. En propriétaire, elle lit plan_config et
-- organizations quel que soit l'appelant — et ne peut rien en dire : elle
-- ne renvoie qu'un booléen sur l'appelant lui-même (get_business_owner_id).
--
-- Trois sorties possibles, dans l'ordre de décision :
--   • plan non gratuit (ou essai actif) → true, tout l'historique ;
--   • plan gratuit avec quota posé → la ligne est-elle dans la fenêtre ;
--   • pas de quota posé → true (fail-open, cf. en-tête).
--
-- LEAST borné à ~1000 jours : l'illimité se stocke en 2147483647, et
-- now() - 2147483647 jours sortirait du domaine des timestamps (erreur
-- « timestamp out of range » qui casserait TOUS les SELECT de ventes).
-- 1000 ans couvre toute vente réelle, sans risque d'arithmétique.
CREATE OR REPLACE FUNCTION within_plan_history(p_moment timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN c.value >= 2147483646 THEN true
              ELSE p_moment >= now() - make_interval(days => LEAST(c.value, 365000))
            END
       FROM plan_config c
      WHERE c.plan = current_org_plan()
        AND c.key = 'history_days'),
    true
  );
$$;

COMMENT ON FUNCTION within_plan_history(timestamptz) IS
  'Vrai si la ligne appartient à l''historique visible du plan appelant : '
  'toujours pour un plan payant (ou en essai), dans la fenêtre history_days '
  'pour le gratuit, toujours si aucun quota n''est posé (fail-open). '
  'SECURITY DEFINER : appelée depuis la politique sales, en anon y compris.';

GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO anon;
GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO service_role;


-- ─── 3. sales : la fenêtre posée sur la lecture ──────────────
-- La politique remplace celle de migration_security.sql : même isolation
-- (user_id = get_business_owner_id()), plus la fenêtre, plus l'exemption
-- des dettes (OR NOT settled, cf. en-tête). Aucune écriture client n'existe
-- sur sales — tout passe par des RPC SECURITY DEFINER — donc le SELECT est
-- le seul point à toucher.
--
-- sale_items n'a pas de politique à écrire : la sienne pointe vers sales
-- par une sous-requête, et une politique applique la RLS de la table lue —
-- les lignes d'une vente hors fenêtre disparaissent avec leur vente.
DROP POLICY IF EXISTS "user_sales_select" ON sales;
CREATE POLICY "user_sales_select" ON sales
  FOR SELECT USING (
    user_id = get_business_owner_id()
    AND (within_plan_history(created_at) OR NOT settled)
  );


-- ─── 4. check_product_limit() — quotas en configuration ─────
-- Même trigger, corps remplacé (CREATE OR REPLACE suffit : le trigger
-- référence la fonction, pas son corps). Trois différences avec l'ancienne
-- version écrite en dur dans migration_plan_limits.sql :
--   • les quotas viennent de plan_config, pas d'un CASE dans le dépôt ;
--   • le plan est l'effet utile, essai et échéance prépayée compris ;
--   • pas de quota posé → on laisse passer (l'ancien CASE tombait en
--     'free' pour un plan inconnu — bloquer par défaut avait du sens quand
--     la valeur était connue ; sans valeur, bloquer reviendrait à inventer
--     une offre).
CREATE OR REPLACE FUNCTION check_product_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_plan    text;
  v_quota   int;
  v_comptes int;
BEGIN
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = NEW.user_id;

  v_plan := COALESCE(v_plan, 'free');

  SELECT value INTO v_quota
    FROM plan_config
   WHERE plan = v_plan AND key = 'products';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_comptes
    FROM products
   WHERE user_id = NEW.user_id;

  IF v_comptes >= v_quota THEN
    RAISE EXCEPTION 'Limite de produits atteinte pour le plan % (max %). Passez à un plan supérieur.', v_plan, v_quota;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_product_limit ON products;
CREATE TRIGGER enforce_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_limit();


-- ─── 5. check_employee_limit() — le quota d'équipe ───────────
-- Deux tables, une fonction (TG_TABLE_NAME décide du décompte) :
--
--   • employee_invitations (invitation) : le quota compte les membres +
--     les invitations EN ATTENTE (accepted_at NULL et non expirées). C'est
--     le même décompte que TeamModule à l'écran : l'invitation en attente
--     occupe déjà un poste, sinon l'échec arriverait à l'acceptation sans
--     raison visible.
--
--   • business_members (acceptation du lien, dans redeem_invitation) :
--     les MEMBRES SEULEMENT. L'invitation est encore « en attente » à cet
--     instant (accepted_at se remplit juste après) : la compter aussi
--     double-compterait la même personne et refuserait l'acceptation
--     exactement quand tout est en ordre.
--
--   Les deux décomptes réunis gardent l'invariant membres + en attente ≤
--   quota : l'invitation naît sous le premier décompte, l'acceptation
--   transfère la place de l'une à l'autre sans l'ajouter.
--
-- Seules les INSERT sont déclenchées : ni UPDATE ni DELETE ne crée
-- d'employé — un membre qui part libère sa place par la suppression, sans
-- trigger (aucune libération n'a besoin d'être refusée).
CREATE OR REPLACE FUNCTION check_employee_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_plan   text;
  v_quota  int;
  v_comptes int;
BEGIN
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = NEW.owner_id;

  v_plan := COALESCE(v_plan, 'free');

  SELECT value INTO v_quota
    FROM plan_config
   WHERE plan = v_plan AND key = 'employees';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'business_members' THEN
    SELECT COUNT(*) INTO v_comptes
      FROM business_members
     WHERE owner_id = NEW.owner_id;
  ELSE
    SELECT
      (SELECT COUNT(*) FROM business_members WHERE owner_id = NEW.owner_id)
    + (SELECT COUNT(*) FROM employee_invitations
        WHERE owner_id = NEW.owner_id
          AND accepted_at IS NULL
          AND expires_at > now())
    INTO v_comptes;
  END IF;

  IF v_comptes >= v_quota THEN
    IF v_quota = 0 THEN
      RAISE EXCEPTION 'Le plan % ne prend pas d''employé. Passez à un plan supérieur.', v_plan;
    END IF;
    RAISE EXCEPTION 'Limite du plan % atteinte : % employé(s) maximum, invitations en attente comprises. Passez à un plan supérieur.', v_plan, v_quota;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_employee_limit ON employee_invitations;
CREATE TRIGGER enforce_employee_limit
  BEFORE INSERT ON employee_invitations
  FOR EACH ROW EXECUTE FUNCTION check_employee_limit();

DROP TRIGGER IF EXISTS enforce_member_limit ON business_members;
CREATE TRIGGER enforce_member_limit
  BEFORE INSERT ON business_members
  FOR EACH ROW EXECUTE FUNCTION check_employee_limit();

-- ============================================================
--  ⬇ migration_relances.sql
-- ============================================================

-- ============================================================
-- migration_relances.sql — P6 : relances automatiques (rappel programmé)
--
-- L'évaluation §7 tranche : la relance MANUELLE est sur tous les plans
-- (« Dettes + relance manuelle : oui »), les relances AUTOMATIQUES sont
-- Starter et Pro (« Relances automatiques : non | oui | oui »). Ce fichier
-- est la moitié payante : il détecte CE qu'il faut relancer et retient
-- QUAND on l'a fait. L'envoi lui-même reste le lien WhatsApp existant —
-- aucun code n'envoie un WhatsApp tout seul sans API Business.
--
-- LE CHOIX « CALCUL EN DIRECT »
--   Pas de cron, pas de table de signaux pré-calculés : dettes_a_relancer()
--   calcule à chaque lecture (données toujours fraîches, aucun secret à
--   poser, aucune panne silencieuse de job). Le jour où les notifications
--   push arrivent, c'est cette même fonction qui les alimentera.
--
-- LA CADENCE (7 JOURS, DEUX FOIS)
--   Une dette devient « à relancer » quand sa plus vieille vente ouverte a
--   7 jours ou plus, et ne le redevient que 7 jours après la dernière
--   relance journalisée. Ce sont des constantes de rythme produit — même
--   nature que le « depuis N jours » affiché par l'écran, qui utilise déjà
--   7 jours — pas des valeurs d'offre : rien à configurer, rien à cacher.
--
-- FAIL-SAFE : marquer_relance() ne refuse jamais bruyamment. La journali-
-- sation ne doit jamais empêcher l'envoi : un tap « Relancer » dont le log
-- échoue ouvre quand même WhatsApp (au pire, la dette ressurgit).
-- ============================================================

-- ─── 1. relance_suivi — quand chaque dette a été relancée ───
-- Une ligne par dette (customer_debts.id), écrasée à chaque relance. Pas de
-- colonne d'organisation : la dette appartient déjà à une boutique, et c'est
-- elle qui porte l'isolation. Suppression en cascade : une dette qui
-- disparaît n'a plus rien à rappeler.
CREATE TABLE IF NOT EXISTS relance_suivi (
  debt_id          uuid        NOT NULL PRIMARY KEY REFERENCES customer_debts(id) ON DELETE CASCADE,
  last_reminded_at timestamptz NOT NULL DEFAULT now(),
  reminded_by      uuid
);

ALTER TABLE relance_suivi ENABLE ROW LEVEL SECURITY;

-- Même régime que payment_orders : le navigateur ne touche pas la table.
-- Toute lecture passe par dettes_a_relancer(), toute écriture par
-- marquer_relance(), toutes deux SECURITY DEFINER avec contrôle du patron.
REVOKE ALL ON relance_suivi FROM anon;
REVOKE ALL ON relance_suivi FROM authenticated;
GRANT ALL ON relance_suivi TO service_role;

COMMENT ON TABLE relance_suivi IS
  'Dernière relance journalisée par dette. Écrite par marquer_relance() au '
  'tap « Relancer », lue par dettes_a_relancer() pour ne pas re-proposer '
  'une dette déjà relancée il y a moins de 7 jours.';

-- ─── 2. marquer_relance() — journaliser l'envoi ───
CREATE OR REPLACE FUNCTION marquer_relance(p_debt_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Dette d'une autre boutique : on ment poliment (false), on ne lève pas.
  -- Lever ici bloquerait l'ouverture de WhatsApp côté écran.
  IF NOT EXISTS (SELECT 1 FROM customer_debts d
                  WHERE d.id = p_debt_id
                    AND d.user_id = get_business_owner_id()) THEN
    RETURN false;
  END IF;

  INSERT INTO relance_suivi (debt_id, last_reminded_at, reminded_by)
  VALUES (p_debt_id, now(), auth.uid())
  ON CONFLICT (debt_id) DO UPDATE
    SET last_reminded_at = now(),
        reminded_by = auth.uid();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION marquer_relance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marquer_relance(uuid) TO authenticated;

COMMENT ON FUNCTION marquer_relance(uuid) IS
  'Journalise une relance au tap « Relancer ». Ne refuse jamais bruyamment '
  '(false si dette étrangère) : le log ne doit pas empêcher l''envoi.';

-- ─── 3. dettes_a_relancer() — CE qu'il faut relancer ───
-- Même calcul de solde que get_customer_debts() (dues par téléphone, dettes
-- soldées exclues), plus deux filtres : âge de la plus vieille vente
-- ouverte (≥ 7 jours) et fraîcheur de la dernière relance (< 7 jours →
-- masquée). Le verrou de plan est ici, pas dans l'écran : current_org_plan()
-- connaît l'essai (starter) comme l'échéance (retour au gratuit).
CREATE OR REPLACE FUNCTION dettes_a_relancer()
RETURNS TABLE (
  debt_id          uuid,
  phone            text,
  name             text,
  total_due        numeric,
  total_paid       numeric,
  oldest_sale_at   timestamptz,
  jours            integer,
  last_reminded_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                  AS total_paid,
      MIN(s.created_at)                       AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  )
  SELECT d.id,
         d.phone,
         d.name,
         GREATEST(COALESCE(u.total_due, 0), 0),
         COALESCE(u.total_paid, 0),
         u.oldest_sale_at,
         (extract(epoch FROM now() - u.oldest_sale_at) / 86400)::int,
         rs.last_reminded_at
    FROM customer_debts d
    LEFT JOIN dues u
      ON u.user_id = d.user_id AND u.client_phone = d.phone
    LEFT JOIN relance_suivi rs
      ON rs.debt_id = d.id
   WHERE d.user_id = get_business_owner_id()
     -- VERROU DE PLAN (évaluation §7 : automatiques = Starter et Pro).
     -- current_org_plan() traduit l'essai en starter et l'échéance en free :
     -- un essai en cours reçoit les rappels, un plan échu ne les reçoit plus.
     AND current_org_plan() IN ('starter', 'pro')
     AND GREATEST(COALESCE(u.total_due, 0), 0) > 0
     AND u.oldest_sale_at <= now() - interval '7 days'
     AND (rs.last_reminded_at IS NULL
          OR rs.last_reminded_at <= now() - interval '7 days')
   ORDER BY u.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION dettes_a_relancer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dettes_a_relancer() TO authenticated;

COMMENT ON FUNCTION dettes_a_relancer() IS
  'Dettes à relancer pour la boutique appelante, du plus ancien au plus '
  'récent : solde > 0, plus vieille vente ouverte ≥ 7 jours, pas de relance '
  'journalisée depuis 7 jours. Vide sur le plan gratuit (la relance manuelle '
  'reste, elle, sur tous les plans). SECURITY DEFINER : lit relance_suivi, '
  'révoquée au navigateur.';

-- ============================================================
--  ⬇ migration_plan_definer.sql
-- ============================================================

-- ============================================================
-- migration_plan_definer.sql — les triggers de quotas lisent en propriétaire
--
-- BUG PROD (Sprint 19) : check_product_limit() et check_employee_limit()
-- lisent plan_config, table RÉVOQUÉE au navigateur. En SECURITY INVOKER
-- (le défaut), chaque création de produit et chaque invitation répondait
-- 403 « permission denied for table plan_config » en production : la
-- boutique ne pouvait plus ajouter d'article. Le harnais ne le voyait pas —
-- il s'exécute en superuser, insensible aux REVOKE (section 39 : les
-- triggers y sont désormais exercés en rôle authenticated).
--
-- SECURITY DEFINER : le trigger lit les quotas en propriétaire, comme
-- within_plan_history() le fait déjà pour la fenêtre d'historique. Le
-- contrôle reste le même (plan effectif, invitations en attente comptées,
-- fail-open sans ligne posée) ; seul le lecteur change. ALTER, pas
-- CREATE OR REPLACE : le corps est intact, seul le régime change.
-- ============================================================

ALTER FUNCTION check_product_limit() SECURITY DEFINER;
ALTER FUNCTION check_employee_limit() SECURITY DEFINER;

COMMENT ON FUNCTION check_product_limit() IS
  'Quota produits à l''INSERT : SECURITY DEFINER car plan_config est '
  'révoquée au navigateur — en INVOKER, chaque création répondait 403.';

COMMENT ON FUNCTION check_employee_limit() IS
  'Quota employés (invitations en attente comprises) : SECURITY DEFINER, '
  'même raison — une invitation répondait 403 au lieu du message de plan.';

-- ============================================================
--  ⬇ migration_realtime.sql
-- ============================================================

-- ============================================================
-- migration_realtime.sql — temps réel multi-caisses (Supabase Realtime)
-- À exécuter dans Supabase SQL Editor, APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : deux caisses du même commerce (patron + employé, ou deux
-- téléphones) partagent le stock, les ventes, les dettes et les commandes de
-- salle. Sans temps réel, chaque appareil ne voit les changements de l'autre
-- qu'après un rechargement manuel. Le client s'abonne via
-- src/lib/hooks/useRealtimeRefresh.ts et relit la base à chaque changement —
-- la base reste la seule source de vérité.
--
-- CE QUE FAIT CETTE MIGRATION : ajouter `products`, `sales`, `customer_debts`
-- et `restaurant_orders` à la publication `supabase_realtime`, sans quoi le
-- serveur Realtime n'émet aucun événement pour ces tables. Rien d'autre : ni
-- policy, ni privilège, ni données.
--
-- LA RLS EST RESPECTÉE : Supabase Realtime évalue les policies avec l'identité
-- de l'abonné (son JWT). Un abonné ne reçoit donc que les lignes qu'il peut
-- déjà lire — le filtre `user_id` côté client n'est qu'une optimisation.
--
-- INERTE PAR DÉFAUT : la partie client n'ouvre aucun canal tant que
-- NEXT_PUBLIC_REALTIME ne vaut pas « 1 ». Cette migration peut donc être
-- appliquée sans rien activer.
--
-- Rejouable : le bloc ne fait rien si la publication n'existe pas (harnais
-- PGlite), si la table n'existe pas encore, ou si elle y est déjà.
-- ============================================================

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['products', 'sales', 'customer_debts', 'restaurant_orders', 'restaurant_order_items', 'restaurant_reservations'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = t
         )
      THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ============================================================
--  ⬇ migration_hardening.sql
-- ============================================================

-- ============================================================
-- migration_hardening.sql — durcissement du schéma public (S-4)
-- À exécuter APRÈS migration_security.sql
-- ============================================================
--
-- S-4 : `anon` et `authenticated` ne doivent pas pouvoir CRÉER d'objets dans
-- le schéma public. Ce n'est pas exploitable directement aujourd'hui — les
-- fonctions SECURITY DEFINER figent leur `search_path = public` et les tables
-- qu'elles lisent existent déjà, donc rien ne peut être « shadowé ». Mais
-- c'est la deuxième moitié de la règle : un schéma où le client ne peut pas
-- écrire ne peut pas être détourné, même si une future fonction oubliait son
-- `search_path`.
--
-- Le rôle `postgres` (migrations, scripts) garde tous ses droits ; `service_role`
-- conserve les siens (GRANT explicites, non retirés par un REVOKE sur PUBLIC).
--
-- Rejouable : REVOKE est idempotent.
-- ============================================================

REVOKE CREATE ON SCHEMA public FROM anon, authenticated;

-- ============================================================
--  ⬇ migration_cash_sessions.sql
-- ============================================================

-- ============================================================
-- migration_cash_sessions.sql — sessions de caisse (fond, clôture, écart)
-- À exécuter APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : une caisse doit s'OUVRIR (avec un fond de caisse) et se CLÔTURER
-- (avec un comptage). Sans cela, un commerçant ne peut pas répondre à la seule
-- question qui compte en fin de journée : « j'ai compté tant, j'aurais dû avoir
-- combien ? ». La « base de caisse » (amount_received) existe déjà dans les
-- calculs de CA ; il manquait l'ouverture et la clôture explicites.
--
-- DEUX RPC, SECURITY DEFINER :
--   • open_cash_session(fond)     — refuse une seconde caisse ouverte ;
--   • close_cash_session(compte)  — calcule l'attendu, l'écart, et ferme.
--
-- L'ATTENDU est calculé EN BASE, jamais reçu du navigateur :
--   fond + encaissements ESPÈCES depuis l'ouverture.
-- Les encaissements espèces = ventes `payment_method='cash'` (amount_received)
-- + règlements `credit_payments.method='cash'` (acomptes et dettes). Une vente
-- à crédit n'est PAS en 'cash', et son acompte est déjà dans credit_payments :
-- aucun double compte.
--
-- LES CHARGES NE SONT PAS DÉDUITES : la table `expenses` n'a pas de moyen de
-- paiement — impossible de savoir si une charge a été payée en espèces depuis
-- le tiroir. On ne devine pas : l'écart reste « attendu vs compté », et le
-- commerçant l'explique par une note.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opened_by     uuid NOT NULL,
  opening_float numeric(12,2) NOT NULL DEFAULT 0,
  closed_at     timestamptz,
  closed_by     uuid,
  counted_cash  numeric(12,2),
  expected_cash numeric(12,2),
  difference    numeric(12,2),
  note          text,
  CONSTRAINT cash_sessions_float_non_negative   CHECK (opening_float >= 0),
  CONSTRAINT cash_sessions_counted_non_negative CHECK (counted_cash IS NULL OR counted_cash >= 0)
);

-- Une seule caisse OUVERTE par boutique : deux caissiers ne doivent pas tenir
-- deux tiroirs « ouverts » en parallèle dans la même boutique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_sessions_ouverte
  ON cash_sessions(user_id) WHERE closed_at IS NULL;

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;

-- Lecture : le patron ET ses employés (un caissier doit voir la caisse ouverte).
DROP POLICY IF EXISTS "cash_sessions_read" ON cash_sessions;
CREATE POLICY "cash_sessions_read" ON cash_sessions
  FOR SELECT USING (user_id = get_business_owner_id());

-- Aucune écriture client : les deux RPC SECURITY DEFINER s'en chargent, et
-- l'attendu/écart ne peut donc pas être forgé par le navigateur.
REVOKE INSERT, UPDATE, DELETE ON cash_sessions FROM anon, authenticated;


-- ─── Ouvrir la caisse ───────────────────────────────────────
CREATE OR REPLACE FUNCTION open_cash_session(p_opening_float numeric DEFAULT 0)
RETURNS cash_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_row   cash_sessions;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_opening_float IS NULL OR p_opening_float < 0 THEN
    RAISE EXCEPTION 'Le fond de caisse ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM cash_sessions WHERE user_id = v_owner AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'Une caisse est déjà ouverte pour cette boutique' USING ERRCODE = '23514';
  END IF;

  INSERT INTO cash_sessions (user_id, opened_by, opening_float)
  VALUES (v_owner, auth.uid(), p_opening_float)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION open_cash_session(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_cash_session(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION open_cash_session(numeric) TO service_role;

COMMENT ON FUNCTION open_cash_session(numeric) IS
  'Ouvre la caisse de la boutique avec un fond. Refuse une seconde caisse '
  'ouverte. SECURITY DEFINER : l''écriture n''est pas ouverte au navigateur.';


-- ─── Clôturer la caisse ─────────────────────────────────────
CREATE OR REPLACE FUNCTION close_cash_session(p_counted_cash numeric, p_note text DEFAULT NULL)
RETURNS cash_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid := get_business_owner_id();
  v_row     cash_sessions;
  v_entrees numeric(12,2);
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
    RAISE EXCEPTION 'Le montant compté ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM cash_sessions
   WHERE user_id = v_owner AND closed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune caisse ouverte' USING ERRCODE = 'P0002';
  END IF;

  -- Encaissements ESPÈCES depuis l'ouverture. Ventes espèces + règlements
  -- espèces (acomptes de vente à crédit et dettes). Pas de double compte :
  -- une vente à crédit n'est pas en 'cash', son acompte est dans cp.
  SELECT COALESCE((
           SELECT SUM(s.amount_received) FROM sales s
            WHERE s.user_id = v_owner
              AND s.payment_method = 'cash'
              AND s.created_at >= v_row.opened_at
         ), 0)
       + COALESCE((
           SELECT SUM(cp.amount) FROM credit_payments cp
            WHERE cp.user_id = v_owner
              AND cp.method = 'cash'
              AND cp.created_at >= v_row.opened_at
         ), 0)
    INTO v_entrees;

  UPDATE cash_sessions
     SET closed_at     = now(),
         closed_by     = auth.uid(),
         counted_cash  = p_counted_cash,
         expected_cash = v_row.opening_float + v_entrees,
         difference    = p_counted_cash - (v_row.opening_float + v_entrees),
         note          = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION close_cash_session(numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_cash_session(numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION close_cash_session(numeric, text) TO service_role;

COMMENT ON FUNCTION close_cash_session(numeric, text) IS
  'Clôture la caisse ouverte : calcule l''attendu (fond + espèces encaissées '
  'depuis l''ouverture), l''écart avec le compté, et ferme. Les charges ne sont '
  'pas déduites (pas de moyen de paiement connu). SECURITY DEFINER.';

-- ============================================================
--  ⬇ migration_purchase_orders.sql
-- ============================================================

-- ============================================================
-- migration_purchase_orders.sql — bons de commande fournisseur
-- À exécuter APRÈS migration_suppliers.sql
-- ============================================================
--
-- POURQUOI : le module fournisseurs existe, mais on ne peut que les
-- enregistrer. Un commerce COMMANDE : on prépare une commande (quels
-- articles, combien, à quel coût), on l'envoie au fournisseur, puis on la
-- RÉCEPTIONNE — et c'est la réception qui fait entrer le stock.
--
-- DEUX RPC, SECURITY DEFINER (aucune écriture client sur ces tables) :
--   • create_purchase_order(fournisseur, lignes, note) — naît en « ordered » ;
--   • receive_purchase_order(id)  — incrémente le stock + journal de stock,
--                                   passe en « received » (une seule fois) ;
--   • cancel_purchase_order(id)   — annule une commande non reçue.
--
-- La RÉCEPTION est le seul moment où le stock bouge : créer une commande ne
-- touche à rien. Le coût unitaire est CONSERVÉ sur la ligne (traçabilité du
-- prix d'achat), mais ne réécrit PAS products.price_buy : changer le coût
-- courant est une décision du commerçant, pas un effet de bord d'une
-- réception.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ─── 1. La commande ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id   uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  -- Instantané du nom : une commande doit rester lisible même si le
  -- fournisseur est retiré du carnet.
  supplier_name text,
  status        text NOT NULL DEFAULT 'ordered'
                CHECK (status IN ('ordered', 'received', 'cancelled')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  received_at   timestamptz,
  received_by   uuid
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_user
  ON purchase_orders(user_id, created_at DESC);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_orders_read" ON purchase_orders;
CREATE POLICY "purchase_orders_read" ON purchase_orders
  FOR SELECT USING (user_id = get_business_owner_id());

-- ─── 2. Les lignes ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  quantity     numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost    numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order
  ON purchase_order_items(order_id);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_order_items_read" ON purchase_order_items;
CREATE POLICY "purchase_order_items_read" ON purchase_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM purchase_orders o
       WHERE o.id = purchase_order_items.order_id
         AND o.user_id = get_business_owner_id()
    )
  );

-- Aucune écriture client : les RPC s'en chargent.
REVOKE INSERT, UPDATE, DELETE ON purchase_orders      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON purchase_order_items FROM anon, authenticated;
REVOKE ALL ON purchase_orders      FROM anon;
REVOKE ALL ON purchase_order_items FROM anon;


-- ─── 3. Créer une commande ──────────────────────────────────
CREATE OR REPLACE FUNCTION create_purchase_order(
  p_supplier_id uuid,
  p_items       jsonb,
  p_note        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid := get_business_owner_id();
  v_order_id uuid;
  v_nom      text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Une commande doit contenir au moins une ligne' USING ERRCODE = '22023';
  END IF;

  -- Chaque ligne doit être valide AVANT toute écriture.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
       OR COALESCE(e->>'unit_cost', '0') !~ '^[0-9]+([.,][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'Ligne de commande invalide' USING ERRCODE = '22023';
  END IF;

  -- Le fournisseur doit appartenir à la boutique (sinon ignoré).
  IF p_supplier_id IS NOT NULL THEN
    SELECT name INTO v_nom FROM suppliers WHERE id = p_supplier_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fournisseur introuvable' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO purchase_orders (user_id, supplier_id, supplier_name, note, created_by)
  VALUES (v_owner, p_supplier_id, v_nom, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_order_id;

  -- Les produits doivent appartenir à la boutique : on lit le nom et on refuse
  -- un produit étranger, plutôt que d'écrire une ligne orpheline.
  INSERT INTO purchase_order_items (order_id, product_id, product_name, quantity, unit_cost)
  SELECT v_order_id,
         p.id,
         p.name,
         (replace(e->>'quantity', ',', '.'))::numeric,
         COALESCE(NULLIF(replace(e->>'unit_cost', ',', '.'), ''), '0')::numeric
    FROM jsonb_array_elements(p_items) AS e
    JOIN products p ON p.id = (e->>'product_id')::uuid AND p.user_id = v_owner;

  IF (SELECT count(*) FROM purchase_order_items WHERE order_id = v_order_id) = 0 THEN
    RAISE EXCEPTION 'Aucun produit valide dans la commande' USING ERRCODE = '22023';
  END IF;

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION create_purchase_order(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_purchase_order(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION create_purchase_order(uuid, jsonb, text) TO service_role;


-- ─── 4. Réceptionner (fait entrer le stock) ─────────────────
CREATE OR REPLACE FUNCTION receive_purchase_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_statut text;
  v_ligne  record;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  SELECT status INTO v_statut
    FROM purchase_orders
   WHERE id = p_order_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_statut <> 'ordered' THEN
    RAISE EXCEPTION 'Cette commande n''est plus en attente (statut : %)', v_statut
      USING ERRCODE = '23514';
  END IF;

  -- Chaque ligne incrémente le stock et écrit le journal.
  FOR v_ligne IN
    SELECT i.product_id, i.product_name, i.quantity
      FROM purchase_order_items i
     WHERE i.order_id = p_order_id
  LOOP
    UPDATE products
       SET stock_qty = stock_qty + v_ligne.quantity
     WHERE id = v_ligne.product_id AND user_id = v_owner;

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    )
    SELECT v_owner, v_ligne.product_id, v_ligne.product_name, 'restock',
           v_ligne.quantity,
           p.stock_qty - v_ligne.quantity, p.stock_qty, p_order_id
      FROM products p
     WHERE p.id = v_ligne.product_id;
  END LOOP;

  UPDATE purchase_orders
     SET status = 'received', received_at = now(), received_by = auth.uid()
   WHERE id = p_order_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION receive_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid) TO service_role;

COMMENT ON FUNCTION receive_purchase_order(uuid) IS
  'Réceptionne une commande : incrémente le stock, écrit le journal (restock), '
  'passe en « received ». Une seule fois (refuse si déjà reçue/annulée). '
  'Ne réécrit pas products.price_buy — le coût reste sur la ligne.';


-- ─── 5. Annuler ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_purchase_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_statut text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  SELECT status INTO v_statut
    FROM purchase_orders
   WHERE id = p_order_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_statut <> 'ordered' THEN
    RAISE EXCEPTION 'Seule une commande en attente peut être annulée (statut : %)', v_statut
      USING ERRCODE = '23514';
  END IF;

  UPDATE purchase_orders SET status = 'cancelled' WHERE id = p_order_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION cancel_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_purchase_order(uuid) TO service_role;

-- ============================================================
--  ⬇ migration_returns.sql
-- ============================================================

-- ============================================================
-- migration_returns.sql — retours / avoirs (ventes comptoir)
-- À exécuter APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : une vente comptoir (espèces / MoMo) ne pouvait pas être annulée
-- ni remboursée. Or un client se ravise, un article est défectueux. Le retour
-- doit : REMETTRE le stock, RENDRE l'argent, et TRACER l'avoir.
--
-- PÉRIMÈTRE v1 : ventes `cash` / `momo`. Un retour réduit `sales.amount_received`
-- du montant rendu — c'est la colonne qui définit le chiffre d'affaires (base
-- de caisse) partout, donc CA et tiroir suivent sans qu'aucun écran n'ait à
-- changer. Le remboursement suit donc le moyen de la VENTE (une vente espèces
-- rend des espèces).
--
-- LE CRÉDIT EST REFUSÉ ICI : sur une vente à crédit, réduire amount_received
-- AUGMENTERAIT la dette (get_customer_debts calcule total_amount −
-- amount_received). Un retour à crédit doit passer par le carnet de dettes —
-- on le dit, on ne le devine pas.
--
-- Le stock est remis (products.stock_qty += quantité) et le journal reçoit un
-- mouvement 'return'. On ne peut pas rendre plus que ce qui a été vendu, ni
-- deux fois la même quantité : les retours déjà enregistrés sont déduits.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ─── 1. L'avoir et ses lignes ───────────────────────────────
CREATE TABLE IF NOT EXISTS sale_returns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sale_id    uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount     numeric(12,2) NOT NULL CHECK (amount >= 0),
  method     text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'momo')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    uuid NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  quantity     numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);

ALTER TABLE sale_returns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_returns_read" ON sale_returns;
CREATE POLICY "sale_returns_read" ON sale_returns
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "sale_return_items_read" ON sale_return_items;
CREATE POLICY "sale_return_items_read" ON sale_return_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.id = sale_return_items.return_id
         AND r.user_id = get_business_owner_id()
    )
  );

-- Aucune écriture client : la RPC s'en charge.
REVOKE INSERT, UPDATE, DELETE ON sale_returns      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON sale_return_items FROM anon, authenticated;
REVOKE ALL ON sale_returns      FROM anon;
REVOKE ALL ON sale_return_items FROM anon;


-- ─── 2. Enregistrer un retour ───────────────────────────────
CREATE OR REPLACE FUNCTION return_sale(
  p_sale_id uuid,
  p_items   jsonb,
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid := get_business_owner_id();
  v_sale     sales%ROWTYPE;
  v_return   uuid;
  v_montant  numeric(12,2) := 0;
  v_item     record;
  v_vendu    numeric(12,3);
  v_deja     numeric(12,3);
  v_prix     numeric(12,2);
  v_stock    numeric(12,3);
  v_nom      text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Un retour doit contenir au moins une ligne' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sale FROM sales
   WHERE id = p_sale_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- v1 : comptoir seulement. Voir l'en-tête.
  IF v_sale.payment_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Retour impossible sur une vente à crédit : réglez la dette depuis l''écran Dettes.'
      USING ERRCODE = '22023';
  END IF;

  -- Valider la forme de chaque ligne AVANT toute écriture.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'Ligne de retour invalide' USING ERRCODE = '22023';
  END IF;

  INSERT INTO sale_returns (user_id, sale_id, amount, method, note, created_by)
  VALUES (v_owner, p_sale_id, 0, v_sale.payment_method,
          NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_return;

  FOR v_item IN
    SELECT (e->>'product_id')::uuid AS product_id,
           (replace(e->>'quantity', ',', '.'))::numeric AS quantity
      FROM jsonb_array_elements(p_items) AS e
  LOOP
    -- Quantité vendue de ce produit sur CETTE vente.
    SELECT si.quantity, si.unit_price, si.product_name
      INTO v_vendu, v_prix, v_nom
      FROM sale_items si
     WHERE si.sale_id = p_sale_id AND si.product_id = v_item.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ce produit ne figure pas dans la vente' USING ERRCODE = 'P0002';
    END IF;

    -- Déjà retourné sur ce produit (tous retours confondus).
    SELECT COALESCE(SUM(sri.quantity), 0) INTO v_deja
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.id = sri.return_id
     WHERE sr.sale_id = p_sale_id AND sri.product_id = v_item.product_id;

    IF v_item.quantity > v_vendu - v_deja THEN
      RAISE EXCEPTION 'Retour supérieur à ce qui reste dû pour « % » (vendu : %, déjà retourné : %)',
        v_nom, v_vendu, v_deja USING ERRCODE = '23514';
    END IF;

    -- Remise en stock + journal.
    SELECT stock_qty INTO v_stock FROM products
     WHERE id = v_item.product_id AND user_id = v_owner FOR UPDATE;
    UPDATE products SET stock_qty = stock_qty + v_item.quantity
     WHERE id = v_item.product_id AND user_id = v_owner;
    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    ) VALUES (
      v_owner, v_item.product_id, v_nom, 'return',
      v_item.quantity, v_stock, v_stock + v_item.quantity, v_return
    );

    INSERT INTO sale_return_items (return_id, product_id, product_name, quantity, unit_price)
    VALUES (v_return, v_item.product_id, v_nom, v_item.quantity, v_prix);

    v_montant := v_montant + v_prix * v_item.quantity;
  END LOOP;

  -- Le montant rendu ne peut pas dépasser ce qui a été réellement encaissé.
  v_montant := LEAST(v_montant, v_sale.amount_received);

  UPDATE sale_returns SET amount = v_montant WHERE id = v_return;
  UPDATE sales SET amount_received = GREATEST(amount_received - v_montant, 0)
   WHERE id = p_sale_id;

  RETURN jsonb_build_object('return_id', v_return, 'amount', v_montant);
END;
$$;

REVOKE ALL ON FUNCTION return_sale(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION return_sale(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION return_sale(uuid, jsonb, text) TO service_role;

COMMENT ON FUNCTION return_sale(uuid, jsonb, text) IS
  'Retour d''une vente comptoir : remet le stock, réduit amount_received du '
  'montant rendu (donc le CA et le tiroir), trace l''avoir. Refuse une vente '
  'à crédit et un retour supérieur à ce qui reste dû.';

-- ============================================================
--  ⬇ migration_restaurant_price_trace.sql
-- ============================================================

-- ============================================================
-- migration_restaurant_price_trace.sql — prix catalogue figé sur la ligne de salle
-- À exécuter APRÈS migration_restaurant_finitions.sql
-- ============================================================
--
-- POURQUOI : `restaurant_order_items.unit_price` est écrit par le client (RLS
-- FOR ALL pour tout membre de l'équipe), et `close_table_order()` facture CE
-- prix. Un caissier pouvait donc insérer une ligne à 1 F et faire encaisser
-- 1 F — la recette prétendait le contraire, la base ne l'empêchait pas.
--
-- La parade est celle du comptoir (migration_price_override.sql) : le prix
-- catalogue est FIGÉ sur la ligne au moment de l'insertion, dans `list_price`.
-- Une concession reste possible — un patron peut offrir un plat — mais elle
-- devient VISIBLE (unit_price < list_price), au lieu de disparaître.
--
-- On n'interdit PAS unit_price < list_price : bloquer empêcherait d'offrir un
-- plat, comme bloquer la vente à perte empêcherait de solder un stock. C'est la
-- traçabilité qui protège, pas le verrou.
--
-- Rejouable : IF NOT EXISTS / DROP TRIGGER IF EXISTS / CREATE OR REPLACE.
-- ============================================================

ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS list_price numeric(12,2);

COMMENT ON COLUMN restaurant_order_items.list_price IS
  'Prix catalogue du produit, figé à l''insertion de la ligne. Rendu visible '
  'quand unit_price lui est inférieur : la concession reste traçable.';

CREATE OR REPLACE FUNCTION restaurant_order_items_set_list_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT p.price_sell INTO NEW.list_price
    FROM products p
   WHERE p.id = NEW.product_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION restaurant_order_items_set_list_price() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restaurant_order_items_set_list_price() TO authenticated, service_role;

DROP TRIGGER IF EXISTS restaurant_order_items_list_price ON restaurant_order_items;
CREATE TRIGGER restaurant_order_items_list_price
  BEFORE INSERT ON restaurant_order_items
  FOR EACH ROW EXECUTE FUNCTION restaurant_order_items_set_list_price();

-- ============================================================
--  ⬇ migration_restaurant_transfer_merge.sql
-- ============================================================

-- ─── Transfert et fusion de tables (Salle) ──────────────────────────────
--
-- Deux gestes du service en salle qu'un maquis fait tous les jours :
--   • « déplacer » une commande d'une table vers une autre (le client change
--     de place, on rapproche deux groupes) ;
--   • « fusionner » deux tables (deux groupes qui se rejoignent).
--
-- Les deux passent par des fonctions SQL, pas par des écritures dispersées du
-- client : l'index `uniq_restaurant_orders_open_table` interdit deux commandes
-- ouvertes sur la même table, et un transfert en deux temps (libérer puis
-- occuper) laisserait une fenêtre où la table est libre pour tout le monde.
-- Ici, tout se fait dans une transaction.
--
-- SECURITY INVOKER (défaut) : la RLS s'applique avec l'identité de l'appelant.
-- Un membre de l'équipe ne peut donc déplacer que les commandes de SA boutique.

-- ─── Transfert : déplacer une commande ouverte vers une table LIBRE ──────
CREATE OR REPLACE FUNCTION transfer_table_order(
  p_order_id        uuid,
  p_target_table_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_table  uuid;
BEGIN
  SELECT status, table_id INTO v_status, v_table
    FROM restaurant_orders WHERE id = p_order_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'Cette commande est déjà clôturée' USING ERRCODE = '22023';
  END IF;
  -- Déplacer vers la même table : rien à faire, mais pas une erreur.
  IF p_target_table_id = v_table THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM restaurant_tables WHERE id = p_target_table_id) THEN
    RAISE EXCEPTION 'Table introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM restaurant_orders
     WHERE table_id = p_target_table_id AND status <> 'closed'
  ) THEN
    RAISE EXCEPTION 'Cette table est déjà occupée' USING ERRCODE = '22023';
  END IF;

  UPDATE restaurant_orders SET table_id = p_target_table_id WHERE id = p_order_id;
END;
$$;

-- ─── Fusion : verser les lignes de la source dans la cible, puis la vider ─
--
-- La commande SOURCE est supprimée une fois vidée : sa table redevient libre,
-- et il ne reste qu'une seule addition. La commande CIBLE garde sa table et
-- reçoit toutes les lignes.
CREATE OR REPLACE FUNCTION merge_table_orders(
  p_source_order_id uuid,
  p_target_order_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_src_owner uuid;
  v_tgt_owner uuid;
  v_src_status text;
  v_tgt_status text;
BEGIN
  IF p_source_order_id = p_target_order_id THEN
    RAISE EXCEPTION 'Ce sont la même commande' USING ERRCODE = '22023';
  END IF;

  SELECT owner_id, status INTO v_src_owner, v_src_status
    FROM restaurant_orders WHERE id = p_source_order_id;
  SELECT owner_id, status INTO v_tgt_owner, v_tgt_status
    FROM restaurant_orders WHERE id = p_target_order_id;

  IF v_src_owner IS NULL OR v_tgt_owner IS NULL THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  -- Deux boutiques ne se mélangent jamais (la RLS le garantit déjà, mais la
  -- fonction est aussi appelable hors RLS par un rôle privilégié).
  IF v_src_owner <> v_tgt_owner THEN
    RAISE EXCEPTION 'Ces commandes ne sont pas de la même boutique' USING ERRCODE = '22023';
  END IF;
  IF v_src_status = 'closed' OR v_tgt_status = 'closed' THEN
    RAISE EXCEPTION 'Une des commandes est déjà clôturée' USING ERRCODE = '22023';
  END IF;

  UPDATE restaurant_order_items
     SET order_id = p_target_order_id
   WHERE order_id = p_source_order_id;

  DELETE FROM restaurant_orders WHERE id = p_source_order_id;
END;
$$;

REVOKE ALL ON FUNCTION transfer_table_order(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_table_orders(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfer_table_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION merge_table_orders(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION transfer_table_order(uuid, uuid) IS
  'Déplace une commande ouverte vers une table libre (même boutique).';
COMMENT ON FUNCTION merge_table_orders(uuid, uuid) IS
  'Verse les lignes d''une commande ouverte dans une autre, puis supprime la source.';

-- ============================================================
--  ⬇ migration_restaurant_covers.sql
-- ============================================================

-- ─── Couverts (nombre de clients à table) ────────────────────────────────
--
-- Le « nombre de couverts » est le chiffre de base d'un restaurant : c'est lui
-- qui donne le ticket moyen par client (CA ÷ couverts), la rotation des tables
-- et le taux d'occupation. Sans lui, un maquis ne sait pas s'il a fait 30
-- clients à 2 000 F ou 3 clients à 20 000 F — deux soirées très différentes.
--
-- Il se saisit à l'ouverture (ou en cours) de service, sur la commande ouverte,
-- et il est conservé sur la commande clôturée (comme `closed_at` et `sale_id`).

ALTER TABLE restaurant_orders ADD COLUMN IF NOT EXISTS covers int;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_orders_covers_check'
  ) THEN
    ALTER TABLE restaurant_orders
      ADD CONSTRAINT restaurant_orders_covers_check
      CHECK (covers IS NULL OR (covers >= 1 AND covers <= 200));
  END IF;
END $$;

COMMENT ON COLUMN restaurant_orders.covers IS
  'Nombre de clients à table (ticket moyen par couvert). NULL = non renseigné.';

-- ─── Statistiques restaurant (couverts, additions, CA) ───────────────────
--
-- Renvoie, sur une période (bornes locales incluses) :
--   • covers    : somme des couverts des commandes clôturées ;
--   • additions : nombre de tables soldées (additions) ;
--   • revenue   : chiffre d'affaires encaissé sur la période (sales).
-- Le client en tire le ticket moyen (revenue / additions) et le ticket moyen
-- par couvert (revenue / covers).
--
-- SECURITY INVOKER + RLS : un tenant ne voit que ses propres chiffres.
CREATE OR REPLACE FUNCTION get_restaurant_stats(
  p_from date,
  p_to   date,
  p_tz   text DEFAULT 'Africa/Porto-Novo'
) RETURNS TABLE (covers int, additions int, revenue numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE((
      SELECT SUM(o.covers) FROM restaurant_orders o
       WHERE o.status = 'closed'
         AND o.closed_at IS NOT NULL
         AND (o.closed_at AT TIME ZONE p_tz)::date BETWEEN p_from AND p_to
    ), 0)::int AS covers,
    COALESCE((
      SELECT COUNT(*) FROM restaurant_orders o
       WHERE o.status = 'closed'
         AND o.closed_at IS NOT NULL
         AND (o.closed_at AT TIME ZONE p_tz)::date BETWEEN p_from AND p_to
    ), 0)::int AS additions,
    COALESCE((
      SELECT SUM(s.total_amount) FROM sales s
       WHERE (s.created_at AT TIME ZONE p_tz)::date BETWEEN p_from AND p_to
    ), 0)::numeric AS revenue;
$$;

REVOKE ALL ON FUNCTION get_restaurant_stats(date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_restaurant_stats(date, date, text) TO authenticated;

COMMENT ON FUNCTION get_restaurant_stats(date, date, text) IS
  'Couverts, additions et CA d''une période (ticket moyen par couvert).';

-- ============================================================
--  ⬇ migration_restaurant_payments.sql
-- ============================================================

-- ─── Paiement multiple + partage par article ─────────────────────────────
--
-- 1. PARTAGE PAR ARTICLE : chaque ligne de commande peut être rattachée à un
--    convive (split_part). L'écran additionne alors par convive — on partage
--    « ce que chacun a commandé », pas seulement le total en N parts égales.
--
-- 2. PAIEMENT MULTIPLE : une même addition peut être réglée avec plusieurs
--    moyens (ex. 5 000 espèces + 3 000 MoMo). Les lignes vont dans
--    sale_payments ; la vente porte alors payment_method = 'mixed', et
--    get_sales_summary ventile espèces/MoMo à partir de ces lignes.

-- ── Part (convive) d'une ligne de commande ──
ALTER TABLE restaurant_order_items ADD COLUMN IF NOT EXISTS split_part int;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_items_split_part_check') THEN
    ALTER TABLE restaurant_order_items
      ADD CONSTRAINT restaurant_order_items_split_part_check
      CHECK (split_part IS NULL OR (split_part >= 1 AND split_part <= 20));
  END IF;
END $$;
COMMENT ON COLUMN restaurant_order_items.split_part IS
  'Convive auquel la ligne est rattachée (partage par article). NULL = non affecté.';

-- ── Paiements d'une vente ──
CREATE TABLE IF NOT EXISTS sale_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id    uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method     text NOT NULL CHECK (method IN ('cash', 'momo')),
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);

ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_payments_read ON sale_payments;
CREATE POLICY sale_payments_read ON sale_payments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM sales s
     WHERE s.id = sale_payments.sale_id
       AND s.user_id = get_business_owner_id()
  ));

-- Le client lit ses paiements ; il n'écrit que par la fonction (SECURITY DEFINER).
REVOKE ALL ON sale_payments FROM anon;
REVOKE INSERT, UPDATE, DELETE ON sale_payments FROM authenticated;
GRANT SELECT ON sale_payments TO authenticated;

-- ── close_table_order : accepte un tableau de paiements ──
-- L'ancienne signature (7 args) est retirée : sans ce DROP, deux surcharges
-- coexisteraient et les appels (navigateur et tests) deviendraient ambigus.
DROP FUNCTION IF EXISTS close_table_order(uuid, text, numeric, integer, text, text, numeric);
CREATE OR REPLACE FUNCTION public.close_table_order(p_order_id uuid, p_payment_method text, p_amount_paid numeric DEFAULT NULL::numeric, p_split_count integer DEFAULT 1, p_client_phone text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_tip numeric DEFAULT 0, p_payments jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_order   restaurant_orders%ROWTYPE;
  v_items   jsonb;
  v_sale    jsonb;
  v_sale_id uuid;
  v_total   numeric(12,2);
  v_paid    numeric(12,2);
  v_tip     numeric(12,2);
  v_table   text;
  v_multi   boolean := false;
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

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id, 'quantity', a.quantity, 'unit_price', a.unit_price)), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3) AS quantity,
             (i.unit_price + i.extra_price)::numeric(12,2) AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id
       GROUP BY i.product_id, (i.unit_price + i.extra_price)
    ) AS a;

  -- Paiement multiple : plusieurs moyens sur une même addition. La somme doit
  -- égaler l'addition (pas de crédit mélangé : le crédit a sa propre fonction).
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
    IF (SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(p_payments) e) <> v_total THEN
      RAISE EXCEPTION 'La somme des paiements doit égaler l''addition (% F)', v_total
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

  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_total THEN
      RAISE EXCEPTION 'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_total;
  END IF;

  UPDATE restaurant_orders
     SET status = 'closed', closed_at = now(), sale_id = v_sale_id,
         split_count = p_split_count, payment_method = p_payment_method,
         amount_paid = v_paid, tip = v_tip
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_total,
    'amount_paid',    v_paid,
    'tip',            v_tip,
    'total_with_tip', v_total + v_tip,
    'split_count',    p_split_count,
    'per_share',      round(v_total / p_split_count, 2)
  );
END;
$function$;

-- ── get_sales_summary : ventile espèces/MoMo depuis les paiements ──
CREATE OR REPLACE FUNCTION public.get_sales_summary(p_from date, p_to date, p_tz text DEFAULT 'UTC'::text)
RETURNS TABLE(day date, revenue numeric, cash numeric, momo numeric, tx bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH bornes AS (
    SELECT (p_from::timestamp AT TIME ZONE p_tz) AS debut,
           ((p_to + 1)::timestamp AT TIME ZONE p_tz) AS fin
  ),
  ventes AS (
    SELECT s.id, (s.created_at AT TIME ZONE p_tz)::date AS jour,
           s.amount_received, s.payment_method
      FROM sales s, bornes b
     WHERE s.created_at >= b.debut AND s.created_at < b.fin
  ),
  reglements AS (
    SELECT cp.sale_id,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'cash'), 0) AS cash,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'momo'), 0) AS momo
      FROM credit_payments cp
     WHERE cp.sale_id IS NOT NULL
     GROUP BY 1
  ),
  multi AS (
    SELECT sp.sale_id,
           COALESCE(SUM(sp.amount) FILTER (WHERE sp.method = 'cash'), 0) AS cash,
           COALESCE(SUM(sp.amount) FILTER (WHERE sp.method = 'momo'), 0) AS momo
      FROM sale_payments sp
     GROUP BY 1
  )
  SELECT
    v.jour AS day,
    COALESCE(SUM(v.amount_received), 0) AS revenue,
    COALESCE(SUM(COALESCE(m.cash, CASE WHEN v.payment_method = 'cash' THEN v.amount_received ELSE 0 END)), 0)
      + COALESCE(SUM(r.cash), 0) AS cash,
    COALESCE(SUM(COALESCE(m.momo, CASE WHEN v.payment_method = 'momo' THEN v.amount_received ELSE 0 END)), 0)
      + COALESCE(SUM(r.momo), 0) AS momo,
    COUNT(*) AS tx
  FROM ventes v
  LEFT JOIN reglements r ON r.sale_id = v.id
  LEFT JOIN multi m ON m.sale_id = v.id
  GROUP BY 1
  ORDER BY 1;
$function$;

-- ── create_sale : accepte 'mixed' (paiement multiple) ──
CREATE OR REPLACE FUNCTION public.create_sale(p_items jsonb, p_payment_method text, p_client_name text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_client_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
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
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    v_est_plat := EXISTS (
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

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
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
$function$
;