// Harness PGlite : applique réellement les migrations sur un Postgres en WASM
// et teste le comportement de create_sale.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const SQL_DIR = process.argv[2];
const ORDER = [
  'schema.sql',
  'migration_team.sql',
  'migration_saas.sql',
  'migration_plan_limits.sql',
  'migration_invoices.sql',
  'migration_webhook_logs.sql',
  'migration_indexes.sql',
  'migration_sales_rpc.sql',
  'migration_roles.sql',
  // Crée require_feature(), referenced par les trois fonctions payantes
  // (get_product_profitability, get_cash_flow, get_customer_debts). Doit
  // précéder ces trois migrations, sinon la fonction n'existe pas encore.
  'migration_plan_gate.sql',
  // Les trois migrations qui redéfinissent create_sale(). Vues dans cet ordre,
  // la dernière version l'emporte : vente au poids (NUMERIC + virgule).
  //
  // ⚠ Toute migration antérieure listée APRÈS celles-ci réécrirait
  //   create_sale() dans sa version entière — y compris pendant le test de
  //   rejouabilité, qui les rejoue dans l'ordre du tableau. C'est exactement ce
  //   qui faisait échouer la section « vente au poids » : migration_sales_rpc.sql
  //   rejouée réinstallait la version à quantités entières, et 1,5 kg était
  //   refusé avec « Ligne de panier invalide ».
  'migration_price_override.sql',
  'migration_weighted_sales.sql',
  // Crée sales.settled : les deux migrations suivantes filtrent dessus pour la
  // recette à l'encaissement. Doit précéder profitability et expenses.
  'migration_credit.sql',
  // Cree sales.amount_received, lu par les deux migrations suivantes.
  'migration_partial_payment.sql',
  'migration_profitability.sql',
  'migration_expenses.sql',
  'migration_invitations.sql',
  'migration_profitability_fix.sql',
  'migration_suppliers.sql',
  'migration_credit_fns.sql',
  // Doit etre applique apres organizations (schema.sql) : son trigger
  // s'execute sur chaque creation de boutique.
  'migration_beta_program.sql',
  // DOIT RESTER DERNIERE. Elle ferme les failles ouvertes plus tôt : RLS sur
  // rate_limits, verrou de organizations.plan, index unique sur subscriptions,
  // policies de business_members et la garde de redeem_invitation(). La placer
  // avant redeviendrait ces failles a la seconde migration suivante.
  'migration_sales_summary.sql',
  'migration_security.sql',
  // claim_webhook_event() : idempotence atomique du webhook Stripe.
  'migration_webhook_claim.sql',
  'migration_fk_indexes.sql',
  // organizations.domain : paramètre d'affichage, jamais un privilège.
  'migration_domain.sql',
  // Salle et commande ouverte : Sprint 13.
  'migration_restaurant_tables.sql',
  // Clôture d'addition : la commande entre dans les ventes.
  'migration_table_checkout.sql',
  // Recettes et coût de matière : le KPI d'un restaurant.
  'migration_recipes.sql',
  // Modificateurs, plat du jour, pourboire, réservations.
  'migration_restaurant_finitions.sql',
  // Carte par jour de la semaine : un plat du vendredi le mardi, c'est faux.
  'migration_menu_days.sql',
  // Base de caisse : un seul chiffre d'affaires sur tous les écrans. Doit
  //precéder le rejouage de DERNIERE_VERSION, qui réinstalle l'ancienne
  // version de get_sales_summary() via migration_sales_summary.sql.
  'migration_ca_caisse.sql',
  // Facturation : une boutique dont le compteur est désaligné doit pouvoir
  // vendre. Elle redéfinit create_sale() en entier, donc DERNIÈRE.
  'migration_facture_sequentielle.sql',
  // Facture : la numérotation suit le plan EFFECTIF (essai / échéance prépayée),
  // comme current_org_plan(). Redéfinit create_sale() en entier, donc APRÈS la
  // précédente.
  'migration_facture_plan_effectif.sql',
  // Hors-ligne : client_ref + create_sale() idempotente (5ᵉ paramètre).
  // Redéfinit create_sale() en entier, donc APRÈS la précédente.
  'migration_offline_sales.sql',
  // Crédit hors-ligne : record_credit_sale() idempotente (7ᵉ paramètre).
  'migration_offline_credit.sql',
  // Équipe : gestion des membres sans clé service role. Ne dépend que des
  // fonctions de migration_team.sql / migration_security.sql.
  'migration_equipe_sans_service_role.sql',
  // Onboarding guidé et mode simple : ui_mode, onboarding_step,
  // business_type, et le carnet de dettes rendu au plan gratuit.
  'migration_onboarding_mode.sql',
  // normalize_phone() connaît les numéros béninois à 10 chiffres (01…).
  'migration_telephone_benin.sql',
  // Mesure du parcours d'activation : get_activation_funnel(), réservée au
  // service_role — créée APRÈS migration_security.sql, donc à révoquer
  // d'authenticated elle-même (voir la fin du fichier).
  'migration_activation_funnel.sql',
  // Mode d'ouverture : organizations.display_mode ('standalone' ou
  // 'navigateur', NULL = jamais relevé). Jointuré au relevé par
  // scripts/funnel.mjs — get_activation_funnel() lui-même ne change pas.
  'migration_display_mode.sql',
  // Essai Starter de 14 jours : colonnes trial sur organizations (sans GRANT
  // client), start_free_trial() SECURITY DEFINER, current_org_plan() conscient
  // de l'essai. AVANT migration_plan_config.sql, qui lit le plan effectif.
  'migration_trial.sql',
  // Mobile Money : périodes prépayées. Colonnes d'échéance, commandes,
  // activate_prepaid_plan() service_role, current_org_plan() avec échéance.
  // APRÈS migration_trial.sql (qui définit déjà current_org_plan) et AVANT
  // migration_plan_config.sql : ses triggers lisent plan_valid_until, la
  // colonne doit exister avant leur première déclenchement.
  'migration_mobilemoney.sql',
  // Limites des plans côté serveur : table plan_config (vide dans le dépôt,
  // remplie par scripts/sync-plan-config.mjs), quotas produits et employés,
  // fenêtre d'historique sur sales (détections de dettes comprises).
  'migration_plan_config.sql',
  // Relances automatiques (P6) : dettes_a_relancer() lit current_org_plan()
  // (essai et échéance), posé par trial + plan_config — donc après eux.
  'migration_relances.sql',
  // Triggers de quotas en propriétaire : ils lisent plan_config, révoquée
  // au navigateur — en INVOKER, la création produit répondait 403 en prod.
  'migration_plan_definer.sql',
  // Temps réel multi-caisses : ajoute products et sales à la publication
  // supabase_realtime. Aucun effet sur le schéma ni les données ; la partie
  // client reste inerte tant que NEXT_PUBLIC_REALTIME ≠ « 1 ».
  'migration_realtime.sql',
  // Durcissement (S-4) : anon/authenticated ne peuvent plus créer d'objets
  // dans le schéma public.
  'migration_hardening.sql',
  // Sessions de caisse : fond de caisse, clôture, écart espèces.
  'migration_cash_sessions.sql',
  // Bons de commande fournisseur : création, réception (entrée en stock), annulation.
  'migration_purchase_orders.sql',
  // Retours / avoirs : vente comptoir remboursée, stock remis, avoir tracé.
  'migration_returns.sql',
  // Traçabilité du prix en salle : list_price figé à l'insertion de la ligne.
  'migration_restaurant_price_trace.sql',
  // Transfert et fusion de tables (salle) : deux gestes de service, atomiques.
  'migration_restaurant_transfer_merge.sql',
  // Couverts : nombre de clients à table, pour le ticket moyen par couvert.
  'migration_restaurant_covers.sql',
  // Paiement multiple (sale_payments) + partage par article (split_part).
  'migration_restaurant_payments.sql',
  // Remises et offerts : remise sur l'addition, ligne offerte (patron/manager).
  'migration_restaurant_discount.sql',
  // Tailles/variantes : supplément négatif autorisé (une « demi » coûte moins).
  'migration_restaurant_variants.sql',
];

// schema.sql et migration_team.sql sont appliqués deux fois, à la fin : sur une
// base existante, un `CREATE TABLE` sans IF NOT EXISTS échoue en 42P07 et
// interrompt le script en cours de route. C'est ce que l'utilisateur a rencontré
// en collant le fichier complet.

const db = new PGlite();

// Les erreurs PGlite remontent avec une pile enorme et illisible : on ne
// garde que le message PostgreSQL.
process.on('uncaughtException', (err) => {
  console.log(`\n  ✗ ERREUR INATTENDUE : ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`\n  ✗ ERREUR INATTENDUE : ${err?.message ?? err}`);
  process.exit(1);
});

async function q(sql) {
  return db.query(sql);
}
const e = (sql) => db.exec(sql);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Stub du schéma auth ────────────────────────────────────
async function bootstrap() {
  await e(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      -- Colonnes jeton que migration_security.sql section 6 remplit quand elles
      -- sont NULL : GoTrue les lit dans un string non nullable.
      confirmation_token text,
      recovery_token text,
      email_change_token_new text,
      email_change text
    );
    -- request.jwt.claim.sub porte l'utilisateur courant ; permet de simuler
    -- plusieurs acteurs dans un seul test.
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('request.jwt.role', true), 'anon');
      $$;
  `);
  // PGlite n'embarque pas uuid-ossp ; on en reproduit juste la surface utilisée.
  await e(`
    CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
      LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;
  `);
  // Rôles fournis par Supabase, absents de PGlite.
  await e(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  // Et leurs privilèges par défaut, eux aussi. Supabase accorde EXECUTE sur
  // les fonctions à anon, authenticated et service_role au moment de la
  // création (ALTER DEFAULT PRIVILEGES) : le grant ne vient PAS de PUBLIC.
  // Sans cette ligne, le harnais diffère de la base réelle — un
  // `REVOKE ... FROM PUBLIC` y passe alors qu'en production il laisse la clé
  // anon parfaitement capable d'appeler la fonction. Un test vert qui ne
  // prouve rien, c'est pire qu'absent.
  await e(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
}

// ─── 1. Application des migrations ──────────────────────────
console.log('\n▸ Application des migrations');
await bootstrap();

for (const file of ORDER) {
  // PGlite n'embarque pas les extensions ; on les retire du texte (elles sont
  // disponibles sur Supabase, et uuid_generate_v4 est stubé plus haut).
  const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
    .replace(/CREATE EXTENSION[^;]*;/gi, '');
  try {
    await db.exec(sql);
    console.log(`  ✓ ${file}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${file}\n    ${e.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} échec(s) : les migrations suivantes n'ont pas été validées.`);
  process.exit(1);
}

// ─── 1b. Rejouabilité ───────────────────────────────────────
// TOUTES les migrations doivent être rejouables : le fichier
// APPLY_MIGRATIONS.sql les concatène et l'utilisateur le colle en un bloc sur
// une base déjà peuplée. Un `CREATE TABLE` sans IF NOT EXISTS échoue alors en
// 42P07 et interrompt le script — c'est ce qu'il a rencontré.
//
// Une policy créée sans DROP préalable échoue de même en 42710.
//
// ⚠ La rejouabilité teste que le SCRIPT ne casse pas, pas qu'il produit le bon
// état. Rejouer chaque migration dans l'ordre du tableau réinstalle
// create_sale() dans sa version la plus ancienne — migration_sales_rpc.sql la
// redéfinit entièrement. La base se retrouvait avec une fonction à quantités
// entières alors que la colonne était numérique, et la section « vente au
// poids » échouait sur 1,5 kg.
//
// On rejoue donc dans l'ordre d'application reel, et on remet la derniere
// version de chaque fonction a la fin : c'est l'etat attendu apres coup.
const REPLAYABLE = ORDER;

const DERNIERE_VERSION = [
  // Fonctions redefinies par plusieurs migrations : seule la derniere compte.
  'migration_sales_rpc.sql',      // bump_rate_limit, purge_rate_limits
  'migration_price_override.sql', // create_sale (prix negocié)
  // ⚠ weighted_sales supprime recipe_costs et restaurant_menu_today avant
  //   leurs ALTER : ces deux vues lisent products.stock_qty. Comme il est
  //   rejoué APRÈS migration_recipes.sql dans cette liste, il les efface sans
  //   qu'elles soient recréées — et le test 25k échouait sur une vue absente
  //   alors que la migration était bien appliquée. Les deux migrations doivent
  //   suivre, dans cet ordre précis.
  'migration_weighted_sales.sql', // create_sale (NUMERIC) + vue fournisseur
  'migration_recipes.sql',       // recipe_costs (reprise après le DROP)
  'migration_menu_days.sql',     // restaurant_menu_today (idem)
  // ⚠ suppliers passe après weighted_sales : celui-ci recrée
  //   products_with_supplier, et il lui faut la table suppliers pour ce faire.
  'migration_suppliers.sql',     // products_with_supplier (remise en état)
  // En DERNIÈRE position de cette liste : ca_caisse redéfinit
  // get_sales_summary(), record_credit_sale() et pay_customer_debt(), que
  // migration_sales_summary.sql et migration_credit_fns.sql réinstallent dans
  // leur version antérieure — celle qui compte le CA en brut. Sans cette
  // remise en état, la rejouabilité laisserait trois écrans avec trois
  // chiffres, ce qu'on vient précisément de corriger.
  'migration_profitability.sql',  // archive_product, restore_product, gel du cout
  'migration_expenses.sql',       // seed_expense_categories
  'migration_invitations.sql',    // redeem_invitation, purge_accepted_invitations
  'migration_roles.sql',          // can_manage_products
  'migration_credit_fns.sql',     // normalize_phone, record_credit_sale, pay, soldes
  'migration_partial_payment.sql', // amount_received + remplissage des ventes
  // ⚠ migration_saas.sql est volontairement ABSENTE. Elle contient le seed
  //   « créer une organisation pour tout utilisateur Auth existant », qui
  //   n'est pas une redéfinition de fonction : la rejouer donnait une
  //   organisation fantôme à l'employé du test 4k et cassait deux assertions.
  //   Un seed de données n'a pas à être rejoué pour que le schéma soit bon.
  //
  // get_cash_flow() porte un type de retour différent depuis la section 8 de
  // migration_security.sql (colonne cogs ajoutée). Son corps n'existe donc
  // qu'à un seul endroit, et c'est ici qu'on le rétablit : la rejouabilité a
  // pu réinstaller l'ancienne version via migration_expenses.sql, et la
  // remise en état s'arrête à migration_partial_payment.sql.
  // En DERNIÈRE position, comme la règle du dépôt l'impose.
  'migration_security.sql',
  'migration_ca_caisse.sql',
  // Facturation : redéfinit create_sale() en entier, donc elle ferme la
  // liste. Sans cela la suite testerait la version antérieure — celle qui
  // bloque une boutique dont le compteur est désaligné — et les tests 29*
  // passeraient à vide.
  'migration_facture_sequentielle.sql',
  // Facture : plan effectif. DOIT être rejouée après facture_sequentielle,
  // sinon la remise en état réinstalle la version qui lit le plan brut et la
  // rejouabilité testerait la mauvaise version.
  'migration_facture_plan_effectif.sql',
  // Hors-ligne : dernière version de create_sale (idempotente). DOIT être
  // rejouée en dernier, sinon la remise en état réinstalle la version à 4
  // arguments et les appels à p_client_ref échouent.
  'migration_offline_sales.sql',
  // Crédit hors-ligne : dernière version de record_credit_sale (7 args). DOIT
  // suivre ca_caisse (qui réinstalle la version à 6 args) et offline_sales.
  'migration_offline_credit.sql',
  // Équipe : les deux fonctions de gestion de membre doivent être les
  // dernières réinstallées, sinon la rejouabilité laisserait la version
  // d'avant — qui ne vérifie pas l'appelant.
  'migration_equipe_sans_service_role.sql',
  // get_customer_debts() sans verrou de plan : migration_ca_caisse.sql, rejouée
  // juste au-dessus, réinstalle la version réservée au Starter. Et
  // migration_security.sql révoque les droits de colonne d'organizations — le
  // GRANT de ui_mode doit donc repasser après elle, comme en production.
  'migration_onboarding_mode.sql',
  // normalize_phone() : migration_credit_fns.sql, rejouée plus haut, réinstalle
  // la version qui ne préfixe que les numéros à 8 chiffres.
  'migration_telephone_benin.sql',
  // Paiement multiple : DERNIÈRE version de create_sale ('mixed'),
  // close_table_order (8 args) et get_sales_summary (ventilation par paiement).
  // DOIT fermer la liste : les migrations de facturation et hors-ligne,
  // rejouées plus haut, réinstallent les versions sans 'mixed'.
  'migration_restaurant_payments.sql',
  // Remises et offerts : DERNIÈRE version de close_table_order (9 args).
  'migration_restaurant_discount.sql',
];

console.log(`\n▸ Rejouabilité (${REPLAYABLE.length} migrations incrémentales)`);
{
  let replayOk = true;
  for (const file of REPLAYABLE) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
      .replace(/CREATE EXTENSION[^;]*;/gi, '');
    try {
      await db.exec(sql);
    } catch (err) {
      replayOk = false;
      failures++;
      console.log(`  ✗ ${file} rejouée\n    ${err.message}`);
    }
  }
  if (replayOk) console.log(`  ✓ les ${REPLAYABLE.length} migrations se rejouent sans erreur`);

  // Remise en état : la rejouabilité a réinstallé les fonctions dans leur
  // version la plus ancienne (create_sale() est redéfinie en entier par
  // migration_sales_rpc.sql). Sans cette étape, la suite teste une base qui
  // ne correspond à aucun déploiement réel.
  for (const file of DERNIERE_VERSION) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
      .replace(/CREATE EXTENSION[^;]*;/gi, '');
    try {
      await db.exec(sql);
    } catch (err) {
      failures++;
      console.log(`  ✗ ${file} (état final)\n    ${err.message}`);
    }
  }
  const def = (await q(
    `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'create_sale'`)).rows[0]?.d ?? '';
  const etatFinal = def.includes("replace(e->>'quantity', ',', '.')");
  if (!etatFinal) {
    failures++;
    console.log('  ✗ create_sale() n\'est pas revenue à la version quantité décimale');
  }
}

// ─── 2. Jeu de données de test ──────────────────────────────
console.log('\n▸ Jeu de données');
const PATRON = '11111111-1111-1111-1111-111111111111';
const AUTRE_PATRON = '11111111-1111-1111-1111-111111111199';
const EMPLOYE = '22222222-2222-2222-2222-222222222222';

// Le programme bêta est FERMÉ pendant toute la suite, sauf sa section dédiée.
//
// Sans cela, chaque INSERT INTO organizations du harnais consommerait une place
// et passerait la boutique en Pro — y compris celles que la section sur le verrou
// de plan crée volontairement en gratuit pour vérifier qu'il sont refusées. Le
// test échouerait non pas parce que le code est faux, mais parce qu'un programme
// de test est ouvert. C'est le genre de couplings qui fait qu'un test rouge ne
// veut plus rien dire.
await e(`UPDATE beta_program SET open = false, slots_used = 0 WHERE id = 1`);

await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}', 'patron@test.ci'), ('${EMPLOYE}', 'employe@test.ci')`);
await q(`UPDATE organizations SET plan = 'pro' WHERE id = '${PATRON}'`);
await q(`INSERT INTO organizations (id, name, slug) VALUES ('${PATRON}', 'Boutique Test', 'boutique-test')`);
await q(`UPDATE organizations SET plan = 'pro' WHERE id = '${PATRON}'`);
await q(`INSERT INTO business_members (owner_id, member_id, member_name) VALUES ('${PATRON}', '${EMPLOYE}', 'Caissier')`);

const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
await q(`
  INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
  VALUES
    ('${P1}', '${PATRON}', 'Riz 5kg', 'RIZ5',  5000,  7000,  10, 2),
    ('${P2}', '${PATRON}', 'Huile 1L', 'HUILE', 3000,  4500,   3, 1)
`);

const stock = async (id) => Number((await q(`SELECT stock_qty FROM products WHERE id = '${id}'`)).rows[0].stock_qty);
const count = async (sql) => Number((await q(sql)).rows[0].count);
/** create_sale RETURNS jsonb : PGlite désérialise la colonne en objet. */
const sale = async (payload, method = 'cash', client = null) => {
  const r = await q(
    `SELECT create_sale('${payload}'::jsonb, '${method}'${client ? `, '${client}'` : ''})`
  );
  return r.rows[0].create_sale;
};
const invoiceOf = async (id) =>
  (await q(`SELECT invoice_number FROM sales WHERE id='${id}'`)).rows[0].invoice_number;

// ─── 3. Comportement de create_sale ─────────────────────────
console.log('\n▸ create_sale');

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// 3a. Vente simple
{
  const res = await sale(`[{"product_id":"${P1}","quantity":2}]`, 'cash', 'M. Diallo');
  const saleId = res.id;
  check('3a. vente simple retourne un id', !!saleId);
  check('3a. stock décrémenté 10 → 8', (await stock(P1)) === 8, `obtenu ${await stock(P1)}`);
  check('3a. total = 2 x 7000', Number((await q(`SELECT total_amount FROM sales WHERE id='${saleId}'`)).rows[0].total_amount) === 14000);
  check('3a. 1 ligne de vente', (await count(`SELECT count(*) FROM sale_items WHERE sale_id='${saleId}'`)) === 1);
  check('3a. journal de stock écrit', (await count(`SELECT count(*) FROM stock_logs WHERE reference_id='${saleId}' AND movement_type='sale'`)) === 1);
  check('3a. total renvoyé = 14000', Number(res.total_amount) === 14000, `obtenu ${res.total_amount}`);
  check('3a. numéro de facture Pro attribué', /^FAC-\d{4}-\d{5}$/.test(await invoiceOf(saleId)), await invoiceOf(saleId));
}

// 3b. Le prix catalogue reste la référence : il n'est jamais modifié par la vente.
//
// Cette règle a changé. create_sale() ignorait auparavant tout prix transmis
// (test 3b d'origine : « prix forgé ignoré »), parce qu'un client ne doit pas
// pouvoir facturer 1 FCFA. Mais dans un marché où le marchandage est la règle,
// l'impossibilité de modifier un prix est un blocage, pas une protection.
//
// Le prix catalogue n'est donc plus imposé, mais il est conservé dans
// sale_items.list_price : c'est la traçabilité qui remplace le verrou.
{
  const res = await sale(`[{"product_id":"${P1}","quantity":1,"unit_price":1}]`, 'momo');
  const li = (await q(`SELECT unit_price, list_price FROM sale_items WHERE sale_id='${res.id}'`)).rows[0];
  check('3b. prix convenu appliqué (1)', Number(li.unit_price) === 1, `obtenu ${li.unit_price}`);
  check('3b2. prix catalogue conservé pour comparaison', Number(li.list_price) === 7000, `obtenu ${li.list_price}`);
  check('3b3. remise restituée = 6 999', Number(res.discount_amount) === 6999, `obtenu ${res.discount_amount}`);

  // Ce que la vente ne doit PAS pouvoir faire : sortir le stock d'un autre
  // tenant, ou donner le stock. C'est la véritable surface d'attaque.
  const vol = Number((await q(`SELECT total_amount FROM sales WHERE id='${res.id}'`)).rows[0].total_amount);
  check('3b4. total = prix convenu × quantité', vol === 1, `obtenu ${vol}`);
}

// 3c. Numéro de facture unique et séquentiel
{
  const nums = (await q(`SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL ORDER BY created_at`)).rows.map((r) => r.invoice_number);
  check('3c. numéros de facture uniques', new Set(nums).size === nums.length, nums.join(', '));
}

// 3c2. La facture suit le plan EFFECTIF, pas le plan brut (S-1).
// Une boutique Pro PRÉPAYÉE échue (plan='pro', plan_valid_until passée) n'est
// plus Pro pour require_feature() : elle ne doit pas non plus émettre de numéro
// de facture, sinon peutDelivrerFacture() — qui se base sur la présence du
// numéro — la croirait encore Pro. Produit dédié pour ne pas fausser le stock
// des sections suivantes.
{
  const PX = 'aaaaaaaa-0000-0000-0000-0000000000ff';
  await q(`INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
           VALUES ('${PX}', '${PATRON}', 'Test plan', 'PLANX', 100, 200, 50, 1)`);

  await q(`UPDATE organizations SET plan='pro', plan_valid_until = now() - interval '1 day' WHERE id='${PATRON}'`);
  const res = await sale(`[{"product_id":"${PX}","quantity":1}]`, 'cash');
  check('3c2. Pro prépayé ÉCHU : aucune facture émise', (await invoiceOf(res.id)) === null, `obtenu ${await invoiceOf(res.id)}`);

  await q(`UPDATE organizations SET plan='pro', plan_valid_until = now() + interval '1 month' WHERE id='${PATRON}'`);
  const res2 = await sale(`[{"product_id":"${PX}","quantity":1}]`, 'cash');
  check('3c2. Pro prépayé EN COURS : facture attribuée', /^FAC-\d{4}-\d{5}$/.test(await invoiceOf(res2.id)), await invoiceOf(res2.id));

  // Remise en état : PATRON reste Pro sans échéance pour le reste de la suite.
  await q(`UPDATE organizations SET plan='pro', plan_valid_until = NULL WHERE id='${PATRON}'`);
}

// 3c3. Rejeu idempotent d'une vente hors-ligne (P7).
// Deux appels avec le MÊME client_ref ne doivent produire qu'UNE vente : c'est
// la garde qui empêche un rejeu (réponse perdue) de doubler le stock et le CA.
{
  const PZ = 'aaaaaaaa-0000-0000-0000-0000000000ee';
  await q(`INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
           VALUES ('${PZ}', '${PATRON}', 'Test hors-ligne', 'OFFL', 100, 200, 10, 1)`);

  const ref = '11112222-3333-4444-5555-666677778888';
  const venteAvant = await count(`SELECT count(*) FROM sales`);
  const r1 = await q(`SELECT create_sale('[{"product_id":"${PZ}","quantity":2}]'::jsonb, 'cash', NULL, NULL, '${ref}') AS v`);
  const r2 = await q(`SELECT create_sale('[{"product_id":"${PZ}","quantity":2}]'::jsonb, 'cash', NULL, NULL, '${ref}') AS v`);
  const venteApres = await count(`SELECT count(*) FROM sales`);
  check('3c3. rejeu : la MÊME vente est renvoyée', r1.rows[0].v.id === r2.rows[0].v.id, `${r1.rows[0].v.id} vs ${r2.rows[0].v.id}`);
  check('3c3. rejeu : une seule vente créée', venteApres === venteAvant + 1, `${venteAvant} → ${venteApres}`);
  check('3c3. rejeu : stock déduit une seule fois (10 → 8)', (await stock(PZ)) === 8, `obtenu ${await stock(PZ)}`);
}

// 3d. Stock insuffisant → rien n'est écrit
{
  const before = await stock(P2);
  const salesBefore = await count(`SELECT count(*) FROM sales`);
  let msg = '';
  try {
    await q(`SELECT create_sale('[{"product_id":"${P2}","quantity":99}]'::jsonb, 'cash')`);
  } catch (e) { msg = e.message; }
  check('3d. stock insuffisant rejeté', /Stock insuffisant/.test(msg), msg);
  check('3d. stock inchangé', (await stock(P2)) === before);
  check('3d. aucune vente orpheline', (await count(`SELECT count(*) FROM sales`)) === salesBefore);
}

// 3e. Le même produit en double ne peut pas dépasser le stock
{
  const before = await stock(P2);
  let msg = '';
  try {
    await q(`SELECT create_sale('[{"product_id":"${P2}","quantity":2},{"product_id":"${P2}","quantity":2}]'::jsonb, 'cash')`);
  } catch (e) { msg = e.message; }
  check('3e. doublon agrégé rejeté (2+2 > 3)', /Stock insuffisant/.test(msg), msg);
  check('3e. stock inchangé', (await stock(P2)) === before, `obtenu ${await stock(P2)}`);
}

// 3f. Quantité invalide
for (const [label, payload] of [
  ['zéro', '[{"product_id":"' + P1 + '","quantity":0}]'],
  ['négative', '[{"product_id":"' + P1 + '","quantity":-5}]'],
  ['non numérique', '[{"product_id":"' + P1 + '","quantity":"abc"}]'],
  ['id invalide', '[{"product_id":"pas-un-uuid","quantity":1}]'],
]) {
  let msg = '';
  try { await q(`SELECT create_sale('${payload}'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check(`3f. quantité ${label} rejetée`, /Ligne de panier invalide/.test(msg), msg);
}

// 3g. Moyen de paiement invalide
{
  let msg = '';
  try { await q(`SELECT create_sale('[{"product_id":"${P1}","quantity":1}]'::jsonb, 'bitcoin')`); } catch (e) { msg = e.message; }
  check('3g. moyen de paiement invalide rejeté', /Moyen de paiement invalide/.test(msg), msg);
}

// 3h. Panier vide
{
  let msg = '';
  try { await q(`SELECT create_sale('[]'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check('3h. panier vide rejeté', /Panier vide/.test(msg), msg);
}

// 3i. Produit d'une autre boutique → introuvable
{
  const AUTRE = '33333333-3333-3333-3333-333333333333';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${AUTRE}', 'autre@test.ci')`);
  await q(`INSERT INTO organizations (id, name, slug) VALUES ('${AUTRE}', 'Concurrent', 'concurrent')`);
  const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';
  await q(`INSERT INTO products (id, user_id, name, price_sell, stock_qty) VALUES ('${P3}', '${AUTRE}', 'Secret', 100, 50)`);
  let msg = '';
  try { await q(`SELECT create_sale('[{"product_id":"${P3}","quantity":1}]'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check('3i. produit d\'un autre tenant rejeté', /Produit introuvable/.test(msg), msg);
}

// 3j. Un employé peut encaisser (le locator est résolu côté serveur)
{
  const stockBefore = await stock(P1);
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  let msg = '';
  let res = null;
  try { res = await sale(`[{"product_id":"${P1}","quantity":1}]`); } catch (err) { msg = err.message; }
  check('3j. l\'employé peut encaisser', msg === '', msg);
  check('3j. le stock du patron est décrémenté', (await stock(P1)) === stockBefore - 1);
  const owner = (await q(`SELECT user_id FROM sales WHERE id='${res.id}'`)).rows[0].user_id;
  check('3j. la vente est imputée au patron', owner === PATRON, owner);
}

// 3k. La contrainte CHECK protège le stock
{
  let msg = '';
  try { await q(`UPDATE products SET stock_qty = -1 WHERE id = '${P1}'`); } catch (e) { msg = e.message; }
  check('3k. stock négatif bloqué par CHECK', /products_stock_qty_non_negative/.test(msg), msg || 'aucune erreur levée');
}

// ─── 4. Policies RLS (le cœur du correctif de rôle) ─────────
// PGlite tourne en superuser, qui contourne la RLS : on bascule sur le rôle
// `authenticated` pour que les policies s'appliquent réellement.
console.log('\n▸ RLS — droits sur le catalogue');

await e(`
  GRANT USAGE ON SCHEMA public, auth TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
`);

// En PostgreSQL, un UPDATE/DELETE refusé par une policy USING ne lève
// AUCUNE erreur : la ligne est simplement filtrée (0 ligne affectée). L'error
// n'est un signal fiable que pour les inserts (WITH CHECK). On vérifie donc
// systématiquement l'effet réel sur la base.
const run = async (sql, as) => {
  await q(`SELECT set_config('request.jwt.claim.sub', '${as}', false)`);
  await e('SET ROLE authenticated');
  let affected = -1;
  let err = '';
  try {
    const r = await q(sql);
    affected = r.affectedRows ?? 0;
  } catch (ex) {
    err = ex.message;
  }
  await e('RESET ROLE');
  return { affected, err };
};

const canWrite = async (label, sql, expectAllowed, as) => {
  const { affected, err } = await run(sql, as);
  const allowed = affected > 0;
  check(label, allowed === expectAllowed,
    `${allowed ? 'appliqué' : `refusé (${affected} ligne${affected > 1 ? 's' : ''}${err ? ', ' + err.slice(0, 50) : ''})`}`);
  return affected;
};

// Un SELECT ne se mesure pas via affectedRows : on lit la valeur renvoyée.
const canRead = async (label, sql, expectVisible, as) => {
  await q(`SELECT set_config('request.jwt.claim.sub', '${as}', false)`);
  await e('SET ROLE authenticated');
  let value = -1;
  try {
    const r = await q(sql);
    value = Number(r.rows[0].count);
  } catch {
    value = -1;
  }
  await e('RESET ROLE');
  check(label, (value > 0) === expectVisible, `${value} ligne(s) visible(s)`);
};

// Employé : lecture oui, écriture non.
await canRead('4a. employé LIT les produits du patron',
  `SELECT count(*) FROM products`, true, EMPLOYE);
await canWrite('4b. employé NE MODIFIE PAS un produit',
  `UPDATE products SET price_sell = 1 WHERE id = '${P1}'`, false, EMPLOYE);
await canWrite('4c. employé NE SUPPRIME PAS un produit',
  `DELETE FROM products WHERE id = '${P1}'`, false, EMPLOYE);
await canWrite('4d. employé NE CRÉE PAS de produit',
  `INSERT INTO products (user_id, name, price_sell, stock_qty) VALUES ('${PATRON}', 'X', 1, 1)`, false, EMPLOYE);

// Le stock et le prix n'ont pas bougé malgré les tentatives ci-dessus.
check('4e. le prix du produit est intact',
  Number((await q(`SELECT price_sell FROM products WHERE id='${P1}'`)).rows[0].price_sell) === 7000);
check('4f. le produit existe toujours',
  (await count(`SELECT count(*) FROM products WHERE id='${P1}'`)) === 1);

// Patron : écriture oui.
await canWrite('4g. patron MODIFIE un produit',
  `UPDATE products SET category = 'Céréales' WHERE id='${P1}'`, true, PATRON);
await canRead('4h. patron LIT ses produits', `SELECT count(*) FROM products`, true, PATRON);

// Journal d'activité : impossible d'écrire au nom d'une autre organisation.
const AUTRE2 = '44444444-4444-4444-4444-444444444444';
await q(`INSERT INTO auth.users (id, email) VALUES ('${AUTRE2}', 'x@test.ci')`);
await q(`INSERT INTO organizations (id, name, slug) VALUES ('${AUTRE2}', 'Victime', 'victime')`);
await canWrite('4i. impossible de forger un journal chez un autre tenant',
  `INSERT INTO activity_logs (business_owner_id, actor_id, actor_email, action, description)
   VALUES ('${AUTRE2}', '${PATRON}', 'patron@test.ci', 'fraud', 'forge')`, false, PATRON);
await canWrite('4j. impossible de purge le journal d\'autrui',
  `DELETE FROM activity_logs WHERE business_owner_id = '${AUTRE2}'`, false, PATRON);

// Un employé ne peut pas créer sa propre organisation à côté de celle du patron.
await canWrite('4k. employé NE FORK PAS sa propre organisation',
  `INSERT INTO organizations (id, name, slug) VALUES ('${EMPLOYE}', 'Ma boite', 'ma-boite')`, false, EMPLOYE);
const forks = await count(`SELECT count(*) FROM organizations WHERE id = '${EMPLOYE}'`);
check('4l. aucune organisation fantôme créée', forks === 0, `${forks} trouvée(s)`);

// Le patron peut purger et écrire dans son propre tenant.
await canWrite('4m. patron écrit dans SON journal',
  `INSERT INTO activity_logs (business_owner_id, actor_id, actor_email, action, description)
   VALUES ('${PATRON}', '${PATRON}', 'patron@test.ci', 'test', 'legitime')`, true, PATRON);

// ─── 5. Rate limiting distribué ────────────────────────────
console.log('\n▸ bump_rate_limit');

const bump = (key, max = 3, window = 3600) =>
  q(`SELECT bump_rate_limit('${key}', ${max}, ${window})`).then((r) => r.rows[0].bump_rate_limit);

{
  const key = 'test:1.2.3.4';
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await bump(key));
  check('5a. les 3 premières tentatives passent', !results[0] && !results[1] && !results[2],
    results.join(','));
  check('5b. la 4e est bloquée', results[3] === true);
  check('5c. la 5e est bloquée', results[4] === true);
}
{
  // Clé distincte = compteur indépendant
  const r = await bump('test:5.6.7.8');
  check('5d. une autre IP a son propre compteur', r === false);
}
{
  // Fenêtre expirée : le compteur repart de zéro
  const r = await bump('test:expire', 2, 0);
  check('5e. fenêtre expirée → compteur remis à zéro', r === false);
}
{
  const before = await count(`SELECT count(*) FROM rate_limits`);
  await q(`SELECT purge_rate_limits()`);
  const after = await count(`SELECT count(*) FROM rate_limits WHERE reset_at > now()`);
  check('5f. purge_rate_limits ne supprime que l\'expiré', after <= before, `${after} restant(s)`);
}

// ─── 6. Rentabilité & archivage ────────────────────────────
console.log('\n▸ Coût figé et marge');

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

{
  const p = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${p}','${PATRON}','Marge test',3000,5000,100)`);
  const r = await sale(`[{"product_id":"${p}","quantity":3}]`);
  const item = (await q(`SELECT unit_cost, subtotal FROM sale_items WHERE sale_id='${r.id}'`)).rows[0];
  check('6a. unit_cost enregistré à la vente', Number(item.unit_cost) === 3000, `obtenu ${item.unit_cost}`);
  check('6b. subtotal correct', Number(item.subtotal) === 15000, `obtenu ${item.subtotal}`);

  // Le prix d'achat change : la marge historique ne doit pas bouger.
  await q(`UPDATE products SET price_buy = 4000 WHERE id = '${p}'`);
  const after = (await q(`SELECT unit_cost FROM sale_items WHERE sale_id='${r.id}'`)).rows[0];
  check('6c. coût figé après changement du prix d\'achat', Number(after.unit_cost) === 3000);

  let msg = '';
  try { await q(`UPDATE sale_items SET unit_cost = 1 WHERE sale_id='${r.id}'`); } catch (e) { msg = e.message; }
  check('6d. modification du coût refusée', /figé/.test(msg), msg || 'acceptée !');

  const v = (await q(`SELECT * FROM get_product_profitability() WHERE id='${p}'`)).rows[0];
  check('6e. CA = 15 000', Number(v.revenue) === 15000, `obtenu ${v.revenue}`);
  check('6f. coût des marchandises = 9 000', Number(v.cost_of_goods) === 9000, `obtenu ${v.cost_of_goods}`);
  check('6g. marge brute = 6 000', Number(v.gross_profit) === 6000, `obtenu ${v.gross_profit}`);
  check('6h. taux de marge = 40 %', Number(v.margin_pct) === 40, `obtenu ${v.margin_pct}`);
}

// Régression : une vue filtrée par get_business_owner_id() renvoyait zéro ligne
// dès qu'aucun utilisateur n'était résolu (clé service role, scripts).
// SECURITY INVOKER doit laisser la RLS décider.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  const all = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6i. lisible sans utilisateur (service role / scripts)', all > 0, `${all} ligne(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  const own = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6j. filtré sur le patron connecté', own > 0 && own <= all, `${own}/${all}`);

  // Un employé voit les produits de son patron (RLS products_read).
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  const emp = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6k. l\'employé voit la rentabilité du patron', emp > 0, `${emp} ligne(s)`);
}

// La vue ne doit exposer que le tenant courant (une vue contourne la RLS).
{
  const SECRET = 'aaaaaaaa-0000-0000-0000-0000000000a9';
  await q(`INSERT INTO auth.users (id,email) VALUES ('55555555-5555-5555-5555-555555555555','x@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('55555555-5555-5555-5555-555555555555','Rival','rival')`);
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${SECRET}','55555555-5555-5555-5555-555555555555','Secret',1,999999,10)`);
  // Isolation réellement Updates la RLS : on bascule sur le rôle authenticated.
  // En superuser la RLS est contournée, ce test ne prouverait rien.
  await e(`GRANT EXECUTE ON FUNCTION get_product_profitability() TO authenticated`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let seen = [];
  try {
    seen = (await q(`SELECT name FROM get_product_profitability()`)).rows.map((x) => x.name);
  } catch (err) { seen = ['<erreur: ' + err.message + '>']; }
  await e('RESET ROLE');
  check('6l. l\'isolation tient sous le rôle authenticated', !seen.includes('Secret'),
    seen.join(', '));
}

console.log('\n▸ Archivage de produit');
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
{
  // Produit vendu → archivage refusé (historique préservé)
  let msg = '';
  try { await q(`SELECT archive_product('${P1}')`); } catch (e) { msg = e.message; }
  check('6m. produit vendu : archivage refusé', /Impossible d' archiv|Impossible d.archiver/.test(msg), msg);
  check('6n. le produit vendu reste actif',
    (await q(`SELECT is_active FROM products WHERE id='${P1}'`)).rows[0].is_active === true);

  // Produit invendu → archivable
  const orphan = 'aaaaaaaa-0000-0000-0000-0000000000b1';
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${orphan}','${PATRON}','Obsolete',100,200,5)`);
  await q(`SELECT archive_product('${orphan}')`);
  const p = (await q(`SELECT is_active, archived_at FROM products WHERE id='${orphan}'`)).rows[0];
  check('6o. produit invendu archivé', p.is_active === false);
  check('6p. archived_at renseigné', !!p.archived_at);
  await q(`SELECT restore_product('${orphan}')`);
  check('6q. restauration possible',
    (await q(`SELECT is_active FROM products WHERE id='${orphan}'`)).rows[0].is_active === true);
}

// ─── 7. Dépenses & résultat net ─────────────────────────────
console.log('\n▸ Dépenses');
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// Plan de comptes : créé une fois, jamais dupliqué.
// Appel SANS argument : c'est exactement ce que fait le frontend, et c'est ce
// qui échouait (PostgREST ne faisait pas correspondre la signature à un uuid).
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`SELECT seed_expense_categories()`);
await q(`SELECT seed_expense_categories()`);
{
  const n = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${PATRON}'`);
  check('7a. seed idempotent (11 catégories, pas de doublon)', n === 11, `${n} catégorie(s)`);
  const first = (await q(
    `SELECT name FROM expense_categories WHERE user_id='${PATRON}' ORDER BY sort_order LIMIT 1`
  )).rows[0].name;
  check('7b. première catégorie = Loyer', first === 'Loyer', first);
}

// Le seed ne doit toucher QUE l'organisation de l'appelant : c'est la
// garantie que la suppression du paramètre p_owner n'a rien coûté.
// On utilise un patron (pas un employé déjà rattaché ailleurs : un membre
// n'appartient qu'à une organisation, index unique sur member_id).
{
  const AUTRE0 = '88888888-8888-8888-8888-888888888888';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE0}','w@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE0}','Voisin','voisin')`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${AUTRE0}', false)`);
  await q(`SELECT seed_expense_categories()`);

  const forOther = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${AUTRE0}'`);
  check('7b2. le seed crée bien le plan du patron qui l\'appelle', forOther === 11, `${forOther} catégorie(s)`);

  const forOwner = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${PATRON}'`);
  check('7b3. le seed ne touche pas le plan d\'un autre tenant', forOwner === 11, `${forOwner} catégorie(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
}

// Une charge normale passe, une charge négative ou sans libellé est refusée
const TODAY = '2026-06-15';
{
  const { error } = await q(`
    INSERT INTO expenses (user_id, category, label, amount, day)
    VALUES ('${PATRON}', 'Loyer', 'Loyer juin', 50000, '${TODAY}')`);
  check('7c. dépense valide acceptée', !error, error?.message);

  let msg = '';
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','Remboursement',-5000,'${TODAY}')`);
  } catch (e) { msg = e.message; }
  check('7d. montant négatif refusé', /expenses_amount_positive/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','   ','1000','${TODAY}')`);
  } catch (e) { msg = e.message; }
  check('7e. libellé vide refusé', /expenses_label_not_blank/.test(msg), msg || 'accepté !');
}

// Le résultat net combine CA et charges
{
  // Insertion directe en SQL, sans passer par create_sale(). C'est le cas du
  // trigger fill_amount_received() : sans lui, amount_received resterait à 0 et
  // cette vente payée disparaîtrait du chiffre d'affaires sans lever la moindre
  // erreur. Le test vérifie que le trigger rattrape l'oubli.
  const d = '2026-06-15';
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, created_at)
           VALUES ('${PATRON}', 20000, 'cash', '${d}T10:00:00+00:00')`);
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${PATRON}','Électricité','EDF juin',15000,'${d}')`);

  const saisi = (await q(`SELECT amount_received FROM sales
     WHERE user_id = '${PATRON}' AND total_amount = 20000
       AND created_at::text LIKE '${d}%'`)).rows[0];
  check('7f0. insertion directe : amount_received renseigné par le trigger',
    Number(saisi?.amount_received) === 20000, String(saisi?.amount_received));

  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7f. CA du jour = 20 000', Number(row.revenue) === 20000, `obtenu ${row.revenue}`);
  check('7g. charges du jour = 65 000 (50 000 + 15 000)', Number(row.expenses) === 65000, `obtenu ${row.expenses}`);
  check('7h. résultat net = -45 000 (déficit)', Number(row.net) === -45000, `obtenu ${row.net}`);
  check('7i. transactions comptées', Number(row.transactions) >= 1, `${row.transactions}`);
}

// Un jour avec charge mais aucune vente doit apparaître (FULL OUTER JOIN)
{
  const d = '2026-06-16';
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${PATRON}','Autre','Achat 2 kwatt',3000,'${d}')`);
  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7j. journée sans vente mais avec charge visible', !!row && Number(row.revenue) === 0,
    row ? `revenue ${row.revenue}` : 'jour absent');
}

// Le coût des marchandises vendues fait partie du résultat. Sans lui, l'écran
// « Charges » affichait CA − charges : un bénéfice fictif, puisque le prix de
// la marchandise n'était déduit nulle part. Relevé en prod sur 30 jours :
// 1 161 200 F affichés pour 207 444 F réels, l'écart valant exactement le CMV.
{
  const d = '2026-06-18';
  const p = '9c9c9c9c-0000-4000-8000-000000000001';
  const s = '9c9c9c9c-0000-4000-8000-000000000002';
  await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
           VALUES ('${p}', '${PATRON}', 'Sac de riz 25 kg', 4000, 10000, 50)`);
  await q(`INSERT INTO sales (id, user_id, total_amount, payment_method, created_at)
           VALUES ('${s}', '${PATRON}', 30000, 'cash', '${d}T09:00:00+00:00')`);
  await q(`INSERT INTO sale_items
             (sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost)
           VALUES ('${s}', '${p}', 'Sac de riz 25 kg', 3, 10000, 30000, 4000)`);

  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7o. CA du jour = 30 000', Number(row?.revenue) === 30000, `obtenu ${row?.revenue}`);
  check('7p. coût des marchandises = 12 000 (3 × 4 000)', Number(row?.cogs) === 12000,
    `obtenu ${row?.cogs}`);
  check('7q. le résultat déduit bien le coût : CA − CMV − charges',
    Number(row?.net) === Number(row?.revenue) - Number(row?.cogs) - Number(row?.expenses),
    `net ${row?.net} pour CA ${row?.revenue}, CMV ${row?.cogs}, charges ${row?.expenses}`);
}

// RLS : un employé lit mais n'écrit pas
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  const seen = (await q(
    `SELECT count(*)::int c FROM expenses WHERE user_id = '${PATRON}'`)).rows[0].c;
  check('7k. employé LIT les charges', seen > 0, `${seen} ligne(s)`);

  await e('SET ROLE authenticated');
  let allowed = false;
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','Fuite',9999,'2026-06-17')`);
    allowed = true;
  } catch { /* refusé par RLS */ }
  await e('RESET ROLE');
  check('7l. employé NE SAISIT PAS de charge', !allowed);
}

// Isolation multi-tenant
{
  const AUTRE3 = '77777777-7777-7777-7777-777777777777';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE3}','z@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE3}','Autre','autre')`);
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${AUTRE3}','Autre','Confidentiel',4200,'2026-06-15')`);

  // Isolation : la RLS ne s'applique qu'à un rôle non superuser. PGlite tourne
  // en superuser, ce test ne prouverait donc rien sans ce basculement.
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let leaked = -1;
  let cfExpenses = -1;
  try {
    leaked = Number((await q(
      `SELECT count(*)::int c FROM expenses WHERE user_id = '${AUTRE3}'`)).rows[0].c);
    const cf = (await q(`SELECT * FROM get_cash_flow('2026-06-15','2026-06-15')`)).rows[0];
    cfExpenses = Number(cf.expenses);
  } catch {
    leaked = -2;
  }
  await e('RESET ROLE');

  check(`7m. les charges d'un autre tenant sont invisibles`, leaked === 0, `${leaked} vue(s)`);
  check(`7n. le cash-flow n'inclut pas les charges d'autrui`, cfExpenses === 65000, `obtenu ${cfExpenses}`);
}

// ═══ 8. Invitations d'équipe ═══════════════════════════════
// Le patron invite un employé par email ; l'employé choisit son propre mot de
// passe et consommé le lien. redeem_invitation() doit être atomique et refuser
// un lien déjà utilisé, expiré, ou présenté par un compte au mauvais email.
console.log('\n▸ Invitations d\'équipe');

const INVITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EMPLOYE2 = '12121212-1212-1212-1212-121212121212';
const INTRUS = '13131313-1313-1313-1313-131313131313';
const TOKEN = 'tok_' + 'a'.repeat(48);

await q(`INSERT INTO auth.users (id,email) VALUES ('${INVITE}','marie@exemple.ci')`);
await q(`INSERT INTO auth.users (id,email) VALUES ('${EMPLOYE2}','marie@exemple.ci')`);
await q(`INSERT INTO auth.users (id,email) VALUES ('${INTRUS}','pirate@exemple.ci')`);

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO employee_invitations (owner_id, email, token, role)
         VALUES ('${PATRON}', 'marie@exemple.ci', '${TOKEN}', 'employee')`);
{
  const n = await count(
    `SELECT count(*) FROM employee_invitations WHERE owner_id='${PATRON}' AND token='${TOKEN}'`);
  check('8a. invitation créée par le patron', n === 1);
}

// Le token doit être unique : deux invitations ne peuvent pas le partager.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'autre@exemple.ci', '${TOKEN}')`);
  } catch (e) { msg = e.message; }
  check('8b. token en double refusé', /employee_invitations_token_key|duplicate key/.test(msg),
    msg || 'accepté !');
}

// L'email est normalisé en minuscules : deux invitations pour la même adresse
// ne divergent pas à l'orthographe.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'Marie@Exemple.CI', '${'b'.repeat(48)}')`);
  } catch (e) { msg = e.message; }
  check('8c. email en majuscules refusé (normalisé)', /employee_invitations_email_lower/.test(msg),
    msg || 'accepté !');
}

// Un token trop court est refusé : un lien devinable n'est pas un secret.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'court@exemple.ci', 'trop-court')`);
  } catch (e) { msg = e.message; }
  check('8d. token trop court refusé', /employee_invitations_token_len/.test(msg),
    msg || 'accepté !');
}

// ── Le cas central : un compte au MAUVAIS email tente de consommer le lien.
// Sans ce contrôle, un lien intercepté (WhatsApp, capture d'écran) suffit à
// s'attribuer la boutique.
{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${INTRUS}', 'Pirate')`);
  } catch (e) { msg = e.message; }
  check('8e. email différent de celui invité : refusé',
    /invite uniquement/.test(msg), msg || 'accepté !');

  const still = await count(
    `SELECT count(*) FROM employee_invitations WHERE token='${TOKEN}' AND accepted_at IS NULL`);
  check('8f. l\'invitation reste inutilisée après le refus', still === 1);
}

// Usage normal : le bon compte, le bon email.
{
  const r = await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${EMPLOYE2}', '  Marie Koffi  ')`);
  const row = r.rows[0];
  check('8g. remboursement accepté', !!row, 'aucune ligne retournée');
  check('8h. boutique correcte', row?.owner_id === PATRON, row?.owner_id);
  check('8i. email.normalisé renvoyé', row?.email === 'marie@exemple.ci', row?.email);
  check('8j. nom rogné', row?.member_name === 'Marie Koffi', row?.member_name);

  const members = await count(
    `SELECT count(*) FROM business_members WHERE member_id='${EMPLOYE2}' AND owner_id='${PATRON}'`);
  check('8k. membre lié à la boutique', members === 1);

  const role = (await q(
    `SELECT role FROM business_members WHERE member_id='${EMPLOYE2}'`)).rows[0]?.role;
  check('8l. rôle repris de l\'invitation', role === 'employee', role);

  const accepted = await count(
    `SELECT count(*) FROM employee_invitations WHERE token='${TOKEN}' AND accepted_at IS NOT NULL`);
  check('8m. invitation marquée acceptée', accepted === 1);
}

// Un lien à usage unique ne se réutilise pas.
{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${EMPLOYE2}', 'Marie Koffi')`);
  } catch (e) { msg = e.message; }
  check('8n. second usage refusé', /déjà (été )?utilisée/.test(msg), msg || 'accepté !');
}

{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('inexistant', '${EMPLOYE2}', 'X')`);
  } catch (e) { msg = e.message; }
  check('8o. token inconnu refusé', /introuvable|révoquée/.test(msg), msg || 'accepté !');
}

// Invitation expirée
{
  const TOK_EXP = 'c'.repeat(48);
  await q(`INSERT INTO employee_invitations (owner_id, email, token, expires_at)
           VALUES ('${PATRON}', 'tardif@exemple.ci', '${TOK_EXP}', now() - interval '1 day')`);
  await q(`INSERT INTO auth.users (id,email) VALUES ('14141414-1414-1414-1414-141414141414','tardif@exemple.ci')`);

  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOK_EXP}', '14141414-1414-1414-1414-141414141414', 'Tardif')`);
  } catch (e) { msg = e.message; }
  check('8p. invitation expirée refusée', /expiré/.test(msg), msg || 'accepté !');
}

// ── RLS : un employé ne doit pas voir les invitations de la boutique, sinon
// il pourrait s'inviter lui-même ou lire un jeton.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE2}', false)`);
  await e('SET ROLE authenticated');
  let seen = -1;
  let inserted = false;
  try {
    seen = Number((await q(
      `SELECT count(*)::int c FROM employee_invitations WHERE owner_id='${PATRON}'`)).rows[0].c);
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}',' pirate@exemple.ci','${'d'.repeat(48)}')`);
    inserted = true;
  } catch { /* refusé */ }
  await e('RESET ROLE');
  check('8q. employé NE LIT PAS les invitations', seen === 0, `${seen} vue(s)`);
  check('8r. employé NE CRÉE PAS d\'invitation', !inserted);
}

// Isolation multi-tenant sur les invitations
{
  const AUTRE4 = '99999999-9999-9999-9999-999999999999';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE4}','patron2@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE4}','Deux','deux')`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const leaked = Number((await q(
    `SELECT count(*)::int c FROM employee_invitations WHERE owner_id='${AUTRE4}'`)).rows[0].c);
  await e('RESET ROLE');
  check('8s. les invitations d\'autre tenant sont invisibles', leaked === 0, `${leaked} vue(s)`);
}

// redeem_invitation n'est pas appelable par un client authentifié : elle est
// révoquée au public et accordée au service_role seulement.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE2}', false)`);
  await e('SET ROLE authenticated');
  let denied = false;
  try {
    await q(`SELECT * FROM redeem_invitation('${'e'.repeat(48)}', '${EMPLOYE2}', 'X')`);
  } catch { denied = true; }
  await e('RESET ROLE');
  check('8t. un client authentifié ne peut PAS appeler redeem_invitation', denied);
}

// Purge : seules les invitations acceptées et anciennes de CETTE boutique sont
// supprimées.
//
// La fonction a changé de signature : elle prend le propriétaire et refuse tout
// identifiant qui n'est pas celui de l'appelant. Une version globale, exécutable
// par un client, aurait laissé n'importe quel utilisateur authentifié vider les
// invitations de toutes les boutiques — voir migration_equipe_sans_service_role.
{
  const before = await count(`SELECT count(*) FROM employee_invitations`);
  await q(`UPDATE employee_invitations
           SET accepted_at = now() - interval '30 days'
           WHERE token='${TOKEN}'`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let purged = -1;
  try {
    purged = Number((await q(
      `SELECT purge_accepted_invitations('${PATRON}', 7)`
    )).rows[0].purge_accepted_invitations);
  } catch {
    purged = -1;
  }
  await e('RESET ROLE');
  check('8u. purge supprime les invitations acceptées et anciennes', purged === 1,
    `${purged} purgée(s)`);

  const after = await count(`SELECT count(*) FROM employee_invitations`);
  check('8v. la purge épargne les invitations en attente', after === before - 1,
    `${before} → ${after}`);

  // Le contrôle du propriétaire est le seul qui tienne : la fonction est
  // SECURITY DEFINER, donc la RLS ne filtre rien pour elle.
  await q(`INSERT INTO auth.users (id, email) VALUES ('${AUTRE_PATRON}', 'purge-tiers@test.local')`);
  // Le jeton est calculé ici et non dans le gabarit : `\${...}` est la seule
  // interpolation reconnue dans un gabarit, donc 'f'.repeat(48) y partait
  // littéralement et PostgreSQL signalait une erreur de syntaxe sur le point.
  const jetonTiers = 'f'.repeat(48);
  await q(`INSERT INTO employee_invitations (owner_id, email, role, token, expires_at, accepted_at)
    VALUES ('${AUTRE_PATRON}', 'tiers@test.local', 'employee', '${jetonTiers}',
            now() - interval '1 day', now() - interval '30 days')`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let refuse = false;
  try {
    await q(`SELECT purge_accepted_invitations('${AUTRE_PATRON}', 7)`);
  } catch { refuse = true; }
  await e('RESET ROLE');
  check('8w. un patron ne purge pas les invitations d\'une autre boutique', refuse);

  const tiers = await count(
    `SELECT count(*) FROM employee_invitations WHERE owner_id='${AUTRE_PATRON}'`
  );
  check('8x. les invitations du tiers sont intactes', tiers === 1, `${tiers} ligne(s)`);

  // Et l'autre patron purge bien les siennes : le refus vient du contrôle, pas
  // d'une fonction devenue inerte.
  await q(`SELECT set_config('request.jwt.claim.sub', '${AUTRE_PATRON}', false)`);
  await e('SET ROLE authenticated');
  const tiersPurges = Number((await q(
    `SELECT purge_accepted_invitations('${AUTRE_PATRON}', 7)`
  )).rows[0].purge_accepted_invitations);
  await e('RESET ROLE');
  check('8y. le tiers purge ses propres invitations', tiersPurges === 1,
    `${tiersPurges} purgée(s)`);
}

// ═══ 9. Correctif marge : lines sans coût figé ═══════════
// Reproduit le déploiement incomplet : une vente insérée sans unit_cost, comme
// le faisait la create_sale() d'avant. Le correctif doit la réparer, sans
// dégrader la protection qui interdit de retoucher un coût une fois figé.
console.log('\n▸ Correctif du coût figé');

{
  const ART = '90909090-9090-9090-9090-909090909090';
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
           VALUES ('${ART}', '${PATRON}', 'Article correctif', 4000, 10000, 50)`);

  // Vente créée « à l'ancienne » : unit_cost non fourni.
  await q(`INSERT INTO sales (user_id, total_amount, payment_method)
           VALUES ('${PATRON}', 20000, 'cash')`);
  const saleId = (await q(
    `SELECT id FROM sales WHERE user_id='${PATRON}' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
           VALUES ('${saleId}', '${ART}', 'Article correctif', 2, 10000, 20000)`);

  const avant = (await q(
    `SELECT unit_cost FROM sale_items WHERE sale_id='${saleId}'`)).rows[0].unit_cost;
  check('9a. vente ancienne sans coût (NULL)', avant === null, String(avant));

  await e(fs.readFileSync(path.join(SQL_DIR, 'migration_profitability_fix.sql'), 'utf8'));

  const apres = (await q(
    `SELECT unit_cost, product_id_archived FROM sale_items WHERE sale_id='${saleId}'`)).rows[0];
  check('9b. coût retrospectively rempli (4 000)', Number(apres.unit_cost) === 4000, String(apres.unit_cost));
  check('9c. product_id_archived renseigné', !!apres.product_id_archived);

  // Le correctif ne doit pas assouplir la protection : un coût figé reste figé.
  const trig = (await q(
    `SELECT count(*)::int c FROM pg_trigger WHERE tgname='sale_items_freeze_cost'`)).rows[0].c;
  check('9d. trigger de figeage toujours présent', trig === 1, `${trig}`);

  let bloque = false;
  const siId = (await q(
    `SELECT id FROM sale_items WHERE sale_id='${saleId}'`)).rows[0].id;
  try { await q(`UPDATE sale_items SET unit_cost = 1 WHERE id='${siId}'`); }
  catch { bloque = true; }
  check('9e. modifier un coût figé reste refusé', bloque);

  // Et une vente neuve, créée par la create_sale() courante, fige son coût.
  await q(`UPDATE products SET stock_qty = 50 WHERE id='${ART}'`);
  const r = await q(`SELECT create_sale(
    '[{"product_id":"${ART}","quantity":1}]'::jsonb, 'cash', null) AS v`);
  // create_sale() renvoie du jsonb : selon le pilote, il arrive en objet ou en
  // chaîne. On normalise avant d'en lire l'id.
  const brut = r.rows[0]?.v;
  const vente = typeof brut === 'string' ? JSON.parse(brut) : brut;
  check('9f. create_sale() aboutit', !!vente?.id, JSON.stringify(brut)?.slice(0, 120));
  const neuf = (await q(
    `SELECT si.unit_cost FROM sale_items si
      WHERE si.sale_id = '${vente?.id}'`)).rows[0]?.unit_cost;
  check('9g. nouvelle vente : coût figé (4 000)', Number(neuf) === 4000, String(neuf));

  // La marge n'est plus nulle une fois le coût connu. Le produit a désormais
  // deux ventes : 2 unités (20 000 F) + 1 unité (10 000 F) = 30 000 F de CA,
  // pour 3 × 4 000 = 12 000 F de coût.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article correctif');
  check('9h. CA cumulé = 30 000', Number(prof?.revenue) === 30000, `obtenu ${prof?.revenue}`);
  check('9i. coût des marchandises = 12 000', Number(prof?.cost_of_goods) === 12000,
    `obtenu ${prof?.cost_of_goods}`);
  check('9j. marge brute = 18 000 (30 000 − 12 000)', Number(prof?.gross_profit) === 18000,
    `obtenu ${prof?.gross_profit}`);
  check('9k. taux de marge = 60 %', Math.round(Number(prof?.margin_pct)) === 60,
    `obtenu ${prof?.margin_pct}`);
}

// ═══ 10. Fournisseurs ═════════════════════════════════════
// Un fournisseur par produit, ON DELETE SET NULL : supprimer un grossiste ne
// doit jamais supprimer les articles qui en dépendent.
console.log('\n▸ Fournisseurs');

const FOURNISSEUR = 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0';
const ART_SANS = 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0';
const ART_AVEC = 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0';

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_SANS}', '${PATRON}', 'Sans fournisseur', 1000, 2000, 5),
                ('${ART_AVEC}', '${PATRON}', 'Avec fournisseur', 1000, 2000, 5)`);

{
  // Un nom vide ou en blanc est refusé : la colonne porte le nom, pas une
  // adresse email.
  let msg = '';
  try {
    await q(`INSERT INTO suppliers (user_id, name) VALUES ('${PATRON}', '   ')`);
  } catch (e) { msg = e.message; }
  check('10a. nom de fournisseur vide refusé', /suppliers_name_not_blank/.test(msg),
    msg || 'accepté !');
}

{
  await q(`INSERT INTO suppliers (id, user_id, name, phone)
           VALUES ('${FOURNISSEUR}', '${PATRON}', 'Grossiste Cokhan', '+229 97 00 00 00')`);
  await q(`UPDATE products SET supplier_id = '${FOURNISSEUR}' WHERE id = '${ART_AVEC}'`);

  const n = await count(`SELECT count(*) FROM suppliers WHERE user_id='${PATRON}'`);
  check('10b. fournisseur créé', n === 1, `${n}`);
}

// La vue doit conserver les produits sans fournisseur, pas les masquer.
// Filtré sur nos deux articles : les sections précédentes ont déjà créé des
// produits, et le test porte sur ce catalogue-là.
{
  const rows = (await q(`SELECT name, supplier_id, supplier_name
                         FROM products_with_supplier
                         WHERE id IN ('${ART_SANS}', '${ART_AVEC}')
                         ORDER BY name`)).rows;
  check('10c. la vue expose les deux articles', rows.length === 2, `${rows.length}`);
  const avec = rows.find((r) => r.name === 'Avec fournisseur');
  const sans = rows.find((r) => r.name === 'Sans fournisseur');
  check('10d. fournisseur résolu (jointure)', avec?.supplier_name === 'Grossiste Cokhan',
    avec?.supplier_name);
  check('10e. produit sans fournisseur conservé', sans && sans.supplier_id === null,
    JSON.stringify(sans));
}

// Supprimer un fournisseur NE doit pas supprimer les articles.
{
  await q(`DELETE FROM suppliers WHERE id = '${FOURNISSEUR}'`);
  const n = await count(`SELECT count(*) FROM products WHERE id = '${ART_AVEC}'`);
  check('10f. l\'article survit à la suppression du fournisseur', n === 1, `${n}`);

  const orphelin = (await q(`SELECT supplier_id FROM products WHERE id='${ART_AVEC}'`)).rows[0];
  check('10g. fournisseur mis à null (SET NULL)', orphelin.supplier_id === null,
    String(orphelin.supplier_id));
}

// Un fournisseur d'un autre tenant est invisible et inutilisable.
{
  const AUTRE5 = '55555555-5555-5555-5555-555555555555';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE5}','fourn@t.ci')
          ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE5}','Chez lui','chezlui')
          ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO suppliers (user_id, name) VALUES ('${AUTRE5}','GrossisteBidon')`);

  // Rattachement refusé : la policy vérifie can_manage_products() ET le tenant.
  let refuse = false;
  try {
    await q(`UPDATE products SET supplier_id = (SELECT id FROM suppliers WHERE user_id='${AUTRE5}')
             WHERE id='${ART_SANS}'`);
  } catch { refuse = true; }
  check('10h. rattacher un fournisseur d\'autre boutique : refusé', refuse);

  // Et invisible en lecture, sous le rôle authentifié.
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const vus = Number((await q(
    `SELECT count(*)::int c FROM suppliers WHERE user_id='${AUTRE5}'`)).rows[0].c);
  await e('RESET ROLE');
  check('10i. les fournisseurs d\'autre tenant sont invisibles', vus === 0, `${vus} vue(s)`);
}

// Rôle : un employé ne gère pas le catalogue fournisseurs.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  await e('SET ROLE authenticated');
  let insere = false;
  try {
    await q(`INSERT INTO suppliers (user_id, name) VALUES ('${PATRON}', 'Interdit')`);
    insere = true;
  } catch { /* refusé */ }
  await e('RESET ROLE');
  check('10j. un employé NE CRÉE PAS de fournisseur', !insere);
}

// Vue : l'isolation tient sous le rôle authentifié.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const noms = (await q(
    `SELECT DISTINCT supplier_name FROM products_with_supplier
      WHERE supplier_name IS NOT NULL`)).rows.map((r) => r.supplier_name);
  await e('RESET ROLE');
  check('10k. la vue n\'expose aucun fournisseur d\'autre tenant',
    !noms.includes('GrossisteBidon'), noms.join(', '));
}

// ═══ 11. Prix négocié ═════════════════════════════════════
// Cas réel de marché : « c'est le dernier prix ». Le prix catalogue reste la
// référence et la remise doit rester traçable, sinon la caisse peut cacher du
// chiffre d'affaires.
console.log('\n▸ Prix négocié');

const NEGO = 'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${NEGO}', '${PATRON}', 'Article négocié', 4000, 10000, 100)`);

const vendre = async (items) => {
  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};
const ligne = (saleId) =>
  q(`SELECT * FROM sale_items WHERE sale_id='${saleId}'`);

{
  // 1. Prix catalogue : le comportement historique doit être inchangé.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 2 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11a. sans prix transmis : prix catalogue', Number(li.unit_price) === 10000, String(li.unit_price));
  check('11b. list_price renseigné même sans remise', Number(li.list_price) === 10000, String(li.list_price));
  check('11c. total = 2 × 10 000', Number(v.total_amount) === 20000, String(v.total_amount));
  check('11d. aucune remise signalée', Number(v.discount_amount) === 0, String(v.discount_amount));
}

{
  // 2. Le cas du marchandage : prix convenu inférieur au catalogue.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 2, unit_price: 8000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11e. prix convenu enregistré', Number(li.unit_price) === 8000, String(li.unit_price));
  check('11f. prix catalogue conservé (remise traçable)', Number(li.list_price) === 10000, String(li.list_price));
  check('11g. total recalculé sur le prix convenu', Number(v.total_amount) === 16000, String(v.total_amount));
  check('11h. remise signalée = 4 000', Number(v.discount_amount) === 4000, String(v.discount_amount));
  // La marge doit suivre le prix réellement encaissé, pas le catalogue.
  check('11i. coût figé sur la ligne inchangé', Number(li.unit_cost) === 4000, String(li.unit_cost));
}

{
  // 3. Revente à perte : autorisée, mais comptée.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 3000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11j. vente à perte autorisée (3 000 < coût 4 000)', Number(v.total_amount) === 3000, String(v.total_amount));
  check('11k. vente à perte signalée (at_loss_count)', Number(v.at_loss_count) === 1, String(v.at_loss_count));
  check('11l. coût figé malgré la perte', Number(li.unit_cost) === 4000, String(li.unit_cost));
}

{
  // 4. Prix supérieur au catalogue : autorisé (vente flash, lot au détail).
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 12000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11m. prix supérieur au catalogue accepté', Number(li.unit_price) === 12000, String(li.unit_price));
  check('11n. remise = 0 (pas de remise, pas de majoration)', Number(v.discount_amount) === 0, String(v.discount_amount));
}

{
  // 5. Garde-fous : ce qui n'a pas de sens marchand est refusé.
  let msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 0 }]));
  } catch (e) { msg = e.message; }
  check('11o. prix à 0 refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: -500 }]));
  } catch (e) { msg = e.message; }
  check('11p. prix négatif refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 'gratuit' }]));
  } catch (e) { msg = e.message; }
  check('11q. prix non numérique refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');
}

{
  // 6. Deux prix différents pour le même article : deux LIGNES, pas un prix
  //    unique. L'ancien code refusait le panier ; quand le restaurant a commencé à
  //    passer au travers de ce refus, il s'est aligné sur le prix le MOINS cher et
  //    sous-facturé de 5 000 — « un poulet à 100 puis un à 9 000 » devenait
  //    200. Garder les deux prix supprime le risque : plus rien à arbitrer.
  const v = await vendre(JSON.stringify([
    { product_id: NEGO, quantity: 1, unit_price: 100 },
    { product_id: NEGO, quantity: 1, unit_price: 9000 },
  ]));
  const li = (await ligne(v.id)).rows;
  check('11r. deux prix pour le même article donnent deux lignes', li.length === 2,
    `${li.length} ligne(s)`);
  check('11r2. et le total additionne les deux prix, sans arbitrage',
    Number(v.total_amount) === 9100, String(v.total_amount));
}

{
  // 7. Même article à deux lignes, même prix : l'agrégation doit encore
  //    fonctionner, et le prix convenu être conservé.
  const v = await vendre(JSON.stringify([
    { product_id: NEGO, quantity: 2, unit_price: 7000 },
    { product_id: NEGO, quantity: 1, unit_price: 7000 },
  ]));
  const li = (await ligne(v.id)).rows;
  check('11s. lignes agrégées en une seule', li.length === 1, `${li.length} ligne(s)`);
  check('11t. quantités cumulées (2 + 1 = 3)', Number(li[0].quantity) === 3, String(li[0].quantity));
  check('11u. prix convenu conservé après agrégation', Number(li[0].unit_price) === 7000, String(li[0].unit_price));
  check('11v. total = 3 × 7 000', Number(v.total_amount) === 21000, String(v.total_amount));
}

{
  // 8. Le stock est décrémenté du montant réel, même avec un prix négocié.
  //    Ventes abouties : 2 (11a) + 2 (11e) + 1 (11j) + 1 (11m) + 3 (11s) + 2 (11r) = 11.
  //    Les ventes refusées (prix 0, négatif, non numérique) ne doivent rien
  //    consommer : c'est le point qu'on vérifie ici.
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${NEGO}'`)).rows[0].stock_qty;
  check('11w. stock décrémenté du seul volume vendu (11 unités)',
    Number(stock) === 100 - 11, `stock = ${stock}, attendu ${100 - 11}`);
}

{
  // 9. Une remise ne doit pas pouvoir servir à sortir le stock d'un autre
  //    tenant : le prix ne dispense pas de la validation de stock.
  let refuse = false;
  try {
    await q(`SELECT set_config('request.jwt.claim.sub',
      (SELECT owner_id FROM business_members LIMIT 1), false)`);
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 100 }]));
  } catch { refuse = true; }
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  check('11x. un employé ne vend pas un produit du patron', refuse);
}

// ═══ 12. Changer la signature de retour d'une fonction ══════
// PostgreSQL refuse en 42P13 de remplacer une fonction dont le type de retour
// diffère : les paramètres OUT font partie de la signature. C'est ce que
// l'utilisateur a rencontré en collant APPLY_MIGRATIONS.sql après l'ajout des
// colonnes de prix négocié à get_product_profitability().
//
// On vérifie le mécanisme : une fonction à signature retour A, remplacée par une
// à signature retour B, doit rester applicable.
console.log('\n▸ Changement de signature de retour');

{
  const signA = 'alpha int, beta int';
  const signB = 'alpha int, beta int, gamma int';

  await e(`CREATE OR REPLACE FUNCTION sig_test() RETURNS TABLE (${signA})
           LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta $$`);

  // Sans DROP préalable, ce remplacement échoue : c'est le cas que la migration
  // doit éviter.
  let refuse = false;
  try {
    await e(`CREATE OR REPLACE FUNCTION sig_test() RETURNS TABLE (${signB})
             LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta, 3 AS gamma $$`);
  } catch (err) {
    refuse = /42P13|cannot change return type/i.test(err.message);
  }
  check('12a. sans DROP, le changement de signature est refusé (42P13)', refuse);

  // Avec DROP : le remplacement passe.
  await e(`DROP FUNCTION IF EXISTS sig_test()`);
  await e(`CREATE FUNCTION sig_test() RETURNS TABLE (${signB})
           LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta, 3 AS gamma $$`);
  const r = (await q(`SELECT * FROM sig_test()`)).rows[0];
  check('12b. avec DROP préalable, la nouvelle signature s\'applique', r?.gamma === 3, JSON.stringify(r));

  await e(`DROP FUNCTION IF EXISTS sig_test()`);
}

// Et la migration réelle : ses trois nouvelles colonnes doivent être là.
{
  const cols = (await q(
    `SELECT * FROM get_product_profitability() LIMIT 1`)).fields.map((f) => f.name);
  check('12c. get_product_profitability() expose avg_sold_price',
    cols.includes('avg_sold_price'), cols.join(', '));
  check('12d. … discount_given', cols.includes('discount_given'));
  check('12e. … units_sold_at_loss', cols.includes('units_sold_at_loss'));
}

// ═══ 13. Vente au poids ═══════════════════════════════════
// Le blocage n° 1 du marché : tout se vend au kilo, et la quantité était un
// INTEGER validé par `^[0-9]+$`. 1,2 kg de riz était impossible à enregistrer.
console.log('\n▸ Vente au poids');

const RIZ = 'e0e0e0e0-0000-4000-8000-000000000001';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, unit, price_buy, price_sell, stock_qty)
         VALUES ('${RIZ}', '${PATRON}', 'Riz', 'kg', 600, 750, 50)`);

const vendreK = async (items) => {
  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};
const ligneK = (saleId) => q(`SELECT * FROM sale_items WHERE sale_id='${saleId}'`);

{
  // 1. Le cas de base : 1,5 kg à 750 F = 1 125 F.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.5 }]));
  const li = (await ligneK(v.id)).rows[0];
  check('13a. 1,5 kg accepté', Number(li.quantity) === 1.5, String(li.quantity));
  check('13b. total = 1,5 × 750', Number(v.total_amount) === 1125, String(v.total_amount));
}

{
  // 2. La virgule décimale : un clavier de téléphone au Bénin produit « 1,2 ».
  //    Sans conversion, ::numeric échoue et la vente est refusée sans raison
  //    visible.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '2,25' }]));
  const li = (await ligneK(v.id)).rows[0];
  check('13c. virgule décimale acceptée (2,25)', Number(li.quantity) === 2.25, String(li.quantity));
  check('13d. total = 2,25 × 750', Number(v.total_amount) === 1687.5, String(v.total_amount));
}

{
  // 3. Trois décimales : 1,250 kg se pèse au gramme près.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '1.250' }]));
  check('13e. trois décimales acceptées', Number((await ligneK(v.id)).rows[0].quantity) === 1.25);
}

{
  // 4. Le stock décrémente proprement, sans reste fantôme.
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  // 50 − 1,5 − 2,25 − 1,25 = 45
  check('13f. stock décrémenté sans arrondi', Number(stock) === 45, `stock = ${stock}`);
}

{
  // 5. L'agrégation additionne les fractions, elle ne les écrase pas.
  //    1,2 + 0,8 = 2 et non 1 : c'est le cas des deux scans du même lot.
  const v = await vendreK(JSON.stringify([
    { product_id: RIZ, quantity: 1.2 },
    { product_id: RIZ, quantity: 0.8 },
  ]));
  const li = (await ligneK(v.id)).rows;
  check('13g. fractions agrégées en une ligne', li.length === 1, `${li.length} ligne(s)`);
  check('13h. 1,2 + 0,8 = 2 (pas 1)', Number(li[0].quantity) === 2, String(li[0].quantity));
  check('13i. total = 2 × 750', Number(v.total_amount) === 1500, String(v.total_amount));
}

{
  // 6. Le prix négocié s'applique au poids, pas au total.
  //    « 700 le kilo au lieu de 750 » — pas « 1400 les 2 kg ».
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 2, unit_price: 700 }]));
  check('13j. prix négocié au poids', Number(v.total_amount) === 1400, String(v.total_amount));
  check('13k. remise = 50 × 2', Number(v.discount_amount) === 100, String(v.discount_amount));
}

{
  // 7. Stock insuffisant : la comparaison est décimale, pas entière.
  //    Avec 1,5 kg restants, vendre 1,6 doit échouer — un cast en int
  //    tronquerait 1,6 à 1 et autoriserait la vente.
  await q(`UPDATE products SET stock_qty = 1.5 WHERE id='${RIZ}'`);
  let msg = '';
  try {
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.6 }]));
  } catch (e) { msg = e.message; }
  check('13l. 1,5 en stock, 1,6 demandé : refusé', /Stock insuffisant/.test(msg), msg || 'accepté !');

  // Et 1,5 en stock, 1,5 demandé : passe, le stock tombe à zéro.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.5 }]));
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  check('13m. 1,5 en stock, 1,5 demandé : accepté', !!v.id, msg);
  check('13n. stock exactement à zéro', Number(stock) === 0, `stock = ${stock}`);
}

{
  // 8. Le stock ne peut pas devenir négatif par fractions.
  await q(`UPDATE products SET stock_qty = 0.4 WHERE id='${RIZ}'`);
  let refuse = false;
  try {
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 0.5 }]));
  } catch { refuse = true; }
  check('13o. 0,4 en stock, 0,5 demandé : refusé', refuse);
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  check('13p. stock resté à 0,4 (pas de décrément partiel)', Number(stock) === 0.4, `stock = ${stock}`);
}

{
  // 9. Garde-fous sur la quantité.
  let msg = '';
  try {
    await q(`UPDATE products SET stock_qty = 100 WHERE id='${RIZ}'`);
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 0 }]));
  } catch (e) { msg = e.message; }
  check('13q. quantité nulle refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: -2 }])); }
  catch (e) { msg = e.message; }
  check('13r. quantité négative refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 'un kilo' }])); }
  catch (e) { msg = e.message; }
  check('13s. quantité non numérique refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '1.2.3' }])); }
  catch (e) { msg = e.message; }
  check('13t. deux points refusés', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');
}

{
  // 10. L'unité est enregistrée et n'affecte aucun calcul.
  const u = (await q(`SELECT unit FROM products WHERE id='${RIZ}'`)).rows[0].unit;
  check('13u. unité enregistrée', u === 'kg', u);

  // Un produit créé avant la migration — donc sans unité explicite — vaut « pce »
  // et non NULL : l'écran affiche toujours quelque chose. P1 vient de la section
  // create_sale, il existe donc.
  const defaut = (await q(`SELECT unit FROM products WHERE id = '${P1}'`)).rows[0]?.unit;
  check('13v. unité par défaut = pce', defaut === 'pce', String(defaut));
}

{
  // 11. La marge au kilo reste juste : c'est le but de l'opération.
  //     Nom distinct de P2 (« Huile 1L » existe déjà) : sinon .find() renvoie
  //     le premier homonyme, qui n'a jamais été vendu.
  await q(`INSERT INTO products (id, user_id, name, unit, price_buy, price_sell, stock_qty)
           VALUES ('e1e1e1e1-0000-4000-8000-000000000002', '${PATRON}', 'Huile litre', 'L', 800, 1000, 20)`);
  await vendreK(JSON.stringify([{ product_id: 'e1e1e1e1-0000-4000-8000-000000000002', quantity: 2.5 }]));
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Huile litre');
  check('13w. CA = 2,5 × 1 000', Number(prof.revenue) === 2500, `obtenu ${prof.revenue}`);
  check('13x. coût = 2,5 × 800', Number(prof.cost_of_goods) === 2000, `obtenu ${prof.cost_of_goods}`);
  check('13y. marge = 500', Number(prof.gross_profit) === 500, `obtenu ${prof.gross_profit}`);
  check('13z. taux = 20 %', Math.round(Number(prof.margin_pct)) === 20, `obtenu ${prof.margin_pct}`);
}

// ═══ 14. Crédit client ═══════════════════════════════════
// Le carnet de dette. Choix comptable : recette à l'encaissement. Une vente à
// crédit ne compte ni dans le chiffre d'affaires ni dans la marge tant qu'elle
// n'est pas réglée — mais le stock part immédiatement.
console.log('\n▸ Crédit client');

const ART_C = 'f0f0f0f0-0000-4000-8000-00000000000a';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_C}', '${PATRON}', 'Article crédit', 4000, 10000, 100)`);

const credit = async (qty, nom, tel) => {
  const r = await q(`SELECT record_credit_sale(
    '[{"product_id":"${ART_C}","quantity":${qty}}]'::jsonb, '${nom}', '${tel}', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};

{
  // 1. Normalisation du numéro : trois écritures, un seul client.
  const n1 = (await q(`SELECT normalize_phone('+229 97 00 00 01') AS n`)).rows[0].n;
  const n2 = (await q(`SELECT normalize_phone('22997000001') AS n`)).rows[0].n;
  const n3 = (await q(`SELECT normalize_phone('97000001') AS n`)).rows[0].n;
  check('14a. « +229 97… » normalisé', n1 === '22997000001', n1);
  check('14b. « 229… » normalisé', n2 === '22997000001', n2);
  check('14c. numéro local préfixé 229', n3 === '22997000001', n3);

  const invalide = (await q(`SELECT normalize_phone('123') AS n`)).rows[0].n;
  check('14d. numéro trop court refusé', invalide === null, String(invalide));
  const vide = (await q(`SELECT normalize_phone('abc') AS n`)).rows[0].n;
  check('14e. texte non numérique refusé', vide === null, String(vide));
}

{
  // 2. Sans téléphone, pas de dette : elle serait orpheline.
  let msg = '';
  try { await credit(1, 'Sans tel', ''); } catch (e) { msg = e.message; }
  check('14f. vente à crédit sans téléphone : refusée', /téléphone est obligatoire/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await credit(1, '', '+229 97 00 00 02'); } catch (e) { msg = e.message; }
  check('14g. vente à crédit sans nom : refusée', /nom du client/.test(msg), msg || 'acceptée !');
}

{
  // 3. La vente passe, le stock part, l'argent n'entre pas.
  const v = await credit(2, 'Koffi', '+229 97 00 00 01');
  check('14h. vente à crédit enregistrée', !!v?.id);
  check('14i. total correct (2 × 10 000)', Number(v.total_amount) === 20000, String(v.total_amount));
  check('14j. numéro normalisé renvoyé', v.client_phone === '22997000001', v.client_phone);

  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${ART_C}'`)).rows[0].stock_qty;
  check('14k. le stock part quand même', Number(stock) === 98, `stock = ${stock}`);

  const s = (await q(`SELECT settled, payment_method, client_phone FROM sales WHERE id='${v.id}'`)).rows[0];
  check('14l. vente marquée non encaissée', s.settled === false);
  check('14m. moyen de paiement = credit', s.payment_method === 'credit', s.payment_method);
  check('14n. téléphone sur la vente', s.client_phone === '22997000001', String(s.client_phone));
}

{
  // 4. LE POINT CENTRAL : la vente ne compte PAS dans le chiffre d'affaires.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14o. CA = 0 (recette à l\'encaissement)', Number(prof.revenue) === 0, `obtenu ${prof.revenue}`);
  check('14p. marge = 0 tant que non réglée', Number(prof.gross_profit) === 0, `obtenu ${prof.gross_profit}`);
  check('14q. coût des marchandises = 0 (non encaissé)', Number(prof.cost_of_goods) === 0, `obtenu ${prof.cost_of_goods}`);
  check('14r. MAIS les unités vendues comptent (fait physique)', Number(prof.units_sold) === 2, `obtenu ${prof.units_sold}`);
  check('14s. crédit en cours exposé à part', Number(prof.unsettled_credit) === 20000, `obtenu ${prof.unsettled_credit}`);
}

{
  // 5. Le résultat net ne doit PAS compter le crédit. Le harnais a déjà fait
  //    des ventes cash aujourd'hui : on compare donc le cash-flow du jour au
  //    cumul des ventes ENCAISSÉES de ce jour. L'écart doit être nul — si le
  //    crédit entrait, l'écart serait de 20 000.
  const jour = (await q(
    `SELECT (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text AS d
       FROM sales WHERE client_phone = '22997000001' LIMIT 1`)).rows[0].d;
  const ca = Number((await q(`SELECT * FROM get_cash_flow('${jour}', '${jour}')`)).rows[0]?.revenue ?? 0);
  // Le cash-flow vaut SUM(amount_received) : c'est la définition. La vente à
  // crédit du harnais est à 0 encaissé, donc elle n'entre pas — et c'est
  // exactement ce que ce test vérifie.
  const encaisse = Number((await q(
    `SELECT COALESCE(SUM(amount_received), 0) AS c FROM sales
      WHERE (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text = '${jour}'`)).rows[0].c);
  check('14t. le cash-flow = encaissements du jour (crédit non réglé exclu)',
    Math.abs(ca - encaisse) < 1, `cash-flow ${ca} vs encaissé ${encaisse}`);
}

{
  // 6. Le solde apparaît, et le plus ancien d'abord.
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14u. une dette listée', dettes.length === 1, `${dettes.length}`);
  check('14v. solde = 20 000', Number(dettes[0].total_due) === 20000, `obtenu ${dettes[0].total_due}`);
  check('14w. fiche client créée', dettes[0].phone === '22997000001', dettes[0].phone);
}

{
  // 7. Encaissement partiel : la norme. 8 000 sur 20 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 8000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('14x. versement partiel accepté', !!p);
  check('14y. solde avant = 20 000', Number(p.balance_before) === 20000, String(p.balance_before));
  check('14z. solde après = 12 000', Number(p.balance_after) === 12000, String(p.balance_after));
  check('14aa. aucune vente soldée (règlement partiel)', Number(p.sales_settled) === 0, String(p.sales_settled));

  const encore = (await q(`SELECT count(*)::int c FROM sales WHERE NOT settled AND client_phone='22997000001'`)).rows[0].c;
  check('14ab. la vente reste ouverte', encore === 1, `${encore}`);
}

{
  // 8. La vente apparaît dans le CA dès l'encaissement complet.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 12000, 'momo', 'solde') AS v`);
  const p = r.rows[0].v;
  check('14ac. solde soldé', Number(p.balance_after) === 0, String(p.balance_after));
  check('14ad. une vente réglée', Number(p.sales_settled) === 1, String(p.sales_settled));

  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14ae. CA apparaît après encaissement (20 000)', Number(prof.revenue) === 20000, `obtenu ${prof.revenue}`);
  check('14af. coût apparaît (8 000)', Number(prof.cost_of_goods) === 8000, `obtenu ${prof.cost_of_goods}`);
  check('14ag. marge apparaît (12 000)', Number(prof.gross_profit) === 12000, `obtenu ${prof.gross_profit}`);
  check('14ah. plus de crédit en cours', Number(prof.unsettled_credit) === 0, `obtenu ${prof.unsettled_credit}`);

  // Et l'écran de dettes ne montre plus un client à 0 F.
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14ai. dette soldée : plus de client listé', dettes.length === 0, `${dettes.length}`);
}

{
  // 9. Un second client, pour tester l'isolation entre dettes.
  await credit(1, 'Adjovi', '+229 96 11 22 33');
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14aj. deux dettes distinctes', dettes.length === 1, `${dettes.length}`);
  check('14ak. bonne fiche', dettes[0]?.phone === '22996112233', dettes[0]?.phone);
}

{
  // 10. Un numéro écrit différemment ne crée pas un second débiteur.
  const v = await credit(1, 'Koffi encore', '96 11 22 33');
  check('14al. réécriture du numéro : même dette', !!v?.id);
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14am. toujours un seul débiteur', dettes.length === 1, `${dettes.length}`);
  const nom = dettes[0]?.name;
  check('14an. nom mis à jour', nom === 'Koffi encore', String(nom));
}

{
  // 11. Encaisser sur une fiche sans dette, ou deux fois : refusé.
  const soldée = (await q(
    `SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  let msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 500, 'cash', null)`);
  } catch (e) { msg = e.message; }
  check('14ao. encaissement sur une dette soldée : refusé', /n'a pas de dette en cours/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 0, 'cash', null)`);
  } catch (e) { msg = e.message; }
  check('14ap. versement nul : refusé', /Montant de versement invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 100, 'carte', null)`);
  } catch (e) { msg = e.message; }
  check('14aq. moyen de paiement inconnu : refusé', /Moyen de paiement invalide/.test(msg), msg || 'accepté !');
}

{
  // 12. Un patron ne peut pas encaisser la dette d'un autre tenant.
  const AUTRE6 = '66666666-6666-6666-6666-666666666666';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE6}','dette@t.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE6}','Chez lui2','chezlui2') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO customer_debts (user_id, phone, name)
           VALUES ('${AUTRE6}', '22990000000', 'Dette étrangère') ON CONFLICT DO NOTHING`);
  const detteEtrangere = (await q(
    `SELECT id FROM customer_debts WHERE user_id='${AUTRE6}'`)).rows[0].id;

  let refuse = false;
  try {
    await q(`SELECT pay_customer_debt('${detteEtrangere}', 1000, 'cash', null)`);
  } catch { refuse = true; }
  check('14ar. encaisser la dette d\'autre boutique : refusé', refuse);

  // Et on ne voit pas ses dettes.
  const vus = (await q(`SELECT count(*)::int c FROM get_customer_debts()
                         WHERE phone = '22990000000'`)).rows[0].c;
  check('14as. les dettes d\'autre tenant sont invisibles', Number(vus) === 0, `${vus}`);
}

{
  // 13. Le stock d'un produit cédé à crédit a bien disparu — c'est le point :
  //     la recette attend l'encaissement, la marchandise, elle, est partie.
  //     100 − 2 (14h) − 1 (14j) − 1 (14j) = 96
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${ART_C}'`)).rows[0].stock_qty;
  check('14at. stock décrémenté par les ventes à crédit', Number(stock) === 96, `stock = ${stock}`);

  // Et la quantité vendue, elle, compte pour toutes les ventes : c'est un fait
  // physique, Prévisions s'en sert pour estimer la rotation.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14au. unités vendues = 4 (crédit compris)', Number(prof.units_sold) === 4, `obtenu ${prof.units_sold}`);

  // Une seule signature, et c'est la dernière. CREATE OR REPLACE avec une
  // nouvelle arity crée une SURCHARGE : l'ancienne version survivrait, et
  // PostgREST la servirait — le client n'enverrait jamais p_advance_method.
  // C'est le piège documenté au README, vérifié ici pour la dernière arité
  // en date (5 → 6 avec p_advance_method).
  const sigs = (await q(
    `SELECT pronargs FROM pg_proc WHERE proname = 'record_credit_sale'`
  )).rows.map((x) => Number(x.pronargs));
  check("14av. record_credit_sale : une seule signature, 7 arguments",
    sigs.length === 1 && sigs[0] === 7, `arités : ${sigs.join(', ')}`);
}

// ═══ 15. Deux boutiques Pro ════════════════════════════════
// Régression d'un bug qui rendait la caisse inutilisable : le compteur de
// facture est par boutique, mais l'index d'unicité portait sur la seule colonne
// invoice_number. Les deux premières boutiques Pro de la plateforme produisaient
// donc toutes deux « FAC-2026-00001 », et la seconde se faisait REFUSER sa
// vente. Un client payant incapable d'encaisser.
console.log('\n▸ Deux boutiques Pro');

{
  const A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${A}','pa@test.ci'),('${B}','pb@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug,plan) VALUES
             ('${A}','Boutique A','boutique-a','pro'),
             ('${B}','Boutique B','boutique-b','pro') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty) VALUES
             ('cccccccc-0000-4000-8000-000000000001','${A}','Article A',4000,10000,50),
             ('dddddddd-0000-4000-8000-000000000001','${B}','Article B',4000,10000,50)
           ON CONFLICT DO NOTHING`);

  const vendre = async (uid, pid) => {
    await q(`SELECT set_config('request.jwt.claim.sub','${uid}',false)`);
    const r = await q(`SELECT create_sale(
      '[{"product_id":"${pid}","quantity":1}]'::jsonb,'cash',null,null) AS v`);
    const b = r.rows[0].v;
    return typeof b === 'string' ? JSON.parse(b) : b;
  };

  const va = await vendre(A, 'cccccccc-0000-4000-8000-000000000001');
  check('15A. la première boutique Pro encaisse', Number(va?.total_amount) === 10000, JSON.stringify(va));

  let vb = null, refus = '';
  try { vb = await vendre(B, 'dddddddd-0000-4000-8000-000000000001'); }
  catch (e) { refus = e.message.split('\n')[0]; }
  check('15B. la DEUXIÈME boutique Pro encaisse aussi', !!vb?.id, refus || 'sa caisse est morte');
  check('15C. sa vente vaut bien 10 000', Number(vb?.total_amount) === 10000, String(vb?.total_amount));

  // Chaque boutique a sa propre séquence. C'est la sémantique attendue d'une
  // numérotation de factures : elle est par contribuable, pas par pays.
  check('15D. les deux|numéros peuvent coincider sans erreur',
    typeof va?.invoice_number === 'string' && typeof vb?.invoice_number === 'string',
    `${va?.invoice_number} / ${vb?.invoice_number}`);

  // Et la séquence avance bien dans la durée pour une même boutique.
  const va2 = await vendre(A, 'cccccccc-0000-4000-8000-000000000001');
  check('15E. la séquence avance dans la même boutique',
    va2?.invoice_number !== va?.invoice_number,
    `${va?.invoice_number} puis ${va2?.invoice_number}`);

  // L'unicité reste réelle là où elle doit l'être : deux ventes d'une même
  // boutique ne peuvent pas porter le même numéro.
  const doublon = (await q(`SELECT count(*)::int c FROM sales
     WHERE user_id='${A}' AND invoice_number = '${va?.invoice_number}'`)).rows[0].c;
  check('15F. unicité maintenue par boutique', Number(doublon) === 1, `${doublon} ligne(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub','${PATRON}',false)`);
}

// ═══ 16. Verrou de plan côté serveur ═══════════════════════
// Le cadenas du menu ne protégeait rien. Les trois fonctions payantes étaient
// appelables en RPC sans qu'aucun plan soit consulté : un client en plan
// gratuit obtenait sa rentabilité, son résultat net et son carnet de dette en
// appelant depuis la console du navigateur. C'est le produit entier qui
// devenait gratuit.
//
// Ces tests vérifient le refus, pas seulement la présence du code.
console.log('\n▸ Verrou de plan');

const FREE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
await q(`INSERT INTO auth.users (id,email) VALUES ('${FREE}','gratuit@test.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO organizations (id,name,slug,plan) VALUES ('${FREE}','Boutique Gratuite','boutique-gratuite','free') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
         VALUES ('f0f0f0f0-0000-4000-8000-00000000000b','${FREE}','Article gratuit',4000,10000,50)
         ON CONFLICT DO NOTHING`);

// Le produit doit exister ET avoir déjà vendu AVANT de vérifier le refus : sinon
// le test passerait pour la mauvaise raison — aucune ligne à renvoyer, donc
// rien à protéger. La vente passe par create_sale(), ce qui prouve au passage
// qu'un client gratuit peut vendre.
await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
await q(`SELECT create_sale(
  '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":2}]'::jsonb,
  'cash', null, null)`);

{
  const plan = (await q(`SELECT current_org_plan() AS p`)).rows[0].p;
  check('16a. le plan de la boutique est lu en base', plan === 'free', plan);
}

{
  // Le trou : avant migration_plan_gate, cet appel renvoyait les chiffres.
  let msg = '';
  try { await q(`SELECT * FROM get_product_profitability()`); } catch (e) { msg = e.message; }
  check('16b. rentabilité refusée en plan gratuit', /plan starter/i.test(msg), msg || 'RENVOYÉE !');
  check('16c. le message nomme le plan à prendre', /starter/i.test(msg), msg);
}

{
  let msg = '';
  try { await q(`SELECT * FROM get_cash_flow('2000-01-01','2100-01-01')`); } catch (e) { msg = e.message; }
  check('16d. résultat net refusé en plan gratuit', /plan starter/i.test(msg), msg || 'RENVOYÉ !');
}

{
  // Vendre à crédit puis demander le relevé : c'est ce que contient la liste
  // des débiteurs — nom et numéro de ceux qui doivent de l'argent.
  await q(`SELECT record_credit_sale(
             '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":1}]'::jsonb,
             'Débiteur gratuit','+229 95 00 00 00',null)`);
  //
  // Règle inversée par migration_onboarding_mode.sql : récupérer son argent
  // n'est pas un avantage payant. Le carnet est l'un des trois piliers du mode
  // simple, celui d'une boutique gratuite. Les rapports (16d) restent payants.
  let msg = '';
  let lignes = [];
  try {
    lignes = (await q(`SELECT name FROM get_customer_debts()`)).rows;
  } catch (e) { msg = e.message; }
  check('16e. carnet de dette lisible en plan gratuit',
    msg === '' && lignes.some((l) => l.name === 'Débiteur gratuit'), msg || `${lignes.length} ligne(s)`);
}

{
  // Prévisions : l'API qui ramenait l'historique de ventes, ligne à ligne.
  let msg = '';
  try { await q(`SELECT * FROM get_units_sold_since(30)`); } catch (e) { msg = e.message; }
  check('16f. prévisions refusées en plan gratuit', /plan pro/i.test(msg), msg || 'RENVOYÉES !');
}

{
  // Le contournement classique : passer un nom de fonctionnalité bidon en
  // espérant un accès granted. Une faute de frappe ne doit rien ouvrir.
  let msg = '';
  try { await q(`SELECT require_feature('reports ')`); } catch (e) { msg = e.message; }
  check('16g. fonctionnalité inconnue refusée', /inconnue/i.test(msg), msg || 'ACCEPTÉE !');
}

{
  // Un plan en Starter a les rapports, mais pas les prévisions. C'est le
  // raccourcissement à ne pas faire : si Starter avait eu les deux, personne
  // n'aurait jamais payé Pro.
  await q(`UPDATE organizations SET plan='starter' WHERE id='${FREE}'`);
  let ok = true, msg = '';
  try { await q(`SELECT * FROM get_product_profitability()`); } catch (e) { ok = false; msg = e.message; }
  check('16h. Starter accède à la rentabilité', ok, msg);
  ok = true; msg = '';
  try { await q(`SELECT * FROM get_cash_flow('2000-01-01','2100-01-01')`); } catch (e) { ok = false; msg = e.message; }
  check('16i. Starter accède au résultat net', ok, msg);
  ok = true; msg = '';
  try { await q(`SELECT * FROM get_customer_debts()`); } catch (e) { ok = false; msg = e.message; }
  check('16j. Starter accède au carnet de dette', ok, msg);

  ok = true; msg = '';
  try { await q(`SELECT * FROM get_units_sold_since(30)`); } catch (e) { ok = false; msg = e.message; }
  check('16k. Starter n\'a PAS les prévisions', !ok && /plan pro/i.test(msg), msg || 'accès accordé !');
}

{
  await q(`UPDATE organizations SET plan='pro' WHERE id='${FREE}'`);
  const r = await q(`SELECT * FROM get_units_sold_since(30)`);
  check('16l. Pro accède aux prévisions', Array.isArray(r.rows), '');
}

{
  // La vente, elle, ne doit jamais être bloquée. Un client gratuit doit pouvoir
  // travailler : c'est l'application. Verrouiller la caisse décourage, et un
  // commerce arrêté ne demande jamais d'upgrade.
  const v = await q(`SELECT create_sale(
    '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":1}]'::jsonb,'cash',null,null) AS v`);
  const b = v.rows[0].v;
  const o = typeof b === 'string' ? JSON.parse(b) : b;
  check('16m. la vente reste possible en plan gratuit', Number(o?.total_amount) === 10000, JSON.stringify(o));

  // Et le stock baisse : c'est une vraie vente, pas un dry-run.
  // 50 − 2 (fixture) − 1 (ici) − 1 (16e, dette créée pour 16e) = 46
  const st = (await q(`SELECT stock_qty FROM products WHERE id='f0f0f0f0-0000-4000-8000-00000000000b'`)).rows[0].stock_qty;
  check('16n. le stock décrémente en plan gratuit', Number(st) === 46, `stock = ${st}`);
}

{
  // Une boutique qui n'existe pas ou n'a pas de plan est traitée comme gratuit.
  // En cas de doute, le coût doit tomber sur le vendeur, jamais sur le client.
  await q(`SELECT set_config('request.jwt.claim.sub',
           'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false)`);
  const plan = (await q(`SELECT current_org_plan() AS p`)).rows[0].p;
  check('16o. boutique inconnue traitée comme gratuit', plan === 'free', plan);
}

// Retour au patron Pro pour la suite de la suite.
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// ═══ 17. Acompte ══════════════════════════════════════════
// « Laisse-moi 50 000 sur 130 000 » est le geste le plus courant d'une boutique
// de quartier. Avant, le choix « Crédit » signifiait 100 % à découvert : ou le
// commerçant encaissait tout et inventait un montant, ou il laissait une dette
// trop grosse. Aucune des deux ne décrivait la réalité.
//
// La règle : amount_received porte ce qui est réellement rentré, et le chiffre
// d'affaires vaut SUM(amount_received). La caisse et le chiffre d'affaires ne
// peuvent donc pas diverger.
console.log('\n▸ Acompte');

const ART_A = 'e0e0e0e0-0000-4000-8000-00000000000a';
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_A}', '${PATRON}', 'Article acompte', 4000, 10000, 200)`);

const acompter = async (qty, tel, avance) => {
  const r = await q(`SELECT record_credit_sale(
    '[{"product_id":"${ART_A}","quantity":${qty}}]'::jsonb, 'Avec acompte', '${tel}', null, ${avance}) AS v`);
  const b = r.rows[0].v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};

{
  const v = await acompter(13, '+229 94 00 00 01', 50000);
  check('17a. vente avec acompte enregistrée', !!v?.id);
  check('17b. prix = 130 000', Number(v.total_amount) === 130000, String(v.total_amount));
  check('17c. acompte renvoyé (50 000)', Number(v.amount_advance) === 50000, String(v.amount_advance));
  check('17d. reste dû renvoyé (80 000)', Number(v.amount_due) === 80000, String(v.amount_due));

  const s = (await q(`SELECT amount_received, settled, payment_method
                         FROM sales WHERE id='${v.id}'`)).rows[0];
  check('17e. encaissé = 50 000', Number(s.amount_received) === 50000, String(s.amount_received));
  check('17f. vente non soldée', s.settled === false);

  // Le stock part, même avec acompte : la marchandise est partie.
  const st = (await q(`SELECT stock_qty FROM products WHERE id='${ART_A}'`)).rows[0].stock_qty;
  check('17g. le stock part quand même', Number(st) === 187, `stock = ${st}`);
}

{
  // LE POINT CENTRAL : la caisse et le chiffre d'affaires concordent.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article acompte');
  check('17h. CA = 50 000 (l\'acompte seulement)', Number(prof.revenue) === 50000, `obtenu ${prof.revenue}`);
  check('17i. coût = 20 000 au prorata (5 000 x 5/13)', Math.abs(Number(prof.cost_of_goods) - 20000) < 1,
    `obtenu ${prof.cost_of_goods}`);
  check('17j. marge = 30 000 au prorata', Math.abs(Number(prof.gross_profit) - 30000) < 1,
    `obtenu ${prof.gross_profit}`);

  // Le taux de marge ne doit PAS être dégradé par l'encaissement partiel : le
  // ratio s'annule, donc c'est le vrai taux du produit.
  check('17k. taux de marge intact (60 %)', Number(prof.margin_pct) === 60, `obtenu ${prof.margin_pct}`);

  // Les unités vendues restent un fait physique : 13 sont sorties.
  check('17l. 13 unités vendues', Number(prof.units_sold) === 13, `obtenu ${prof.units_sold}`);

  // Ce qui reste dû est 80 000, pas 130 000.
  check('17m. crédit restant = 80 000', Math.abs(Number(prof.unsettled_credit) - 80000) < 1,
    `obtenu ${prof.unsettled_credit}`);
}

{
  // Le cash-flow du jour vaut l'acompte, pas le prix.
  const jour = (await q(
    `SELECT (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text AS d
       FROM sales WHERE client_phone = '22994000001' LIMIT 1`)).rows[0].d;
  const ca = Number((await q(`SELECT * FROM get_cash_flow('${jour}','${jour}')`)).rows[0]?.revenue ?? 0);
  const attendu = Number((await q(
    `SELECT COALESCE(SUM(amount_received),0) AS c FROM sales
      WHERE (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text = '${jour}'`)).rows[0].c);
  check('17n. résultat net = encaissements du jour', Math.abs(ca - attendu) < 1,
    `cash-flow ${ca} vs encaissé ${attendu}`);
}

{
  // La dette affichée au commerçant est bien de 80 000.
  const dettes = (await q(`SELECT * FROM get_customer_debts()
                            WHERE phone = '22994000001'`)).rows;
  check('17o. dette = 80 000', Number(dettes[0].total_due) === 80000, `obtenu ${dettes[0].total_due}`);
  check('17p. « déjà versé » = 50 000', Number(dettes[0].total_paid) === 50000,
    `obtenu ${dettes[0].total_paid}`);
  check('17q. l\'acompte est dans l\'historique des versements', Number(dettes[0].payments_count) === 1,
    `${dettes[0].payments_count}`);
}

{
  // Un règlement de 30 000 sur la dette de 80 000 : reste 50 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 30000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17r. solde avant = 80 000', Number(p.balance_before) === 80000, String(p.balance_before));
  check('17s. solde après = 50 000', Number(p.balance_after) === 50000, String(p.balance_after));
  check('17t. aucune vente soldée (règlement partiel)', Number(p.sales_settled) === 0,
    String(p.sales_settled));

  // Et la dette est exactement la somme de ce qui manque, sans répartition
  // reconstituée : 130 000 − 80 000 encaissés.
  const s = (await q(`SELECT amount_received FROM sales WHERE client_phone='22994000001'`)).rows[0];
  check('17u. encaissé cumulé = 80 000', Number(s.amount_received) === 80000, String(s.amount_received));
}

{
  // Le dernier versement solde : 130 000 = 50 000 + 30 000 + 50 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 50000, 'momo', 'solde') AS v`);
  const p = r.rows[0].v;
  check('17v. dette soldée', Number(p.balance_after) === 0, String(p.balance_after));
  check('17w. une vente soldée', Number(p.sales_settled) === 1, String(p.sales_settled));

  const s = (await q(`SELECT amount_received, total_amount, settled FROM sales
                       WHERE client_phone='22994000001'`)).rows[0];
  check('17x. encaissé = prix total', Number(s.amount_received) === 130000, String(s.amount_received));
  check('17y. marquée soldée', s.settled === true);

  // Le CA complet n'apparaît qu'ici, une fois l'argent rentré.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article acompte');
  check('17z. CA complet après encaissement', Number(prof.revenue) === 130000, `obtenu ${prof.revenue}`);
  check('17aa. plus de crédit en cours', Number(prof.unsettled_credit) === 0,
    `obtenu ${prof.unsettled_credit}`);

  // Et la fiche disparaît de l'écran Dettes.
  const dettes = (await q(`SELECT * FROM get_customer_debts() WHERE phone='22994000001'`)).rows;
  check('17ab. dette soldée : plus de débiteur listé', dettes.length === 0, `${dettes.length}`);
}

{
  // Un acompte supérieur au prix, ou négatif : refusé. Un trop-perçu est un
  // autre geste, il se fait sur l'écran Dettes.
  let msg = '';
  try { await acompter(1, '+229 94 00 00 09', 999999); } catch (e) { msg = e.message; }
  check('17ac. acompte supérieur au prix : refusé', /dépasse le prix/.test(msg), msg || 'accepté !');

  msg = '';
  try { await acompter(1, '+229 94 00 00 09', -500); } catch (e) { msg = e.message; }
  check('17ad. acompte négatif : refusé', /n\\'a pas être négative/.test(msg) || /negative|négative/.test(msg),
    msg || 'accepté !');
}

{
  // Un acompte de la totalité : c'est une vente cash qui a traîné. Elle doit
  // être marquée soldée, sinon le client apparaît dans l'écran Dettes avec 0 F
  // dû — un client fantôme.
  const v = await acompter(1, '+229 94 00 00 10', 10000);
  const s = (await q(`SELECT settled, amount_received FROM sales WHERE id='${v.id}'`)).rows[0];
  check('17ae. acompte intégral = vente soldée', s.settled === true, `settled = ${s.settled}`);
  check('17af. encaissé = 10 000', Number(s.amount_received) === 10000, String(s.amount_received));

  const dettes = (await q(`SELECT * FROM get_customer_debts() WHERE phone='22994000010'`)).rows;
  check('17ag. pas de client listé pour une dette nulle', dettes.length === 0, `${dettes.length}`);
}

{
  // Répartition FIFO avec acompte : la dette la plus ancienne est soldée
  // d'abord, même si une vente plus récente a reçu un acompte.
  await acompter(1, '+229 94 00 00 20', 0);   // 10 000 dus, plus ancien
  await acompter(1, '+229 94 00 00 20', 0);   // 10 000 dus, plus récent
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000020'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 15000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17ah. FIFO : la plus ancienne vente est soldée', Number(p.sales_settled) === 1,
    String(p.sales_settled));
  check('17ai. reste dû = 5 000', Number(p.balance_after) === 5000, String(p.balance_after));

  const ventes = (await q(`SELECT total_amount, amount_received, settled FROM sales
                            WHERE client_phone='22994000020' ORDER BY created_at ASC`)).rows;
  check('17aj. 1re vente : encaissée et soldée',
    Number(ventes[0].amount_received) === 10000 && ventes[0].settled === true,
    `${ventes[0].amount_received} / ${ventes[0].settled}`);
  check('17ak. 2e vente : 5 000 encaissés, encore ouverte',
    Number(ventes[1].amount_received) === 5000 && ventes[1].settled === false,
    `${ventes[1].amount_received} / ${ventes[1].settled}`);
}

{
  // Le trop-perçu ne devient pas du chiffre d'affaires. C'est de l'argent
  // avancé par le client, pas une vente.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000020'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 20000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17al. trop-perçu : dette soldée', Number(p.balance_after) === 0, String(p.balance_after));
  check('17am. trop-perçu : montant enregistré en totalité', Number(p.amount_paid) === 20000,
    String(p.amount_paid));

  const ventes = (await q(`SELECT SUM(amount_received) AS s FROM sales
                            WHERE client_phone='22994000020'`)).rows[0];
  check('17an. rien au-delà du prix réellement vendu', Number(ventes.s) === 20000,
    `encaissé ${ventes.s}, vendu 20 000`);
}

{
  // Une vente espèces porte bien son prix : c'est ce qui garantit que la caisse
  // et le chiffre d'affaires concordent pour l'essentiel des ventes.
  const r = await q(`SELECT create_sale(
    '[{"product_id":"${ART_A}","quantity":2}]'::jsonb,'cash',null,null) AS v`);
  const b = r.rows[0].v;
  const o = typeof b === 'string' ? JSON.parse(b) : b;
  const s = (await q(`SELECT amount_received, total_amount FROM sales WHERE id='${o.id}'`)).rows[0];
  check('17ao. vente espèces : encaissé = prix', Number(s.amount_received) === Number(s.total_amount),
    `${s.amount_received} / ${s.total_amount}`);
}

{
  // La contrainte d'intégrité : on ne peut pas encaisser plus que le prix.
  const v = await acompter(1, '+229 94 00 00 30', 0);
  let refuse = false;
  try {
    await q(`UPDATE sales SET amount_received = total_amount + 1 WHERE id = '${v.id}'`);
  } catch { refuse = true; }
  check('17ap. encaisser plus que le prix : refusé par la contrainte', refuse);
}
// ═══ 18. Programme bêta ═══════════════════════════════════
// Dix comptes en accès complet, pour tester en conditions réelles. Le mécanisme
// est volontairement un budget de places et non un code : il n'y a rien à
// distribuer, donc rien à trouver, et le onzième compte s'inscrit normalement en
// gratuit.
console.log('\n▸ Programme bêta');

{
  // Le harnais a fermé le programme. On le rouvre avec un budget connu.
  await e(`UPDATE beta_program
              SET open = true, slots_total = 3, slots_used = 0, note = 'test'
            WHERE id = 1`);

  const st0 = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18a. programme ouvert, 3 places, 0 prise',
    st0.open === true && st0.slots_total === 3 && st0.slots_used === 0,
    JSON.stringify(st0));
  check('18b. places restantes = 3', Number(st0.remaining) === 3, String(st0.remaining));

  const inscrire = async (n) => {
    // 11 zéros + le chiffre : le dernier groupe d'un UUID fait 12 caractères.
    // Un de moins et PostgreSQL refuse l'identifiant — pour une raison qui n'a
    // rien à voir avec ce qu'on teste.
    const uid = `f1f1f1f1-0000-4000-8000-00000000000${n}`;
    await q(`INSERT INTO auth.users (id, email) VALUES ('${uid}', 'beta${n}@test.ci')`);
    await q(`INSERT INTO organizations (id, name, slug)
             VALUES ('${uid}', 'Boutique Beta ${n}', 'beta-${n}')`);
    // Un article, pour prouver que le compte hors plafond peut vendre. Une boutique
    // sans produit ne prouve rien sur la caisse.
    await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('a1a1a1a1-0000-4000-8000-00000000000${n}', '${uid}',
                     'Article beta', 4000, 10000, 20)`);
    const o = (await q(`SELECT plan FROM organizations WHERE id='${uid}'`)).rows[0];
    return { uid, plan: o.plan };
  };

  // 1. Le point central : une inscription ordinaire devient Pro, sans que
  //    l'application ait eu à le demander ni à le savoir.
  const b1 = await inscrire(1);
  check('18c. le 1er compte bêta passe en Pro', b1.plan === 'pro', b1.plan);

  const acc1 = (await q(`SELECT * FROM beta_access WHERE user_id='${b1.uid}'`)).rows[0];
  check('18d. il est enregistré dans beta_access', !!acc1, '(absent)');
  check('18e. son email est récupéré depuis auth.users', acc1?.email === 'beta1@test.ci',
    String(acc1?.email));

  const b2 = await inscrire(2);
  const b3 = await inscrire(3);
  check('18f. les 2e et 3e comptes passent en Pro', b2.plan === 'pro' && b3.plan === 'pro',
    `${b2.plan} / ${b3.plan}`);

  const st1 = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18g. 3 places sur 3 consommées',
    st1.slots_used === 3 && st1.remaining === 0,
    `utilisées ${st1.slots_used}, restantes ${st1.remaining}`);

  // 2. LE PLAFOND. Le 4e compte s'inscrit normalement, en gratuit. C'est la
  //    propriété qui rend le programme sûr : sans elle, le nombre « dix » ne
  //    serait qu'une intention.
  const b4 = await inscrire(4);
  check('18h. le 4e compte est en gratuit (plafond atteint)', b4.plan === 'free', b4.plan);
  const pasAcc = (await q(
    `SELECT count(*)::int c FROM beta_access WHERE user_id='${b4.uid}'`)).rows[0].c;
  check('18i. le 4e n\'est pas enregistré comme bêta', pasAcc === 0, `${pasAcc}`);

  // Le refus ne doit rien casser : la boutique existe et la caisse fonctionne.
  // Vérifié ici parce que le cas du compte juste après le plafond est le plus
  // fréquent — dix potes, puis un onzième qui tombe sur un écran verrouillé.
  await q(`SELECT set_config('request.jwt.claim.sub', '${b4.uid}', false)`);
  const v = await q(`SELECT create_sale(
    '[{"product_id":"a1a1a1a1-0000-4000-8000-000000000004","quantity":1}]'::jsonb,
    'cash', null, null) AS v`);
  check('18j. le compte hors plafond peut quand même vendre', !!v.rows[0].v,
    JSON.stringify(v.rows[0]).slice(0, 110));
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
}

{
  // 3. Fermer le programme : plus aucune attribution, même si le budget
  //    permettrait encore des places. C'est le geste qui rend le programme
  //    vraiment fermé.
  await e(`UPDATE beta_program SET open = false WHERE id = 1`);
  const uid = `f1f1f1f1-0000-4000-8000-000000000009`;
  await q(`INSERT INTO auth.users (id, email) VALUES ('${uid}', 'beta9@test.ci')`);
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ('${uid}', 'Boutique Fermee', 'beta-fermee')`);
  const o = (await q(`SELECT plan FROM organizations WHERE id='${uid}'`)).rows[0];
  check('18k. programme fermé : inscription en gratuit', o.plan === 'free', o.plan);
}

{
  // 4. Rouvrir avec un budget plus large, pour une deuxième vague.
  await e(`UPDATE beta_program SET open = true, slots_total = 10, slots_used = 0 WHERE id = 1`);
  const st = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18l. rouvrir avec 10 places', st.open === true && st.remaining === 10,
    JSON.stringify(st));
}

{
  // 5. Révoquer : tout le monde repasse en gratuit, et les retours sont
  //    conservés. C'est le geste de fermeture réelle.
  const msg = (await q(`SELECT revoke_all_beta() AS m`)).rows[0].m;
  check('18m. révocation : message rendu', typeof msg === 'string' && msg.includes('gratuit'), String(msg));

  const restants = (await q(
    `SELECT count(*)::int c FROM organizations o
       JOIN beta_access b ON b.user_id = o.id
      WHERE o.plan = 'pro'`)).rows[0].c;
  check('18n. plus aucune boutique bêta en Pro', restants === 0, `${restants}`);

  // Les commentaires de retour survivent à la révocation : c'est tout l'intérêt
  // de la table, sinon on jetterait le matériau du debriefing avec l'accès.
  // Trois fiches : les trois comptes qui ont eu une place. Celui créé après le
  // plafond, et celui créé programme fermé, n'en ont pas — c'est le but.
  const notes = (await q(`SELECT count(*)::int c FROM beta_access`)).rows[0].c;
  check('18o. les fiches bêta sont conservées', notes === 3, `${notes}`);

  const st = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18p. compteur remis à zéro, programme fermé',
    st.slots_used === 0 && st.open === false, JSON.stringify(st));
}

{
  // 6. Un testeur ne doit pas pouvoir élargir son propre accès. Les tables sont
  //    sans policy et en FORCE ROW LEVEL SECURITY ; seul le trigger, en SECURITY
  //    DEFINER, écrit dedans.
  const policies = (await q(
    `SELECT count(*)::int c FROM pg_policies
      WHERE tablename IN ('beta_program', 'beta_access')`)).rows[0].c;
  check('18q. aucune policy RLS sur les tables bêta', policies === 0, `${policies} policy(s)`);

  const forcee = (await q(
    `SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relname IN ('beta_program', 'beta_access') ORDER BY relname`)).rows;
  check('18r. RLS forcé sur les deux tables',
    forcee.length === 2 && forcee.every((x) => x.relforcerowsecurity === true),
    JSON.stringify(forcee));

  // Un client authentifié ne doit pas pouvoir élargir son propre accès. On vérifie
  // sous le rôle réel, sinon la RLS serait contournée par superuser.
  //
  // ⚠ Un UPDATE refusé par la RLS ne lève PAS d'erreur : la ligne est simplement
  //   filtrée, donc « UPDATE ... WHERE id = 1 » ne modifie aucune ligne et
  //   renvoie un compte de 0. Attendre une exception ferait échouer le test sur
  //   la mauvaise raison et donnerait une fausse impression de sécurité : c'est
  //   le compte de lignes qui prouve le blocage, pas l'absence d'erreur.
  await e(`GRANT EXECUTE ON FUNCTION beta_status() TO authenticated`);
  await e('SET ROLE authenticated');
  let vu = null;
  try {
    vu = (await q(`SELECT * FROM beta_status()`)).rows[0];
  } catch (err) { vu = { erreur: err.message }; }

  let modifiees = -1;
  try {
    const r = await q(`UPDATE beta_program SET slots_total = 9999 WHERE id = 1`);
    modifiees = r.affectedRows ?? r.rows?.length ?? -1;
  } catch { modifiees = -2; }
  await e('RESET ROLE');

  check('18s. un client peut lire l\'état du programme (utile, inoffensif)',
    !!vu && !('erreur' in (vu ?? {})), JSON.stringify(vu)?.slice(0, 80));
  check('18t. un client NE PEUT PAS ajouter de places (RLS : 0 ligne touchée)',
    modifiees === 0, `lignes modifiées = ${modifiees}`);

  // Et la valeur n'a pas bougé, une fois revenu au rôle normal.
  const cap = (await q(`SELECT slots_total FROM beta_program WHERE id = 1`)).rows[0].slots_total;
  check('18u. le budget est intact', Number(cap) === 10, `${cap}`);
}

// Le harnais referme derrière lui : la section bêta est la seule qui ouvre le
// programme, et un test qui suivrait ne doit pas hériter de l'état.
await e(`UPDATE beta_program SET open = false WHERE id = 1`);

// ─── 19. Durcissement sécurité ──────────────────────────────
//
// Le harnais a fait GRANT ALL sur toutes les tables (section 4) pour pouvoir
// tester la RLS. C'est exactement l'état d'une base Supabase vierge : les
// privilèges par défaut sont posés à la création des tables, et
// migration_security.sql ne les restreint qu'ensuite. On rejoue donc la
// migration dans cet état — c'est l'ordre réel du déploiement, et c'est le seul
// moyen d'y tester les privilèges : une assertion posée avant le GRANT ALL
// passerait pour la mauvaise raison.
console.log('\n▸ Durcissement sécurité');

const readSql = (f) =>
  fs.readFileSync(path.join(SQL_DIR, f), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, '');

try {
  await db.exec(readSql('migration_security.sql'));
  console.log('  ✓ 19a. migration_security.sql se rejoue après les grants par défaut');
} catch (err) {
  failed++;
  console.log(`  ✗ 19a. rejouage — ${err.message}`);
}

const SEC_PATRON = '66666666-6666-4666-8666-666666666666';
const SEC_AUTRE = '77777777-7777-4777-8777-777777777777';
const SEC_SANS_ORG = '42424242-4242-4242-4242-424242424242';

await q(`INSERT INTO auth.users (id, email)
  VALUES ('${SEC_PATRON}', 'sec1@t.ci'), ('${SEC_AUTRE}', 'sec2@t.ci'),
         ('${SEC_SANS_ORG}', 'sec3@t.ci')
  ON CONFLICT DO NOTHING`);
await q(`INSERT INTO organizations (id, name, slug)
  VALUES ('${SEC_PATRON}', 'Securite', 'securite-19') ON CONFLICT DO NOTHING`);
// Le programme bêta est refermé ci-dessus : la boutique naît en gratuit.
const planInitial = (await q(`SELECT plan FROM organizations WHERE id='${SEC_PATRON}'`)).rows[0].plan;
check('19b. la boutique de test démarre en gratuit', planInitial === 'free', planInitial);

// 1. rate_limits : la faille la plus simple du projet.
//    D'abord prouver que la table n'est PAS vide : sans ça, « invisible » et
//    « aucun compteur » se confondraient et le test passerait pour la bonne
//    raison par accident.
await e(`INSERT INTO rate_limits (key, count, reset_at)
         VALUES ('securite:19', 1, now() + interval '1 hour')
         ON CONFLICT (key) DO NOTHING`);
const nbCompteurs = (await q(`SELECT count(*)::int c FROM rate_limits`)).rows[0].c;
check('19c. la table rate_limits contient des compteurs', nbCompteurs >= 1, `${nbCompteurs}`);
await canRead('19d. rate_limits est invisible pour un client',
  `SELECT count(*) FROM rate_limits`, false, SEC_PATRON);
await canWrite('19e. rate_limits ne peut pas être vidée depuis le navigateur',
  `DELETE FROM rate_limits`, false, SEC_PATRON);

// 2. organizations.plan : la faille qui rendait Stripe facultatif.
await canWrite('19f. un client ne peut pas passer sa boutique en pro',
  `UPDATE organizations SET plan = 'pro' WHERE id = '${SEC_PATRON}'`, false, SEC_PATRON);
const planApres = (await q(`SELECT plan FROM organizations WHERE id='${SEC_PATRON}'`)).rows[0].plan;
check('19g. le plan est resté gratuit', planApres === 'free', planApres);

// Le verrou ne doit porter que sur plan : le reste de la fiche reste à jour.
await canWrite('19h. le patron peut toujours renommer sa boutique',
  `UPDATE organizations SET name = 'Securite 19' WHERE id = '${SEC_PATRON}'`, true, SEC_PATRON);
await canWrite('19i. mais pas toucher au numéro de facture',
  `UPDATE organizations SET invoice_counter = 999 WHERE id = '${SEC_PATRON}'`, false, SEC_PATRON);
await canWrite('19j. un client ne peut pas CITER la colonne plan',
  `INSERT INTO organizations (id, name, slug, plan)
     VALUES ('${SEC_AUTRE}', 'Pirate', 'pirate-19', 'pro')`, false, SEC_AUTRE);
await canWrite('19k. il peut en revanche créer sa boutique en gratuit',
  `INSERT INTO organizations (id, name, slug)
     VALUES ('${SEC_AUTRE}', 'Sa boutique', 'sa-boutique-19')`, true, SEC_AUTRE);

// Le service role, lui, doit continuer : c'est le webhook Stripe.
await e(`GRANT USAGE ON SCHEMA public TO service_role;
         GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
         GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
await q(`SELECT set_config('request.jwt.claim.sub', '${SEC_PATRON}', false)`);
await e('SET ROLE service_role');
let svcAffected = -1;
let svcErr = '';
try {
  const r = await q(`UPDATE organizations SET plan = 'starter' WHERE id = '${SEC_PATRON}'`);
  svcAffected = r.affectedRows ?? 0;
} catch (ex) { svcErr = ex.message; }
await e('RESET ROLE');
check('19l. le service role (webhook Stripe) peut toujours changer le plan',
  svcAffected > 0, svcErr || `${svcAffected} ligne(s)`);
await q(`UPDATE organizations SET plan = 'free' WHERE id = '${SEC_PATRON}'`);

// 3. subscriptions : l'upsert du webhook, qui échouait en silence.
const ux = (await q(
  `SELECT count(*)::int c FROM pg_indexes
    WHERE tablename = 'subscriptions' AND indexname = 'ux_subscriptions_org'`
)).rows[0].c;
check('19m. index unique sur subscriptions(org_id)', ux === 1, `${ux}`);

let upsertMsg = '';
try {
  await q(`INSERT INTO subscriptions (org_id, plan, status)
             VALUES ('${SEC_PATRON}', 'free', 'active')
           ON CONFLICT (org_id) DO UPDATE
             SET plan = 'pro', status = 'active', updated_at = now()`);
} catch (ex) { upsertMsg = ex.message; }
check('19n. l\'upsert du webhook (ON CONFLICT org_id) fonctionne enfin',
  upsertMsg === '', upsertMsg || 'refusé');
const nbAb = (await q(
  `SELECT count(*)::int c FROM subscriptions WHERE org_id = '${SEC_PATRON}'`
)).rows[0].c;
check('19o. une seule ligne par boutique', nbAb === 1, `${nbAb}`);

// 4. business_members : le rattachement arbitraire.
await canWrite('19p. un client ne peut pas rattacher un compte à son équipe',
  `INSERT INTO business_members (owner_id, member_id, member_name)
     VALUES ('${SEC_PATRON}', '${SEC_SANS_ORG}', 'Forcé')`, false, SEC_PATRON);

// Isolé du RLS, en superuser : ici seul le déclencheur peut refuser.
let gardeMsg = '';
try {
  await q(`INSERT INTO business_members (owner_id, member_id, member_name)
             VALUES ('${SEC_PATRON}', '${SEC_AUTRE}', 'Patron détourne')`);
} catch (ex) { gardeMsg = ex.message; }
check('19q. rattacher un compte qui possède déjà sa boutique est refusé',
  /possède déjà sa propre boutique/.test(gardeMsg), gardeMsg || 'insertion acceptée');

// Et la garde ne doit pas tout bloquer : un compte sans boutique reste
// rattachable, sinon plus aucune invitation ne passerait.
let normalMsg = '';
try {
  await q(`INSERT INTO business_members (owner_id, member_id, member_name)
             VALUES ('${SEC_PATRON}', '${SEC_SANS_ORG}', 'Caissière')`);
} catch (ex) { normalMsg = ex.message; }
check('19r. un compte sans boutique est toujours rattachable',
  normalMsg === '', normalMsg);

// Le SELECT du patron survit à la suppression de la policy FOR ALL : sans lui,
// l'équipe devient illisible pour celui qui la dirige.
await canRead('19s. le patron lit toujours son équipe',
  `SELECT count(*) FROM business_members WHERE owner_id = '${SEC_PATRON}'`, true, SEC_PATRON);
await canRead('19t. mais pas celle d\'un autre',
  `SELECT count(*) FROM business_members WHERE owner_id = '${PATRON}'`, false, SEC_AUTRE);

// 5. sales / sale_items / stock_logs : créées SANS clause FOR, donc pour les
//    quatre commandes. Leur prédicat `user_id = get_business_owner_id()`
//    renvoie le PATRON pour un employé — celui-ci passait donc dans le USING
//    comme dans le WITH CHECK, et pouvait UPDATE/DELETE les ventes de la
//    boutique depuis le navigateur, avec la seule clé anon.
// On cherche explicitement une vente POURVUE de lignes : un insert direct
// dans `sales` (fixtures de certains tests) n'en crée pas.
const lignePatron = (await q(
  `SELECT si.id FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
    WHERE s.user_id = '${PATRON}' LIMIT 1`)).rows[0]?.id;
const ventePatron = lignePatron
  ? (await q(`SELECT sale_id FROM sale_items WHERE id = '${lignePatron}'`)).rows[0]?.sale_id
  : undefined;
const journalPatron = (await q(
  `SELECT id FROM stock_logs WHERE user_id = '${PATRON}' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
const estMembre = (await q(
  `SELECT count(*)::int c FROM business_members
    WHERE owner_id = '${PATRON}' AND member_id = '${EMPLOYE}'`)).rows[0].c;

check('19u. fixtures : vente, ligne et mouvement de stock du patron',
  !!ventePatron && !!lignePatron && !!journalPatron,
  `vente=${!!ventePatron} ligne=${!!lignePatron} journal=${!!journalPatron}`);
check('19v. fixture : l\'employé est bien dans l\'équipe du patron',
  estMembre >= 1, `${estMembre}`);

if (ventePatron && lignePatron && journalPatron && estMembre >= 1) {
  await canWrite('19w. un employé ne peut pas modifier une vente',
    `UPDATE sales SET total_amount = 1 WHERE id = '${ventePatron}'`, false, EMPLOYE);
  await canWrite('19x. ni la supprimer',
    `DELETE FROM sales WHERE id = '${ventePatron}'`, false, EMPLOYE);
  await canRead('19y. mais il lit toujours les ventes',
    `SELECT count(*) FROM sales WHERE id = '${ventePatron}'`, true, EMPLOYE);
  await canRead('19z. et leurs lignes',
    `SELECT count(*) FROM sale_items WHERE id = '${lignePatron}'`, true, EMPLOYE);
  await canWrite('19aa. il ne peut pas modifier une ligne de vente',
    `UPDATE sale_items SET quantity = 99 WHERE id = '${lignePatron}'`, false, EMPLOYE);
  await canWrite('19bb. ni le journal des stocks',
    `UPDATE stock_logs SET quantity_change = 0 WHERE id = '${journalPatron}'`, false, EMPLOYE);
  await canWrite('19cc. ni le supprimer — le journal est inaltérable',
    `DELETE FROM stock_logs WHERE id = '${journalPatron}'`, false, EMPLOYE);
  await canWrite('19dd. ni y insérer un mouvement (can_manage_products() faux)',
    `INSERT INTO stock_logs (user_id, product_id, product_name, movement_type, quantity_change, stock_before, stock_after)
       VALUES ('${PATRON}', '${P1}', 'Mouvement indu', 'adjustment', 99, 0, 99)`, false, EMPLOYE);

  // Le patron, lui, continue : c'est par ce INSERT que passent le
  // réapprovisionnement et l'inventaire.
  await canWrite('19ee. le patron insère bien un mouvement de stock',
    `INSERT INTO stock_logs (user_id, product_id, product_name, movement_type, quantity_change, stock_before, stock_after)
       VALUES ('${PATRON}', '${P1}', 'Réappro test', 'restock', 5, 10, 15)`, true, PATRON);
}

// ─── 20. Suppression de compte ────────────────────────────────
// Deux pannes de bout en bout relevées dans les logs Auth, qui nommaient les
// causes au mot près :
//   • « converting NULL to string is unsupported » → l'API refusait de lire
//     tout compte dont les colonnes jeton étaient NULL (créé par insertion
//     manuelle) : liste, fiche et suppression devenaient impossibles ;
//   • « delete on table "products" violates foreign key constraint
//     "sale_items_product_id_fkey" » → la cascade partait de products avant
//     sales, donc avant que sale_items ait disparu.
console.log('\n▸ Suppression de compte');

const SUP_JETABLE = '88888888-8888-4888-8888-888888888821';
await q(`INSERT INTO auth.users (id, email, confirmation_token, recovery_token,
         email_change_token_new, email_change)
         VALUES ('${SUP_JETABLE}', 'jetable20@t.ci', NULL, NULL, NULL, NULL)
         ON CONFLICT DO NOTHING`);
const nullAvant = (await q(`SELECT count(*)::int c FROM auth.users
  WHERE id = '${SUP_JETABLE}' AND confirmation_token IS NULL AND recovery_token IS NULL
    AND email_change_token_new IS NULL AND email_change IS NULL`)).rows[0].c;
check('20a. le compte jetable part avec des jetons NULL', nullAvant === 1, `${nullAvant}`);

try {
  await db.exec(readSql('migration_security.sql'));
  const nullApres = (await q(`SELECT count(*)::int c FROM auth.users
    WHERE confirmation_token IS NULL OR recovery_token IS NULL
       OR email_change_token_new IS NULL OR email_change IS NULL`)).rows[0].c;
  check('20b. la section 6 remplit les jetons NULL de auth.users', nullApres === 0, `${nullApres} reste(nt)`);
} catch (err) {
  failures++;
  console.log(`  ✗ 20b. rejouage — ${err.message}`);
}

for (const [libelle, table, nom] of [
  ['20c. sale_items → products vérifie à la fin de la transaction', 'sale_items', 'sale_items_product_id_fkey'],
  ['20d. stock_logs → products vérifie à la fin de la transaction', 'stock_logs', 'stock_logs_product_id_fkey'],
]) {
  const fk = (await q(`SELECT condeferrable d, condeferred f FROM pg_constraint
    WHERE conname = '${nom}' AND conrelid = '${table}'::regclass`)).rows[0];
  check(libelle, fk?.d === true && fk?.f === true, JSON.stringify(fk));
}

// La cascade de bout en bout : le cas exact qui renvoyait 23503. Avant la
// section 6, ce DELETE échouait parce que products partait alors que la ligne
// de vente le référençait encore.
const SUP_U = '88888888-8888-4888-8888-888888888822';
const SUP_P = '88888888-8888-4888-8888-888888888823';
const SUP_V = '88888888-8888-4888-8888-888888888824';
await q(`INSERT INTO auth.users (id, email)
         VALUES ('${SUP_U}', 'cascade20@t.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id, user_id, name)
         VALUES ('${SUP_P}', '${SUP_U}', 'Produit jetable')`);
await q(`INSERT INTO sales (id, user_id, total_amount, payment_method)
         VALUES ('${SUP_V}', '${SUP_U}', 20, 'cash')`);
await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
         VALUES ('${SUP_V}', '${SUP_P}', 'Produit jetable', 1, 20, 20)`);
await q(`INSERT INTO stock_logs (user_id, product_id, product_name, movement_type,
                                 quantity_change, stock_before, stock_after)
         VALUES ('${SUP_U}', '${SUP_P}', 'Produit jetable', 'sale', -1, 5, 4)`);

let suppressionOk = true;
let motifSup = '';
try {
  await q(`DELETE FROM auth.users WHERE id = '${SUP_U}'`);
} catch (err) {
  suppressionOk = false;
  motifSup = err.message;
}
check('20e. la suppression d’un compte pourvu de ventes réussit', suppressionOk, motifSup);

const reste = (await q(`
  SELECT (SELECT count(*) FROM products   WHERE user_id  = '${SUP_U}')::int
       + (SELECT count(*) FROM sales      WHERE user_id  = '${SUP_U}')::int
       + (SELECT count(*) FROM sale_items WHERE product_id = '${SUP_P}')::int
       + (SELECT count(*) FROM stock_logs WHERE product_id = '${SUP_P}')::int AS c`)).rows[0].c;
check('20f. la cascade a tout emporté', reste === 0, `${reste} ligne(s) restante(s)`);

// ─── 21. Synthèse des ventes ─────────────────────────────────
// Rapports et Historique additionnaient les ventes côté JavaScript : ils
// téléchargeaient sales + sale_items(*) sur toute la période. La fonction
// remplace ce calcul — elle doit rendre EXACTEMENT le même chiffre, sinon les
// totaux affichés bougent au déploiement sans que personne l'ait demandé.
console.log('\n▸ Synthèse des ventes');

// PGlite rend les colonnes `date` en objets Date JavaScript : interpolés dans
// une requête, ils deviennent « Mon Jun 15 2026 … » et PostgreSQL refuse.
// On force du texte, comme le fait déjà le reste du harnais (::date::text).
const SYN = (await q(`
  SELECT (min(created_at) AT TIME ZONE 'UTC')::date::text AS a,
         (max(created_at) AT TIME ZONE 'UTC')::date::text AS b
    FROM sales`)).rows[0];

const synthese = (await q(
  `SELECT day::text AS day, revenue, cash, momo, tx
     FROM get_sales_summary('${SYN.a}', '${SYN.b}', 'UTC')`)).rows;

// Référence en BASE DE CAISSE : amount_received, pas total_amount.
//
// Ce test disait autrefois « identique à l'ancien calcul client », et c'était
// vrai — mais l'ancien calcul comptait ce qui était FACTURÉ. Trois écrans
// affichaient alors trois chiffres pour la même journée (recette navigateur du
// 04/10/2026 : 42 300 F en Ventes, 34 300 F en Rentabilité). La référence est
// donc ce que l'application PROMET au commerçant : « une vente à crédit entre
// dans le chiffre d'affaires quand vous encaissez ».
//
// cash et momo incluent les règlements de dettes par leur moyen de paiement,
// sinon l'argent liquide reçu d'un client pour solder sa dette n'entrait dans
// aucun des deux — et les modes de paiement ne correspondaient pas au total
// affiché juste au-dessus.
const refSyn = (await q(`
  SELECT COALESCE(SUM(amount_received), 0) AS revenue,
         COALESCE(SUM(CASE WHEN payment_method = 'cash'
                           THEN amount_received ELSE 0 END), 0)
           + COALESCE((SELECT SUM(cp.amount) FROM credit_payments cp
                        WHERE cp.method = 'cash'
                          AND cp.sale_id IN (
                            SELECT id FROM sales
                             WHERE created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
                               AND created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')
                          )), 0) AS cash,
         COALESCE(SUM(CASE WHEN payment_method = 'momo'
                           THEN amount_received ELSE 0 END), 0)
           + COALESCE((SELECT SUM(cp.amount) FROM credit_payments cp
                        WHERE cp.method = 'momo'
                          AND cp.sale_id IN (
                            SELECT id FROM sales
                             WHERE created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
                               AND created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')
                          )), 0) AS momo,
         COUNT(*) AS tx
    FROM sales
   WHERE created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
     AND created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')`)).rows[0];

const somme = (col) => synthese.reduce((t, r) => t + Number(r[col]), 0);

check('21a. chiffre d’affaires en base de caisse (amount_received)',
  somme('revenue') === Number(refSyn.revenue),
  `fonction ${somme('revenue')} / SQL ${refSyn.revenue}`);
check('21b. part espèces, règlements de dettes inclus',
  somme('cash') === Number(refSyn.cash),
  `fonction ${somme('cash')} / SQL ${refSyn.cash}`);
check('21c. part Mobile Money, règlements de dettes inclus',
  somme('momo') === Number(refSyn.momo),
  `fonction ${somme('momo')} / SQL ${refSyn.momo}`);
check('21d. nombre de transactions identique',
  somme('tx') === Number(refSyn.tx),
  `fonction ${somme('tx')} / SQL ${refSyn.tx}`);

// Le découpage par jour est le nerf du graphique : c'est lui qui place les
// barres. Il doit suivre le fuseau passé en paramètre, et lui seul.
const joursRef = (await q(`
  SELECT (created_at AT TIME ZONE 'UTC')::date::text AS d, COUNT(*) AS n
    FROM sales GROUP BY 1 ORDER BY 1`)).rows;
check('21e. une ligne par jour de vente, même découpage',
  JSON.stringify(synthese.map((r) => `${r.day}:${Number(r.tx)}`)) ===
  JSON.stringify(joursRef.map((r) => `${r.d}:${Number(r.n)}`)),
  `${synthese.length} jour(s)`);

// Top produits : même classement que l'ancien sort().slice(0, 6) du client.
const top = (await q(
  `SELECT * FROM get_top_products('${SYN.a}', '${SYN.b}', 'UTC', 6)`)).rows;
const topRef = (await q(`
  SELECT si.product_name, COALESCE(SUM(si.quantity), 0) AS qty
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE s.created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
     AND s.created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')
   GROUP BY si.product_name
   ORDER BY COALESCE(SUM(si.quantity), 0) DESC, si.product_name
   LIMIT 6`)).rows;
check('21f. top produits identique',
  JSON.stringify(top.map((r) => `${r.product_name}:${Number(r.qty)}`)) ===
  JSON.stringify(topRef.map((r) => `${r.product_name}:${Number(r.qty)}`)),
  `${top.length} ligne(s)`);

// Bornes de la limite : sans plafond, un appelant repartirait avec la table
// entière — on aurait déplasé le problème au lieu de le régler.
const borne = (await q(`SELECT count(*)::int c FROM get_top_products(
  '${SYN.a}', '${SYN.b}', 'UTC', 999999)`)).rows[0].c;
check('21g. la limite est plafonnée à 100', borne <= 100, `${borne} ligne(s)`);

// Ces fonctions n'additionnent que des lignes que l'appelant peut déjà
// SELECTer sous RLS, mais rien ne sert de les exposer à la clé anon.
const anon = (await q(`
  SELECT has_function_privilege('anon', 'get_sales_summary(date,date,text)', 'EXECUTE')       AS a,
         has_function_privilege('anon', 'get_top_products(date,date,text,int)', 'EXECUTE')    AS b`)).rows[0];
check('21h. la clé anon ne peut pas appeler ces fonctions',
  anon.a === false && anon.b === false, `anon=${anon.a}/${anon.b}`);

// ─── 22. La clé anon ne doit plus rien appeler ────────────────
// Constat qui a motivé la 7ᵉ section de migration_security.sql : Supabase
// accorde EXECUTE à anon, authenticated et service_role au moment de la
// CRÉATION de chaque fonction (ALTER DEFAULT PRIVILEGES). Le grant vient du
// rôle, pas de PUBLIC — donc tous les `REVOKE ... FROM PUBLIC` écrits dans les
// migrations ne lui retiraient rien, et la clé publique du navigateur appelait
// 33 des 35 fonctions, dont 20 en SECURITY DEFINER.
//
// Sans cette section, le harnais restait vert pendant que la base réelle
// laissait la porte ouverte : c'est exactement ce qui s'est passé.
console.log('\n▸ Exposition de la clé anon');

const anonFns = (await q(`
  SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
   ORDER BY 1`)).rows.map((r) => r.sig);

// Deux, et deux seulement : celles que les policies RLS appellent. Elles
// s'évaluent sous le rôle de l'appelant, donc les retirer ferait renvoyer
// « permission denied » au lieu de zéro ligne. Pour anon elles renvoient
// NULL / false — aucun accès concédé.
const anonAttendues = ['can_manage_products()', 'get_business_owner_id()'];
check('22a. anon ne garde que les deux helpers des policies RLS',
  JSON.stringify(anonFns) === JSON.stringify(anonAttendues),
  `${anonFns.length} fonction(s) : ${anonFns.join(', ')}`);

// Ce que le navigateur appelle réellement, relevé par grep sur `.rpc(`.
// close_table_order et send_order_items font partie du navigateur (Sprint 14) :
// les oublier ici les laisserait Granted à PERSONNE en production — la migration
// passe, les tests sont verts, et l'écran « encaisser » échoue en 404.
const duNavigateur = [
  'create_sale', 'record_credit_sale', 'archive_product', 'get_customer_debts',
  'pay_customer_debt', 'get_sales_summary', 'get_top_products', 'get_cash_flow',
  'get_product_profitability', 'get_units_sold_since', 'seed_expense_categories',
  'current_org_plan', 'close_table_order', 'send_order_items',
];
const privs = (await q(`
  SELECT DISTINCT p.proname
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN (${duNavigateur.map((f) => `'${f}'`).join(', ')})
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows
  .map((r) => r.proname).sort();
const attendues = [...duNavigateur].sort();
check('22b. authenticated appelle toujours les 14 fonctions du navigateur',
  JSON.stringify(privs) === JSON.stringify(attendues),
  `présentes : ${privs.join(', ')}`);

// Le vrai risque d'un REVOKE trop large : une policy RLS qui ne s'évalue plus.
// On passe en rôle anon, on vide les variables JWT laissées par les sections
// précédentes (sans quoi auth.uid() répond encore et le test ne prouve rien),
// puis on interroge les deux helpers et on vérifie qu'une fonction de garde
// est bien refusée.
let helperOwner, helperRole, gardeBloquee;
try {
  await e(`SET ROLE anon;
           SELECT set_config('request.jwt.claim.sub', '', false);
           SELECT set_config('request.jwt.role', 'anon', false);`);
  helperOwner = (await q(`SELECT get_business_owner_id() IS NULL AS v`)).rows[0].v;
  helperRole = (await q(`SELECT can_manage_products() AS v`)).rows[0].v;
  try {
    await q(`SELECT close_beta_program()`);
    gardeBloquee = false;
  } catch {
    gardeBloquee = true;
  }
} finally {
  await e(`RESET ROLE`);
}
check('22c. en rôle anon, get_business_owner_id() répond NULL (et non une erreur)',
  helperOwner === true, `valeur : ${helperOwner}`);
// `NULL = NULL` vaut NULL, et `NULL OR false` vaut NULL : la fonction répond
// NULL à anon, pas false. Ce qui compte n'est pas le type mais l'effet — il
// faudrait `true` pour ouvrir quoi que ce soit.
check('22d. en rôle anon, can_manage_products() n’accorde rien',
  helperRole !== true, `valeur : ${String(helperRole)}`);
check('22e. en rôle anon, close_beta_program() est refusée',
  gardeBloquee === true, gardeBloquee ? 'permission denied' : 'elle a répondu');

// Et le verrou doit tenir pour les créations futures : une fonction ajoutée
// par la PROCHAINE migration naît déjà fermée, sinon elle rouvrirait la porte
// d'elle-même — exactement ce qui s'est produit sept fois de suite.
await e(`CREATE FUNCTION tmp_porte_fermee() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
const aclFutur = (await q(`
  SELECT coalesce(proacl::text, '(ACL implicite = PUBLIC)') AS a
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'tmp_porte_fermee'`)).rows[0].a;
await e(`DROP FUNCTION tmp_porte_fermee()`);
check('22f. une fonction créée après le verrou naît déjà fermée',
  aclFutur !== '(ACL implicite = PUBLIC)' && !aclFutur.includes('anon'),
  `acl : ${aclFutur}`);

// Les deux helpers ne servent pas qu'aux policies : migration_credit_fns,
// migration_expenses, migration_plan_gate, migration_profitability et
// migration_suppliers les appellent depuis des fonctions SECURITY INVOKER,
// donc SOUS LE RÔLE DE L'APPELANT. Révoquer PUBLIC les couperait aussi pour
// authenticated — et le harnais tourne en postgres, il ne le verrait pas.
const authHelpers = (await q(`
  SELECT p.proname
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('get_business_owner_id', 'can_manage_products')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
   ORDER BY p.proname`)).rows.map((r) => r.proname);
check('22g. authenticated appelle toujours les deux helpers des policies',
  JSON.stringify(authHelpers) === JSON.stringify(['can_manage_products', 'get_business_owner_id']),
  `présentes : ${authHelpers.join(', ') || 'aucune'}`);

// ─── 23. Restaurant : salle et commande ouverte ──────────────
// Une commande n'est pas une vente : elle vit sur une table avant d'être
// soldée, et elle ne touche pas au chiffre d'affaires tant qu'elle n'est pas
// close. Ces contrôles verrouillent les trois invariants qui font le métier —
// une seule commande ouverte par table, l'isolation entre restaurants, et le
// fait qu'un caissier solde une addition sans que la vente quitte le patron.
console.log('\n▸ Restaurant — salle et commande ouverte');

// UUID.ne clashes avec le reste de la suite : les identifiants 13131313 et
// 14141414 sont déjà pris plus haut (section invitation). Un duplicate key
// ferait échouer la section entière sur un détail de fixture.
const RESTO = '23232323-2323-2323-2323-232323232323';
const SERVEUR = '25252525-2525-2525-2525-252525252525';

await q(`INSERT INTO auth.users (id, email) VALUES
  ('${RESTO}', 'resto@test.ci'), ('${SERVEUR}', 'serveur@test.ci')
  ON CONFLICT DO NOTHING`);
await q(`INSERT INTO organizations (id, name, slug, domain)
  VALUES ('${RESTO}', 'Maquis Test', 'maquis-test', 'restaurant')`);
await q(`INSERT INTO business_members (owner_id, member_id, member_name, role)
  VALUES ('${RESTO}', '${SERVEUR}', 'Serveur', 'employee')`);

const T1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const T2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const O2 = 'cccccccc-0000-0000-0000-000000000002';
await q(`INSERT INTO restaurant_tables (id, owner_id, name, zone, seats) VALUES
  ('${T1}', '${RESTO}', 'Table 1', 'Terrasse', 4),
  ('${T2}', '${RESTO}', 'Table 2', 'Terrasse', 2)`);

const O1 = 'cccccccc-0000-0000-0000-000000000001';
await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, customer_name, opened_by)
  VALUES ('${O1}', '${RESTO}', '${T1}', 'M. Kponou', '${PATRON}')`);

// 23a. L'index unique parcial : une seule commande ouverte par table.
{
  let refuse = false;
  try {
    await q(`INSERT INTO restaurant_orders (owner_id, table_id, opened_by)
      VALUES ('${RESTO}', '${T1}', '${PATRON}')`);
  } catch {
    refuse = true;
  }
  check('23a. une table déjà occupée refuse une seconde commande', refuse);
}
{
  // La contrainte est partielle : après clôture, la table se libère.
  await q(`UPDATE restaurant_orders SET status='closed', closed_at=now(), sale_id=NULL
    WHERE id='${O1}'`);
  let ok = true;
  try {
    await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, opened_by)
      VALUES ('${O2}', '${RESTO}', '${T1}', '${PATRON}')`);
  } catch {
    ok = false;
  }
  check('23b. une table libérée accepte une nouvelle commande', ok);
}

// 23c. Lignes de commande et total
// Le stock de P1 a déjà bougé dans les sections précédentes : on le relit
// juste avant, sinon ce contrôle comparerait une valeur au passage.
const stockAvantCommande = await stock(P1);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, note)
  VALUES ('${O2}', '${P1}', 2, 6000, 'bien cuit'), ('${O2}', '${P2}', 1, 4500, NULL)`);
{
  const total = Number((await q(`
    SELECT coalesce(sum(quantity * unit_price), 0) AS t
      FROM restaurant_order_items WHERE order_id='${O2}'`)).rows[0].t);
  check('23c. le total de la commande vaut 16 500', total === 16500, `obtenu ${total}`);

  // Le stock n'est PAS décrémenté : rien n'est vendu tant que la commande
  // n'est pas close. Un serveur qui prend 12 plats ne doit pas faire tomber le
  // stock sous zéro avant le service.
  const s1 = await stock(P1);
  check('23d. une commande ouverte ne décrémente pas le stock', s1 === stockAvantCommande,
    `stock ${s1}, attendu ${stockAvantCommande}`);
}

await q(`UPDATE restaurant_orders SET status='open' WHERE id='${O2}'`);

// 23e. Isolation entre deux restaurants : un tenant ne doit voir ni les
// commandes ni les lignes de commande de l'autre. Le contrôle se fait en RÔLE
// authenticated — lu en postgres, le superuser contourne les policies et le
// test passerait toujours, ce qui ne prouverait rien.
const A = '23636363-6363-6363-6363-636363636363';
const B = '24646464-6464-6464-6464-646464646464';
for (const u of [A, B]) {
  await q(`INSERT INTO auth.users (id, email) VALUES ('${u}', '${u}@test.ci') ON CONFLICT DO NOTHING`);
}
await q(`INSERT INTO organizations (id, name, slug, domain)
  VALUES ('${A}', 'Resto A', 'resto-a', 'restaurant'), ('${B}', 'Resto B', 'resto-b', 'restaurant')`);
const PA = 'abababab-0000-0000-0000-000000000001';
const PB = 'abababab-0000-0000-0000-000000000002';
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty, min_stock_level)
  VALUES ('${PA}', '${A}', 'Plat A', 1000, 2000, 50, 5), ('${PB}', '${B}', 'Plat B', 1000, 2000, 50, 5)`);
const OA = 'cdcdcdcd-0000-0000-0000-00000000000a';
const OB = 'cdcdcdcd-0000-0000-0000-00000000000b';
await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, opened_by)
  VALUES ('${OA}', '${A}', NULL, '${A}'), ('${OB}', '${B}', NULL, '${B}')`);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price) VALUES
  ('${OA}', '${PA}', 1, 2000), ('${OB}', '${PB}', 1, 2000)`);

{
  // Les produits sont rattachés au tenant : c'est ce qui rend le test
  // vérifiable par le RLS des produits, lui aussi deny-by-tenant.
  await q(`SELECT set_config('request.jwt.claim.sub', '${A}', false)`);
  await e('SET ROLE authenticated');
  const vus = Number((await q(`SELECT count(*)::int AS n FROM restaurant_order_items`)).rows[0].n);
  await e('RESET ROLE');
  check('23e. un restaurateur voit les lignes de SA commande', vus === 1, `${vus} ligne(s)`);
}
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${B}', false)`);
  await e('SET ROLE authenticated');
  const vus = Number((await q(`SELECT count(*)::int AS n FROM restaurant_order_items`)).rows[0].n);
  const cmd = Number((await q(`SELECT count(*)::int AS n FROM restaurant_orders`)).rows[0].n);
  await e('RESET ROLE');
  check('23f. un autre restaurant ne voit pas les lignes de commande', vus === 1, `${vus} ligne(s)`);
  check('23f2. un autre restaurant ne voit pas les commandes de l\'autre', cmd === 1, `${cmd} commande(s)`);
}
{
  // write-only : lire est refusé, mais écrire dans la commande d'autrui doit
  // l'être aussi — sinon un intrus viderait la commande d'un autre restaurant.
  await q(`SELECT set_config('request.jwt.claim.sub', '${B}', false)`);
  await e('SET ROLE authenticated');
  let refuse = false;
  try {
    await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
      VALUES ('${OA}', '${PB}', 1, 2000)`);
  } catch {
    refuse = true;
  }
  await e('RESET ROLE');
  check('23f3. on ne peut pas ajouter de ligne à la commande d\'un autre', refuse);
}
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// 23g. Un caissier sert une table comme tout le monde. Il peut aussi la solder
// (24j) : il ne peut pas ÉCRIRE la clôture lui-même, seulement appeler
// close_table_order() — c'est la fonction qui tient le contrôle de stock, la
// facture et l'écriture de la vente. Un UPDATE direct passerait à côté des trois.
await canWrite('23g. un caissier ajoute un plat à une commande',
  `INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
   VALUES ('${O2}', '${P1}', 1, 7000)`, true, SERVEUR);
{
  // 23g2. Le prix catalogue est FIGÉ sur la ligne (list_price) : une concession
  // (unit_price < list_price) devient traçable, comme au comptoir. Sans ce
  // figeage, un caissier pouvait insérer une ligne à 1 F sans laisser de trace.
  const li = (await q(`SELECT unit_price, list_price FROM restaurant_order_items
                        WHERE order_id='${O2}' AND product_id='${P1}' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const cat = Number((await q(`SELECT price_sell FROM products WHERE id='${P1}'`)).rows[0].price_sell);
  check('23g2. list_price = prix catalogue figé à l\'insertion',
    Number(li?.list_price) === cat, `list_price ${li?.list_price} vs catalogue ${cat}`);
}
{
  await canWrite('23h. un caissier ne clôture pas la commande à la main',
    `UPDATE restaurant_orders SET status='closed', closed_at=now() WHERE id='${O2}'`, false, SERVEUR);

  await canWrite('23i. un caissier ne réorganise pas la salle',
    `INSERT INTO restaurant_tables (owner_id, name) VALUES ('${RESTO}', 'Table 99')`, false, SERVEUR);

  // Le patron du restaurant est RESTO lui-même, pas PATRON : c'est lui le
  // propriétaire de la ligne. Un tiers, même patron de sa propre boutique,
  // n'a rien à faire sur cette commande.
  await canWrite('23j. le patron clôture sa commande',
    `UPDATE restaurant_orders SET status='closed', closed_at=now() WHERE id='${O2}'`, true, RESTO);
}

// 23j2. Une commande ne se supprime pas : elle s'annule ou se clôture. Une
// suppression laisserait une table « occupée » sans commande et effacerait le
// service du jour sans trace.
await canWrite('23j2. personne ne supprime une commande',
  `DELETE FROM restaurant_orders WHERE id='${O2}'`, false, RESTO);

// 23j3. Un patron d'AUTRE boutique ne clôture pas la commande d'un restaurant
// qui n'est pas le sien : l'isolation prime sur le rôle.
await canWrite('23j3. un patron étranger ne clôture pas la commande',
  `UPDATE restaurant_orders SET status='closed', closed_at=now() WHERE id='${O2}'`, false, PATRON);

// 23k. Une commande close n'accepte plus de ligne : le ticket est figé.
await canWrite('23k. une commande close refuse une ligne de plus',
  `INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
   VALUES ('${O2}', '${P1}', 1, 7000)`, false, PATRON);

// 23l. La vue de la salle reste en security_invoker : en DEFINER elle
// contournerait les RLS des trois tables et exposerait les autres restaurants.
{
  const def = (await q(`
    SELECT coalesce(c.reloptions::text, '') AS o
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'restaurant_floor'`)).rows[0].o;
  check('23l. restaurant_floor reste en security_invoker',
    def.includes('security_invoker=true'), `options : ${def || '(aucune)'}`);
}

// 23m. La vue montre la commande EN COURS et son montant. Elle est testée sur
// une commande neuve : O2 vient d'être close, la vue ne doit la voir que si
// elle n'est pas filtrée sur status — c'est exactement ce qu'on vérifie ici.
{
  const TM = 'bbbbbbbb-0000-0000-0000-000000000039';
  const OM = 'cccccccc-0000-0000-0000-000000000039';
  await q(`INSERT INTO restaurant_tables (id, owner_id, name) VALUES ('${TM}', '${RESTO}', 'Table 9')`);
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, opened_by)
    VALUES ('${OM}', '${RESTO}', '${TM}', '${PATRON}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${OM}', '${P1}', 3, 7000)`);

  const row = (await q(`SELECT order_id, status, order_total FROM restaurant_floor
    WHERE id='${TM}' AND owner_id='${RESTO}'`)).rows[0];
  check('23m. la vue expose la commande en cours et son montant',
    !!row && row.status === 'open' && Number(row.order_total) === 21000,
    `total ${row ? row.order_total : 'aucune ligne'}`);

  // Une table libre n'a pas de commande : la vue doit rester une ligne, pas
  // disparaître — le plan de salle montre TOUTES les tables.
  const libre = (await q(`SELECT count(*)::int AS n FROM restaurant_floor
    WHERE id='${T2}' AND owner_id='${RESTO}'`)).rows[0].n;
  check('23m2. une table libre reste visible, sans commande', libre === 1, `${libre} ligne(s)`);
}

// 23n. Quantité nulle ou négative refusée : une ligne sans quantité fausserait
// le total sans aucun signal.
let refNeg = false;
try {
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${O2}', '${P1}', 0, 7000)`);
} catch { refNeg = true; }
check('23n. une ligne de quantité nulle est refusée', refNeg);

// 23o. Une commande À EMPORTER : table_id NULL. Chez un maquis, c'est la moitié
// du chiffre d'affaires, et la policy d'insertion l'interdisait — le serveur
// devait inventer une table, ou faire encaisser au comptoir. Trouvé en recette
// navigateur, le 04/10/2026.
await canWrite('23o. un caissier peut ouvrir une commande à emporter',
  `INSERT INTO restaurant_orders (owner_id, opened_by) VALUES ('${RESTO}', '${SERVEUR}')`, true, SERVEUR);

// 23o2. Plusieurs à emporter simultanées : l'index unique ne porte que sur
// table_id, qui vaut NULL ici — un serveur peut en prendre trois.
for (const n of [1, 2]) {
  await q(`INSERT INTO restaurant_orders (owner_id, opened_by, customer_name)
    VALUES ('${RESTO}', '${SERVEUR}', 'Emport ${n}')`);
}
check('23o2. plusieurs commandes à emporter coexistent',
  (await count(`SELECT count(*) FROM restaurant_orders
     WHERE owner_id='${RESTO}' AND table_id IS NULL AND status='open'`)) === 3);

// 23o3. Une commande sans plat ne peut pas être encaissée, à emporter ou non.
{
  const OV = 'cccccccc-0000-0000-0000-0000000000c9';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${OV}', '${RESTO}', '${SERVEUR}')`);
  let refuse = false;
  try { await q(`SELECT close_table_order('${OV}', 'cash')`); } catch { refuse = true; }
  check('23o3. une commande à emporter vide est refusée à la clôture', refuse);
}

// ─── 24. Restaurant : clôture d'addition ────────────────────
// Le lien qui manquait : une table servie doit entrer dans le chiffre
// d'affaires, exactement comme un encaissement au comptoir, et une seule fois.
console.log('\n▸ Restaurant — clôture d\'addition');

const PS = 'bbbbbbbb-0000-0000-0000-0000000000a1';
const PS2 = 'bbbbbbbb-0000-0000-0000-0000000000a2';
await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}', 'patron2@test.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty, min_stock_level)
  VALUES ('${PS}', '${RESTO}', 'Poulet braisé', 2000, 4500, 20, 5),
         ('${PS2}', '${RESTO}', 'Riz parfumé', 400, 1200, 40, 5)`);

const OS = 'cccccccc-0000-0000-0000-0000000000a1';
await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, customer_name, opened_by)
  VALUES ('${OS}', '${RESTO}', '${T1}', 'M. Kponou', '${RESTO}')`);
// Deux plats différents, dont un à prix négocié : la remise se voit sur la ligne
// correspondante et nowhere ailleurs.
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, note)
  VALUES ('${OS}', '${PS}', 2, 4000, 'bien cuit'), ('${OS}', '${PS2}', 1, 1200, NULL)`);

const ventesAvant = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
const stockAvantCloture = await stock(PS);

// 24a. La clôture écrit UNE vente de 9 200 (2 × 4 000 + 1 200), prix convenu
// compris : c'est le cœur du lien salle → comptabilité.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  const r = await q(`SELECT close_table_order('${OS}', 'cash', NULL, 1)`);
  const res = r.rows[0].close_table_order;
  check('24a. la clôture écrit une vente au total convenu',
    Number(res.total_amount) === 9200, `total ${res.total_amount}`);
  check('24b. la commande est rattachée à la vente', !!res.sale_id, res.sale_id ?? 'aucun');

  const ventesApres = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('24c. exactement une vente de plus', ventesApres === ventesAvant + 1,
    `${ventesAvant} -> ${ventesApres}`);
}

// 24d. Le stock ne bouge qu'à la clôture, jamais avant.
{
  const apres = await stock(PS);
  check('24d. le stock est décrémenté à la clôture', apres === stockAvantCloture - 2,
    `stock ${apres}, attendu ${stockAvantCloture - 2}`);
}

// 24e. Le prix convenu est conservé dans la ligne de vente, et le catalogue
// n'a pas bougé : c'est la garantie qu'une remise est traçable.
{
  const ligne = (await q(`SELECT unit_price, list_price FROM sale_items
    WHERE sale_id = (SELECT sale_id FROM restaurant_orders WHERE id='${OS}')
      AND product_id = '${PS}'`)).rows[0];
  check('24e. le prix convenu est enregistré (remise traçable)',
    Number(ligne.unit_price) === 4000 && Number(ligne.list_price) === 4500,
    `facturé ${ligne.unit_price}, catalogue ${ligne.list_price}`);
}

// 24f. Double clôture refusée : le total de la table ne peut pas être encaissé
// deux fois. C'est l'erreur la plus coûteuse du nouveau module.
{
  let refuse = false;
  try {
    await q(`SELECT close_table_order('${OS}', 'cash')`);
  } catch {
    refuse = true;
  }
  check('24f. une addition déjà soldée ne peut pas être encaissée deux fois', refuse);
  const ventes = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('24f2. et aucune seconde vente n\'a été écrite', ventes === ventesAvant + 1, `${ventes} vente(s)`);
}

// 24g. Le fractionnement ne multiplie PAS les ventes.
{
  const OF = 'cccccccc-0000-0000-0000-0000000000a2';
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, opened_by)
    VALUES ('${OF}', '${RESTO}', '${T2}', '${RESTO}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${OF}', '${PS}', 3, 4500)`);

  const avant = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  const res = (await q(`SELECT close_table_order('${OF}', 'cash', NULL, 4)`)).rows[0].close_table_order;
  const apres = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('24g. une addition partagée reste UNE vente', apres === avant + 1, `${apres} vente(s)`);
  check('24g2. la part de chacun est calculée', Number(res.per_share) === 3375,
    `part ${res.per_share}`);
  check('24g3. le total n\'est pas altéré par le fractionnement',
    Number(res.total_amount) === 13500, `total ${res.total_amount}`);
}

// 24h. Une commande vide ne peut pas être encaissée : le caissier ne solde pas
// une table où rien n'a été commandé.
{
  const OV = 'cccccccc-0000-0000-0000-0000000000a3';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${OV}', '${RESTO}', '${RESTO}')`);
  let refuse = false;
  try {
    await q(`SELECT close_table_order('${OV}', 'cash')`);
  } catch { refuse = true; }
  check('24h. une commande sans plat est refusée à la clôture', refuse);
}

// 24i. Le moyen de paiement est validé : 'bitcoin' ne solde pas une table.
const OP = 'cccccccc-0000-0000-0000-0000000000a4';
await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
  VALUES ('${OP}', '${RESTO}', '${RESTO}')`);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
  VALUES ('${OP}', '${PS}', 1, 4500)`);
{
  let refuse = false;
  try {
    await q(`SELECT close_table_order('${OP}', 'bitcoin')`);
  } catch { refuse = true; }
  check('24i. un moyen de paiement inconnu est refusé', refuse);
}

// 24j. Un caissier SOLDE une addition — et la vente reste celle du patron.
//
// Règle changée le 05/10/2026, décidée avec l'utilisateur. Elle était ici plus
// stricte que sur la caisse : create_sale() n'examine pas le rôle, un caissier
// encaisse au comptoir tous les jours, mais il ne pouvait pas clôturer une table
// dont il venait de servir les plats. Dans un maquis, le personnel est employé :
// il ramasse l'argent et ne pouvait pas l'écrire.
//
// Ce que le test verrouille, ce n'est pas l'interdiction — c'est que le geste ne
// déplace RIEN : la vente est écrite sur le patron, jamais sur le caissier.
{
  const avant = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  let refus = '';
  try {
    await q(`SELECT set_config('request.jwt.claim.sub', '${SERVEUR}', false)`);
    await e('SET ROLE authenticated');
    await q(`SELECT close_table_order('${OP}', 'cash')`);
  } catch (e2) {
    refus = e2.message;
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  }
  check('24j. un caissier solde une addition', refus === '', refus.slice(0, 90));

  const apres = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('24j2. et la vente reste inscrite sur le patron', apres === avant + 1,
    `${avant} -> ${apres} ventes`);

  const surServeur = await count(
    `SELECT count(*) FROM sales WHERE user_id='${SERVEUR}'`);
  check('24j3. aucune vente n\'est portée au nom du caissier', surServeur === 0,
    `${surServeur} vente(s) au caissier`);

  // Et le ticket est figé : la commande est close, on ne rajoute plus de plat.
  const statut = await count(
    `SELECT count(*) FROM restaurant_orders WHERE id='${OP}' AND status='closed'`);
  check('24j4. et la commande est close', statut === 1);
}

// 24j5. Ouvrir l'encaissement au caissier n'ouvre RIEN aux étrangers.
//
// C'est le test qui manque le plus depuis l'assouplissement de la garde : elle
// passe de « patron ou manager » à « membre de l'équipe ». Un patron d'une autre
// boutique n'est membre de rien, il doit donc rester dehors — c'est l'ISOLATION,
// pas le rôle, qui protège ici.
{
  const avant = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  let refus = '';
  try {
    await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
    await e('SET ROLE authenticated');
    await q(`SELECT close_table_order('${OP}', 'cash')`);
  } catch (e2) {
    refus = e2.message;
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  }
  const apres = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('24j5. un patron d\'une autre boutique ne solde pas l\'addition',
    refus !== '', refus.slice(0, 90) || 'accepté !');
  check('24j6. et aucune vente n\'est écrite pour ce compte', apres === avant,
    `${avant} -> ${apres} ventes`);
}

// 24k. Ticket de cuisine : sans prix, et security_invoker.
{
  const def = (await q(`
    SELECT coalesce(c.reloptions::text, '') AS o
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'restaurant_kitchen_ticket'`)).rows[0].o;
  check('24k. le ticket de cuisine reste en security_invoker',
    def.includes('security_invoker=true'), `options : ${def || '(aucune)'}`);

  const colonnes = (await q(`
    SELECT string_agg(column_name, ',' ORDER BY column_name) AS c
      FROM information_schema.columns
     WHERE table_name = 'restaurant_kitchen_ticket'`)).rows[0].c;
  check('24l. le ticket de cuisine ne contient aucun prix',
    !colonnes.includes('price') && !colonnes.includes('unit_price'), `colonnes : ${colonnes}`);

  // Une commande close disparaît du ticket : plus rien à cuisiner.
  const lignes = await count(`SELECT count(*) FROM restaurant_kitchen_ticket WHERE order_id='${OS}'`);
  check('24m. une commande soldée sort du ticket de cuisine', lignes === 0, `${lignes} ligne(s)`);
}

// 24p. Deux lignes du MÊME plat à des prix différents : les deux prix sont
// conservés. Le regroupement par produit seul gardait le moins cher — une table
// à 8 500 était encaissée 8 000, et le restaurant perdait 500 F à chaque fois
// qu'un client commandait le même plat deux fois avec deux options.
// Trouvé en recette navigateur le 04/10/2026.
{
  const OD = 'cccccccc-0000-0000-0000-0000000000a6';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${OD}', '${RESTO}', '${RESTO}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${OD}', '${PS}', 1, 4500), ('${OD}', '${PS}', 1, 4000)`);
  const res = (await q(`SELECT close_table_order('${OD}', 'cash')`)).rows[0].close_table_order;
  check('24p. deux prix pour un même plat sont tous les deux facturés',
    Number(res.total_amount) === 8500, `total ${res.total_amount}, attendu 8 500`);
}

// 24n. « C'est parti » : idempotent, et un plat déjà servi n'est pas ré-expédié.
{
  const ON2 = 'cccccccc-0000-0000-0000-0000000000a5';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${ON2}', '${RESTO}', '${RESTO}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${ON2}', '${PS}', 2, 4500)`);
  // Une seule ligne (quantité 2) : c'est le nombre de LIGNES qui passe, pas la
  // quantité — la cuisine reçoit deux plats, mais une seule ligne à envoyer.
  const premier = Number((await q(`SELECT send_order_items('${ON2}')`)).rows[0].send_order_items);
  const second = Number((await q(`SELECT send_order_items('${ON2}')`)).rows[0].send_order_items);
  check('24n. envoyer en cuisine passe les plats en « envoyé »', premier === 1, `${premier} ligne(s)`);
  check('24n2. envoyer deux fois ne renvoie rien de plus', second === 0, `${second} ligne(s)`);

  // Une commande close ne se ré-expédie pas : la cuisine a déjà fini.
  await q(`SELECT close_table_order('${ON2}', 'cash')`);
  let refuse = false;
  try {
    await q(`SELECT send_order_items('${ON2}')`);
  } catch { refuse = true; }
  check('24o. une commande soldée ne peut plus partir en cuisine', refuse);
}

// ─── 25. Restaurant : recettes et coût de matière ───────────
// Sans recette, la marge d'un plat est une fiction : le patron n'achète pas
// du « poulet braisé », il achète du poulet. Ces contrôles vérifient que le
// coût remonte l'arbre des recettes, que les ingrédients partent, et qu'une
// recette circulaire est refusée.
console.log('\n▸ Restaurant — recettes');

const RJ = 'dddddddd-0000-0000-0000-000000000001'; // poulet braisé
const RR = 'dddddddd-0000-0000-0000-000000000002'; // riz blanc
const RH = 'dddddddd-0000-0000-0000-000000000003'; // huile
const RJ2 = 'dddddddd-0000-0000-0000-000000000004'; // poulet sauté (contient RJ)

await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}', 'patron3@test.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty, min_stock_level) VALUES
  ('${RJ}', '${RESTO}', 'Poulet braisé', 2000, 4500, 100, 5),
  ('${RR}', '${RESTO}', 'Riz blanc',    400, 1200,  50, 5),
  ('${RH}', '${RESTO}', 'Huile 1L',     900, 1000,  20, 5),
  ('${RJ2}', '${RESTO}', 'Poulet sauté', 3000, 6000,  80, 5)`);

await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);

// 25a. Sans recette, le coût est le prix d'achat.
check('25a. un produit sans recette coûte son prix d\'achat',
  Number((await q(`SELECT product_cost('${RR}')`)).rows[0].product_cost) === 400);

// 25b. Avec recette, le coût est la somme des ingrédients.
await q(`SELECT add_recipe_ingredient('${RJ}', '${RR}', 0.3)`);
await q(`SELECT add_recipe_ingredient('${RJ}', '${RH}', 0.05)`);
{
  // 300 g × 400 + 0,05 L × 900 = 120 + 45 = 165
  const c = Number((await q(`SELECT product_cost('${RJ}')`)).rows[0].product_cost);
  check('25b. le coût d\'une recette est la somme de ses ingrédients', c === 165, `coût ${c}`);
}

// 25c. La récursion : un plat peut contenir un autre plat. « Poulet sauté »
// vaut son ingrédient — donc le coût du « poulet braisé », lui-même valued
// 165 F. Le prix d'achat du plat (3 000) n'intervient plus : dès qu'une recette
// existe, c'est elle qui fait le coût.
await q(`SELECT add_recipe_ingredient('${RJ2}', '${RJ}', 1)`);
{
  const c = Number((await q(`SELECT product_cost('${RJ2}')`)).rows[0].product_cost);
  check('25c. un plat peut contenir un autre plat (récursif)', c === 165, `coût ${c}`);
}

// 25d. Le cycle indirect est refusé : RJ2 contient RJ, donc RJ ne peut pas
// contenir RJ2.
let cycle = false;
try {
  await q(`SELECT add_recipe_ingredient('${RJ}', '${RJ2}', 1)`);
} catch { cycle = true; }
check('25d. une recette ne peut pas se contenir elle-même', cycle);

// 25e. Le cycle direct aussi.
let direct = false;
try {
  await q(`SELECT add_recipe_ingredient('${RR}', '${RR}', 1)`);
} catch { direct = true; }
check('25e. le cycle direct est refusé', direct);

// 25f. La vente d'un plat consomme ses ingrédients. Le riz part de 50 à 47
// pour 3 plats × 300 g. Le stock du PLAT ne bouge pas : un plat se cuisine.
{
  await q(`INSERT INTO sales (id, user_id, total_amount, payment_method, amount_received)
    VALUES ('eeeeeeee-0000-0000-0000-000000000001', '${RESTO}', 13500, 'cash', 13500)`);
  await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost, list_price)
    VALUES ('eeeeeeee-0000-0000-0000-000000000001', '${RJ}', 'Poulet braisé', 3, 4500, 13500, 2000, 4500)`);

  const riz = await stock(RR);
  const huile = await stock(RH);
  check('25f. la vente d\'un plat décrémente son ingrédient',
    riz === 49.1, `riz ${riz}, attendu 49,1`);
  check('25g. et le deuxième ingrédient aussi', huile === 19.85, `huile ${huile}, attendu 19,85`);
}

// 25h. Le coût figé est celui de la RECETTE (165), pas le prix d'achat (2 000) :
// c'est ce qui rend la marge du plat réelle.
{
  const cout = (await q(`SELECT unit_cost FROM sale_items
    WHERE sale_id = 'eeeeeeee-0000-0000-0000-000000000001'`)).rows[0].unit_cost;
  check('25h. le coût figé de la vente est celui de la recette', Number(cout) === 165,
    `coût ${cout}, attendu 165`);
}

// 25i. Manque d'ingrédient : la vente entière est annulée, ligne d'en-tête
// comprise. Commander 200 plats alors qu'il n'y a que 50 kg de riz ne peut pas
// créer une vente sans riz.
let pasStock = true;
try {
  await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost, list_price)
    VALUES ('eeeeeeee-0000-0000-0000-000000000001', '${RJ}', 'Poulet braisé', 200, 4500, 900000, 2000, 4500)`);
  pasStock = false;
} catch { /* refus attendu : c'est le comportement voulu */ }
check('25i. une vente sans ingrédient suffisant est refusée', pasStock);
{
  // Le riz n'a pas bougé du tour précédent : la transaction a bien été annulée,
  // et pas seulement la ligne refusée.
  const riz = await stock(RR);
  check('25i2. et le stock d\'ingrédient est intact', riz === 49.1, `riz ${riz}`);
}

// 25j. Un caissier ne réécrit pas la carte.
{
  await canWrite('25j. un caissier ne modifie pas une recette',
    `INSERT INTO recipe_ingredients (dish_id, ingredient_id, quantity)
     VALUES ('${RJ}', '${RH}', 1)`, false, SERVEUR);
}

// 25k. La vue de marge reste en security_invoker.
{
  const def = (await q(`
    SELECT coalesce(c.reloptions::text, '') AS o
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'recipe_costs'`)).rows[0].o;
  check('25k. recipe_costs reste en security_invoker',
    def.includes('security_invoker=true'), `options : ${def || '(aucune)'}`);
}
{
  const vue = (await q(`
    SELECT unit_cost, margin, margin_pct FROM recipe_costs WHERE id = '${RJ}'`)).rows[0];
  // 4 500 − 165 = 4 335, soit 96,3 %
  check('25l. la marge du plat est calculée sur son coût de recette',
    Number(vue.unit_cost) === 165 && Number(vue.margin) === 4335 && Number(vue.margin_pct) === 96.3,
    `coût ${vue.unit_cost}, marge ${vue.margin}, ${vue.margin_pct} %`);
}

// 25m. Les recettes sont du tenant : un autre restaurant ne les voit pas.
{
  await canRead('25m. un autre restaurant ne voit pas la recette',
    `SELECT count(*) FROM recipe_ingredients WHERE dish_id = '${RJ}'`, false, PATRON);
}

// 25n → 25p. Un plat composé d'un AUTRE plat.
//
// migration_recipes.sql promet : « Le riz des deux est additionné : vendre un
// poulet consomme ce que les deux plats demandent. » Le COÛT tient cette
// promesse — product_cost() est récursif (25c). La CONSOMMATION, elle, ne
// l'était pas : sale_items_consume_ingredients() ne descendait qu'UN niveau,
// prenait le plat intermédiaire pour un ingrédient et décrémentait SON stock —
// dont la valeur naturelle est 0. Deux conséquences, selon que ce stock existe :
// la vente est REFUSÉE (« Stock insuffisant pour l'ingrédient « Poulet en
// portion » » — alors que le riz est plein), ou elle passe en décrémentant un
// plat qui n'existe pas en stock et en laissant le riz intact. Dans les deux
// cas, l'inventaire ment.
{
  const MENU = 'dddddddd-0000-0000-0000-000000000010';
  const PORT = 'dddddddd-0000-0000-0000-000000000011';
  const VTE = 'eeeeeeee-0000-0000-0000-000000000009';

  // 25m a laissé le jeton sur un AUTRE acteur (c'est ce que vérifie canRead) :
  // get_business_owner_id() résoudrait alors un autre tenant, et
  // add_recipe_ingredient() répondrait « Plat introuvable » pour une raison de
  // fixture. On se replace sur le patron du restaurant, comme le fait la
  // section 26 juste après.
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);

  await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty, min_stock_level) VALUES
    ('${MENU}', '${RESTO}', 'Menu du jour',  0, 3000, 0, 0),
    ('${PORT}', '${RESTO}', 'Poulet portion', 0, 2000, 0, 0)`);
  // Deux niveaux : MENU → PORT → riz. Le riz est la seule feuille.
  await q(`SELECT add_recipe_ingredient('${PORT}', '${RR}', 0.2)`);
  await q(`SELECT add_recipe_ingredient('${MENU}', '${PORT}', 1)`);

  const rizAvant = await stock(RR);
  let vendu = true;
  let refus = '';
  try {
    await q(`INSERT INTO sales (id, user_id, total_amount, payment_method, amount_received)
      VALUES ('${VTE}', '${RESTO}', 3000, 'cash', 3000)`);
    await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost, list_price)
      VALUES ('${VTE}', '${MENU}', 'Menu du jour', 1, 3000, 3000, 0, 3000)`);
  } catch (err) { vendu = false; refus = err.message; }
  check('25n. la vente d\'un plat composé d\'un autre plat aboutit', vendu,
    refus.slice(0, 110));

  const rizApres = await stock(RR);
  check('25o. et la feuille de la recette est consommée (0,2 kg de riz)',
    rizApres === Math.round((rizAvant - 0.2) * 1000) / 1000,
    `riz ${rizApres}, avant ${rizAvant}, attendu ${rizAvant - 0.2}`);

  const portStock = await stock(PORT);
  check('25p. le plat intermédiaire n\'a pas de stock à décrémenter',
    portStock === 0, `stock ${portStock}, attendu 0`);
}

// ─── 26. Restaurant : modificateurs, pourboire, réservations ──
// Les finitions qui font la différence entre « une caisse qui gère des plats »
// et « une caisse de restaurant ». Trois règles y comptent : le modificateur
// entre dans le prix mais pas dans la consommation d'ingrédients, le pourboire
// n'entre PAS dans le chiffre d'affaires, et la carte se modifie côté patron
// seulement.
console.log('\n▸ Restaurant — finitions');

// Le jeton courant est celui du dernier canWrite/canRead — un autre acteur. On
// se replace sur le patron du restaurant : sinon get_business_owner_id() résout
// un autre tenant et « commande introuvable » ferait échouer la section pour
// une raison de fixture.
await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);

const MOD1 = 'ffffffff-0000-0000-0000-000000000001';
const MOD2 = 'ffffffff-0000-0000-0000-000000000002';
await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}', 'patron4@test.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO product_modifiers (id, owner_id, product_id, name, extra_price) VALUES
  ('${MOD1}', '${RESTO}', '${RJ}', 'Bien cuit', 0),
  ('${MOD2}', '${RESTO}', '${RJ}', 'Double portion', 1500)`);

// 26a. Un supplément négatif est désormais ACCEPTÉ : c'est une taille « demi »
// (elle coûte moins). Un montant hors bornes reste refusé.
let negOk = true;
try {
  await q(`INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
    VALUES ('${RESTO}', '${RJ}', 'Demi portion', -100)`);
} catch { negOk = false; }
check('26a. une taille « demi » (supplément négatif) est acceptée', negOk);
let tropNeg = false;
try {
  await q(`INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
    VALUES ('${RESTO}', '${RJ}', 'Trop', -2000000)`);
} catch { tropNeg = true; }
check('26a2. un supplément hors bornes est refusé', tropNeg);

// 26b. Le modificateur ENTRE dans le prix facturé : deux doubles portions
// coûtent 2 × (4 500 + 1 500) = 12 000.
const OMB = 'cccccccc-0000-0000-0000-0000000000b1';
await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
  VALUES ('${OMB}', '${RESTO}', '${RESTO}')`);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, extra_price, modifier, note)
  VALUES ('${OMB}', '${RJ}', 2, 4500, 1500, 'Double portion', NULL)`);
const rizAvantMod = await stock(RR);
{
  const res = (await q(`SELECT close_table_order('${OMB}', 'cash')`)).rows[0].close_table_order;
  check('26b. le supplément du modificateur entre dans l\'addition',
    Number(res.total_amount) === 12000, `total ${res.total_amount}, attendu 12 000`);

  // 26c. Le modificateur ne change QUE le prix : la recette consomme toujours
  // la quantité, pas le supplément.
  const rizApres = await stock(RR);
  check('26c. le modificateur ne modifie pas la consommation d\'ingrédients',
    Math.abs((rizAvantMod - rizApres) - 0.6) < 0.001,
    `consommé ${(rizAvantMod - rizApres).toFixed(2)} kg, attendu 0,6`);
}

// 26b2. DEUX options du MÊME plat ne perdent pas le supplément le plus cher.
//
// Trouvé en recette navigateur le 04/10/2026, en clôturant une table de la
// recette : une double portion (supplément 1 500) puis un « bien cuit »
// (supplément 0) du même poulet. L'écran annonçait 10 500 F, la vente enregistrée
// valait 9 000 — le restaurant perdait 1 500 F sur chaque table qui commande le
// même plat deux fois avec des options différentes. La cause : le regroupement
// par produit seul, qui gardait le seul prix le MOINS cher.
const OMD = 'cccccccc-0000-0000-0000-0000000000b3';
await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
  VALUES ('${OMD}', '${RESTO}', '${RESTO}')`);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, extra_price, modifier)
  VALUES ('${OMD}', '${RJ}', 1, 4500, 1500, 'Double portion'),
         ('${OMD}', '${RJ}', 1, 4500,    0, 'Bien cuit')`);
{
  const res = (await q(`SELECT close_table_order('${OMD}', 'cash')`)).rows[0].close_table_order;
  // 4 500 + 1 500 + 4 500 + 0 = 10 500. L'ancien calcul rendait 9 000.
  check('26b2. deux options du même plat gardent les DEUX suppléments',
    Number(res.total_amount) === 10500, `total ${res.total_amount}, attendu 10 500`);

  // Et la vente porte deux lignes, pas une : c'est la condition pour que le
  // détail corresponde à ce que le client a commandé.
  const venteId = (await q(`SELECT id FROM sales WHERE user_id='${RESTO}'
    ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const lignes = await q(`SELECT count(*)::int c, sum(subtotal)::text s
    FROM sale_items WHERE sale_id = '${venteId}'`);
  check('26b3. la vente porte une ligne par prix, donc deux lignes',
    Number(lignes.rows[0].c) === 2 && Number(lignes.rows[0].s) === 10500,
    `${lignes.rows[0].c} ligne(s), ${lignes.rows[0].s}`);
}

// 26b4. Deux lignes du même plat AU MÊME prix fusionnent bien, sinon
// create_sale() refuserait « Deux prix différents pour le même article ».
{
  const OMF = 'cccccccc-0000-0000-0000-0000000000b4';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${OMF}', '${RESTO}', '${RESTO}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, extra_price, modifier)
    VALUES ('${OMF}', '${RJ}', 1, 4500, 0, 'Bien cuit'),
           ('${OMF}', '${RJ}', 1, 4500, 0, 'Bien cuit')`);
  const res = (await q(`SELECT close_table_order('${OMF}', 'cash')`)).rows[0].close_table_order;
  check('26b4. deux lignes au même prix restent une seule ligne de vente',
    Number(res.total_amount) === 9000, `total ${res.total_amount}, attendu 9 000`);
}

// 26b5. Le PATRON encaisse sa table alors qu'il n'a AUCUNE ligne dans
// business_members — et c'est le cas réel : seule redeem_invitation() en crée
// une, pour un employé. Un restaurant inscrit aujourd'hui n'a donc AUCUN membre
// enregistré, et la garde de rôle doit le laisser passer.
//
// Cette ligne a été écrite après avoir appliqué à la main, en production, une
// version de close_table_order() qui avait perdu la condition
// « v_owner <> auth.uid() » : le restaurant ne pouvait plus encaisser. Le test
// 23j couvrait déjà le cas, mais il le couvre par hasard — en étant le premier
// à appeler la clôture, il s'arrêtait sur une erreur inattendue, sans dire de
// quelle garde il s'agissait. Ici c'est nommé, et vérifié deux fois : le refus
// doit être vide ET la vente doit exister.
{
  const lignes = await count(
    `SELECT count(*) FROM business_members WHERE member_id = '${RESTO}'`);
  check('26b5. le patron du restaurant n\'a bien aucune ligne d\'équipe', lignes === 0,
    `${lignes} ligne(s)`);

  const OH = 'cccccccc-0000-0000-0000-0000000000b5';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
    VALUES ('${OH}', '${RESTO}', '${SERVEUR}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${OH}', '${RJ}', 1, 4500)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  let refus = '';
  try {
    await q(`SELECT close_table_order('${OH}', 'cash')`);
  } catch (ex) { refus = ex.message; }
  await e('RESET ROLE');

  check('26b6. le patron encaisse sa première addition sans être dans l\'équipe',
    refus === '', refus.slice(0, 70));
  const vente = await count(
    `SELECT count(*) FROM sales WHERE user_id='${RESTO}' AND total_amount = 4500`);
  check('26b7. et la vente est bien écrite', vente >= 1, `${vente} vente(s) de 4 500`);
}

// 26b8. UN PLAT SE SERT MÊME AVEC UN STOCK PROPRE DE 0.
//
// Trouvé en recette navigateur le 05/10/2026 : un maquis neuf, ouvert sur
// Table 1, deux attiéké poisson et deux poulet braisé. L'encaissement est
// refusé : « Stock insuffisant pour « Attiéké poisson » (disponible : 0.000,
// demandé : 2.000) ». Le stock du PLAT est vérifié, alors qu'un plat ne se
// stocke pas — sa disponibilité vient de ses ingrédients, qui étaient là.
//
// create_sale() contrôle donc qu'un produit ayant une recette, et ce
// seulement. Sans ce correctif, le catalogue d'exemple — qui crée des plats à
// 0 — rendait tout maquis instantly incapable de servir quoi que ce soit.
{
  // Un plat à 0, deux ingrédients en stock.
  const PLAT = 'eeeeeeee-0000-0000-0000-0000000000b6';
  await q(`INSERT INTO products (id, user_id, name, category, price_sell, price_buy, stock_qty)
    VALUES ('${PLAT}', '${RESTO}', 'Plat test 0 stock', 'Plats', 2000, 0, 0)`);
  await q(`INSERT INTO products (id, user_id, name, category, price_sell, price_buy, stock_qty)
    VALUES ('eeeeeeee-0000-0000-0000-0000000000b7', '${RESTO}', 'Ingrédient test A', 'Ingrédients', 800, 400, 10),
           ('eeeeeeee-0000-0000-0000-0000000000b8', '${RESTO}', 'Ingrédient test B', 'Ingrédients', 600, 300, 10)`);
  await q(`INSERT INTO recipe_ingredients (dish_id, ingredient_id, quantity)
    VALUES ('${PLAT}', 'eeeeeeee-0000-0000-0000-0000000000b7', 0.2),
           ('${PLAT}', 'eeeeeeee-0000-0000-0000-0000000000b8', 0.1)`);

  const r = await q(`SELECT create_sale(
    '[{"product_id":"${PLAT}","quantity":2}]'::jsonb, 'cash')`);
  const v = r.rows[0].create_sale;
  check('26b8. un plat à 0 de stock se vend quand ses ingrédients sont là',
    Number(v.total_amount) === 4000, `total ${v?.total_amount}, attendu 4 000`);

  const platApres = await q(`SELECT stock_qty::text s FROM products WHERE id='${PLAT}'`);
  check('26b9. et le stock du plat reste à 0 : un plat ne se stocke pas',
    Number(platApres.rows[0].s) === 0, `stock ${platApres.rows[0].s}`);

  const a = await q(`SELECT stock_qty::text s FROM products WHERE id='eeeeeeee-0000-0000-0000-0000000000b7'`);
  check('26b10. les ingrédients, eux, sont décrémentés de 2 × 0,2',
    Math.abs(Number(a.rows[0].s) - 9.6) < 0.001, `stock ${a.rows[0].s}, attendu 9,6`);

  // L'ing manquant, lui, doit refuser — et c'est le DÉCLENCHEUR qui parle, avec
  // le nom de l'ingrédient, pas le nom du plat.
  await q(`UPDATE products SET stock_qty = 0.05 WHERE id='eeeeeeee-0000-0000-0000-0000000000b7'`);
  let refus = '';
  try {
    await q(`SELECT create_sale('[{"product_id":"${PLAT}","quantity":1}]'::jsonb, 'cash')`);
  } catch (e) { refus = e.message; }
  check('26b11. un ingrédient manquant refuse la vente, en nommant l\'ingrédient',
    /Stock insuffisant pour l'ingrédient/.test(refus) && /Ingrédient test A/.test(refus),
    refus.slice(0, 90) || 'acceptée !');
}

// 26b12. Un produit SANS recette reste contrôlé normalement : le correctif ne
// doit pas ouvrir la vente d'un article en rupture.
{
  await q(`UPDATE products SET stock_qty = 0.2 WHERE id='eeeeeeee-0000-0000-0000-0000000000b8'`);
  let refus = '';
  try {
    await q(`SELECT create_sale(
      '[{"product_id":"eeeeeeee-0000-0000-0000-0000000000b8","quantity":1}]'::jsonb, 'cash')`);
  } catch (e) { refus = e.message; }
  check('26b12. un ingrédient vendu seul reste soumis au contrôle de stock',
    /Stock insuffisant pour/.test(refus) && /Ingrédient test B/.test(refus),
    refus.slice(0, 70) || 'acceptée !');
}

// 26b13. Deux tables ne peuvent pas porter le même nom.
//
// Trouvé en recette le 05/10/2026 : rien ne l'empêchait. Le plan affichait
// deux tuiles « Table 1 », et le ticket cuisine comme le reçu n'imprimaient que
// « Table 1 » — le plongeur ne savait plus quelle table les deux portions
// attendaient. La comparaison ignore la casse et les espaces : « table 1 » est
// « Table 1 » pour un serveur qui tape vite.
{
  const ref = '';
  void ref;
  const tableId = await q(`INSERT INTO restaurant_tables (owner_id, name, zone)
    VALUES ('${RESTO}', 'Table garantie unique', 'Salle') RETURNING id`);
  const id = tableId.rows[0].id;

  let refus = '';
  try {
    await q(`INSERT INTO restaurant_tables (owner_id, name, zone)
      VALUES ('${RESTO}', '  TABLE GARANTIE UNIQUE  ', 'Salle')`);
  } catch (e) { refus = e.message; }
  check('26b13. un nom de table déjà pris est refusé, casse et espaces ignorés',
    /restaurant_tables_owner_name_uniq/.test(refus), refus.slice(0, 90) || 'accepté !');

  // Archiver une table libère son nom : sans le WHERE is_active, on ne pourrait
  // plus jamais réinstaller « Table 1 » après l'avoir démontée.
  await q(`UPDATE restaurant_tables SET is_active = false WHERE id = '${id}'`);
  const re = await q(`INSERT INTO restaurant_tables (owner_id, name, zone)
    VALUES ('${RESTO}', 'Table garantie unique', 'Salle') RETURNING id`);
  check('26b14. une table archivée libère son nom', !!re.rows[0]?.id);
}

// 26d. Le ticket de cuisine montre le modificateur, TOUJOURS sans prix.
{
  const colonnes = (await q(`
    SELECT string_agg(column_name, ',' ORDER BY column_name) AS c
      FROM information_schema.columns
     WHERE table_name = 'restaurant_kitchen_ticket'`)).rows[0].c;
  check('26d. le ticket de cuisine porte le modificateur',
    colonnes.includes('modifier'), `colonnes : ${colonnes}`);
  check('26e. et toujours aucun prix', !colonnes.includes('price'), `colonnes : ${colonnes}`);
}

// 26f. Le pourboire est HORS du chiffre d'affaires : c'est une manne, pas une
// recette. 36 000 + 5 000 de pourboire = 36 000 de vente, 41 000 pour le client.
const OMT = 'cccccccc-0000-0000-0000-0000000000b2';
await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by)
  VALUES ('${OMT}', '${RESTO}', '${RESTO}')`);
await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
  VALUES ('${OMT}', '${RJ}', 8, 4500)`);
{
  const avant = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  const res = (await q(`SELECT close_table_order('${OMT}', 'cash', NULL, 1, NULL, NULL, 5000)`)).rows[0].close_table_order;
  check('26f. le pourboire n\'entre pas dans le total de la vente',
    Number(res.total_amount) === 36000, `total ${res.total_amount}`);
  check('26g. il est reporté à part',
    Number(res.tip) === 5000 && Number(res.total_with_tip) === 41000,
    `pourboire ${res.tip}, avec ${res.total_with_tip}`);

  const vente = (await q(`SELECT total_amount FROM sales
    WHERE id = (SELECT sale_id FROM restaurant_orders WHERE id='${OMT}')`)).rows[0];
  check('26h. et la vente en base vaut bien 36 000', Number(vente.total_amount) === 36000,
    `vente ${vente.total_amount}`);
  const apres = await count(`SELECT count(*) FROM sales WHERE user_id='${RESTO}'`);
  check('26h2. une seule vente écrite', apres === avant + 1, `${apres} ventes`);
}

// 26i. Un pourboire négatif est refusé.
let tipNeg = false;
try {
  const OMT2 = 'cccccccc-0000-0000-0000-0000000000b3';
  await q(`INSERT INTO restaurant_orders (id, owner_id, opened_by) VALUES ('${OMT2}', '${RESTO}', '${RESTO}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${OMT2}', '${RJ}', 1, 4500)`);
  await q(`SELECT close_table_order('${OMT2}', 'cash', NULL, 1, NULL, NULL, -500)`);
} catch { tipNeg = true; }
check('26i. un pourboire négatif est refusé', tipNeg);

// 26j. La version à 6 arguments a disparu : PostgREST résout par nombre
// d'arguments, une fonction surchargée créerait une ambiguïté silencieuse.
{
  const n = await count(`SELECT count(*) FROM pg_proc
    WHERE proname = 'close_table_order' AND pronargs = 6`);
  check('26j. close_table_order n\'existe plus qu\'en 7 arguments', n === 0, `${n} signature(s)`);
}

// 26k. Un caissier ne réécrit pas la carte.
await canWrite('26k. un caissier n\'ajoute pas de modificateur',
  `INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
   VALUES ('${RESTO}', '${RJ}', 'Sans piment', 0)`, false, SERVEUR);

// 26l. Le patron, lui, peut.
await canWrite('26l. le patron modifie la carte',
  `INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
   VALUES ('${RESTO}', '${RJ}', 'Sans piment', 0)`, true, RESTO);

// 26m. Le plat du jour est un drapeau, pas une planification.
await canWrite('26m. le patron bascule un plat du jour',
  `UPDATE products SET is_daily_special = true WHERE id = '${RJ}'`, true, RESTO);
{
  const v = (await q(`SELECT is_daily_special FROM products WHERE id='${RJ}'`)).rows[0];
  check('26n. le drapeau est bien posé', v.is_daily_special === true);
}

// 26o. Réservation : taille positive obligatoire.
let taille = false;
try {
  await q(`INSERT INTO restaurant_reservations (owner_id, customer_name, slot_at, party_size)
    VALUES ('${RESTO}', 'M. Zinsou', now(), 0)`);
} catch { taille = true; }
check('26o. une réservation sans place est refusée', taille);

await q(`INSERT INTO restaurant_reservations (owner_id, customer_name, slot_at, party_size, phone)
  VALUES ('${RESTO}', 'M. Zinsou', now() + interval '3 hours', 4, '+229 97 00 00 00')`);
{
  const n = await count(`SELECT count(*) FROM restaurant_reservations WHERE owner_id='${RESTO}'`);
  check('26p. une réservation se prend', n === 1, `${n} réservation(s)`);
}

// 26q. Un caissier réserve au téléphone (écriture permise)...
await canWrite('26q. un caissier peut prendre une réservation',
  `INSERT INTO restaurant_reservations (owner_id, customer_name, slot_at, party_size)
   VALUES ('${RESTO}', 'M. Sossa', now() + interval '5 hours', 2)`, true, SERVEUR);

// ...mais il ne voit pas les réservations d'un autre restaurant.
await canRead('26r. un autre restaurant ne voit pas les réservations',
  `SELECT count(*) FROM restaurant_reservations WHERE owner_id='${RESTO}'`, false, PATRON);

// ─── 27. Restaurant : carte par jour de la semaine ──────────
// Une carte qui propose un plat non servi est pire qu'une carte courte : le
// client commande ce qu'il voit, et la cuisine ne cuisine pas ce qui n'est pas
// au menu.
console.log('\n▸ Restaurant — carte de la semaine');

// 27a. Un jour hors 0-6 est refusé, un doublon aussi (le tableau ne doit pas
// se remplir de 5, 5, 5 par trois clics répétés).
let jourFaux = false;
try {
  await q(`UPDATE products SET menu_days = ARRAY[1, 9] WHERE id = '${RJ}'`);
} catch { jourFaux = true; }
check('27a. un jour de semaine inexistant est refusé', jourFaux);

let vide = false;
try {
  await q(`UPDATE products SET menu_days = ARRAY[]::int[] WHERE id = '${RJ}'`);
} catch { vide = true; }
check('27b. un tableau de jours vide est refusé', vide);

// 27c. NULL = tous les jours : le défaut, pour qu'un plat créé depuis Stock
// reste servi sans configuration.
check('27c. NULL signifie tous les jours',
  (await q(`SELECT menu_days FROM products WHERE id='${RH}'`)).rows[0].menu_days === null);

// 27d. Les jours se pose et se lisent, et la vue du jour suit.
{
  // 5 = vendredi, 6 = samedi.
  await q(`UPDATE products SET menu_days = ARRAY[5, 6] WHERE id = '${RJ}'`);
  const v = (await q(`SELECT menu_days FROM products WHERE id='${RJ}'`)).rows[0].menu_days;
  check('27d. les jours de service se posent',
    Array.isArray(v) && v.includes(5) && v.includes(6), `menu_days ${JSON.stringify(v)}`);

  const jour = (await q(`SELECT extract(dow FROM now())::int AS d`)).rows[0].d;
  const servi = Number((await q(`SELECT servi_aujourdhui FROM restaurant_menu_today
    WHERE id = '${RJ}'`)).rows[0].servi_aujourdhui);

  // Le test ne dépend pas du jour où il tourne : il vérifie la COHÉRENCE entre
  // la colonne et la vue, pas une date figée.
  // PGlite renvoie le boolean du SQL sous forme de 0/1, pas true/false :
  // la comparaison se fait donc en booléen des deux côtés.
  const attendu = jour === 5 || jour === 6;
  check('27e. la carte du jour suit les jours de service',
    Boolean(servi) === attendu, `aujourd'hui ${jour}, servi=${servi}, attendu=${attendu}`);

  // Un plat sans jours reste servi tous les jours.
  const riz = (await q(`SELECT servi_aujourdhui FROM restaurant_menu_today
    WHERE id = '${RR}'`)).rows[0].servi_aujourdhui;
  check('27f. un plat sans jours est servi tous les jours', Boolean(riz) === true);
}

// 27g. La vue du jour reste en security_invoker : en DEFINER elle exposerait la
// carte d'un autre restaurant.
{
  const def = (await q(`
    SELECT coalesce(c.reloptions::text, '') AS o
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'restaurant_menu_today'`)).rows[0].o;
  check('27g. restaurant_menu_today reste en security_invoker',
    def.includes('security_invoker=true'), `options : ${def || '(aucune)'}`);
}

// 27h. Un caissier ne change pas la carte : c'est une décision de patron.
await canWrite('27h. un caissier ne change pas les jours de service',
  `UPDATE products SET menu_days = ARRAY[1,2,3] WHERE id = '${RJ}'`, false, SERVEUR);

// 27i. Retirer tous les jours revient à « tous les jours » : c'est ce que fait
// l'interface, et un tableau vide serait refusé par la contrainte.
{
  await q(`UPDATE products SET menu_days = NULL WHERE id = '${RJ}'`);
  const servi = Number((await q(`SELECT servi_aujourdhui FROM restaurant_menu_today
    WHERE id = '${RJ}'`)).rows[0].servi_aujourdhui);
  check('27i. remettre à null rend le plat servi tous les jours', Boolean(servi) === true);
}

// ─── 27bis. Restaurant : transfert et fusion de tables ────────────────────
//
// Deux gestes du service. Le transfert déplace une commande ouverte vers une
// table libre ; la fusion verse les lignes d'une commande dans une autre et
// libère la source. L'index « une seule commande ouverte par table » doit tenir
// dans les deux cas.
console.log('\n▸ Restaurant — transfert et fusion de tables');

const TR1 = 'f0f0f0f0-0000-0000-0000-000000000001';
const TR2 = 'f0f0f0f0-0000-0000-0000-000000000002';
const TR3 = 'f0f0f0f0-0000-0000-0000-000000000003';
const ORD_A = 'f0f0f0f0-0000-0000-0000-000000000011';
const ORD_B = 'f0f0f0f0-0000-0000-0000-000000000012';
{
  await q(`INSERT INTO products (user_id, name, sku, price_sell, stock_qty)
    VALUES ('${RESTO}', 'Plat transfert', 'TRF-1', 1000, 10)`);
  const PLAT_TR = (await q(`SELECT id FROM products WHERE user_id='${RESTO}' AND sku='TRF-1'`)).rows[0].id;

  await q(`INSERT INTO restaurant_tables (id, owner_id, name, zone, seats) VALUES
    ('${TR1}', '${RESTO}', 'Transfert 1', 'Test', 4),
    ('${TR2}', '${RESTO}', 'Transfert 2', 'Test', 4),
    ('${TR3}', '${RESTO}', 'Transfert 3', 'Test', 4)`);
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id, opened_by) VALUES
    ('${ORD_A}', '${RESTO}', '${TR1}', '${PATRON}'),
    ('${ORD_B}', '${RESTO}', '${TR2}', '${PATRON}')`);

  // Transfert vers une table libre.
  await q(`SELECT transfer_table_order('${ORD_A}', '${TR3}')`);
  const t3 = (await q(`SELECT table_id FROM restaurant_orders WHERE id='${ORD_A}'`)).rows[0].table_id;
  check('27b1. le transfert déplace la commande vers la table libre', t3 === TR3, `table : ${t3}`);

  // Transfert vers une table occupée : refusé.
  let refuseT = false;
  try { await q(`SELECT transfer_table_order('${ORD_A}', '${TR2}')`); } catch { refuseT = true; }
  check('27b2. le transfert vers une table occupée est refusé', refuseT);

  // Fusion : les lignes de ORD_B rejoignent ORD_A, ORD_B disparaît.
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${ORD_B}', '${PLAT_TR}', 1, 1000)`);
  const itemsAvant = Number((await q(`SELECT count(*)::int n FROM restaurant_order_items WHERE order_id='${ORD_A}'`)).rows[0].n);
  await q(`SELECT merge_table_orders('${ORD_B}', '${ORD_A}')`);
  const resteB = Number((await q(`SELECT count(*)::int n FROM restaurant_orders WHERE id='${ORD_B}'`)).rows[0].n);
  const itemsApres = Number((await q(`SELECT count(*)::int n FROM restaurant_order_items WHERE order_id='${ORD_A}'`)).rows[0].n);
  check('27b3. la fusion déplace les lignes et supprime la commande source',
    resteB === 0 && itemsApres === itemsAvant + 1, `source:${resteB} cible:${itemsApres}/${itemsAvant}`);

  // La table de la source est redevenue libre.
  const libB = Number((await q(`SELECT count(*)::int n FROM restaurant_orders WHERE table_id='${TR2}' AND status<>'closed'`)).rows[0].n);
  check('27b4. la table de la commande fusionnée redevient libre', libB === 0);

  // Fusion de soi-même : refusée.
  let refuseM = false;
  try { await q(`SELECT merge_table_orders('${ORD_A}', '${ORD_A}')`); } catch { refuseM = true; }
  check('27b5. fusionner une commande avec elle-même est refusé', refuseM);
}

// ─── 27c. Couverts et statistiques restaurant ─────────────────────────────
console.log('\n▸ Restaurant — couverts');

{
  // La contrainte des couverts : ni 0, ni au-delà de 200.
  let refuse0 = false;
  let refuse201 = false;
  try { await q(`UPDATE restaurant_orders SET covers=0 WHERE id='${ORD_A}'`); } catch { refuse0 = true; }
  try { await q(`UPDATE restaurant_orders SET covers=201 WHERE id='${ORD_A}'`); } catch { refuse201 = true; }
  await q(`UPDATE restaurant_orders SET covers=3 WHERE id='${ORD_A}'`);
  const ok = (await q(`SELECT covers FROM restaurant_orders WHERE id='${ORD_A}'`)).rows[0].covers;
  check('27c1. un nombre de couverts hors bornes est refusé', refuse0 && refuse201,
    `0:${refuse0} 201:${refuse201}`);
  check('27c2. un nombre de couverts valide est accepté', Number(ok) === 3, `covers : ${ok}`);
}

{
  // get_restaurant_stats est appelable sous RLS (rôle authenticated) : la
  // fonction existe, est accordée, et répond une ligne.
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  try {
    const r = (await q(`SELECT * FROM get_restaurant_stats(current_date, current_date, 'Africa/Porto-Novo')`)).rows[0];
    check('27c3. get_restaurant_stats répond sous RLS', r !== undefined && r.covers !== undefined,
      `ligne : ${JSON.stringify(r)}`);
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
}

// ─── 27d. Paiement multiple et partage par article ────────────────────────
console.log('\n▸ Restaurant — paiement multiple');

const PM_T = 'f0f0f0f0-0000-0000-0000-0000000000e1';
const PM_O = 'f0f0f0f0-0000-0000-0000-0000000000e2';
{
  await q(`INSERT INTO products (user_id, name, sku, price_sell, stock_qty)
    VALUES ('${RESTO}', 'Plat multi', 'PM-1', 1000, 10)`);
  const p = (await q(`SELECT id FROM products WHERE user_id='${RESTO}' AND sku='PM-1'`)).rows[0].id;
  await q(`INSERT INTO restaurant_tables (id, owner_id, name, zone) VALUES ('${PM_T}', '${RESTO}', 'Multi', 'Test')`);
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id) VALUES ('${PM_O}', '${RESTO}', '${PM_T}')`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, split_part)
    VALUES ('${PM_O}', '${p}', 8, 1000, 1)`); // total 8 000

  // split_part hors bornes refusé.
  let refusePart = false;
  try { await q(`UPDATE restaurant_order_items SET split_part=0 WHERE order_id='${PM_O}'`); } catch { refusePart = true; }
  check('27d1. une part hors bornes est refusée', refusePart);

  // Paiement multiple : 5 000 espèces + 3 000 MoMo.
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  let res;
  try {
    res = (await q(`SELECT close_table_order('${PM_O}', 'cash', NULL, 1, NULL, NULL, 0,
      '[{"method":"cash","amount":5000},{"method":"momo","amount":3000}]'::jsonb) AS r`)).rows[0].r;
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }

  const sale = (await q(`SELECT payment_method, amount_received, total_amount FROM sales WHERE id='${res.sale_id}'`)).rows[0];
  check('27d2. un paiement multiple crée une vente « mixed » au total',
    sale.payment_method === 'mixed' && Number(sale.amount_received) === 8000, JSON.stringify(sale));

  const pay = (await q(`SELECT method, amount FROM sale_payments WHERE sale_id='${res.sale_id}' ORDER BY method`)).rows;
  check('27d3. les deux paiements sont enregistrés',
    pay.length === 2 && Number(pay.find((x) => x.method === 'cash').amount) === 5000,
    JSON.stringify(pay));

  // La ventilation espèces/MoMo suit les paiements.
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  let sum;
  try {
    sum = (await q(`SELECT cash, momo FROM get_sales_summary(current_date, current_date, 'Africa/Porto-Novo')`)).rows[0];
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
  check('27d4. la ventilation espèces/MoMo suit les paiements',
    Number(sum.cash) >= 5000 && Number(sum.momo) >= 3000, JSON.stringify(sum));

  // Somme fausse refusée.
  const PM_O2 = 'f0f0f0f0-0000-0000-0000-0000000000e3';
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id) VALUES ('${PM_O2}', '${RESTO}', NULL)`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${PM_O2}', '${p}', 1, 1000)`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  let refuseSomme = false;
  try {
    await q(`SELECT close_table_order('${PM_O2}', 'cash', NULL, 1, NULL, NULL, 0,
      '[{"method":"cash","amount":500}]'::jsonb)`);
  } catch { refuseSomme = true; }
  await e('RESET ROLE');
  await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  check('27d5. une somme de paiements fausse est refusée', refuseSomme);
}

// ─── 27e. Remises et offerts ──────────────────────────────────────────────
console.log('\n▸ Restaurant — remises et offerts');

const D_T = 'f0f0f0f0-0000-0000-0000-0000000000f1';
const D_O = 'f0f0f0f0-0000-0000-0000-0000000000f2';
{
  await q(`INSERT INTO products (user_id, name, sku, price_sell, stock_qty)
    VALUES ('${RESTO}', 'Plat remise', 'REM-1', 2000, 10)`);
  const p = (await q(`SELECT id FROM products WHERE user_id='${RESTO}' AND sku='REM-1'`)).rows[0].id;
  await q(`INSERT INTO restaurant_tables (id, owner_id, name, zone) VALUES ('${D_T}', '${RESTO}', 'Remise', 'Test')`);
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id) VALUES ('${D_O}', '${RESTO}', '${D_T}')`);
  // Une ligne normale (2 000) et une ligne OFFERTE (comptée 0).
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price, is_offered)
    VALUES ('${D_O}', '${p}', 1, 2000, false), ('${D_O}', '${p}', 1, 2000, true)`);

  // Encaissement par le patron (RESTO) avec une remise de 500.
  await q(`SELECT set_config('request.jwt.claim.sub', '${RESTO}', false)`);
  await e('SET ROLE authenticated');
  let res;
  try {
    res = (await q(`SELECT close_table_order('${D_O}', 'cash', NULL, 1, NULL, NULL, 0, NULL, 500) AS r`)).rows[0].r;
  } finally {
    await e('RESET ROLE');
    await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
  check('27e1. une ligne offerte ne compte pas dans l’addition (2 000 − 500 = 1 500)',
    Number(res.total_amount) === 1500, JSON.stringify(res));
  const sale = (await q(`SELECT total_amount, discount_amount FROM sales WHERE id='${res.sale_id}'`)).rows[0];
  check('27e2. la remise est tracée sur la vente',
    Number(sale.total_amount) === 1500 && Number(sale.discount_amount) === 500, JSON.stringify(sale));

  // Un employé (caissier) ne peut pas accorder de remise.
  const D_O2 = 'f0f0f0f0-0000-0000-0000-0000000000f3';
  await q(`INSERT INTO restaurant_orders (id, owner_id, table_id) VALUES ('${D_O2}', '${RESTO}', NULL)`);
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price)
    VALUES ('${D_O2}', '${p}', 1, 2000)`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${SERVEUR}', false)`);
  await e('SET ROLE authenticated');
  let refuseRemise = false;
  try {
    await q(`SELECT close_table_order('${D_O2}', 'cash', NULL, 1, NULL, NULL, 0, NULL, 500)`);
  } catch { refuseRemise = true; }
  await e('RESET ROLE');
  await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  check('27e3. un employé ne peut pas accorder de remise', refuseRemise);
}

// ─── 27f. Tailles et variantes ────────────────────────────────────────────
console.log('\n▸ Restaurant — tailles et variantes');
{
  const V_P = (await q(`SELECT id FROM products WHERE user_id='${RESTO}' AND sku='REM-1'`)).rows[0].id;
  await q(`INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
    VALUES ('${RESTO}', '${V_P}', 'Demi 27f', -1000)`);
  const neg = Number((await q(`SELECT extra_price FROM product_modifiers WHERE owner_id='${RESTO}' AND name='Demi 27f'`)).rows[0].extra_price);
  check('27f1. une taille « demi » (supplément négatif) est acceptée', neg === -1000, `extra : ${neg}`);

  let refuseHorsBornes = false;
  try {
    await q(`INSERT INTO product_modifiers (owner_id, product_id, name, extra_price)
      VALUES ('${RESTO}', '${V_P}', 'Trop', -2000000)`);
  } catch { refuseHorsBornes = true; }
  check('27f2. un supplément hors bornes est refusé', refuseHorsBornes);
}

const CAISSER2 = 'abababab-0000-4000-8000-0000000000ca';

// ─── 28. Base de caisse : un seul chiffre d'affaires ──────────────────────
//
// Recette navigateur du 04/10/2026 : deux écrans, le même jour, la même
// boutique, deux chiffres d'affaires. 42 300 F sur « Ventes », 34 300 F sur
// « Rentabilité » — l'écart valait exactement la dette non réglée. La cause :
// get_sales_summary() comptait total_amount, get_cash_flow() amount_received.
//
// Ces tests verrouillent la base de caisse ET le fait que les trois écrans ne
// puissent plus diverger entre eux.
console.log('\n▸ Base de caisse');

const CA = 'dddddddd-0000-0000-0000-0000000000ca';
{
  // Boutique isolée : ces ventes ne doivent pas gonfler les totaux des autres
  // sections du harnais.
  await q(`INSERT INTO auth.users (id, email) VALUES ('${CA}', 'caisse@test.local')`);
  await q(`INSERT INTO organizations (id, name, slug, plan, timezone)
    VALUES ('${CA}', 'Boutique caisse', 'boutique-caisse', 'pro', 'Africa/Porto-Novo')`);
  await q(`INSERT INTO products (id, user_id, name, price_sell, price_buy, stock_qty)
    VALUES ('eeeeeeee-0000-0000-0000-0000000000e1', '${CA}', 'Article', 1000, 500, 100)`);
}

// Une vente à crédit de 9 000 avec 1 000 d'acompte : 8 000 restent dûs.
await q(`SELECT set_config('request.jwt.claim.sub', '${CA}', false)`);

// Totaux AVANT toute écriture de la section : la période couvre déjà les ventes
// des sections précédentes : seules les variations prouvent le comportement.
const _j = (await q(`SELECT (now() AT TIME ZONE 'UTC')::date::text d`)).rows[0].d;
const _avant = (await q(`SELECT revenue::text r, cash::text c FROM get_sales_summary('${_j}','${_j}','UTC')`)).rows[0];
const baseR0 = Number(_avant.r);
const baseC0 = Number(_avant.c);

const vCredit = await q(`SELECT record_credit_sale(
  '[{"product_id":"eeeeeeee-0000-0000-0000-0000000000e1","quantity":9}]'::jsonb,
  'Client Test', '0102030405', NULL, 1000)`);
const creditId = vCredit.rows[0].record_credit_sale.id;
const detteId = vCredit.rows[0].record_credit_sale.debt_id;

// La période contient déjà les ventes des sections précédentes : on mesure
// donc des ÉCARTS, pas des absolus. C'est ce que voit l'utilisateur — un total
// qui bouge de 3 000 après un encaissement de 3 000.
const jourCa = (await q(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`)).rows[0].d;
const ca = async () => {
  const r = (await q(`SELECT revenue::text r, cash::text c, momo::text m
    FROM get_sales_summary('${jourCa}','${jourCa}','UTC')`)).rows[0];
  return { r: Number(r.r), c: Number(r.c), m: Number(r.m) };
};

const base = await ca();
check('28a. une vente à crédit de 9 000 n’entre dans le CA que pour son acompte',
  base.r - baseR0 === 1000, `+${base.r - baseR0}, attendu +1000`);
check('28a2. et l’acompte va bien aux espèces',
  base.c - baseC0 === 1000, `+${base.c - baseC0}, attendu +1000`);

// Le règlement de 3 000, en Mobile Money : 3 000 de plus au CA, et 3 000 en momo.
await q(`SELECT pay_customer_debt('${detteId}', 3000, 'momo')`);
const momo3k = await ca();

check('28b. encaisser 3 000 ajoute 3 000 au chiffre d’affaires',
  momo3k.r - base.r === 3000, `+${momo3k.r - base.r}, attendu +3000`);
check('28c. et ces 3 000 apparaissent en Mobile Money, pas en espèces',
  momo3k.m - base.m === 3000 && momo3k.c === base.c,
  `espèces ${base.c} → ${momo3k.c}, momo ${base.m} → ${momo3k.m}`);
check('28d. le prix facturé (9 000) ne transparaît nulle part',
  momo3k.r - baseR0 < 9000,
  `CA de la boutique = ${momo3k.r - baseR0}, facturé 9000`);

// Le même geste, en espèces cette fois : c'est le cas que le bug initial
// ignorait — l'argent liquide d'un règlement n'entrait dans AUCUN total.
await q(`SELECT pay_customer_debt('${detteId}', 2000, 'cash')`);
const cash2k = await ca();
check('28e. un règlement en espèces entre dans le total « Espèces »',
  cash2k.c - momo3k.c === 2000,
  `espèces ${momo3k.c} → ${cash2k.c}, attendu +2000`);

// Le reliquat solde la vente.
await q(`SELECT pay_customer_debt('${detteId}', 4000, 'cash')`);
const cash4k = await ca();
const solder = await q(`SELECT settled FROM sales WHERE id='${creditId}'`);

check('28f. la vente est soldée',
  solder.rows[0].settled === true || String(solder.rows[0].settled) === 't');
check('28g. le CA atteint alors le montant facturé, 9 000',
  cash4k.r - baseR0 === 9000, `CA = ${cash4k.r - baseR0}, attendu 9000`);
// Espèces réellement rattachées : l'acompte de 1 000 à la vente, plus 2 000 du
// deuxième règlement. Le troisième (4 000) ne solde que 3 000 de reste dû : son
// excédent de 1 000 reste au client, sans vente rattachée, et ne doit entrer
// dans aucun total — d'où 6 000 et non 7 000. C'est vérifié plus bas en 28n.
check('28h. les espèces couvrent 1 000 + 2 000 + 3 000 = 6 000',
  cash4k.c - baseC0 === 6000, `espèces ${baseC0} → ${cash4k.c}`);

// Les trois écrans doivent afficher le MÊME chiffre. C'est le défaut qu'on
// corrige : ils divergeaient parce que chacun lisait une colonne différente.
{
  // get_cash_flow() découpe avec le fuseau de l'organisation (Porto-Novo, soit
  // UTC+1) alors que la synthèse est appelée ici en UTC : les deux fenêtres
  // doivent contenir les ventes du test, sinon les totaux divergent. L'heure
  // locale passe à minuit une heure avant qu'UTC ne bascule — entre 00:00 et
  // 01:00 locales (23:00–24:00 UTC), la vente du jour tombe sur le lendemain
  // LOCAL et sort d'une borne calée sur la date UTC (flux 0 / synthèse pleine).
  // La borne de fin couvre donc aussi le lendemain UTC : ce jour ne contient
  // aucune donnée — tout est « now » — élargir ne fausse rien, et la
  // comparaison redevient valable à toute heure du jour et de la nuit.
  const d0 = (await q(`SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::date::text d`)).rows[0].d;
  const d1 = (await q(`SELECT ((now() AT TIME ZONE 'UTC')::date + 1)::date::text d`)).rows[0].d;
  const flux = (await q(`SELECT revenue FROM get_cash_flow('${d0}'::date,'${d1}'::date)`))
    .rows.reduce((t, r) => t + Number(r.revenue), 0);
  const syn = (await q(
    `SELECT revenue FROM get_sales_summary('${d0}','${d1}','UTC')`))
    .rows.reduce((t, r) => t + Number(r.revenue), 0);

  check('28i. synthèse et flux de caisse affichent le même chiffre',
    syn === flux, `synthèse ${syn} / flux ${flux}`);

  // L'invariant, énoncé directement : sur toute la période, le chiffre
  // d'affaires rendu par la fonction est la somme de ce qui a été ENCAISSÉ.
  // Avec la base brute (total_amount), cette égalité tient tant qu'aucune
  // dette n'est ouverte — et cesse de tenir dès la première, ce qui est
  // précisément le jour où le commerçant en a le plus besoin.
  const sommeRecue = (await q(`
    SELECT COALESCE(SUM(amount_received), 0)::text AS r,
           COALESCE(SUM(total_amount), 0)::text    AS b
      FROM sales
     WHERE created_at >= ('${d0}'::timestamp AT TIME ZONE 'UTC')
       AND created_at <  (('${jourCa}'::date + 1)::timestamp AT TIME ZONE 'UTC')`)).rows[0];

  check('28j. le chiffre d’affaires de la période vaut exactement la somme encaissée',
    Number(syn) === Number(sommeRecue.r),
    `synthèse ${syn} / somme amount_received ${sommeRecue.r}`);
  check('28k2. et il est STRICTEMENT inférieur au facturé, puisqu\'une dette est ouverte',
    Number(syn) < Number(sommeRecue.b),
    `encaissé ${syn} / facturé ${sommeRecue.b}`);
}

// Un geste qui solde plusieurs ventes reste UN versement annoncé au client.
// Deux ventes ouvertes pour ce client : c'est le cas qui produit une
// ventilation. Une seule vente ne le ferait pas — le règlement la solderait
// entièrement et le geste n'aurait qu'une ligne.
for (const qte of [2, 1]) {
  await q(`SELECT record_credit_sale(
    '[{"product_id":"eeeeeeee-0000-0000-0000-0000000000e1","quantity":${qte}}]'::jsonb,
    'Client Test', '0102030405', NULL, 0)`);
}
// 10 chiffres en 01 : numéro béninois actuel, préfixé de 229
// (migration_telephone_benin.sql).
const d2 = (await q(`SELECT id::text d FROM customer_debts
  WHERE user_id='${CA}' AND phone='2290102030405'`)).rows[0].d;
{

  const avant = (await q(`SELECT payments_count::text p, sales_count::text n
    FROM get_customer_debts() WHERE debt_id='${d2}'`)).rows[0];

  if (!avant) {
    // Filet de sécurité : sans cette ligne, le block suivant planterait sur
    // undefined et masquerait la cause réelle (dette soldée, plan, téléphone).
    const toutes = await q(`SELECT debt_id::text d, total_due::text t
      FROM get_customer_debts()`);
    check('28k. la dette de test est bien listée', false,
      `dette ${d2} absente — liste : ${JSON.stringify(toutes.rows)}`);
  } else {
    // Le règlement de 2 500 solde la vente de 2 000 (la plus ancienne) puis 500
    // entame la suivante : un geste, deux lignes de ventilation.
    await q(`SELECT pay_customer_debt('${d2}', 2500, 'cash')`);
    const apres = (await q(`SELECT payments_count::text p, sales_count::text n
      FROM get_customer_debts() WHERE debt_id='${d2}'`)).rows[0];

    check('28k. un règlement ventilé reste un seul versement annoncé',
      Number(apres.p) === Number(avant.p) + 1,
      `${avant.p} → ${apres.p}`);
    check('28l. et les deux ventes ont bien été traversées',
      Number(apres.n) === Number(avant.n) - 1,
      `${avant.n} → ${apres.n} vente(s) due(s)`);

    // Un geste de 2 500, ventilé en 2 000 + 500 : une seule ligne par
    // gesture_id, deux lignes par vente. C'est la preuve que la ventilation
    // ne transforme pas un versement en deux dans l'historique du client.
    const geste = await q(`
      SELECT count(*)::text lignes, count(DISTINCT gesture_id)::text gestes
        FROM credit_payments
       WHERE user_id='${CA}' AND day = current_date AND sale_id IS NOT NULL
         AND gesture_id IN (
           SELECT gesture_id FROM credit_payments
            WHERE user_id='${CA}' AND day = current_date
              AND amount IN (2000, 500)
              GROUP BY 1 HAVING count(*) = 2)`);
    check('28l2. les deux lignes d\'un même geste partagent son identifiant',
      Number(geste.rows[0].gestes) === 1 && Number(geste.rows[0].lignes) === 2,
      `${geste.rows[0].lignes} ligne(s), ${geste.rows[0].gestes} geste(s)`);
  }
}

// Un règlement supérieur à la dette reste un règlement, et n'entre dans
// aucun total : il ne solde aucune vente.
{
  // 500 restent dus (le règlement précédent en a laissé). On verse 2 000 :
  // 500 soldent la vente, 1 500 restent au client.
  const _c = await ca();
  const reste = await q(`SELECT pay_customer_debt('${detteId}', 2000, 'cash')`);
  const apresExcedent = await ca();

  check('28m. un versement supérieur à la dette laisse un crédit au client',
    Number(reste.rows[0].pay_customer_debt.balance_after) === 0,
    `solde ${reste.rows[0].pay_customer_debt.balance_after}`);
  check('28n. seuls les 500 qui soldent la vente entrent au chiffre d’affaires',
    apresExcedent.r - _c.r === 500 && apresExcedent.c - _c.c === 500,
    `CA +${apresExcedent.r - _c.r}, espèces +${apresExcedent.c - _c.c}, attendu +500`);

  const orphelin = await q(`SELECT count(*)::text c FROM credit_payments
    WHERE sale_id IS NULL AND user_id='${CA}'`);
  check('28n2. le crédit restant de 1 500 est enregistré sans vente rattachée',
    Number(orphelin.rows[0].c) >= 1, `${orphelin.rows[0].c} ligne(s)`);
}

// Un caissier peut encaisser un règlement (il prend l'argent au comptoir), mais
// seulement sur une vente de la boutique — et il ne peut pas écrire dans
// credit_payments directement, ce qui passerait outre la répartition FIFO.
{
  await q(`INSERT INTO auth.users (id, email) VALUES ('${CAISSER2}', 'caisse2@test.local')`);
  await q(`INSERT INTO business_members (owner_id, member_id, member_name, role)
    VALUES ('${CA}', '${CAISSER2}', 'Caissier', 'employee')`);

  await canWrite('28o. un caissier n’écrit pas un versement à la main',
    `INSERT INTO credit_payments (debt_id, user_id, amount, day, method)
     VALUES ('${d2}', '${CA}', 100, current_date, 'cash')`,
    false, CAISSER2);
}

// ════════════════════════════════════════════════════════════════════════════
// Facturation séquentielle — une boutique bloquée ne peut plus vendre
// ════════════════════════════════════════════════════════════════════════════
//
// Le scénario reproduit ici est le pire de l'application : le compteur de
// factures est désaligné, `create_sale()` se prend une violation d'unicité, et
// le commerçant ne peut plus encaisser QUOI QUE CE SOIT. Aucune quantité, aucun
// client, aucun montant ne débloque la boutique.
//
// Chaque test réfute le mécanisme de blocage, pas seulement le symptôme.
console.log('\n▸ Facturation : compteur désaligné');

const FB = 'ffffffff-0000-0000-0000-0000000000fb';
const FB2 = 'ffffffff-0000-0000-0000-000000000fb2';
const FP1 = 'ffffffff-0000-0000-0000-0000000000f1';
const FP2 = 'ffffffff-0000-0000-0000-0000000000f2';
const AN = new Date().getFullYear();

{
  await q(`INSERT INTO auth.users (id, email) VALUES ('${FB}', 'facture@test.local')`);
  await q(`INSERT INTO organizations (id, name, slug, plan, timezone)
    VALUES ('${FB}', 'Boutique facturée', 'boutique-facturee', 'pro', 'Africa/Porto-Novo')`);
  await q(`INSERT INTO products (id, user_id, name, price_sell, price_buy, stock_qty)
    VALUES ('${FP1}', '${FB}', 'Article facturé', 2000, 900, 100)`);
  // La boutique courante doit être FB : create_sale() ne voit que le tenant
  // de l'appelant, et refuserait un produit qui n'est pas le sien.
  await q(`SELECT set_config('request.jwt.claim.sub', '${FB}', false)`);
}

const vendreFB = async (qte = 1) => {
  const r = await q(
    `SELECT create_sale('[{"product_id":"${FP1}","quantity":${qte}}]'::jsonb, 'cash')`
  );
  return r.rows[0].create_sale;
};
const compteurFB = async () =>
  Number((await q(`SELECT invoice_counter FROM organizations WHERE id='${FB}'`)).rows[0].invoice_counter);

// Une facture saisie à la main, hors de create_sale() : c'est ainsi qu'une
// boutique se désaligne (rattrapage après incident, restauration, bascule de
// plan). Le compteur reste à 0, la facture portera le 00005.
{
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, invoice_number, amount_received)
    VALUES ('${FB}', 2000, 'cash', 'FAC-${AN}-00005', 2000)`);

  const vente = await vendreFB();
  check('29a. une vente aboutit malgré une facture saisie à la main',
    typeof vente?.invoice_number === 'string', JSON.stringify(vente));
  check('29b. le numéro évite la facture manuelle',
    vente?.invoice_number === `FAC-${AN}-00006`, vente?.invoice_number);
  check('29c. le compteur est remis d\'après la vente',
    await compteurFB() === 6, `compteur ${await compteurFB()}`);
}

// Le cas le plus fréquent : le compteur est en RETARD de plusieurs numéros.
{
  await q(`UPDATE organizations SET invoice_counter = 1 WHERE id='${FB}'`);

  const vente = await vendreFB();
  check('29d. une vente aboutit avec le compteur en retard',
    typeof vente?.invoice_number === 'string', JSON.stringify(vente));
  check('29e. le numéro reprend après le plus haut déjà émis',
    vente?.invoice_number === `FAC-${AN}-00007`, vente?.invoice_number);
  check('29f. le compteur est rattrapé',
    await compteurFB() === 7, `compteur ${await compteurFB()}`);
}

// Le compteur en avance (saut volontaire d'une série) doit être respecté :
// la réparation ne recule JAMAIS un compteur.
{
  await q(`UPDATE organizations SET invoice_counter = 50 WHERE id='${FB}'`);
  const vente = await vendreFB();
  check('29g. un compteur volontairement avancé n\'est pas reculé',
    vente?.invoice_number === `FAC-${AN}-00051`, vente?.invoice_number);
}

// Séquentielité continue : aucune vente ne saute de numéro, sur une série.
{
  const numeros = [];
  for (let i = 0; i < 5; i++) numeros.push((await vendreFB()).invoice_number);
  const attendus = [52, 53, 54, 55, 56].map((n) => `FAC-${AN}-${String(n).padStart(5, '0')}`);
  check('29h. la numérotation reste continue sur cinq ventes',
    JSON.stringify(numeros) === JSON.stringify(attendus), numeros.join(', '));
}

// Une facture au bon gabarit mais hors suite ne doit pas non plus bloquer.
{
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, invoice_number, amount_received)
    VALUES ('${FB}', 2000, 'cash', 'FAC-${AN}-00060', 2000)`);
  await q(`UPDATE organizations SET invoice_counter = 2 WHERE id='${FB}'`);
  const vente = await vendreFB();
  check('29i. une facture hors suite ne bloque pas la vente',
    vente?.invoice_number === `FAC-${AN}-00061`, vente?.invoice_number);
}

// Une facture écrite dans un AUTRE format est ignorée, jamais comptée.
{
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, invoice_number, amount_received)
    VALUES ('${FB}', 2000, 'cash', 'FACTURE-INTERNE-1', 2000)`);
  const vente = await vendreFB();
  check('29j. une facture au format étranger est ignorée',
    vente?.invoice_number === `FAC-${AN}-00062`, vente?.invoice_number);
}

// Une boutique qui n'a jamais facturé CETTE année repart à 1, même si l'année
// d'avant est allée très haut : c'est le comportement attendu, et la
// réparation ne doit surtout pas le « rattraper » vers le haut.
//
// Boutique dédiée : celle de 29a-29j a déjà 62 factures cette année, et il est
// correct qu'elle ne reparte pas à 1. Réutiliser FB rendrait le test faux.
{
  await q(`INSERT INTO auth.users (id, email) VALUES ('${FB2}', 'facture2@test.local')`);
  await q(`INSERT INTO organizations (id, name, slug, plan, timezone)
    VALUES ('${FB2}', 'Boutique janvier', 'boutique-janvier', 'pro', 'Africa/Porto-Novo')`);
  await q(`INSERT INTO products (id, user_id, name, price_sell, price_buy, stock_qty)
    VALUES ('${FP2}', '${FB2}', 'Article de janvier', 2000, 900, 100)`);
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, invoice_number, amount_received)
    VALUES ('${FB2}', 2000, 'cash', 'FAC-${AN - 1}-00099', 2000)`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${FB2}', false)`);

  const nums = [];
  for (let i = 0; i < 2; i++) {
    const r = await q(
      `SELECT create_sale('[{"product_id":"${FP2}","quantity":1}]'::jsonb, 'cash')`
    );
    nums.push(r.rows[0].create_sale?.invoice_number);
  }
  check('29k. l\'année en cours repart à 1 malgré 99 factures l\'an passé',
    nums[0] === `FAC-${AN}-00001` && nums[1] === `FAC-${AN}-00002`, nums.join(', '));
}

// Deux ventes ne doivent pas pouvoir lire le même compteur. La sérialisation
// repose sur le verrou de la ligne organisation (FOR UPDATE), pris dans la
// transaction de la vente.
//
// Ce harnais tourne sur une seule connexion PGlite : les requêtes y sont
// sérialisées, donc la concurrence y est INDÉMONTRABLE — un test ici
// passerait sans rien prouver. Ce qui est vérifiable, c'est que le verrou est
// pris : la fonction tient la ligne organisation ouverte pendant qu'elle lit le
// compteur et le réécrit, ce que la migration garantit en réalignant dans le
// même SELECT ... FOR UPDATE. La preuve de bout en bout demanderait deux
// connexions, hors de ce harnais.

// Le stock doit être descendu par ces ventes : la réparation ne doit pas
// court-circuiter l'écriture de la vente, ni laisser la vente sans effets.
{
  const restant = Number((await q(`SELECT stock_qty FROM products WHERE id='${FP1}'`)).rows[0].stock_qty);
  const vendu = 100 - restant;
  // 29a, 29d, 29g : 1 unité chacune — 29h : 5 — 29i, 29j : 1 chacune.
  check('29l. le stock a bien été décrémenté par ces ventes',
    vendu === 10, `${vendu} unité(s) décrémentée(s), attendu 10`);
}

// ════════════════════════════════════════════════════════════════════════════
// Équipe — gérer ses employés sans clé service role
// ════════════════════════════════════════════════════════════════════════════
//
// Les routes de l'équipe utilisent la clé service, qui contourne toutes les
// règles de sécurité de la base, pour deux opérations seulement : changer un
// rôle, retirer un membre. Ce test vérifie que les fonctions qui les remplacent
// font le même travail — et surtout qu'elles ne laissent personne faire ce que
// la clé service permettait à tout le monde.
//
// Chaque test d'intrusion compte autant que les tests de fonctionnement : une
// fonction SECURITY DEFINER accessible aux clients est une porte, et une
// porte sans serrure est pire que le service role qu'elle remplace.
console.log('\n▸ Équipe : rôle et retrait sans clé service role');

const EQ = 'cccccccc-0000-0000-0000-0000000000e1';
const EQ_EMPLOYE = 'cccccccc-0000-0000-0000-0000000000e2';
const EQ_AUTRUI = 'cccccccc-0000-0000-0000-0000000000e3';
const EQ_CALC = 'cccccccc-0000-0000-0000-0000000000e4';
const EQ_SIEN = 'cccccccc-0000-0000-0000-0000000000e5';

{
  for (const [id, email] of [
    [EQ, 'equipe@test.local'],
    [EQ_EMPLOYE, 'equipe-employe@test.local'],
    [EQ_AUTRUI, 'equipe-tiers@test.local'],
    [EQ_CALC, 'equipe-calculateur@test.local'],
    [EQ_SIEN, 'equipe-sien@test.local'],
  ]) {
    await q(`INSERT INTO auth.users (id, email) VALUES ('${id}', '${email}')`);
  }
  await q(`INSERT INTO organizations (id, name, slug, plan, timezone) VALUES
    ('${EQ}', 'Boutique équipe', 'boutique-equipe', 'pro', 'Africa/Porto-Novo'),
    ('${EQ_AUTRUI}', 'Boutique tierce', 'boutique-tierce', 'pro', 'Africa/Porto-Novo')`);
  // Un membre n'appartient qu'à UNE équipe (idx_business_members_member_id) :
  // l'autre équipe a donc le sien, sinon la donnée de test serait invalide et
  // l'insertion échouerait avant même d'atteindre les fonctions testées.
  await q(`INSERT INTO business_members (owner_id, member_id, member_name, role) VALUES
    ('${EQ}', '${EQ_EMPLOYE}', 'employé', 'employee'),
    ('${EQ}', '${EQ_CALC}',   'calculateur', 'employee'),
    ('${EQ_AUTRUI}', '${EQ_SIEN}', 'employé ailleurs', 'employee')`);
}

// ── Le fonctionnement normal ────────────────────────────────────────────
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ}', false)`);
  const r = await q(`SELECT business_members_set_role('${EQ_EMPLOYE}', 'manager')`);
  check('30a. le patron promeut son employé', r.rows[0].business_members_set_role === true);

  const role = (await q(
    `SELECT role FROM business_members WHERE member_id='${EQ_EMPLOYE}' AND owner_id='${EQ}'`
  )).rows[0]?.role;
  check('30b. le rôle est bien enregistré', role === 'manager', `role = ${role}`);
}

// ── Un rôle inventé ne doit pas être accepté ────────────────────────────
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ}', false)`);
  let msg = '';
  try { await q(`SELECT business_members_set_role('${EQ_EMPLOYE}', 'patron')`); } catch (e) { msg = e.message; }
  check('30c. un rôle hors nomenclature est refusé', /Rôle invalide/.test(msg), msg.slice(0, 80));

  const role = (await q(
    `SELECT role FROM business_members WHERE member_id='${EQ_EMPLOYE}' AND owner_id='${EQ}'`
  )).rows[0]?.role;
  check('30d. le rôle n\'a pas bougé', role === 'manager', `role = ${role}`);
}

// ── L'intrusion : un employé ne gère pas l'équipe ───────────────────────
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ_EMPLOYE}', false)`);
  let msg = '';
  try { await q(`SELECT business_members_set_role('${EQ_CALC}', 'manager')`); } catch (e) { msg = e.message; }
  check('30e. un employé ne promeut pas un collègue', /Employé introuvable/.test(msg), msg.slice(0, 80));

  msg = '';
  try { await q(`SELECT business_members_remove('${EQ_CALC}')`); } catch (e) { msg = e.message; }
  check('30f. un employé ne retire pas un collègue', /Employé introuvable/.test(msg), msg.slice(0, 80));

  // rows[0] peut ne pas exister — c'est précisément le symptôme d'une
  // intrusion réussie. Un assert qui lit une ligne absente planterait le
  // fichier de tests et masquerait tous les contrôles suivants : pire qu'un
  // échec, puisque l'arrêt premature donne l'impression que rien d'autre
  // n'était à vérifier.
  const role = (await q(
    `SELECT role FROM business_members WHERE member_id='${EQ_CALC}' AND owner_id='${EQ}'`
  )).rows[0]?.role;
  check('30g. le collègue est intact', role === 'employee', `role = ${role}`);
}

// ── L'intrusion : un patron étranger ne touche pas cette équipe ────────
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ_AUTRUI}', false)`);
  let msg = '';
  try { await q(`SELECT business_members_remove('${EQ_EMPLOYE}')`); } catch (e) { msg = e.message; }
  check('30h. un patron étranger ne retire pas un employé', /Employé introuvable/.test(msg), msg.slice(0, 80));

  const reste = Number((await q(
    `SELECT count(*) FROM business_members WHERE member_id='${EQ_EMPLOYE}'`
  )).rows[0].count);
  check('30i. l\'employé est toujours là', reste === 1, `${reste} ligne(s)`);
}

// ── Le patron ne se retire pas lui-même de sa propre équipe ────────────
{
  // La base refuse déjà ce cas : le déclencheur business_members_guard
  // (business_members_reject_owner_member) rejette un membre qui possède sa
  // propre boutique. La garde de la fonction est donc une défense en
  // profondeur — mais une défense qui n'a jamais été éprouvée n'est pas une
  // défense. On neutralise le déclencheur le temps du test, puis on le remet.
  await q(`ALTER TABLE business_members DISABLE TRIGGER business_members_guard`);
  await q(`INSERT INTO business_members (owner_id, member_id, member_name, role)
    VALUES ('${EQ}', '${EQ}', 'lui-même', 'employee')`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ}', false)`);

  let msg = '';
  try { await q(`SELECT business_members_remove('${EQ}')`); } catch (e) { msg = e.message; }
  check('30j. le patron ne se retire pas lui-même', /ne peut pas se retirer/.test(msg), msg.slice(0, 80));

  await q(`DELETE FROM business_members WHERE member_id='${EQ}'`);
  await q(`ALTER TABLE business_members ENABLE TRIGGER business_members_guard`);
}

// ── Le retrait libère le poste et épargne le compte ─────────────────────
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EQ}', false)`);

  // Si une intrusion a réussi plus haut, l'employé n'existe plus : on le
  // recrée pour que la section rende son bilan complet au lieu de planter.
  // L'échec, lui, est déjà reporté par 30i.
  const present = Number((await q(
    `SELECT count(*) FROM business_members WHERE member_id='${EQ_EMPLOYE}' AND owner_id='${EQ}'`
  )).rows[0].count);
  if (!present) {
    await q(`INSERT INTO business_members (owner_id, member_id, member_name, role)
      VALUES ('${EQ}', '${EQ_EMPLOYE}', 'employé', 'employee')`);
  }

  const r = await q(`SELECT business_members_remove('${EQ_EMPLOYE}')`);
  check('30k. le patron retire son employé', r.rows[0].business_members_remove === true);

  const reste = Number((await q(
    `SELECT count(*) FROM business_members WHERE member_id='${EQ_EMPLOYE}'`
  )).rows[0].count);
  check('30l. le lien est supprimé', reste === 0, `${reste} ligne(s)`);

  // Le compte Auth doit survivre : organizations et sales partent en CASCADE
  // depuis auth.users. C'est ce qui a détruit une boutique entière par le passé.
  const compte = Number((await q(
    `SELECT count(*) FROM auth.users WHERE id='${EQ_EMPLOYE}'`
  )).rows[0].count);
  check('30m. le compte de l\'employé survit', compte === 1, `${compte} compte(s)`);
}

// ── L'écriture directe reste interdite, même au patron ─────────────────
//
// C'est le cœur du changement : la table n'a toujours AUCUNE écriture client.
// Sans cela, la clé service n'aurait servi à rien — il suffirait d'un client
// malveillant pour écrire directement.
await canWrite(
  '30n. le patron n\'écrit toujours pas directement dans business_members',
  `UPDATE business_members SET role = 'manager' WHERE member_id='${EQ_CALC}'`,
  false,
  EQ
);
await canWrite(
  '30o. le patron ne supprime toujours pas directement un membre',
  `DELETE FROM business_members WHERE member_id='${EQ_CALC}' AND owner_id='${EQ}'`,
  false,
  EQ
);

// ── La lecture, elle, reste possible : c'est ce que l'écran Équipe fait ──
//
// canRead fait son propre assert ; il prend un booléen « visible attendu », pas
// un nombre, d'où le booléen en troisième argument.
await canRead('30p. le patron voit son équipe',
  `SELECT count(*) FROM business_members WHERE owner_id='${EQ}'`, true, EQ);
await canRead('30q. un patron ne voit pas l\'équipe d\'un autre',
  `SELECT count(*) FROM business_members WHERE owner_id='${EQ_AUTRUI}'`, false, EQ);
await canRead('30r. un employé voit son propre lien',
  `SELECT count(*) FROM business_members WHERE member_id='${EQ_CALC}'`, true, EQ_CALC);

// ─── 31. Onboarding guidé et mode simple ──────────────────────
// Trois invariants : (1) les boutiques déjà en service gardent l'interface
// complète, seules les inscriptions à venir naissent en mode simple ; (2) le
// patron peut écrire les trois colonnes de l'assistant — sans le GRANT de
// colonne, l'assistant se bloquait sur « permission denied » ; (3) une boutique
// gratuite lit son carnet de dettes.
console.log('\n▸ Onboarding guidé et mode simple');
{
  // Les sections précédentes ont rejoué migration_security.sql, qui révoque
  // les droits de colonne d'organizations. En production la migration passe
  // après elle : on remet la base dans cet ordre.
  await e(readSql('migration_onboarding_mode.sql'));

  // (1) Simuler le déploiement sur une base en service : la colonne n'existe
  // pas encore et des boutiques sont déjà inscrites.
  await e(`ALTER TABLE organizations DROP COLUMN IF EXISTS ui_mode CASCADE`);
  const existantes = Number((await q(`SELECT count(*) FROM organizations`)).rows[0].count);
  await e(readSql('migration_onboarding_mode.sql'));
  const enComplet = Number((await q(
    `SELECT count(*) FROM organizations WHERE ui_mode = 'full'`)).rows[0].count);
  check('31a. les boutiques existantes restent en mode complet',
    existantes > 0 && enComplet === existantes, `${enComplet}/${existantes}`);

  const NEUVE = '31313131-3131-3131-3131-313131313131';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${NEUVE}', 'neuve@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id, name, slug) VALUES ('${NEUVE}', 'Boutique neuve', 'boutique-neuve')`);
  const mode = (await q(`SELECT ui_mode, plan FROM organizations WHERE id='${NEUVE}'`)).rows[0];
  check('31b. une inscription neuve naît en mode simple', mode.ui_mode === 'beginner', mode.ui_mode);

  // Le rejeu ne doit faire basculer personne.
  await e(readSql('migration_onboarding_mode.sql'));
  const apresRejeu = (await q(`SELECT ui_mode FROM organizations WHERE id='${NEUVE}'`)).rows[0].ui_mode;
  const completsApres = Number((await q(
    `SELECT count(*) FROM organizations WHERE ui_mode = 'full'`)).rows[0].count);
  check('31c. le rejeu ne change le mode de personne',
    apresRejeu === 'beginner' && completsApres === enComplet, `${apresRejeu}, ${completsApres} complets`);

  // (2) Le patron écrit les colonnes de l'assistant, en rôle authenticated.
  await canWrite('31d. le patron enregistre son activité et l\'étape de l\'assistant',
    `UPDATE organizations SET business_type = 'epicerie', onboarding_step = 'samples' WHERE id = '${NEUVE}'`,
    true, NEUVE);
  await canWrite('31e. le patron passe en mode complet',
    `UPDATE organizations SET ui_mode = 'full' WHERE id = '${NEUVE}'`, true, NEUVE);
  await canWrite('31f. … et revient en mode simple',
    `UPDATE organizations SET ui_mode = 'beginner' WHERE id = '${NEUVE}'`, true, NEUVE);
  await canWrite('31g. un autre patron ne change pas le mode de cette boutique',
    `UPDATE organizations SET ui_mode = 'full' WHERE id = '${NEUVE}'`, false, AUTRE_PATRON);

  // Les CHECK : une valeur inventée est refusée, même par le superuser.
  for (const [label, sql] of [
    ['31h. ui_mode inconnu refusé', `UPDATE organizations SET ui_mode = 'expert' WHERE id = '${NEUVE}'`],
    ['31i. activité inconnue refusée', `UPDATE organizations SET business_type = 'grossiste' WHERE id = '${NEUVE}'`],
    ['31j. étape inconnue refusée', `UPDATE organizations SET onboarding_step = 'fin' WHERE id = '${NEUVE}'`],
  ]) {
    let refuse = false;
    try { await q(sql); } catch { refuse = true; }
    check(label, refuse);
  }

  // (3) Le carnet de dettes en plan gratuit : l'appel ne lève plus.
  check('31k. la boutique de test est bien en plan gratuit', mode.plan === 'free', mode.plan);
  await q(`SELECT set_config('request.jwt.claim.sub', '${NEUVE}', false)`);
  await e('SET ROLE authenticated');
  let erreur = '';
  try { await q(`SELECT count(*) FROM get_customer_debts()`); } catch (err) { erreur = err.message; }
  await e('RESET ROLE');
  check('31l. une boutique gratuite lit son carnet de dettes', erreur === '', erreur);
  const def = (await q(
    `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'get_customer_debts'`)).rows[0].d;
  check('31m. get_customer_debts() n\'exige plus le plan Starter', !def.includes('require_feature'));
}

// ─── 32. Numéros béninois à 10 chiffres ────────────────────────
// Depuis fin 2024, un mobile béninois s'écrit 01 + 8 chiffres. Sans indicatif,
// le lien wa.me de la relance ne mène nulle part.
console.log('\n▸ Téléphone béninois à 10 chiffres');
{
  const n = async (v) => (await q(`SELECT normalize_phone('${v}') AS n`)).rows[0].n;
  check('32a. « 01 97 00 00 01 » reçoit l\'indicatif', (await n('01 97 00 00 01')) === '2290197000001');
  check('32b. « +229 01 97 00 00 01 » reste tel quel', (await n('+229 01 97 00 00 01')) === '2290197000001');
  check('32c. l\'ancien format à 8 chiffres est toujours préfixé', (await n('97000001')) === '22997000001');
  check('32d. un numéro ivoirien international n\'est pas touché', (await n('+225 07 07 07 07 07')) === '2250707070707');

  // Réparation des lignes existantes, et le cas qui doit rester intact.
  const TEL = '32323232-3232-3232-3232-323232323232';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${TEL}', 'tel@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id, name, slug) VALUES ('${TEL}', 'Boutique tel', 'boutique-tel')`);
  await q(`INSERT INTO customer_debts (user_id, phone, name) VALUES
    ('${TEL}', '0196000001', 'Ancien format'),
    ('${TEL}', '0196000002', 'Doublon'),
    ('${TEL}', '2290196000002', 'Déjà international')`);
  await e(readSql('migration_telephone_benin.sql'));
  const fiches = (await q(`SELECT name, phone FROM customer_debts WHERE user_id='${TEL}' ORDER BY name`)).rows;
  const tel = (nom) => fiches.find((f) => f.name === nom)?.phone;
  check('32e. une fiche enregistrée sans indicatif est corrigée', tel('Ancien format') === '2290196000001', tel('Ancien format'));
  check('32f. une fiche qui créerait un doublon est laissée telle quelle',
    tel('Doublon') === '0196000002' && tel('Déjà international') === '2290196000002', JSON.stringify(fiches));
}

// ─── 33. Mesure du parcours d'activation ─────────────────────
// La mesure P3 de l'évaluation marketing : inscrits → assistant terminé →
// première vente → ventes en semaine 2 → ventes en semaine 4. Le pilote
// décidera du plafond gratuit, du hors ligne et des prix avec ces chiffres
// là — donc ce qui compte ici, ce sont les FRONTIÈRES : le jour se compte
// en fuseau de boutique (23 h 30 UTC est déjà le lendemain à Porto-Novo),
// la fenêtre est [d0+7, d0+14) exclusive à droite, et une boutique trop
// récente n'est pas « inactive », elle est non évaluable.
console.log('\n▸ Mesure du parcours d’activation');
{
  const NOW = '2026-10-08 10:00:00+00';
  const COHORT = `get_activation_funnel('2026-09-01', '2026-10-08', '${NOW}')`;

  // Cinq boutiques, cinq états différents. On ne touche à aucune existante :
  // la mesure doit refléter les données des autres sections telles quelles.
  const seed = [
    // id, email, nom, créée, assistant terminé
    ['fa000000-0000-4000-8000-00000000000a', 'funnel-a@test.local', 'Funnel A', '2026-09-08 09:00:00+00', true],
    ['fb000000-0000-4000-8000-00000000000b', 'funnel-b@test.local', 'Funnel B', '2026-10-06 09:00:00+00', false],
    ['fc000000-0000-4000-8000-00000000000c', 'funnel-c@test.local', 'Funnel C', '2026-09-20 09:00:00+00', true],
    // Hors cohorte : créée en août, doit rester invisible.
    ['fd000000-0000-4000-8000-00000000000d', 'funnel-d@test.local', 'Funnel D', '2026-08-01 09:00:00+00', true],
    // Frontière de cohorte : 23 h 30 UTC = 00 h 30 le 1er septembre à
    // Porto-Novo. En UTC elle serait hors période ; en jour local, elle y est.
    ['fe000000-0000-4000-8000-00000000000e', 'funnel-e@test.local', 'Funnel E', '2026-08-31 23:30:00+00', false],
    // Maturité exacte : créée le 24 septembre, sa semaine 2 s'achève le
    // 8 octobre — le jour de p_now, pas la veille.
    ['ff000000-0000-4000-8000-00000000000f', 'funnel-f@test.local', 'Funnel F', '2026-09-24 09:00:00+00', true],
  ];
  for (const [id, email, nom, cree, fini] of seed) {
    await q(`INSERT INTO auth.users (id, email) VALUES ('${id}', '${email}') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO organizations (id, name, slug, timezone, created_at, onboarding_done)
             VALUES ('${id}', '${nom}', 'funnel-${id.slice(-1)}', 'Africa/Porto-Novo', '${cree}', ${fini})`);
  }

  // Ventes de A — quatre frontières en une :
  //   10/09 12 h UTC        semaine 1, première vente
  //   14/09 22 h UTC = 23 h locale   → 14 septembre local : encore semaine 1
  //   14/09 23 h 30 UTC = 15/09 00 h 30 locale → premier jour de semaine 2
  //   17/09                 semaine 2, cas courant
  //   01/10                 semaine 4 (fenêtre [29/09, 06/10))
  const vente = (uid, at) =>
    q(`INSERT INTO sales (user_id, total_amount, created_at) VALUES ('${uid}', 1000, '${at}')`);
  for (const at of [
    '2026-09-10 12:00:00+00', '2026-09-14 22:00:00+00', '2026-09-14 23:30:00+00',
    '2026-09-17 10:00:00+00', '2026-10-01 10:00:00+00',
  ]) await vente(seed[0][0], at);
  await vente(seed[2][0], '2026-09-28 10:00:00+00'); // C : semaine 2
  await vente(seed[3][0], '2026-08-05 10:00:00+00'); // D : ne doit jamais apparaître
  await vente(seed[5][0], '2026-10-02 10:00:00+00'); // F : semaine 2, dernier jour

  const one = async (name, cols = '*') =>
    (await q(`SELECT ${cols} FROM ${COHORT} WHERE org_name = '${name}'`)).rows[0] ?? null;

  // 33a — la cohorte : jour local du côté inclus, D hors période. Le filtre
  // ne porte que sur « Funnel % » : les autres boutiques du harnais sont
  // créées « maintenant » et tombent légitimement dans la période — c'est D,
  // créée en août, qui ne doit pas y figurer même sous ce filtre.
  const rows = (await q(
    `SELECT org_name FROM ${COHORT} WHERE org_name LIKE 'Funnel%' ORDER BY org_name`)).rows;
  const noms = rows.map((r) => r.org_name);
  check('33a. la cohorte contient A, B, C, E, F — et pas D (créée en août)',
    JSON.stringify(noms) === JSON.stringify(['Funnel A', 'Funnel B', 'Funnel C', 'Funnel E', 'Funnel F']),
    noms.join(', '));

  const a = await one('Funnel A',
    'onboarding_done, first_sale_at::date::text AS fs, sales_week2, sales_week4, mature_week2, mature_week4');
  check('33b. A : assistant terminé et première vente au bon jour',
    a.onboarding_done === true && a.fs === '2026-09-10', JSON.stringify(a));
  check('33c. A : semaine 2 comptée en jour local (22 h exclue, 23 h 30 incluse)',
    a.sales_week2 === 2, `sales_week2 = ${a.sales_week2}, attendu 2`);
  check('33d. A : semaine 4 comptée, les deux fenêtres sont évaluables',
    a.sales_week4 === 1 && a.mature_week2 === true && a.mature_week4 === true, JSON.stringify(a));

  const b = await one('Funnel B',
    'onboarding_done, first_sale_at, sales_week2, sales_week4, mature_week2, mature_week4');
  check('33e. B : rien du tout, et surtout pas comptée comme inactive',
    b.onboarding_done === false && b.first_sale_at === null &&
    b.sales_week2 === 0 && b.sales_week4 === 0 &&
    b.mature_week2 === false && b.mature_week4 === false, JSON.stringify(b));

  const c = await one('Funnel C',
    'sales_week2, mature_week2, mature_week4');
  check('33f. C : semaine 2 évaluée, semaine 4 encore non évaluable',
    c.sales_week2 === 1 && c.mature_week2 === true && c.mature_week4 === false, JSON.stringify(c));

  const f = await one('Funnel F', 'sales_week2, mature_week2, mature_week4');
  check('33g. F : la maturité naît exactement à d0 + 14 jours',
    f.sales_week2 === 1 && f.mature_week2 === true && f.mature_week4 === false, JSON.stringify(f));

  // 33h — la mesure lit toutes les boutiques : elle ne doit répondre ni à la
  // clé publique, ni à un commerçant connecté. On recrée la fonction À FROID
  // (DROP + fichier) : la section 4 du harnais a GRANTé EXECUTE sur TOUTES
  // les fonctions à authenticated pour tester la RLS, et ce grant masquerait
  // l'effet réel du REVOKE. C'est l'état du fichier — celui qui
  // s'appliquera en production — qui est vérifié ici.
  await e('DROP FUNCTION get_activation_funnel(date, date, timestamptz)');
  await e(readSql('migration_activation_funnel.sql'));
  const sig = 'get_activation_funnel(date, date, timestamptz)';
  const priv = (await q(`
    SELECT has_function_privilege('anon', '${sig}', 'EXECUTE')          AS anon,
           has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth,
           has_function_privilege('service_role', '${sig}', 'EXECUTE')  AS svc`)).rows[0];
  check('33h. à froid : anon et authenticated refusés, service_role autorisé',
    priv.anon === false && priv.auth === false && priv.svc === true, JSON.stringify(priv));

  // 33i — rejouable : le fichier re-collé sur la fonction déjà là ne casse
  // rien et ne bouge pas les résultats (APPLY_MIGRATIONS.sql se rejoue sur
  // une base peuplée).
  await e(readSql('migration_activation_funnel.sql'));
  const apresRejeu = (await q(
    `SELECT count(*)::int AS n FROM ${COHORT} WHERE org_name LIKE 'Funnel%'`)).rows[0].n;
  const a2 = await one('Funnel A', 'sales_week2, sales_week4');
  check('33i. le rejeu laisse la mesure intacte (5 boutiques, A inchangée)',
    apresRejeu === 5 && a2.sales_week2 === 2 && a2.sales_week4 === 1,
    `${apresRejeu} ligne(s), A: ${JSON.stringify(a2)}`);
}

// ─── 34. Mode d'ouverture : installée ou navigateur ─────────
// P2 et P3 se répondent : le relevé du parcours doit dire comment chaque
// pilote ouvre l'application — icône installée ou onglet du navigateur.
// Ce qui compte ici : le mode naît NULL (jamais de DEFAULT sur une colonne
// d'affichage), n'accepte que les deux valeurs mesurables, le droit
// d'écrire vient du GRANT colonne de ce fichier, et la jointure de
// scripts/funnel.mjs porte bien la donnée.
console.log('\n▸ Mode d’ouverture : installée ou navigateur');
{
  // 34a — les deux colonnes existent, sans défaut : NULL = jamais relevé.
  const cols = (await q(`
    SELECT column_name, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organizations'
       AND column_name IN ('display_mode', 'display_mode_at')
     ORDER BY column_name`)).rows;
  check('34a. display_mode et display_mode_at existent, toutes deux sans défaut',
    cols.length === 2 && cols.every((c) => c.column_default === null),
    JSON.stringify(cols));

  // 34b — le CHECK : deux valeurs mesurables, rien d'autre. Une valeur
  // inconnue écraserait la mesure sans jamais échouer ailleurs.
  let msg = '';
  try {
    await q(`UPDATE organizations SET display_mode = 'bureau' WHERE name = 'Funnel A'`);
  } catch (ex) { msg = ex.message; }
  check('34b. une valeur inconnue est refusée par le CHECK',
    /organizations_display_mode_check/.test(msg), msg);

  // 34c — les deux modes s'écrivent, horodatés.
  await e(`UPDATE organizations
             SET display_mode = 'standalone',
                 display_mode_at = '2026-10-08 09:15:00+00'
           WHERE name = 'Funnel A'`);
  await e(`UPDATE organizations SET display_mode = 'navigateur' WHERE name = 'Funnel B'`);
  const modes = (await q(`
    SELECT name, display_mode, display_mode_at::text AS at
      FROM organizations
     WHERE name IN ('Funnel A', 'Funnel B')
     ORDER BY name`)).rows;
  check('34c. A : installée et horodatée ; B : navigateur',
    modes[0]?.display_mode === 'standalone'
      && modes[0]?.at?.startsWith('2026-10-08 09:15')
      && modes[1]?.display_mode === 'navigateur',
    JSON.stringify(modes));

  // 34d — jamais relevé = NULL, pas une valeur inventée.
  const c = (await q(
    `SELECT display_mode, display_mode_at FROM organizations WHERE name = 'Funnel C'`)).rows[0];
  check('34d. une boutique muette reste à NULL, pas à une valeur par défaut',
    c.display_mode === null && c.display_mode_at === null, JSON.stringify(c));

  // 34e — la jointure que fait scripts/funnel.mjs : le relevé du parcours
  // porte le mode (A installée ; C, jamais relevée, transmet son NULL).
  const jointure = (await q(`
    SELECT f.org_name, o.display_mode
      FROM get_activation_funnel('2026-09-01', '2026-10-08', '2026-10-08 10:00:00+00') f
      JOIN organizations o ON o.id = f.org_id
     WHERE f.org_name IN ('Funnel A', 'Funnel C')
     ORDER BY f.org_name`)).rows;
  check('34e. la jointure du relevé porte le mode (A : installée, C : jamais relevée)',
    jointure.length === 2
      && jointure[0].display_mode === 'standalone'
      && jointure[1].display_mode === null,
    JSON.stringify(jointure));

  // 34f — à froid : la section 4 a fait GRANT ALL sur toutes les tables à
  // authenticated, qui masquerait l'absence du GRANT colonne. On ôte les
  // deux formes du droit (large et colonne), puis on rejoue le fichier —
  // c'est son GRANT, et lui seul, qui rend l'écriture possible. anon, lui,
  // n'a jamais rien reçu.
  await e(`REVOKE UPDATE ON organizations FROM authenticated`);
  await e(`REVOKE UPDATE (display_mode, display_mode_at) ON organizations FROM authenticated`);
  const apresRevoke = (await q(`
    SELECT has_column_privilege('authenticated', 'organizations', 'display_mode', 'UPDATE') AS auth`)).rows[0];
  await e(readSql('migration_display_mode.sql'));
  const apresRejeu = (await q(`
    SELECT has_column_privilege('authenticated', 'organizations', 'display_mode', 'UPDATE')       AS auth,
           has_column_privilege('authenticated', 'organizations', 'display_mode_at', 'UPDATE')    AS auth_at,
           has_column_privilege('anon', 'organizations', 'display_mode', 'UPDATE')               AS anon`)).rows[0];
  check('34f. sans le GRANT, authenticated ne peut pas écrire ; le rejeu le rend, anon reste dehors',
    apresRevoke.auth === false
      && apresRejeu.auth === true && apresRejeu.auth_at === true && apresRejeu.anon === false,
    `après revoke: ${JSON.stringify(apresRevoke)}, après rejeu: ${JSON.stringify(apresRejeu)}`);

  // 34g — rejouable : le fichier re-collé ne double pas la contrainte et
  // ne bouge pas les valeurs déjà relevées.
  await e(readSql('migration_display_mode.sql'));
  const rejeu = (await q(`
    SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname = 'organizations_display_mode_check') AS contraintes,
           (SELECT display_mode FROM organizations WHERE name = 'Funnel A') AS mode`)).rows[0];
  check('34g. le rejeu garde une contrainte unique et les valeurs intactes',
    rejeu.contraintes === 1 && rejeu.mode === 'standalone', JSON.stringify(rejeu));
}

// ─── 35. Essai gratuit de 14 jours ────────────────────────────────
// Sprint 19 (freemium, plan 14). L'essai n'écrit jamais organizations.plan :
// le plan brut reste l'affaire du webhook Stripe, l'essai vit à côté dans deux
// colonnes sans aucun GRANT client — start_free_trial() est la seule porte, et
// elle vérifie qui appelle. Trois choses sont à prouver : le patron démarre,
// une seule fois ; le plan UTILE passe starter pendant l'essai (require_feature
// avec lui) puis redescend à l'expiration, sans que le plan brut ait bougé ; et
// le navigateur ne peut pas écrire lui-même sa date de fin.
console.log('\n▸ Essai gratuit de 14 jours');
{
  // 35a — à froid, comme 34f. Trois temps : le prédicat doit d'abord VOIR un
  // droit quand il existe (display_mode, que 34f vient de rendre, et un grant
  // posé à la main sur trial_ends_at) ; on retire tout ; puis on rejoue le
  // fichier. Son GRANT... il n'y en a pas, c'est la thèse : le rejeu ne rend
  // toujours pas le navigateur capable de poser sa propre date de fin.
  const voit = (await q(`
    SELECT has_column_privilege('authenticated', 'organizations', 'display_mode', 'UPDATE') AS display,
           has_column_privilege('authenticated', 'organizations', 'trial_ends_at', 'UPDATE') AS essai`)).rows[0];
  check('35a. le prédicat voit le droit de display_mode (34f), et rien sur trial_ends_at',
    voit.display === true && voit.essai === false, JSON.stringify(voit));

  await e(`GRANT UPDATE (trial_ends_at) ON organizations TO authenticated`);
  const avecGrant = (await q(
    `SELECT has_column_privilege('authenticated', 'organizations', 'trial_ends_at', 'UPDATE') AS essai`)).rows[0];
  await q(`REVOKE UPDATE (trial_ends_at, trial_started_at) ON organizations FROM authenticated`).catch(() => {});
  await q(`REVOKE UPDATE ON organizations FROM authenticated`).catch(() => {});
  await e(readSql('migration_trial.sql'));
  const apresRejeu = (await q(`
    SELECT has_column_privilege('authenticated', 'organizations', 'trial_ends_at', 'UPDATE')   AS auth,
           has_column_privilege('anon', 'organizations', 'trial_started_at', 'UPDATE')         AS anon`)).rows[0];
  check('35a2. un grant à la main se voit ; le rejeu du fichier, lui, ne redonne rien (anon comme authenticated)',
    avecGrant.essai === true && apresRejeu.auth === false && apresRejeu.anon === false,
    `grant: ${JSON.stringify(avecGrant)}, rejeu: ${JSON.stringify(apresRejeu)}`);

  // 35a2 — les colonnes existent, toutes deux sans défaut : NULL = jamais
  // d'essai. Un DEFAULT remplit les boutiques existantes d'un essai déjà joué.
  const cols = (await q(`
    SELECT column_name, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name IN ('trial_started_at', 'trial_ends_at')
     ORDER BY column_name`)).rows;
  check('35a3. deux colonnes, toutes deux sans défaut (NULL = jamais d’essai)',
    cols.length === 2 && cols.every((c) => c.column_default === null),
    JSON.stringify(cols));

  // 35b — le patron démarre : colonnes remplies, fin ≈ 14 jours, et surtout
  // le plan brut n'a pas bougé — l'essai n'est pas un faux paiement.
  const ESSAI = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${ESSAI}', 'essai@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id, name, slug, plan) VALUES ('${ESSAI}', 'Boutique Essai', 'boutique-essai', 'free') ON CONFLICT DO NOTHING`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${ESSAI}', false)`);
  const fin = (await q(`SELECT start_free_trial() AS fin`)).rows[0].fin;
  const jours = (new Date(fin).getTime() - Date.now()) / 86400000;
  const o = (await q(
    `SELECT trial_started_at, trial_ends_at, plan FROM organizations WHERE id = '${ESSAI}'`)).rows[0];
  check('35b. le patron démarre un essai d’environ 14 jours, colonnes remplies, plan brut intact',
    jours > 13 && jours < 15 && o.trial_started_at !== null
      && o.trial_ends_at !== null && o.plan === 'free',
    `jours=${jours.toFixed(2)}, ${JSON.stringify(o)}`);

  // 35c — une seule fois pour toujours : un essai expiré ne se relance pas,
  // sinon le plan gratuit devient illimité par rotation.
  let msg = '';
  try { await q(`SELECT start_free_trial()`); } catch (ex) { msg = ex.message; }
  check('35c. un second essai est refusé (une fois par boutique)',
    /une fois par boutique/.test(msg), msg);

  // 35d — un employé ne démarre pas l'essai de la boutique de son patron :
  // auth.uid() est son propre id, qui n'est la clé d'aucune boutique.
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  msg = '';
  try { await q(`SELECT start_free_trial()`); } catch (ex) { msg = ex.message; }
  check('35d. un employé n’y arrive pas : son id n’est pas une boutique',
    /Boutique introuvable/.test(msg), msg);

  // 35e — une boutique déjà payante non plus : c'est le paiement qui
  // commande, l'essai ne fait que soulever le gratuit.
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  msg = '';
  try { await q(`SELECT start_free_trial()`); } catch (ex) { msg = ex.message; }
  check('35e. une boutique payante ne démarre pas d’essai',
    /déjà sur un plan payant/.test(msg), msg);

  // 35f — l'effet : pendant l'essai, le plan UTILE est starter
  // (require_feature ouvre les rapports) ; expiré, il redescend et les mêmes
  // appels échouent — pendant que le plan brut, lui, dit encore 'free'.
  await q(`SELECT set_config('request.jwt.claim.sub', '${ESSAI}', false)`);
  const pendant = (await q(
    `SELECT current_org_plan() AS p, require_feature('reports') AS r`)).rows[0];
  await e(`UPDATE organizations SET trial_ends_at = now() - interval '1 day' WHERE id = '${ESSAI}'`);
  const apresPlan = (await q(
    `SELECT current_org_plan() AS p, plan AS brut FROM organizations WHERE id = '${ESSAI}'`)).rows[0];
  msg = '';
  try { await q(`SELECT require_feature('reports')`); } catch (ex) { msg = ex.message; }
  check('35f. essai actif → plan utile starter (rapports ouverts) ; expiré → free et rapports refusés, plan brut jamais touché',
    pendant.p === 'starter' && pendant.r === true
      && apresPlan.p === 'free' && apresPlan.brut === 'free'
      && /nécessite le plan starter/.test(msg),
    JSON.stringify({ pendant, apresPlan, msg }));

  // 35g — même en contournant le composant : rôle authenticated, RLS
  // favorable, mais aucun privilège sur la colonne — prolonger son essai à la
  // main échoue avant même la politique.
  await e(`SET ROLE authenticated`);
  msg = '';
  try {
    await q(`UPDATE organizations SET trial_ends_at = now() + interval '1 year' WHERE id = '${ESSAI}'`);
  } catch (ex) { msg = ex.message; }
  await e(`RESET ROLE`);
  check('35g. authenticated ne peut pas prolonger lui-même son essai (permission denied)',
    /permission denied/.test(msg), msg);

  // 35h — la porte n'est pas publique : anon sans exécution, authenticated
  // avec (REVOKE PUBLIC du fichier, vérifié à froid sur anon qui n'a rien
  // reçu entre-temps).
  const fn = (await q(`
    SELECT has_function_privilege('anon', 'start_free_trial()', 'EXECUTE')          AS anon,
           has_function_privilege('authenticated', 'start_free_trial()', 'EXECUTE') AS auth`)).rows[0];
  check('35h. start_free_trial() : anon dehors, authenticated dedans',
    fn.anon === false && fn.auth === true, JSON.stringify(fn));

  // 35i — rejouable : le fichier re-collé ne double ni les colonnes ni les
  // fonctions, et ne remet pas à zéro un essai en cours (ADD COLUMN IF NOT
  // EXISTS, CREATE OR REPLACE — pas de DROP qui détruirait les dates).
  await e(readSql('migration_trial.sql'));
  await e(readSql('migration_trial.sql'));
  const rejeu = (await q(`
    SELECT (SELECT count(*)::int FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'organizations'
               AND column_name IN ('trial_started_at', 'trial_ends_at')) AS colonnes,
           (SELECT count(*)::int FROM pg_proc WHERE proname = 'start_free_trial') AS fns,
           ((SELECT trial_ends_at FROM organizations WHERE id = '${ESSAI}') IS NOT NULL) AS essai_intact`)).rows[0];
  check('35i. le rejeu garde deux colonnes, une fonction, et l’essai en cours',
    rejeu.colonnes === 2 && rejeu.fns === 1 && rejeu.essai_intact === true,
    JSON.stringify(rejeu));
}

// ─── 36. Limites des plans côté serveur ────────────────────────────────
// Sprint 19 : ce qui ne vivait que dans le navigateur. Trois limites, une
// table vide dans le dépôt, et deux principes à verrouiller :
//   • sans quota posé, rien ne se bloque (fail-open) — le mécanisme ne
//     devine jamais une valeur ;
//   • les dettes survivent à la fenêtre d'historique : régler son argent
//     n'est pas un avantage payant (§8 : dettes sur tous les plans).
// Les valeurs ci-dessous sont des FIXTURES de test (2, 5, 30…), jamais
// l'offre : le test prouve le mécanisme, jamais un chiffre.
console.log('\n▸ Limites des plans côté serveur');
{
  const ESSAI = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  // La section 16 a laissé la « Boutique Gratuite » en pro (elle servait à
  // vérifier que Pro accède aux prévisions). Ici c'est l'inverse qu'on
  // teste : on la remet en gratuit, comme au premier jour.
  await e(`UPDATE organizations SET plan = 'free', trial_started_at = NULL, trial_ends_at = NULL
            WHERE id = '${FREE}'`);

  // Rejeu d'entrée : la section 19 a re-collé migration_security.sql, qui
  // porte une version SANS fenêtre de la politique sales (elle est antérieure
  // à cette section). En déploiement réel, migration_plan_config.sql arrive
  // APRÈS — c'est ce rejeu qui rétablit l'ordre réel.
  await e(readSql('migration_plan_config.sql'));

  // 36a — la table est vide : aucune valeur dans le dépôt, aucune valeur
  // dans une migration. C'est scripts/sync-plan-config.mjs qui la remplit.
  const vide = (await q(`SELECT count(*)::int n FROM plan_config`)).rows[0];
  check('36a. plan_config existe et aucune migration n’y pose une valeur',
    vide.n === 0, JSON.stringify(vide));

  // 36a2 — à froid : la section 4 a fait GRANT ALL (l'état d'une base
  // Supabase à la création des tables). On retire tout, on rejoue, et c'est
  // le fichier qui décide : navigateur sans AUCUN accès (même la lecture —
  // les quotas affichés viennent du build, pas de la base), service_role
  // complet pour les scripts.
  await e(`REVOKE ALL ON plan_config FROM anon, authenticated, service_role`);
  await e(readSql('migration_plan_config.sql'));
  const priv = (await q(`
    SELECT has_table_privilege('authenticated', 'plan_config', 'SELECT') AS auth_select,
           has_table_privilege('authenticated', 'plan_config', 'INSERT') AS auth_insert,
           has_table_privilege('anon', 'plan_config', 'SELECT')          AS anon_select,
           has_table_privilege('service_role', 'plan_config', 'SELECT,INSERT,UPDATE,DELETE') AS service`)).rows[0];
  check('36a2. à froid : aucun accès navigateur, service_role complet',
    priv.auth_select === false && priv.auth_insert === false
      && priv.anon_select === false && priv.service === true,
    JSON.stringify(priv));


  // 36b — quota posé (fixture : 2 produits) → refus réel par le trigger,
  // plan et quota nommés dans le message.
  await e(`INSERT INTO plan_config (plan, key, value) VALUES
    ('free',    'products',     2),
    ('free',    'employees',    0),
    ('free',    'history_days', 30),
    ('starter', 'products',     5),
    ('starter', 'employees',    2),
    ('starter', 'history_days', 2147483647),
    ('pro',     'products',     2147483647),
    ('pro',     'employees',    2147483647),
    ('pro',     'history_days', 2147483647)`);
  const insProd = (id, org) =>
    `INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
     VALUES ('${id}', '${org}', 'Article ${id.slice(-4)}', 100, 200, 1)`;
  await e(insProd('f0f0f0f0-0000-4000-8000-00000000000c', FREE)); // la 2e : passe
  let msg = '';
  try { await e(insProd('f0f0f0f0-0000-4000-8000-00000000000d', FREE)); }
  catch (ex) { msg = ex.message; }
  check('36b. quota produit appliqué en base : la 3e ligne est refusée, plan et quota nommés',
    /Limite de produits atteinte pour le plan free \(max 2\)/.test(msg), msg);

  // 36c — fail-open : quota retiré, l'insertion repasse. Le mécanisme ne
  // remplace jamais l'absence de valeur par un nombre inventé. Trois
  // articles, pas quatre : la 3e tentative refusée en 36b a été annulée
  // avec sa transaction, elle n'a jamais atterri.
  await e(`DELETE FROM plan_config WHERE plan = 'free' AND key = 'products'`);
  await e(insProd('f0f0f0f0-0000-4000-8000-00000000000e', FREE));
  const compte = (await q(
    `SELECT count(*)::int n FROM products WHERE user_id = '${FREE}'`)).rows[0];
  check('36c. quota retiré → l’insertion repasse (fail-open), trois articles pour la boutique',
    compte.n === 3, JSON.stringify(compte));

  // 36d — l'essai donne les quotas Starter : plan brut 'free', plafond de
  // starter. On réactive l'essai que la section 35 avait laissé expiré.
  await e(`UPDATE organizations SET trial_ends_at = now() + interval '1 day' WHERE id = '${ESSAI}'`);
  for (let i = 1; i <= 5; i++) {
    await e(insProd(`9e9e9e9e-0000-4000-8000-00000000000${i}`, ESSAI));
  }
  msg = '';
  try { await e(insProd('9e9e9e9e-0000-4000-8000-00000000000f', ESSAI)); }
  catch (ex) { msg = ex.message; }
  check('36d. pendant l’essai, le quota lu est celui de starter (max 5, plan starter)',
    /Limite de produits atteinte pour le plan starter \(max 5\)/.test(msg), msg);

  // 36e — le quota d'équipe, dans les deux tables.
  const PAYANTE = '55555555-5555-4555-8555-555555555555';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${PAYANTE}', 'payante@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id, name, slug, plan) VALUES ('${PAYANTE}', 'Boutique Payante', 'boutique-payante', 'starter') ON CONFLICT DO NOTHING`);
  const inv = (owner, email, token) =>
    `INSERT INTO employee_invitations (owner_id, email, token) VALUES ('${owner}', '${email}', '${token}')`;

  // gratuit : pas d'employé du tout.
  msg = '';
  try { await e(inv(FREE, 'aucun@test.ci', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')); }
  catch (ex) { msg = ex.message; }
  check('36e. plan gratuit : l’invitation est refusée, message sans zéro dénué de sens',
    /ne prend pas d.employ/.test(msg), msg);

  // starter : deux invitations en attente passent, la troisième est refusée.
  await e(inv(PAYANTE, 'une@test.ci', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
  await e(inv(PAYANTE, 'deux@test.ci', 'cccccccccccccccccccccccccccccccc'));
  msg = '';
  try { await e(inv(PAYANTE, 'trois@test.ci', 'dddddddddddddddddddddddddddddddd')); }
  catch (ex) { msg = ex.message; }
  check('36e2. starter : 2 invitations ok, la 3e refusée (les en attente occupent un poste)',
    /Limite du plan starter atteinte : 2 employé\(s\) maximum/.test(msg), msg);

  // l'acceptation ne double-compte pas : redeem_invitation insert le membre
  // AVANT de marquer l'invitation acceptée — seul le décompte « membres »
  // s'applique ici, sinon la personne deviendrait son propre refus.
  await q(`INSERT INTO auth.users (id, email) VALUES ('99999999-9999-4999-8999-999999999999', 'nouveau@test.ci') ON CONFLICT DO NOTHING`);
  await e(`INSERT INTO business_members (owner_id, member_id, member_name)
            VALUES ('${PAYANTE}', '99999999-9999-4999-8999-999999999999', 'Nouveau')`);
  const membres = (await q(
    `SELECT count(*)::int n FROM business_members WHERE owner_id = '${PAYANTE}'`)).rows[0];
  check('36e3. l’acceptation passe : le membre entre alors que ses 2 invitations sont encore en attente',
    membres.n === 1, JSON.stringify(membres));

  // 36f — la fenêtre d'historique, et ce qu'elle n'emporte PAS.
  await e(`INSERT INTO sales (id, user_id, total_amount, amount_received, settled, created_at) VALUES
    ('abababab-0000-4000-8000-000000000001', '${FREE}',  9000, 9000, true, now() - interval '40 days'),
    ('abababab-0000-4000-8000-000000000002', '${FREE}',  7000, 7000, true, now() - interval '5 days'),
    ('abababab-0000-4000-8000-000000000005', '${ESSAI}', 8000, 8000, true, now() - interval '40 days')`);
  // La vieille dette : client_phone obligatoire pour une vente non soldée
  // (CHECK sales_credit_needs_phone), et payment_method='credit' pour que
  // fill_amount_received() laisse amount_received à 0 — une vente « cash »
  // à 0 serait re-remplie à plein prix et la dette paraîtrait réglée.
  await e(`INSERT INTO sales (id, user_id, total_amount, amount_received, payment_method, settled, client_phone, created_at)
           VALUES ('abababab-0000-4000-8000-000000000003', '${FREE}', 5000, 0, 'credit', false, '97111111', now() - interval '40 days')`);
  await e(`INSERT INTO sales (id, user_id, total_amount, amount_received, settled, created_at)
           VALUES ('abababab-0000-4000-8000-000000000004', '${PATRON}', 12000, 12000, true, now() - interval '40 days')`);
  await e(`INSERT INTO customer_debts (user_id, phone, name) VALUES ('${FREE}', '97111111', 'Vieux Client') ON CONFLICT DO NOTHING`);
  await e(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal) VALUES
    ('abababab-0000-4000-8000-000000000001', 'f0f0f0f0-0000-4000-8000-00000000000b', 'Article gratuit', 1, 10000, 10000),
    ('abababab-0000-4000-8000-000000000002', 'f0f0f0f0-0000-4000-8000-00000000000b', 'Article gratuit', 1, 7000, 7000)`);

  // Lecture en rôle authenticated (la RLS ne s'applique vraiment qu'alors :
  // le harnais tourne en superuser).
  await e(`SET ROLE authenticated`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
  const vues = (await q(
    `SELECT id::text FROM sales WHERE user_id = '${FREE}'`)).rows.map((r) => r.id);
  const items = (await q(`
    SELECT si.sale_id::text FROM sale_items si
     WHERE si.sale_id IN ('abababab-0000-4000-8000-000000000001',
                          'abababab-0000-4000-8000-000000000002')`)).rows.map((r) => r.sale_id);
  const dettes = (await q(`SELECT phone, total_due FROM get_customer_debts()`)).rows;

  // essai actif (36d) : fenêtre de starter, malgré un plan brut 'free'.
  await q(`SELECT set_config('request.jwt.claim.sub', '${ESSAI}', false)`);
  const essaiVues = (await q(
    `SELECT id::text FROM sales WHERE user_id = '${ESSAI}'`)).rows.map((r) => r.id);

  // plan payant : toute l'histoire — le quota 2147483647 compris, borné en
  // date par within_plan_history (sinon « timestamp out of range »).
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  const patronVues = (await q(
    `SELECT id::text FROM sales WHERE user_id = '${PATRON}'`)).rows.map((r) => r.id);
  await e(`RESET ROLE`);

  const dette = dettes.find((d) => d.phone === '97111111');
  check('36f. gratuit : la payée vieille disparaît, la récente reste, la dette vieille reste (règlement ≠ avantage payant)',
    vues.includes('abababab-0000-4000-8000-000000000002')
      && vues.includes('abababab-0000-4000-8000-000000000003')
      && !vues.includes('abababab-0000-4000-8000-000000000001')
      && items.length === 1 && items[0] === 'abababab-0000-4000-8000-000000000002'
      && dette !== undefined && Number(dette.total_due) === 5000,
    JSON.stringify({ vues, items, dettes, dette }));

  check('36f2. essai → fenêtre starter ; plan payant → tout l’historique, illimité compris, sans erreur de date',
    essaiVues.length === 1
      && essaiVues[0] === 'abababab-0000-4000-8000-000000000005'
      && patronVues.includes('abababab-0000-4000-8000-000000000004'),
    JSON.stringify({ essaiVues, patronVues }));

  // 36f3 — anon : vide, surtout pas d'erreur. Sans SECURITY DEFINER sur
  // within_plan_history, la politique mourrait sur les privilèges de
  // plan_config (révoqués aux navigateurs) — une ERREUR là où le visiteur
  // déconnecté obtenait un résultat vide. On donne d'abord à anon les
  // privilèges de table d'une vraie base Supabase (la section 4 n'accorde
  // qu'à authenticated ; c'est RLS, pas privilèges, qui filtre anon).
  await e(`GRANT USAGE ON SCHEMA public TO anon`);
  await e(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon`);
  await e(`SET ROLE anon`);
  await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  let anonN = -1;
  let anonOk = true;
  try { anonN = (await q(`SELECT count(*)::int n FROM sales`)).rows[0].n; }
  catch (ex) { anonOk = false; anonN = ex.message; }
  await e(`RESET ROLE`);
  check('36f3. anon : zéro ligne et zéro erreur de privilège dans la politique',
    anonOk && anonN === 0, JSON.stringify(anonN));

  // 36g — l'export n'est pas qu'un bouton : le mapping « exportCsv » →
  // starter vit dans require_feature(), et c'est LUI que devront appeler les
  // routes d'export du Sprint 21. Les données qui remplissent un export sont
  // déjà fenêtrées par la politique (36f) ; ce test garantit que la
  // fonctionnalité elle-même refuse en base, pas seulement dans l'écran —
  // et qu'elle suit l'essai, comme tout ce qui lit le plan.
  await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
  let msgExport = '';
  try { await q(`SELECT require_feature('exportCsv')`); }
  catch (ex) { msgExport = ex.message; }
  check('36g. exportCsv refusé en plan gratuit par la base elle-même',
    /exportCsv.*plan starter/i.test(msgExport), msgExport || 'ACCEPTÉ !');

  await e(`UPDATE organizations SET trial_started_at = now(),
            trial_ends_at = now() + interval '1 day'
            WHERE id = '${FREE}'`);
  let essaiExport = false;
  try { essaiExport = (await q(`SELECT require_feature('exportCsv') x`)).rows[0].x === true; }
  catch { essaiExport = false; }
  check('36g2. pendant l’essai, exportCsv est ouvert (le verrou lit le plan effectif)',
    essaiExport === true, String(essaiExport));

  await e(`UPDATE organizations SET trial_started_at = now() - interval '15 days',
            trial_ends_at = now() - interval '1 day'
            WHERE id = '${FREE}'`);
  let msgApres = '';
  try { await q(`SELECT require_feature('exportCsv')`); }
  catch (ex) { msgApres = ex.message; }
  check('36g3. essai expiré : refermé, malgré des colonnes de trial remplies',
    /exportCsv/i.test(msgApres), msgApres || 'ACCEPTÉ !');
  await e(`UPDATE organizations SET trial_started_at = NULL, trial_ends_at = NULL
            WHERE id = '${FREE}'`);

  // 36h — rejouable : trois triggers, la politique de sales, et les quotas
  // déjà posés intacts (la migration ne réécrit pas la configuration).
  await e(readSql('migration_plan_config.sql'));
  const rejeu = (await q(`
    SELECT (SELECT count(*)::int FROM pg_trigger
             WHERE tgname IN ('enforce_product_limit', 'enforce_employee_limit', 'enforce_member_limit')
               AND NOT tgisinternal) AS triggers,
           (SELECT count(*)::int FROM pg_policies
             WHERE policyname = 'user_sales_select' AND tablename = 'sales') AS politiques,
           (SELECT value FROM plan_config WHERE plan = 'free' AND key = 'history_days') AS quota_histoire`)).rows[0];
  check('36h. le rejeu garde 3 triggers, la politique de sales, et les quotas posés',
    rejeu.triggers === 3 && rejeu.politiques === 1 && rejeu.quota_histoire === 30,
    JSON.stringify(rejeu));
}

// ─── 37. Périodes prépayées Mobile Money ───────────────────────────────
// Sprint 19, sans clé de prestataire : la base ne connaît que les COMMANDES
// et leur activation. Ce qui est vérifié ici, dans l'ordre du cycle de vie :
//   • activation → plan + échéance, puis idempotence (webhook rejoué) et
//     prolongation (1 mois puis 3 = 4, pas « depuis maintenant ») ;
//   • échéance → TOUT retombe en gratuit, y compris les quotas appliqués
//     par le trigger lui-même, puisque tout luit current_org_plan() ;
//   • l'essai n'est jamais éteint par une échéance résiduelle ;
//   • le navigateur lit SES commandes et rien d'autre, n'écrit rien, et
//     n'appelle jamais l'activation ; anon n'a rien du tout.
// Montants (7777) et quotas (4) sont des FIXTURES de test, jamais l'offre.
console.log('\n▸ Périodes prépayées Mobile Money');
{
  // Rejeu d'entrée : la section 35 a re-collé migration_trial.sql, qui
  // remet current_org_plan() sans échéance ; la section 36 a re-collé
  // migration_plan_config.sql. Ce fichier arrive juste après les deux dans
  // l'ORDER — ce rejeu rétablit l'ordre réel du déploiement.
  await e(readSql('migration_mobilemoney.sql'));

  await e(`UPDATE organizations
             SET plan = 'free', trial_started_at = NULL, trial_ends_at = NULL,
                 plan_valid_until = NULL
           WHERE id = '${FREE}'`);

  // 37a — première commande : activée en service_role (le rôle que la route
  // callback utilise réellement), le plan et son échéance suivent.
  await e(`INSERT INTO payment_orders (user_id, plan, period_months, amount, provider, reference)
           VALUES ('${FREE}', 'starter', 1, 7777, 'sandbox', 'ref-37a')`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
  let actA = null, actErr = '';
  await e(`SET ROLE service_role`);
  try { actA = (await q(`SELECT activate_prepaid_plan('ref-37a') x`)).rows[0].x; }
  catch (ex) { actErr = ex.message; }
  await e(`RESET ROLE`);
  const etatA = (await q(
    `SELECT plan, plan_valid_until FROM organizations WHERE id = '${FREE}'`)).rows[0];
  const utileA = (await q(`SELECT current_org_plan() p`)).rows[0].p;
  // Comparaison en timestamps, pas « delta en jours − intervalle en mois » :
  // extract(epoch) compte un mois pour 30 jours, l'écart affichait toujours
  // un ou deux jours d'écart artificiel.
  const ecartA = (await q(`
    SELECT abs(extract(epoch FROM plan_valid_until - (now() + interval '1 month')))::int s
      FROM organizations WHERE id = '${FREE}'`)).rows[0].s;
  check('37a. commande activée : plan starter, échéance à ~1 mois, plan effectif starter',
    actA === true && etatA.plan === 'starter' && utileA === 'starter' && ecartA < 86400,
    JSON.stringify({ actA, actErr, utileA, ecartA, etatA }));

  // 37b — idempotence : les prestataires rejouent leurs webhooks ; une
  // seconde activation doit dire « déjà payée » sans ajouter un mois.
  let actB = null, actErrB = '';
  await e(`SET ROLE service_role`);
  try { actB = (await q(`SELECT activate_prepaid_plan('ref-37a') x`)).rows[0].x; }
  catch (ex) { actErrB = ex.message; }
  await e(`RESET ROLE`);
  const etatB = (await q(
    `SELECT plan_valid_until FROM organizations WHERE id = '${FREE}'`)).rows[0];
  check('37b. webhook rejoué : « payée » encore true, échéance strictement inchangée',
    actB === true && +new Date(etatB.plan_valid_until) === +new Date(etatA.plan_valid_until),
    JSON.stringify({ actB, actErrB, avant: etatA.plan_valid_until, apres: etatB.plan_valid_until }));

  // 37c — prolongation : renouveler le même plan AJOUTE à la période en
  // cours. 1 mois puis 3 ≈ 4 mois depuis maintenant, pas 3 depuis aujourd'hui.
  await e(`INSERT INTO payment_orders (user_id, plan, period_months, amount, provider, reference)
           VALUES ('${FREE}', 'starter', 3, 7777, 'sandbox', 'ref-37c')`);
  let actC = null, actErrC = '';
  await e(`SET ROLE service_role`);
  try { actC = (await q(`SELECT activate_prepaid_plan('ref-37c') x`)).rows[0].x; }
  catch (ex) { actErrC = ex.message; }
  await e(`RESET ROLE`);
  const ecartC = (await q(`
    SELECT abs(extract(epoch FROM plan_valid_until - (now() + interval '4 months')))::int s
      FROM organizations WHERE id = '${FREE}'`)).rows[0].s;
  check('37c. prolongation : 1 mois puis 3 = ~4 mois depuis l’activation initiale',
    actC === true && ecartC < 86400, JSON.stringify({ actC, actErrC, ecartC }));

  // 37d — échéance passée : tout retombe en gratuit. Trois miroirs du même
  // plan utile doivent dire la même chose — current_org_plan(), le verrou
  // require_feature(), et le trigger de quota (qui applique alors le quota
  // gratuit, fixture 4 : le 4e article passe, le 5e est refusé).
  await e(`UPDATE organizations SET plan_valid_until = now() - interval '1 second'
            WHERE id = '${FREE}'`);
  const utileD = (await q(`SELECT current_org_plan() p`)).rows[0].p;
  let msgD = '';
  try { await q(`SELECT require_feature('exportCsv')`); }
  catch (ex) { msgD = ex.message; }

  await e(`INSERT INTO plan_config (plan, key, value) VALUES ('free', 'products', 4)
             ON CONFLICT (plan, key) DO UPDATE SET value = 4`);
  let quatreOk = false, cinqMsg = '';
  try {
    await e(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('7a7a7a7a-0000-4000-8000-000000000001', '${FREE}', '4e article prépayé', 1, 2, 1)`);
    quatreOk = true;
  } catch (ex) { cinqMsg = ex.message; }
  let refusCinq = false;
  try {
    await e(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('7a7a7a7a-0000-4000-8000-000000000002', '${FREE}', '5e article prépayé', 1, 2, 1)`);
  } catch (ex) { refusCinq = /atteinte|maximum/i.test(ex.message); cinqMsg = ex.message; }
  check('37d. échéance : plan effectif gratuit, export refusé, quota gratuit appliqué par le trigger',
    utileD === 'free' && /exportCsv/i.test(msgD) && quatreOk && refusCinq,
    JSON.stringify({ utileD, msgD, quatreOk, cinqMsg }));

  // 37e — la coexistence essai/échéance : plan BRUT gratuit + essai actif +
  // échéance résiduelle d'une période d'avant. La branche échéance exige un
  // plan brut payant, elle ne touche donc jamais à l'essai.
  await e(`UPDATE organizations
             SET plan = 'free', trial_ends_at = now() + interval '10 days',
                 plan_valid_until = now() - interval '3 days'
           WHERE id = '${FREE}'`);
  const utileE = (await q(`SELECT current_org_plan() p`)).rows[0].p;
  check('37e. essai actif malgré une échéance résiduelle : le gratuit brut protège l’essai',
    utileE === 'starter', utileE);

  // 37f — le navigateur lit SES commandes, et n'écrit rien : les privilèges
  // (pas seulement la RLS) refusent, donc l'erreur est nette et non un
  // « 0 ligne » silencieux. anon n'a même pas la lecture.
  await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
  await e(`SET ROLE authenticated`);
  let insErr = '', updErr = '', delErr = '', vues = -1;
  try {
    await e(`INSERT INTO payment_orders (user_id, plan, period_months, amount, provider, reference)
             VALUES ('${FREE}', 'starter', 1, 1, 'sandbox', 'ref-37f')`);
  } catch (ex) { insErr = ex.message; }
  try { await e(`UPDATE payment_orders SET status = 'paid' WHERE reference = 'ref-37a'`); }
  catch (ex) { updErr = ex.message; }
  try { await e(`DELETE FROM payment_orders WHERE reference = 'ref-37a'`); }
  catch (ex) { delErr = ex.message; }
  try { vues = (await q(`SELECT count(*)::int n FROM payment_orders`)).rows[0].n; }
  catch (ex) { vues = ex.message; }
  await e(`RESET ROLE`);
  const anonSelect = (await q(
    `SELECT has_table_privilege('anon', 'payment_orders', 'SELECT') x`)).rows[0].x;
  check('37f. navigateur : lecture de SES commandes seule, écriture refusée, anon rien',
    /permission denied/i.test(insErr) && /permission denied/i.test(updErr)
      && /permission denied/i.test(delErr) && vues === 2 && anonSelect === false,
    JSON.stringify({ insErr, updErr, delErr, vues, anonSelect }));

  // 37g — l'activation n'est pas appelable depuis le navigateur : EXECUTE
  // révoqué à authenticated. C'est la route webhook, vérifiée, qui appelle.
  await e(`SET ROLE authenticated`);
  let svcErr = '';
  try { await q(`SELECT activate_prepaid_plan('ref-37a')`); }
  catch (ex) { svcErr = ex.message; }
  await e(`RESET ROLE`);
  check('37g. activation interdite au navigateur (EXECUTE service_role seulement)',
    /permission denied/i.test(svcErr), svcErr || 'ACCEPTÉE !');

  // 37h — un employé de la boutique ne voit AUCUNE commande : la policy
  // compare à auth.uid(), pas au patron, contrairement à la plupart des
  // tables de ce dépôt — les commandes n'affairent pas à l'équipe.
  const CAISSIER = '88888888-8888-4888-8888-888888888837';
  await e(`INSERT INTO auth.users (id, email) VALUES ('${CAISSIER}', 'caissier37@test.ci') ON CONFLICT DO NOTHING`);
  await e(`INSERT INTO business_members (owner_id, member_id, member_name)
             VALUES ('${FREE}', '${CAISSIER}', 'Caissier 37')`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${CAISSIER}', false)`);
  await e(`SET ROLE authenticated`);
  let employeVues = -1;
  try { employeVues = (await q(`SELECT count(*)::int n FROM payment_orders`)).rows[0].n; }
  catch (ex) { employeVues = ex.message; }
  await e(`RESET ROLE`);
  check('37h. un employé ne voit aucune commande',
    employeVues === 0, JSON.stringify(employeVues));

  // 37i — rejeu : ALTER IF NOT EXISTS, DROP puis CREATE (trigger et
  // policy), CREATE OR REPLACE — deux fois de suite sans bouger l'état.
  await e(readSql('migration_mobilemoney.sql'));
  await e(readSql('migration_mobilemoney.sql'));
  const rejeu37 = (await q(`
    SELECT (SELECT count(*)::int FROM information_schema.columns
             WHERE table_name = 'payment_orders') AS colonnes,
           (SELECT count(*)::int FROM pg_trigger
             WHERE tgrelid = 'payment_orders'::regclass AND NOT tgisinternal) AS triggers,
           (SELECT count(*)::int FROM pg_policies
             WHERE tablename = 'payment_orders') AS politiques`)).rows[0];
  check('37i. double rejeu : 14 colonnes, 1 trigger, 1 politique — rien ne se duplique',
    rejeu37.colonnes === 14 && rejeu37.triggers === 1 && rejeu37.politiques === 1,
    JSON.stringify(rejeu37));
}

// ─── 38. Relances automatiques (P6) ───────────────────────────────
console.log('\n▸ Relances automatiques (rappel programmé, Starter+)');
{
  await e(readSql('migration_relances.sql'));

  // 38a — la table naît fermée : aucun accès navigateur, service complet ;
  // les deux fonctions sont exécutables par authenticated.
  const priv38 = (await q(`
    SELECT has_table_privilege('authenticated', 'relance_suivi', 'SELECT') AS auth_select,
           has_table_privilege('anon', 'relance_suivi', 'SELECT')          AS anon_select,
           has_table_privilege('service_role', 'relance_suivi', 'SELECT,INSERT,UPDATE,DELETE') AS service,
           has_function_privilege('authenticated', 'dettes_a_relancer()', 'EXECUTE') AS f_r,
           has_function_privilege('authenticated', 'marquer_relance(uuid)', 'EXECUTE') AS f_m`)).rows[0];
  check('38a. relance_suivi fermée au navigateur, service complet, fonctions exécutables',
    priv38.auth_select === false && priv38.anon_select === false
      && priv38.service === true && priv38.f_r === true && priv38.f_m === true,
    JSON.stringify(priv38));

  // États de départ explicites : les sections précédentes ont laissé FREE
  // payant et ESSAI expiré — la section ne doit rien supposer.
  await e(`UPDATE organizations
             SET plan = 'free', trial_started_at = NULL, trial_ends_at = NULL,
                 plan_valid_until = NULL
           WHERE id = '${FREE}'`);
  const REL = '42424242-4242-4424-8424-424242424242';
  const EXP = '43434343-4343-4434-8434-434343434343';
  const ESSAI = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${REL}','relances@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug,plan) VALUES ('${REL}','Boutique Relances','boutique-relances','starter') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO auth.users (id,email) VALUES ('${EXP}','echue@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug,plan,plan_valid_until) VALUES ('${EXP}','Boutique Échue','boutique-echue','starter', now() - interval '1 day') ON CONFLICT DO NOTHING`);
  // Plans explicites après insertion : le trigger du programme bêta réécrit
  // le plan à la création (compte servi → pro), et sales.settled naît à TRUE
  // (les ventes existantes sont encaissées). Sans ces deux lignes, la section
  // testerait le programme bêta, pas les relances.
  await e(`UPDATE organizations SET plan = 'starter', trial_started_at = NULL,
             trial_ends_at = NULL, plan_valid_until = NULL WHERE id = '${REL}'`);
  await e(`UPDATE organizations SET plan = 'starter', trial_started_at = NULL,
             trial_ends_at = NULL, plan_valid_until = now() - interval '1 day'
           WHERE id = '${EXP}'`);

  // Une vieille dette par org (10 jours, 5000 dus, NON SOLDÉE) + une dette
  // récente (2 jours) pour REL. Téléphones distincts : aucune diaphonie.
  const vieille = (org, tel) => `
    INSERT INTO customer_debts (user_id, phone, name)
      VALUES ('${org}', '${tel}', 'Client ${tel.slice(-4)}')
      ON CONFLICT DO NOTHING;
    INSERT INTO sales (user_id, total_amount, amount_received, payment_method, client_phone, settled, created_at)
      VALUES ('${org}', 5000, 0, 'credit', '${tel}', false, now() - interval '10 days')`;
  await e(vieille(FREE, '22991000002'));
  await e(vieille(REL, '22991000001'));
  await e(vieille(EXP, '22991000004'));
  await e(`INSERT INTO customer_debts (user_id, phone, name)
             VALUES ('${REL}', '22991000003', 'Client récent') ON CONFLICT DO NOTHING`);
  await e(`INSERT INTO sales (user_id, total_amount, amount_received, payment_method, client_phone, settled, created_at)
             VALUES ('${REL}', 3000, 0, 'credit', '22991000003', false, now() - interval '2 days')`);
  const detteRel = (await q(
    `SELECT id FROM customer_debts WHERE user_id='${REL}' AND phone='22991000001'`)).rows[0].id;

  // 38b — verrou de plan : le gratuit voit ses dettes (get_customer_debts,
  // sans verrou) mais ne reçoit aucun rappel programmé.
  await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
  const autoFree = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  const manuelFree = (await q(`SELECT count(*)::int n FROM get_customer_debts()`)).rows[0];
  check('38b. plan gratuit : aucun rappel programmé, carnet manuel intact',
    autoFree.n === 0 && manuelFree.n >= 1, JSON.stringify({ autoFree, manuelFree }));

  // 38c — starter : la vieille dette sort, avec son âge ; la récente non.
  await q(`SELECT set_config('request.jwt.claim.sub', '${REL}', false)`);
  const cand = (await q(`SELECT * FROM dettes_a_relancer()`)).rows;
  check('38c. starter : 1 candidate (la vieille de 10 jours), la récente exclue',
    cand.length === 1 && Number(cand[0].total_due) === 5000
      && Number(cand[0].total_paid) === 0 && cand[0].jours >= 10,
    JSON.stringify(cand));

  // 38d — le tap Relancer journalise : la dette disparaît des candidates.
  const marque = (await q(`SELECT marquer_relance('${detteRel}') m`)).rows[0].m;
  const apres = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  check('38d. marquer_relance() → true, la dette sort des candidates',
    marque === true && apres.n === 0, JSON.stringify({ marque, apres }));

  // 38e — 7 jours plus tard (log vieilli), elle ressurgit : le rappel est
  // programmé, pas unique.
  await e(`UPDATE relance_suivi SET last_reminded_at = now() - interval '8 days'
           WHERE debt_id = '${detteRel}'`);
  const retour = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  check('38e. relance vieille de 8 jours : la dette redevient candidate',
    retour.n === 1, JSON.stringify(retour));

  // 38f — essai en cours = starter : rappels reçus ; essai expiré = free :
  // plus rien. Même org ESSAI, même vieille dette, seul le temps change.
  await e(vieille(ESSAI, '22991000005'));
  await e(`UPDATE organizations SET trial_started_at = now() - interval '1 day',
             trial_ends_at = now() + interval '13 days' WHERE id = '${ESSAI}'`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${ESSAI}', false)`);
  const enEssai = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  await e(`UPDATE organizations SET trial_ends_at = now() - interval '1 day' WHERE id = '${ESSAI}'`);
  const expire = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  check('38f. essai actif → 1 candidate ; essai expiré → 0',
    enEssai.n === 1 && expire.n === 0, JSON.stringify({ enEssai, expire }));

  // 38g — plan payant échu : current_org_plan() retombe à free, aucun rappel.
  await q(`SELECT set_config('request.jwt.claim.sub', '${EXP}', false)`);
  const planExp = (await q(`SELECT current_org_plan() p`)).rows[0].p;
  const autoExp = (await q(`SELECT count(*)::int n FROM dettes_a_relancer()`)).rows[0];
  check('38g. période échue : plan effectif free, aucun rappel',
    planExp === 'free' && autoExp.n === 0, JSON.stringify({ planExp, autoExp }));

  // 38h — isolation : journaliser la dette d'une autre boutique ment
  // poliment (false), sans rien écrire.
  await q(`SELECT set_config('request.jwt.claim.sub', '${REL}', false)`);
  const detteEtrangere = (await q(
    `SELECT id FROM customer_debts WHERE user_id='${FREE}' LIMIT 1`)).rows[0].id;
  const ment = (await q(`SELECT marquer_relance('${detteEtrangere}') m`)).rows[0].m;
  const trace = (await q(
    `SELECT count(*)::int n FROM relance_suivi WHERE debt_id='${detteEtrangere}'`)).rows[0];
  check('38h. dette étrangère : false, aucune trace écrite',
    ment === false && trace.n === 0, JSON.stringify({ ment, trace }));
}

// ─── 39. Triggers de quotas exercés en authenticated ────────────────
// Le bug prod du Sprint 19 : check_product_limit() et check_employee_limit()
// lisaient plan_config en INVOKER — superuser au harnais, 403 « permission
// denied » en production à chaque création de produit et chaque invitation.
// Les sections 36-37 ne faisaient que constater les privilèges ; ici on
// EXERCE les triggers dans le rôle du navigateur.
{
  await e(readSql('migration_plan_definer.sql'));

  const TRIG = '39393939-3939-4393-8393-393939393939';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${TRIG}','triggers@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug,plan) VALUES ('${TRIG}','Boutique Triggers','boutique-triggers','free') ON CONFLICT DO NOTHING`);
  await e(`UPDATE organizations SET plan = 'free', trial_started_at = NULL,
             trial_ends_at = NULL, plan_valid_until = NULL WHERE id = '${TRIG}'`);
  // Quotas déterministes : les sections précédentes ont vidé/retouché la table.
  await e(`DELETE FROM plan_config`);
  await e(`INSERT INTO plan_config (plan, key, value) VALUES
    ('free', 'products', 2),
    ('free', 'employees', 0),
    ('free', 'history_days', 30),
    ('starter', 'products', 2147483647),
    ('starter', 'employees', 2147483647),
    ('starter', 'history_days', 2147483647),
    ('pro', 'products', 2147483647),
    ('pro', 'employees', 2147483647),
    ('pro', 'history_days', 2147483647)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${TRIG}', false)`);
  await e(`SET ROLE authenticated`);

  // 39a — le trigger lit les quotas DANS le rôle du navigateur : deux
  // produits passent (le bug répondait 403 dès le premier).
  let passe39 = true, detail39 = '';
  try {
    await q(`INSERT INTO products (user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('${TRIG}', 'Article 39a-1', 100, 200, 1),
                    ('${TRIG}', 'Article 39a-2', 100, 200, 1)`);
  } catch (ex) { passe39 = false; detail39 = ex.message; }
  check('39a. en authenticated : 2 produits sous quota passent (plus de 403)',
    passe39, detail39);

  // 39b — le 3e est refusé PAR LE QUOTA, avec son message — pas par un privilège.
  let msg39 = '';
  try {
    await q(`INSERT INTO products (user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('${TRIG}', 'Article 39b', 100, 200, 1)`);
  } catch (ex) { msg39 = ex.message; }
  check('39b. en authenticated : le 3e est refusé par le quota, nommé dans le message',
    /Limite de produits atteinte pour le plan free \(max 2\)/.test(msg39)
      && !/permission denied/i.test(msg39), msg39);

  // 39c — l'invitation est refusée PAR LE PLAN (0 employé en gratuit), pas en 403.
  let msg39c = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${TRIG}', 'qui@test.ci', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`);
  } catch (ex) { msg39c = ex.message; }
  check('39c. en authenticated : invitation refusée par le plan, pas par un privilège',
    /ne prend pas d.employ/.test(msg39c) && !/permission denied/i.test(msg39c), msg39c);

  // 39d — fail-open DANS le rôle du navigateur : sans ligne posée, ça passe.
  await e(`RESET ROLE`);
  await e(`DELETE FROM plan_config WHERE plan = 'free' AND key = 'products'`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${TRIG}', false)`);
  await e(`SET ROLE authenticated`);
  let passe39d = true, detail39d = '';
  try {
    await q(`INSERT INTO products (user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('${TRIG}', 'Article 39d', 100, 200, 1)`);
  } catch (ex) { passe39d = false; detail39d = ex.message; }
  check('39d. en authenticated : quota retiré → insertion repasse (fail-open)',
    passe39d, detail39d);
  await e(`RESET ROLE`);
}

// ═══ 40. Sessions de caisse ═════════════════════════════════
console.log('\n▸ Sessions de caisse');
{
  const CS = 'aaaaaaaa-0000-0000-0000-0000000000cc';
  await q(`INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
           VALUES ('${CS}', '${PATRON}', 'Test caisse', 'CAISSE', 100, 1000, 50, 1)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

  // 40a. Ouverture. `SELECT * FROM f()` (et non `SELECT (f()).*`) : dans
  // PGlite, la seconde forme évalue la fonction une fois PAR COLONNE, donc la
  // 2ᵉ évaluation voit déjà la caisse ouverte. PostgREST, lui, utilise la
  // première forme — c'est donc celle-ci qui reflète le vrai appel client.
  const ouv = (await q(`SELECT * FROM open_cash_session(5000)`)).rows[0];
  check('40a. ouverture : fond 5000, caisse ouverte',
    Number(ouv.opening_float) === 5000 && ouv.closed_at === null, JSON.stringify(ouv));

  // 40b. Une seconde caisse ouverte est refusée (un seul tiroir par boutique).
  let double = '';
  try { await q(`SELECT open_cash_session(1000)`); } catch (ex) { double = ex.message; }
  check('40b. une seconde caisse ouverte est refusée', /déjà ouverte/i.test(double), double);

  // 40c-40e. Vente espèces de 2 × 1000 = 2000, puis clôture à 7000.
  await q(`SELECT create_sale('[{"product_id":"${CS}","quantity":2}]'::jsonb, 'cash')`);
  const fer = (await q(`SELECT * FROM close_cash_session(7000)`)).rows[0];
  check('40c. attendu = fond (5000) + espèces (2000)', Number(fer.expected_cash) === 7000, `attendu ${fer.expected_cash}`);
  check('40d. écart nul quand le compté correspond', Number(fer.difference) === 0, `écart ${fer.difference}`);
  check('40e. la caisse est fermée', fer.closed_at !== null);

  // 40f. Re-clôturer est refusé : plus aucune caisse ouverte.
  let reclose = '';
  try { await q(`SELECT close_cash_session(7000)`); } catch (ex) { reclose = ex.message; }
  check('40f. re-clôture refusée', /Aucune caisse ouverte/i.test(reclose), reclose);

  // 40g. Un écart est bien signé : fond 1000 + 1000 vendus, compté 1900 → −100.
  await q(`SELECT open_cash_session(1000)`);
  await q(`SELECT create_sale('[{"product_id":"${CS}","quantity":1}]'::jsonb, 'cash')`);
  const fer2 = (await q(`SELECT * FROM close_cash_session(1900)`)).rows[0];
  check('40g. écart négatif détecté', Number(fer2.difference) === -100, `écart ${fer2.difference}`);

  // 40h-40i. RLS : l'employé lit la caisse, mais aucune écriture directe.
  await canRead('40h. employé lit la caisse', `SELECT count(*) FROM cash_sessions`, true, EMPLOYE);
  await canWrite('40i. insertion directe refusée',
    `INSERT INTO cash_sessions (user_id, opened_by, opening_float)
     VALUES ('${PATRON}', '${PATRON}', 1)`, false, PATRON);
}

// ═══ 41. Bons de commande fournisseur ═══════════════════════
console.log('\n▸ Bons de commande fournisseur');
{
  const PO = 'aaaaaaaa-0000-0000-0000-0000000000dd';
  const F  = 'bbbbbbbb-0000-0000-0000-0000000000dd';
  await q(`INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
           VALUES ('${PO}', '${PATRON}', 'Test commande', 'CMD', 100, 1000, 3, 1)`);
  await q(`INSERT INTO suppliers (id, user_id, name) VALUES ('${F}', '${PATRON}', 'Grossiste Test')`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

  const oid = (await q(
    `SELECT create_purchase_order('${F}',
       '[{"product_id":"${PO}","quantity":10,"unit_cost":80}]'::jsonb, 'Commande test') AS id`
  )).rows[0].id;
  check('41a. commande créée', !!oid);
  check('41b. statut initial « ordered »',
    (await q(`SELECT status FROM purchase_orders WHERE id='${oid}'`)).rows[0].status === 'ordered');
  check('41c. le stock NE bouge PAS à la création', (await stock(PO)) === 3, `stock ${await stock(PO)}`);

  await q(`SELECT receive_purchase_order('${oid}')`);
  check('41d. réception : stock +10 (3 → 13)', (await stock(PO)) === 13, `stock ${await stock(PO)}`);
  check('41e. statut « received »',
    (await q(`SELECT status FROM purchase_orders WHERE id='${oid}'`)).rows[0].status === 'received');
  check('41f. journal de stock écrit (restock)',
    (await count(`SELECT count(*) FROM stock_logs WHERE reference_id='${oid}' AND movement_type='restock'`)) === 1);

  let double = '';
  try { await q(`SELECT receive_purchase_order('${oid}')`); } catch (ex) { double = ex.message; }
  check('41g. double réception refusée', /plus en attente/i.test(double), double);

  await canRead('41h. employé lit les commandes', `SELECT count(*) FROM purchase_orders`, true, EMPLOYE);
  await canWrite('41i. insertion directe refusée',
    `INSERT INTO purchase_orders (user_id, status) VALUES ('${PATRON}', 'ordered')`, false, PATRON);
}

// ═══ 42. Retours / avoirs ════════════════════════════════════
console.log('\n▸ Retours / avoirs');
{
  const RT = 'dddddddd-0000-0000-0000-000000000042';
  await q(`INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
           VALUES ('${RT}', '${PATRON}', 'Test retour', 'RET', 100, 1000, 10, 1)`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

  const saleId = (await q(
    `SELECT create_sale('[{"product_id":"${RT}","quantity":2}]'::jsonb, 'cash') AS v`
  )).rows[0].v.id;
  check('42a. vente de 2 (stock 10 → 8)', (await stock(RT)) === 8, `stock ${await stock(RT)}`);

  // Retour partiel d'1 unité.
  const r = (await q(
    `SELECT return_sale('${saleId}', '[{"product_id":"${RT}","quantity":1}]'::jsonb, 'cassé') AS r`
  )).rows[0].r;
  check('42b. retour : montant rendu 1000', Number(r.amount) === 1000, `montant ${r.amount}`);
  check('42c. stock remis (8 → 9)', (await stock(RT)) === 9, `stock ${await stock(RT)}`);
  check('42d. amount_received réduit (2000 → 1000)',
    Number((await q(`SELECT amount_received FROM sales WHERE id='${saleId}'`)).rows[0].amount_received) === 1000);
  check('42e. journal de retour écrit',
    (await count(`SELECT count(*) FROM stock_logs WHERE movement_type='return' AND reference_id='${r.return_id}'`)) === 1);

  let trop = '';
  try {
    await q(`SELECT return_sale('${saleId}', '[{"product_id":"${RT}","quantity":2}]'::jsonb)`);
  } catch (ex) { trop = ex.message; }
  check('42f. retour supérieur au reste dû refusé', /supérieur/i.test(trop), trop);

  await q(`SELECT return_sale('${saleId}', '[{"product_id":"${RT}","quantity":1}]'::jsonb)`);
  check('42g. retour total : stock 10, amount_received 0',
    (await stock(RT)) === 10 &&
    Number((await q(`SELECT amount_received FROM sales WHERE id='${saleId}'`)).rows[0].amount_received) === 0);

  const vc = (await q(
    `SELECT record_credit_sale('[{"product_id":"${RT}","quantity":1}]'::jsonb, 'Client X', '97000000') AS v`
  )).rows[0].v;
  let creditRefus = '';
  try {
    await q(`SELECT return_sale('${vc.id}', '[{"product_id":"${RT}","quantity":1}]'::jsonb)`);
  } catch (ex) { creditRefus = ex.message; }
  check('42h. retour sur vente à crédit refusé', /crédit/i.test(creditRefus), creditRefus);

  await canRead('42i. employé lit les retours', `SELECT count(*) FROM sale_returns`, true, EMPLOYE);
  await canWrite('42j. insertion directe refusée',
    `INSERT INTO sale_returns (user_id, sale_id, amount) VALUES ('${PATRON}', '${saleId}', 1)`, false, PATRON);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
