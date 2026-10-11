-- ─── Remises et offerts ──────────────────────────────────────────────────
--
-- Deux gestes d'un maquis, réservés au patron et aux managers (comme le prix
-- négocié à la caisse) :
--   • OFFERT : une ligne est offerte (tournée, geste commercial). Elle sort de
--     l'addition sans disparaître de l'historique — la cuisine l'a préparée.
--   • REMISE : une réduction sur le total de l'addition (montant en F), tracée
--     dans sales.discount_amount.
--
-- L'autorisation est vérifiée en base (can_manage_products), pas seulement à
-- l'écran : une remise est de l'argent qui sort.

ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS is_offered boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN restaurant_order_items.is_offered IS
  'Ligne offerte (tournée) : comptée 0 dans l''addition, gardée à l''historique.';

-- Remise accordée sur une addition (montant en F), tracée sur la vente.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN sales.discount_amount IS
  'Remise accordée sur la vente (F). Le total_amount et l''amount_received sont déjà nets.';

-- ── close_table_order : remise + offert ──
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
           'product_id', a.product_id, 'quantity', a.quantity, 'unit_price', a.unit_price)), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3) AS quantity,
             (i.unit_price + i.extra_price)::numeric(12,2) AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id AND NOT i.is_offered
       GROUP BY i.product_id, (i.unit_price + i.extra_price)
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

