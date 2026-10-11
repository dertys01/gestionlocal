-- ============================================================================
--  AUDIT PROD ↔ DÉPÔT — GÉNÉRÉ par scripts/gen-audit-prod.mjs (ne pas éditer).
--
--  À exécuter sur la base cible (Supabase SQL Editor → New query, ou psql).
--  Chaque ligne doit dire OK :
--    OK           = identique au dépôt, byte à byte
--    FORMAT       = même logique, commentaires/espaces seuls diffèrent (sans
--                   risque comportemental ; re-synchronisable par réapplication)
--    DIVERGENCE   = la base ne fait pas ce que le dépôt dit (à corriger)
--    MANQUANTE    = fonction absente de la base
--    EN PLUS      = fonction présente en base mais pas dans le dépôt
--
--  61 fonctions · ordre des sections = APPLY_MIGRATIONS.sql
-- ============================================================================
WITH expect(sig, brut_md5, code_md5) AS (
  VALUES
    ('activate_prepaid_plan(text)', '11f2150b9a0703d9fc614a56a9ea72ed', '0b9971edb05ee1e252b57cf4ce1dd9b3'),
    ('add_recipe_ingredient(uuid,uuid,numeric)', 'e4c0dad4130d66ec3a640b89a0ce5bba', '8337ef1fe6a90cc392cd66df125e56fc'),
    ('archive_product(uuid)', '610b13ef4713663065496c91f73a8786', '9dd0a32e27855218c7983ae482f6ba37'),
    ('beta_claim_slot()', 'e004c9eaec49a5b43916a2adba0fe4ad', 'd0b3e0b43bb0d5f7f8d4a6ccc2b01c1e'),
    ('beta_record_access()', 'e8b542d4667113dd77a3605542fcd9dd', 'e451433ec91bd9bfe216e88e54054ae8'),
    ('beta_status()', 'a5cc743e43988495523970c1f56252be', 'a6aa4fbce06490cd79aed2131a51154c'),
    ('bump_rate_limit(text,integer,integer)', '8610c404663063367697129f896b24a9', '4dba3acf3685f282fd7b22c011350327'),
    ('business_members_reject_owner_member()', '2cbeac4c9480bd23a8d5ae26669c4036', 'cb4202f1705d555b74cbb106ecf08409'),
    ('business_members_remove(uuid)', '5f36ed6ff400cc61947a140820c5730f', '3fdd9d32586d3d98153089078ce2dd94'),
    ('business_members_set_role(uuid,text)', '89a1cd9f06512fb862d59d3a5da9a19b', '89f32a91dcf97b1cae903be3cb2c0c68'),
    ('can_manage_products()', '7c1b153eba2bc02e61338c6b4becb01e', '475b14d5a81518d7f37aa3849484189d'),
    ('cancel_purchase_order(uuid)', 'cda9bc77c7b128799ada7dece149d688', '60b8ef867a7d04936fa7608ec0ba8c8f'),
    ('check_employee_limit()', '828a3a5f9922e321d185623e33fc04fb', 'f904113a6081292e40040c09e64daab8'),
    ('check_product_limit()', 'd64eeeeff7e006665fc411182193e1b9', '832d753ae1e76152276f0732c2897b51'),
    ('check_product_supplier_tenant()', 'a67a791a03cdd317a211be3c870759e6', '03adf983a5186d2d128430f334e6237f'),
    ('claim_webhook_event(text,text,text)', '40a1a3cbee1bf96bae5f60debca639fa', '0c164db9340e69ec622cd45bae135cb4'),
    ('close_beta_program()', '28a8854e2d5e4e0ebf74288bfa0a0cae', '5a82cf9f604a045ca4f163abc3cd1650'),
    ('close_cash_session(numeric,text)', 'd1e5c3e2147d0ed81ee5961cd765a92a', '5d4188a21f7075822623e4399cfb9b50'),
    ('close_table_order(uuid,text,numeric,integer,text,text,numeric)', '0203a702c3229e4d060d929cfb7e1285', '3954e9994a8ec5e873973912f02ebd0a'),
    ('create_purchase_order(uuid,jsonb,text)', '0ecdb36e9b685dae5820226869f2200c', '0bd09e22a9287cd7afd90f08f406f4d7'),
    ('create_sale(jsonb,text,text,text,text)', 'd57c23eaebf5d820bb157f57a6a3f65d', '6e48909dfa5123a80d60795dbbc118dc'),
    ('current_org_plan()', 'ca233084cdc9d653a98bd164a4eae2ac', 'db407b6e27b88cf7f4a0e454971fd30a'),
    ('dettes_a_relancer()', '7a77668c91d18e50b57f655efd059296', '8394e999b5a1b5ece8bf510fb16e8c5c'),
    ('fill_amount_received()', '35e03e2e5bc95e91ad3d43a5e0c5e8e2', '5e1305ee23c60dc867e4b46cd49f9219'),
    ('freeze_sale_item_cost()', '51ea5fb2804004f581857f43c0702706', '9c10ad43d8f21aed0a3b77accd71c0da'),
    ('get_activation_funnel(date,date,timestampwithtimezone)', '2e33c88246c4097b8e8db48c88139f67', '4074908f327846331cfe0fe8f50785d8'),
    ('get_business_owner_id()', 'f1a35c5ce9ed572c1a3313ba0be69fb7', '6cd22294040166c9e6714901940420d2'),
    ('get_cash_flow(date,date)', 'd10976d2751a09b723cf67184725b566', '35094efd447bccb61360005a3876c9ca'),
    ('get_customer_debts()', '1167942d7e174732e05ba3854db67b1a', 'cbf003dd943e7232899d57267a5412ff'),
    ('get_product_profitability()', '3c326bb6148f64e6b04a147c9af1de34', '5fcbcc2842acd55de605b58ab8f4e1f1'),
    ('get_restaurant_stats(date,date,text)', '5b0a1d5685e80af68528376ee3caed09', '054cd6e9f6098fccda819c1017299e9f'),
    ('get_sales_summary(date,date,text)', 'b20ea71234701f0c5cf9c570040027b2', '874d04e131374a05e6e53a23fa2a78bf'),
    ('get_top_products(date,date,text,integer)', '03bcc22bb85b632d90912b919ad92c0d', '7487786d4255660fe52e807dc79f60b1'),
    ('get_units_sold_since(integer)', '8f74000cae984ddf44cf1a6a78ffe3e2', '6b45edfae71cd3b4be3816ad3c959550'),
    ('marquer_relance(uuid)', '17d82722d6179dd487dd1ab67d258948', '3fd61fb19fa1f0010e87d02ad48706b5'),
    ('merge_table_orders(uuid,uuid)', 'e8504e12fdc721d23766cbee27420143', '57b475088295c8c1b52ab6cf81601e12'),
    ('normalize_phone(text)', '560e755f78d2debe862a2814cddae112', '3f8addb8c5e4fbf0ace0ccbceeeda9cc'),
    ('open_cash_session(numeric)', '996128475c5cda3f3db339c96d3b7f82', 'd7c91c30eda660e8de44c21795ff6cb3'),
    ('organizations_reject_plan_change()', '9ee6f5d51d38737a7dc107f3f92caf88', 'feb8216cb154d6953576fe38198dc44a'),
    ('pay_customer_debt(uuid,numeric,text,text)', 'c2464b9cb0a7397a2a09d56032533efe', '1c514fcfadaf0642d540b8318727872c'),
    ('product_cost(uuid,integer)', 'd33441e87e3ffd248893a7024af5ff0e', '0f48633b1895a064c9aaa646118ade47'),
    ('purge_accepted_invitations(uuid,integer)', 'ddeff8d4c129880458a3b22c50c17fc9', '463d9c590e8166ae26d1309daf44b4f8'),
    ('purge_rate_limits()', '4b7a9b9d63f02a306a83ab8f5e29aac7', '809045c7d82f9d32e142716d707faf44'),
    ('receive_purchase_order(uuid)', 'a4e3ca9ed524c7b3dba4e5bf6225efaf', '0f872caa0fb27c144077be015245d544'),
    ('record_credit_sale(jsonb,text,text,text,numeric,text,text)', '648df951e01d4c3bf70acd4056df1498', '2e54595a4070ba57a0a42c4bbbd36a5b'),
    ('redeem_invitation(text,uuid,text)', '62597d5a8ef7b127a90c4354397b735e', '152bbebdabb4071781f1003954618caf'),
    ('require_feature(text)', '8e95a1aba9ea44b186021f6c44cad186', '58f6b3d5be92afdc51ce430688c49882'),
    ('restaurant_order_items_set_list_price()', '7790f8ba6376664fd331e7e29bbb728b', '6f0ffc98a7f8ed543ee9b61c45001e89'),
    ('restore_product(uuid)', 'a31eb65d699703f77adefa8827201769', '5a50f0cf4574e3016236455cd81ffa27'),
    ('return_sale(uuid,jsonb,text)', '6e0b862e73992e29b610fdce5ec15dec', '57f32fd9d89323098b7b1cfe7d99fd1f'),
    ('revoke_all_beta()', 'bef8042ef6262d0e9e84f43c66c76af6', '3e7a05ccee825530eba9ddf348668145'),
    ('sale_items_consume_ingredients()', 'bbdfd78bf377342e2f7632d127d4caa2', '760ec933a9325c49396b08fb2bf08381'),
    ('sale_items_set_unit_cost()', '98677a4e07d5385423a01dab4a7e57de', '8784429620953e858e6fa37cc8c2e34b'),
    ('seed_expense_categories()', '08bc2bda2ee1a6f10c270b8388a23526', '1549868c21e25fd23812c0e698168e6f'),
    ('send_order_items(uuid)', '64dc6cd05843ea786f32e8579966c76f', '9bd93f17cce950d628f5911fc10de731'),
    ('set_beta_slots(integer)', '253f7aa9e61ee16c11f41570f2704ef3', '6ac8fd92fdacfa02c138eccc63564da1'),
    ('start_free_trial()', '00b183213c6ea80e15bdcdf2acd2dbb2', 'e52ae4618f94d46bd1d53ed09ce14c4d'),
    ('transfer_table_order(uuid,uuid)', '390407452996c4f7c505bce9ef2690ed', '4d2a782d112e10829c3ffceddadb23cb'),
    ('update_org_timestamp()', '9baf00d43cdeb2cd0e55c1de045be21b', 'f019c2a85daf0ed4058b77a7a14664a9'),
    ('update_updated_at()', 'da5ac28a58c8b4bb30209bf0d3d7082c', '8d0d99f0f246f51e6e468e02e03e428b'),
    ('within_plan_history(timestampwithtimezone)', 'c07576f52d7c6e0614cf73e1ed6ae59f', 'd766ce063a6eb49dc4f2a4bb46431f58')
),
src AS (
  SELECT p.oid::regprocedure::text AS sig, p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
),
lines AS (
  SELECT s.sig,
         btrim(regexp_replace(btrim(regexp_replace(l, '[ \t]+', ' ', 'g')), '[ \t]+--.*$', '')) AS y,
         ord
  FROM src s, LATERAL regexp_split_to_table(s.prosrc, E'\n') WITH ORDINALITY t(l, ord)
),
code AS (
  SELECT sig, md5(string_agg(y, ' ' ORDER BY ord)) AS code_md5
  FROM lines
  WHERE y <> '' AND y !~ '^--'
  GROUP BY sig
),
actual AS (
  SELECT s.sig, md5(s.prosrc) AS brut_md5, c.code_md5
  FROM src s LEFT JOIN code c USING (sig)
)
SELECT COALESCE(e.sig, a.sig) AS signature,
       CASE
         WHEN a.sig IS NULL THEN 'MANQUANTE EN BASE'
         WHEN e.sig IS NULL THEN 'EN PLUS (pas dans le dépôt)'
         WHEN a.code_md5 IS DISTINCT FROM e.code_md5 THEN '★ DIVERGENCE DE LOGIQUE ★'
         WHEN a.brut_md5 IS DISTINCT FROM e.brut_md5 THEN 'FORMAT SEULEMENT'
         ELSE 'OK'
       END AS verdict
FROM expect e
FULL OUTER JOIN actual a ON a.sig = e.sig
ORDER BY CASE
           WHEN a.sig IS NULL OR e.sig IS NULL OR a.code_md5 IS DISTINCT FROM e.code_md5 THEN 0
           WHEN a.brut_md5 IS DISTINCT FROM e.brut_md5 THEN 1
           ELSE 2
         END,
         COALESCE(e.sig, a.sig) COLLATE "C";
