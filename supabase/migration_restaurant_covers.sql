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
