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
