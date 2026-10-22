/**
 * Parcours fonctionnels : on agit comme un commerçant et on vérifie que la
 * suite des gestes produit l'effet attendu — pas seulement que l'écran
 * s'affiche.
 *
 * Chaque étape est un couple (action, vérification). L'action est faite au
 * navigateur ; la vérification porte sur ce que voit l'utilisateur ET sur ce
 * qui a été écrit en base, parce que la plupart des bugs de cette application
 * sont « l'écran dit que c'est bon, la base dit le contraire ».
 *
 *   node qa/parcours.mjs <email> <motdepasse> [retail|restaurant]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , EMAIL = '', PASSWORD = '', PROFIL = 'retail'] = process.argv;
if (!EMAIL || !PASSWORD) {
  console.error('usage: node qa/parcours.mjs <email> <motdepasse> [retail|restaurant]');
  process.exit(1);
}

// Projet Supabase ciblé : celui de .env.local (le même que l'app testée), jamais
// une adresse codée en dur — un script QA ne doit pas écrire dans la production
// par accident. Surchargeable par QA_SUPABASE_URL / QA_SUPABASE_KEY.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // Pas de .env.local : on s'en remet aux variables d'environnement ci-dessous.
}

const BASE = process.env.QA_BASE ?? 'http://localhost:3001';
const SUPA = process.env.QA_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const CLE = process.env.QA_SUPABASE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
if (!SUPA || !CLE) {
  console.error("✗ QA_SUPABASE_URL / QA_SUPABASE_KEY introuvables (ni dans l'environnement, ni dans .env.local).");
  process.exit(2);
}

const resultats = [];
let echecs = 0;

function verifie(nom, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) echecs++;
  const ligne = `${ok ? '✓' : '✗'} ${nom}${detail && !ok ? ` — ${detail}` : ''}`;
  resultats.push(ligne);
  console.log(ligne);
  return ok;
}

const navigateur = await chromium.launch();
const contexte = await navigateur.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'fr-FR',
  timezoneId: 'Africa/Porto-Novo',
});
const page = await contexte.newPage();

const erreursReseau = [];
page.on('pageerror', (e) => erreursReseau.push(e.message.slice(0, 150)));

await page.goto(BASE + '/connexion', { waitUntil: 'domcontentloaded' });
// Saisie au clavier après hydratation : voir qa/audit.mjs (même piège).
const champEmail = page.locator('#login-email, input[type="email"]').first();
await champEmail.waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(1500);
await champEmail.click();
await champEmail.pressSequentially(EMAIL, { delay: 15 });
const champMdp = page.locator('#login-mdp, input[type="password"]').first();
await champMdp.click();
await champMdp.pressSequentially(PASSWORD, { delay: 15 });
await page.click('button[type="submit"]');
await page.waitForSelector('button[aria-label="Accueil"]', { timeout: 30000 });
await page.waitForTimeout(1500);

/** Session et appels directs à la base, pour vérifier ce que l'écran cache. */
const jeton = await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    const v = localStorage.getItem(k);
    if (v && v.includes('access_token')) return JSON.parse(v).access_token;
  }
  return null;
});

async function base(sqlOuRequete) {
  return page.evaluate(
    async ([url, cle, token, requete]) => {
      const reponse = await fetch(`${url}${requete}`, {
        headers: { apikey: cle, authorization: `Bearer ${token}` },
      });
      return reponse.json();
    },
    [SUPA, CLE, jeton, sqlOuRequete]
  );
}

const onglet = async (nom) => {
  await fermerBoite();
  await page.locator(`button[aria-label="${nom}"]`).first().click();
  await page.waitForTimeout(2500);
};

/**
 * Ferme tout ce qui flotte : reçu, fiche produit, réapprovisionnement.
 *
 * Base UI garde le voile dans le DOM avec data-open tant que la boîte est
 * ouverte, et son overlay intercepte alors tous les clics de la page. Sans
 * cette fermeture, l'étape suivante échoue sur un délai de 30 s et l'audit
 * s'arrête sur le premier encountered, sans dire pourquoi.
 */
async function fermerBoite() {
  // Deux familles coexistent : les boîtes Base UI (reçu), montées dans un
  // portal et marquées data-slot, et les modales maison (fiche produit,
  // réappro, inventaire), un simple `div.fixed.inset-0.z-50`. Les deux
  // laissent un voile qui intercepte tous les clics de la page.
  const fermeurs = page.locator(
    '[data-slot="dialog-content"] button:has-text("Fermer"), [data-slot="dialog-content"] button:has-text("Annuler"), [data-slot="dialog-close"], .fixed.inset-0.z-50 button[aria-label="Fermer"]'
  );
  for (let i = 0; i < 4; i++) {
    if (!(await fermeurs.first().isVisible().catch(() => false))) break;
    await fermeurs.first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

const texte = () => page.evaluate(() => document.body.innerText);

/**
 * Attend qu'un texte apparaisse à l'écran, au lieu d'espérer un délai fixe.
 *
 * Un délai fixe marche jusqu'au jour où la machine est chargée : le reçu n'est
 * pas encore monté, `texte()` renvoie le squelette de la page, et le test
 * échoue sur un écran qui finira par s'afficher — un échec qui ment sur la
 * cause. Ce même pas instable a fait échouer « le reçu distingue la vente à
 * crédit » une fois sur quatre, sans qu'aucune ligne de l'application change.
 *
 * L'attente est bornée : au terme du délai on rend ce qui a été vu, et
 * l'assertion échoue donc pour de bon si le texte n'est jamais arrivé.
 */
const attendTexte = async (motif, delai = 15000) => {
  const fin = Date.now() + delai;
  let vu = '';
  while (Date.now() < fin) {
    vu = await texte();
    if (motif.test(vu)) return vu;
    await page.waitForTimeout(400);
  }
  return vu;
};
const panier = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) =>
      String(d.className).includes('lg:w-80')
    );
    return el ? el.innerText.replace(/\n+/g, ' | ') : '';
  });

// ─── Caisse : une vente complète, de la ligne au reçu ────────────────
await onglet('Caisse');
await page.waitForTimeout(2000);

// Une ligne à prix négocié, en quantité décimale : c'est le chemin le plus
// long (le serveur fige le coût, le prix convenu et l'unité du produit).
// Cible pilihan dans le catalogue RÉELLEMENT affiché, plutôt qu'un nom en
// dur : « RIZ » existe dans un commerce de téléphone, pas dans un maquis.
// On prend la première ligne qui porte un stock — un plat n'a pas de stock
// propre, son prix de vente n'est donc pas comparable à celui du produit.
const cible = await page.evaluate(() => {
  const liste = document.querySelector('.divide-y.divide-slate-100');
  const lignes = [...liste.children].map((b, i) => ({ i, texte: b.innerText.replace(/\n+/g, ' ') }));
  const avecStock = lignes.find((l) => /Stock :/.test(l.texte) && !/Rupture/.test(l.texte));
  const prix = avecStock ? Number((avecStock.texte.match(/([\d\s]+)\s?F\s*$/) || [])[1]?.replace(/\s/g, '')) : 0;
  const nom = avecStock ? avecStock.texte.split(/\s+Stock :/)[0].trim() : '';
  return { index: avecStock?.i ?? -1, nom, prix };
});
verifie('la caisse liste un produit stocké', cible.index >= 0 && cible.prix > 0, JSON.stringify(cible));

const prixUnit = cible.prix;
const nomCible = cible.nom;
const quantite = 2.5;
const prixNegocie = Math.round(prixUnit / 2);
const totalAttendu = prixNegocie * quantite;

if (cible.index >= 0) {
  await page.locator('.divide-y.divide-slate-100 > button').nth(cible.index).click();
  await page.waitForTimeout(600);

  // Quantité décimale à la virgule — le pavé d'un téléphone béninois.
  const champQty = page.locator(`input[aria-label="Quantité pour ${nomCible}"]`);
  await champQty.fill('2,5');
  await page.waitForTimeout(600);
  const apresVirgule = await panier();
  verifie('la quantité « 2,5 » est acceptée (virgule)', /2[,.]5/.test(apresVirgule), apresVirgule.slice(0, 160));
  const attenduDecimal = new Intl.NumberFormat('fr-FR').format(prixUnit * quantite);
  verifie(
    `le total suit la quantité décimale (${prixUnit} × 2,5 = ${attenduDecimal})`,
    new RegExp(attenduDecimal.replace(/\s/g, '\\s')).test(apresVirgule),
    apresVirgule.slice(0, 200)
  );

  // Prix négocié
  const champPrix = page.locator(`input[aria-label="Prix unitaire négocié pour ${nomCible}"]`);
  await champPrix.fill(String(prixNegocie));
  await page.waitForTimeout(600);
  const apresRemise = await panier();
  verifie(
    `le prix négocié (${prixNegocie} F) remplace le prix catalogue`,
    new RegExp(new Intl.NumberFormat('fr-FR').format(totalAttendu).replace(/\s/g, '\\s')).test(apresRemise),
    apresRemise.slice(0, 200)
  );

  // Prix aberrant : refusé, l'ancien prix reste
  await champPrix.fill('-5');
  await page.waitForTimeout(400);
  const apresNegatif = await panier();
  verifie(
    'un prix négatif est refusé, le prix négocié reste',
    new RegExp(new Intl.NumberFormat('fr-FR').format(totalAttendu).replace(/\s/g, '\\s')).test(apresNegatif),
    apresNegatif.slice(0, 200)
  );

  const stockAvant = await base('/rest/v1/products?select=name,stock_qty&limit=200');
  const produitAvant = stockAvant.find((p) => p.name === nomCible);
  const stockInitial = Number(produitAvant?.stock_qty);

  // Encaissement espèces avec monnaie à rendre
  await page.locator('input[aria-label="Montant donné"], input[type="number"]').last().fill('5000');
  await page.waitForTimeout(500);
  const avecMonnaie = await panier();
  const monnaie = 5000 - totalAttendu;
  verifie(
    `la monnaie à rendre est annoncée (${monnaie} F)`,
    monnaie > 0 &&
      new RegExp(new Intl.NumberFormat('fr-FR').format(monnaie).replace(/\s/g, '\\s')).test(avecMonnaie),
    avecMonnaie.slice(-160)
  );

  await page.locator('button:has-text("Encaisser")').first().click();
  const recu = await attendTexte(/Vente enregistrée/);
  verifie('le reçu confirme la vente', /Vente enregistrée/.test(recu), recu.slice(0, 200));
  verifie('le panier est vidé après la vente', /Cliquez sur un produit/.test(await panier()));

  // Ce que la base dit : stock descendu de 2,5, prix figé au prix négocié.
  // sale_items n'a pas de colonne date : on repart donc de l'identifiant de
  // la VENTE. Une requête directe sur sale_items ramenait une ancienne ligne
  // du même produit, et le test comparait le mauvais enregistrement.
  const derniereVente = (await base('/rest/v1/sales?select=id&order=created_at.desc&limit=1'))[0];
  const lignes = await base(
    `/rest/v1/sale_items?select=product_name,quantity,unit_price,subtotal,unit_cost,list_price&sale_id=eq.${derniereVente.id}`
  );
  const ligne = lignes.find((l) => l.product_name === nomCible);
  verifie(
    `la ligne de vente porte la quantité décimale (${nomCible} : 2,5)`,
    Number(ligne?.quantity) === 2.5,
    JSON.stringify(ligne)
  );
  verifie(
    `le prix négocié est conservé en base (${prixNegocie} F)`,
    Number(ligne?.unit_price) === prixNegocie,
    JSON.stringify(ligne)
  );
  verifie(
    `le prix catalogue est mémorisé à part (${prixUnit} F)`,
    Number(ligne?.list_price) === prixUnit,
    JSON.stringify(ligne)
  );

  const stockApres = await base('/rest/v1/products?select=name,stock_qty&limit=200');
  const produitApres = stockApres.find((p) => p.name === nomCible);
  verifie(
    `le stock baisse de la quantité vendue (${stockInitial} → ${produitApres?.stock_qty})`,
    Number(produitApres.stock_qty) === stockInitial - 2.5,
    JSON.stringify(produitApres)
  );

  // Numéro de facture : unique et croissant.
  //
  // Réservé au plan Pro payé — create_sale() ne numérote que si le plan
  // EFFECTIF est « pro » (migration_facture_plan_effectif.sql). Sur un compte
  // gratuit, l'absence de numéro est le comportement attendu : le signaler
  // comme un échec ferait chercher un bug qui n'existe pas.
  const [org] = await base('/rest/v1/organizations?select=plan,plan_valid_until');
  const proPaye = org?.plan === 'pro' && (!org.plan_valid_until || new Date(org.plan_valid_until) > new Date());
  const factures = await base('/rest/v1/sales?select=invoice_number&order=created_at.desc&limit=5');
  const numeros = factures.map((s) => s.invoice_number).filter(Boolean);
  if (proPaye) {
    verifie('chaque vente reçoit un numéro de facture', numeros.length >= 1, JSON.stringify(numeros));
    verifie('les numéros de facture sont uniques', new Set(numeros).size === numeros.length, JSON.stringify(numeros));
  } else {
    console.log('  — numéro de facture : réservé au plan Pro (compte gratuit), non vérifié');
    verifie('aucun numéro de facture sur un compte gratuit', numeros.length === 0, JSON.stringify(numeros));
  }
}

// ─── « Reprendre la dernière vente » ────────────────────────────────
await fermerBoite();
const reprise = page.locator('button:has-text("Reprendre la dernière vente")');
if (await reprise.isVisible().catch(() => false)) {
  await reprise.click();
  await page.waitForTimeout(900);
  const apresReprise = await panier();
  verifie('reprendre la dernière vente la recharge au panier', !/Cliquez sur un produit/.test(apresReprise), apresReprise.slice(0, 120));
} else {
  resultats.push('— pas de « Reprendre la dernière vente » (aucune vente antérieure)');
}

// ─── Journal du jour : le chiffre d'affaires suit l'encaissement ─────
await onglet('Ventes');
await page.waitForTimeout(4000);
const journal = await texte();
const apresVente = await base('/rest/v1/sales?select=total_amount,amount_received&order=created_at.desc&limit=1');
const derniere = apresVente[0];
verifie(
  `le journal affiche le CA encaissé de la dernière vente (${derniere?.amount_received} F)`,
  journal.includes(new Intl.NumberFormat('fr-FR').format(Number(derniere?.amount_received ?? 0))),
  journal.slice(0, 300)
);

// ─── Une vente à crédit entre-t-elle dans le CA ? ────────────────────
await onglet('Caisse');
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const liste = document.querySelector('.divide-y.divide-slate-100');
  liste.children[0].click();
});
await page.waitForTimeout(700);
await page.locator('button:has-text("Crédit")').first().click();
await page.waitForTimeout(500);
await page.fill('input[aria-label="Nom du client"]', 'Client QA');
await page.fill('input[aria-label="Téléphone du client"]', '+229 97 00 00 00');
await page.waitForTimeout(400);
const boutonCredit = await page.locator('button:has-text("Céder à crédit")').first().innerText().catch(() => '');
verifie('le bouton de crédit annonce le montant', /Céder à crédit\s?\d/.test(boutonCredit), boutonCredit);
await page.locator('button:has-text("Céder à crédit")').first().click();
const recuCredit = await attendTexte(/Vente cédée à crédit/);
verifie('le reçu distingue la vente à crédit', /Vente cédée à crédit/.test(recuCredit), recuCredit.slice(0, 200));
verifie('le reçu annonce le reste à recouvrer', /à recouvrer/.test(recuCredit), recuCredit.slice(0, 300));

// Le crédit ne doit PAS gonfler le CA : c'est la promesse de l'écran Dettes.
const credit = await base('/rest/v1/sales?select=payment_method,total_amount,amount_received&order=created_at.desc&limit=1');
verifie(
  'une vente à crédit est enregistrée avec amount_received = 0',
  Number(credit[0].amount_received) === 0 && credit[0].payment_method === 'credit',
  JSON.stringify(credit[0])
);

await onglet('Dettes');
const dettes = await attendTexte(/Client QA/);
verifie('la vente à crédit apparaît au carnet de dette', /Client QA/.test(dettes), dettes.slice(0, 300));

// ─── Un règlement de dette change-t-il le CA ? ──────────────────────
const champMontant = page.locator('input[aria-label^="Montant encaissé"]').first();
if (await champMontant.isVisible().catch(() => false)) {
  await champMontant.fill('500');
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Encaisser")').first().click();
  await page.waitForTimeout(4000);
  const apresReglement = await base('/rest/v1/credit_payments?select=amount,method,gesture_id&order=created_at.desc&limit=20');
  // Un versement est ventilé en une ligne par vente soldée : le geste se lit
  // au gesture_id, pas à la ligne (migration_ca_caisse.sql). Un client qui a
  // deux ventes ouvertes reçoit donc 500 F en deux lignes (200 + 300) : c'est
  // le total du geste qui vaut 500, pas la dernière ligne.
  const geste = apresReglement[0]?.gesture_id;
  const totalGeste = apresReglement
    .filter((p) => p.gesture_id === geste)
    .reduce((s, p) => s + Number(p.amount), 0);
  verifie(
    `le règlement de 500 F est enregistré (dernier geste : ${totalGeste} F)`,
    totalGeste === 500,
    JSON.stringify(apresReglement.slice(0, 3))
  );
  const dettesApres = await texte();
  verifie('le solde du client diminue après règlement', !/à recouvrer/.test(dettesApres) || dettesApres.includes('Client QA'));
} else {
  resultats.push('— aucun champ de règlement visible');
}

// ─── Stock : réapprovisionnement ─────────────────────────────────────
await onglet('Stock');
await page.waitForTimeout(2500);

const produitsAvantRappro = await base('/rest/v1/products?select=name,stock_qty&limit=200');
// On clique le premier bouton de réappro et on relit le nom qu'il annonce :
// c'est du même coup la vérification que les boutons d'action sont nommés.
const boutonRappro = page.locator('button[aria-label^="Réapprovisionner"]').first();
const libelleRappro = (await boutonRappro.getAttribute('aria-label')) ?? '';
const nomProduit = libelleRappro.replace(/^Réapprovisionner\s*/, '');
await boutonRappro.click();
await page.waitForTimeout(900);
const modaleRappro = await page.evaluate(() => {
  const m = document.querySelector('.fixed.inset-0.z-50');
  return m ? m.innerText.replace(/\n+/g, ' | ') : '';
});
verifie("la modale de réappro s'ouvre", modaleRappro.length > 0, modaleRappro.slice(0, 150));
verifie(
  `le bouton de réappro nomme le produit (« ${nomProduit} »)`,
  nomProduit.length > 0 && modaleRappro.includes(nomProduit),
  `libellé : ${libelleRappro}`
);

if (modaleRappro) {
  const stockAvant = produitsAvantRappro.find((p) => p.name === nomProduit)?.stock_qty;

  const champQte = page.locator('.fixed.inset-0.z-50 input[type="number"]').first();
  if (await champQte.isVisible().catch(() => false)) {
    await champQte.fill('7');
    await page.waitForTimeout(300);
    await page.locator('.fixed.inset-0.z-50 form button[type="submit"]').first().click();
    // On attend l'effet, pas un délai fixe : une fonction serverless à froid
    // peut écrire après le délai, et le test échouait alors sur une
    // application qui avait simplement fini après lui.
    let trouve = null;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(700);
      const apres = await base('/rest/v1/products?select=name,stock_qty&limit=200');
      trouve = apres.find((p) => p.name === nomProduit);
      if (trouve && Number(trouve.stock_qty) === Number(stockAvant) + 7) break;
    }
    verifie(
      `le réappro de 7 augmente le stock de « ${nomProduit} » (${stockAvant} → ${trouve?.stock_qty})`,
      trouve && Number(trouve.stock_qty) === Number(stockAvant) + 7,
      JSON.stringify(trouve)
    );
  } else {
    resultats.push('— aucun champ de quantité dans la modale de réappro');
  }
}
await fermerBoite();

// ─── Un produit créé depuis le formulaire ───────────────────────────
await fermerBoite();
const produitsAvant = (await base('/rest/v1/products?select=id&limit=200')).length;
await page.locator('button:has-text("Ajouter")').first().click();
await page.waitForTimeout(900);
const modale = page.locator('.fixed.inset-0.z-50');

// On cible par identifiant, pas par position : la position change dès qu'un
// champ est ajouté, et une saisie décalée d'un cran passe inaperçue
// (prix d'achat dans prix de vente) ou bloque le formulaire.
const nomProduitQA = `Produit QA ${Date.now() % 100000}`;
await modale.locator('#pf-nom').fill(nomProduitQA);
await modale.locator('#pf-prix-achat').fill('1500');
await modale.locator('#pf-prix-vente').fill('2500');
await modale.locator('#pf-stock').fill('12');
await modale.locator('button:has-text("Ajouter le produit")').first().click();

// Même raison que pour le réappro : on attend l'effet en base.
let produitsApres = [];
let cree = null;
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(700);
  produitsApres = await base('/rest/v1/products?select=id,name,price_buy,price_sell,stock_qty&limit=200');
  cree = produitsApres.find((p) => p.name === nomProduitQA);
  if (cree) break;
}
verifie(
  'le produit créé est bien enregistré',
  produitsApres.length === produitsAvant + 1 && Boolean(cree),
  `${produitsAvant} → ${produitsApres.length}`
);
verifie(
  'les prix et le stock saisis sont ceux enregistrés',
  cree && Number(cree.price_buy) === 1500 && Number(cree.price_sell) === 2500 && Number(cree.stock_qty) === 12,
  JSON.stringify(cree)
);

// ─── Le même rayon ne doit pas se dédoubler ─────────────────────────
await fermerBoite();
await page.locator('button:has-text("Ajouter")').first().click();
await page.waitForTimeout(900);
await modale.locator('#pf-nom').fill('Produit catégorie QA');
await modale.locator('#pf-categorie').fill('smartphones');
await page.waitForTimeout(600);
const pastillesSmartphones = await page.evaluate(() => {
  const m = document.querySelector('.fixed.inset-0.z-50');
  if (!m) return -1;
  const libelles = [...m.querySelectorAll('button')].map((b) => b.innerText.trim().toLowerCase());
  return libelles.filter((t) => t === 'smartphones').length;
});
verifie(
  `le rayon « smartphones » n'est proposé qu'une fois (${pastillesSmartphones} fois)`,
  pastillesSmartphones >= 0 && pastillesSmartphones <= 1,
  `${pastillesSmartphones} pastille(s)`
);
await fermerBoite();

// ─── Restaurant : la salle, une commande de bout en bout, les recettes ──
if (PROFIL === 'restaurant') {
  await onglet('Salle');
  await page.waitForTimeout(3000);
  const salle = await texte();
  verifie('la salle affiche des tables', /Table|Terrasse/.test(salle), salle.slice(0, 250));

  const tables = await base('/rest/v1/restaurant_tables?select=id,name,zone,seats&is_active=eq.true');
  verifie('les tables sont bien en base', tables.length >= 3, JSON.stringify(tables));
  const zones = new Set(tables.map((t) => t.zone));
  verifie('les zones de salle sont définies', zones.size >= 1, [...zones].join(','));

  // ── Une commande, de la table vide à l'addition encaissée ─────────
  //
  // C'est le domaine le plus complexe de l'application : une commande vit
  // dans `restaurant_orders`, ses plats dans `restaurant_order_items`, et sa
  // clôture écrit une VENTE — sans passer par le panier du point de vente.
  // Aucun test ne le couvrait jusqu'ici.
  //
  // Le parcours lit d'abord les tables libres EN BASE plutôt que de deviner à
  // l'écran : cliquer une carte déjà occupée n'échouerait pas, elle rouvrirait
  // la commande d'un autre serveur, et le test passerait à côté de la vente
  // qu'il prétend vérifier.
  const commande = await base(
    '/rest/v1/restaurant_orders?select=id,table_id,status&status=neq.closed'
  );
  // Identifiants sans accent : un identifiant accentué est valide en JS mais
  // se perd au premier copier-coller depuis un terminal à autre jeu de
  // caractères — c'est exactement ce qui vient de casser ce fichier.
  const tablesOccupees = new Set(commande.map((o) => o.table_id));
  const libre = tables.find((t) => !tablesOccupees.has(t.id));
  if (!libre) {
    resultats.push('— aucune table libre, la commande n\'a pas été jouée');
  } else {
    // Un plat de la carte, choisi en base : la recherche de l'interface ne
    // propose que les plats servis aujourd'hui, et le test ne doit pas dépendre
    // du jour de la semaine.
    // Deux détails font que cette requête soit fausse si on l'écrit
    // naturellement :
    //   - `exists=` ne vaut que pour une ressource imbriquée, pas pour une
    //     table comme ici ;
    //   - `recipe_ingredients` porte DEUX clés étrangères vers products
    //     (dish_id et ingredient_id), donc PostgREST refuse de choisir et
    //     exige une désambiguïsation par colonne.
    // `!inner` ne garde ensuite que les produits ayant au moins un ingrédient :
    // c'est ce qui distingue un plat d'un produit vendu à l'unité.
    const plats = await base(
      '/rest/v1/products?select=id,name,price_sell,recipe_ingredients!dish_id!inner(ingredient_id)&limit=5'
    );
    const plat = Array.isArray(plats) ? plats[0] : null;
    verifie(
      'la carte contient des plats (produits avec recette)',
      Boolean(plat),
      JSON.stringify(plats).slice(0, 200)
    );

    await page.locator(`button:has-text("${libre.name}")`).first().click({ timeout: 8000 });
    await page.waitForTimeout(2000);
    verifie(
      `la table « ${libre.name} » s'ouvre`,
      (await page.locator('input[aria-label="Chercher un plat à commander"]').isVisible().catch(() => false)),
      libre.name
    );

    if (plat) {
      // La commande vient d'être créée par le clic sur la carte : son
      // identifiant se lit en base, il n'est pas exposé à l'écran.
      const ouverte = await base(
        `/rest/v1/restaurant_orders?select=id&table_id=eq.${libre.id}&status=neq.closed`
      );
      const commandeOuverte = ouverte[0]?.id;
      verifie('la commande est ouverte en base', Boolean(commandeOuverte), JSON.stringify(ouverte));

      await page.locator('input[aria-label="Chercher un plat à commander"]').fill(plat.name);
      await page.waitForTimeout(1200);
      // Premier clic : sélection et chargement des options. Second clic :
      // la ligne est créée. Les fusionner en un seul rendrait le test
      // insensible au premier clic — celui qui perd les options.
      const cartePlat = page.locator(`button:has-text("${plat.name}")`).last();
      await cartePlat.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(900);
      const optionnel = await page
        .locator('button:has-text("Ajouter à la commande")')
        .isVisible()
        .catch(() => false);
      if (optionnel) {
        await page.locator('button:has-text("Ajouter à la commande")').first().click();
        await page.waitForTimeout(1500);
      } else {
        await cartePlat.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }

      const lignes = commandeOuverte
        ? await base(
            `/rest/v1/restaurant_order_items?select=id,quantity,unit_price&order_id=eq.${commandeOuverte}`
          )
        : [];
      verifie(
        `le plat « ${plat.name} » est bien à la commande`,
        lignes.length >= 1,
        `${lignes.length} ligne(s)`
      );
    }

    // ── Encaisser l'addition ───────────────────────────────────────
    const avant = await base('/rest/v1/sales?select=id&order=created_at.desc&limit=1');
    const boutonEncaisser = page.locator('button:has-text("Encaisser")').first();
    if (await boutonEncaisser.isVisible().catch(() => false)) {
      await boutonEncaisser.click();
      await page.waitForTimeout(4000);
    }
    const apresEncaisse = await attendTexte(/Addition encaissée/i);
    verifie(
      "l'écran confirme l'addition encaissée",
      /Addition encaissée/i.test(apresEncaisse),
      apresEncaisse.slice(0, 250)
    );

    const apres = await base('/rest/v1/sales?select=id&order=created_at.desc&limit=1');
    verifie(
      "la clôture a écrit une vente",
      Boolean(avant) && Boolean(apres) && avant[0]?.id !== apres[0]?.id,
      `avant ${avant?.[0]?.id} → après ${apres?.[0]?.id}`
    );

    const tableLibre = await base(
      `/rest/v1/restaurant_orders?select=id,status&table_id=eq.${libre.id}&status=neq.closed`
    );
    verifie(
      `la table « ${libre.name} » est libérée après encaissement`,
      tableLibre.length === 0,
      `${tableLibre.length} commande(s) encore ouverte(s)`
    );
  }

  // L'onglet Recettes n'est présent qu'en mode complet (restaurant). En mode
  // simple, il n'y a pas d'onglet à ouvrir : on le dit au lieu d'échouer sur
  // un écran qui n'est simplement pas proposé.
  if (await page.locator('button[aria-label="Recettes"]').count()) {
    await onglet('Recettes');
    await page.waitForTimeout(3000);
    const recettes = await texte();
    verifie('les recettes listent des plats', /pour 1 portion|Recette|recette/i.test(recettes), recettes.slice(0, 250));
  } else {
    console.log('  — onglet Recettes absent (mode simple), non vérifié');
  }
}

// ─── Erreurs JavaScript ─────────────────────────────────────────────
verifie('aucune erreur JavaScript non rattrapée', erreursReseau.length === 0, erreursReseau.join(' | '));

await navigateur.close();

console.log(resultats.join('\n'));
console.log(`\n${resultats.length} vérifications, ${echecs} en échec. Profil : ${PROFIL}`);
process.exit(echecs ? 1 : 0);
