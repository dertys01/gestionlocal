// Parcours d'onboarding de bout en bout, sur téléphone (375 × 812).
//
// Crée un compte NEUF à chaque passage (qa-onb<horodatage>@test.local), puis :
// bienvenue → activité → produits → première vente → félicitations → dettes,
// et vérifie le mode simple (navigation réduite) et sa bascule dans Paramètres.
//
// Usage (serveur de dev lancé) :
//   QA_BASE=http://localhost:3001 node qa/onboarding.mjs [epicerie|boutique|restaurant|autre] [exemples|mes-produits]
//
// Captures dans qa/shots/onboarding-*.png (non versionnées).
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = process.env.QA_BASE ?? 'http://localhost:3001';
const ACTIVITE = process.argv[2] ?? 'epicerie';
const VOIE = process.argv[3] ?? 'exemples';
const LIBELLES = {
  epicerie: 'Épicerie / Alimentation',
  boutique: 'Boutique / Commerce général',
  restaurant: 'Maquis / Restaurant',
  autre: 'Autre',
};
const EXEMPLE = { epicerie: 'Riz 25 kg', boutique: 'Chargeur', restaurant: 'Poulet braisé', autre: 'Article 1' };
const EST_RESTO = ACTIVITE === 'restaurant';
// Un restaurant ne reçoit pas des « produits d'exemple » mais sa carte, avec
// les recettes de chaque plat. L'écran et les boutons changent donc de libellé.
const TITRE_EXEMPLES = EST_RESTO
  ? 'Votre carte de démarrage'
  : 'Voici quelques produits pour commencer';
const BOUTON_EXEMPLES = EST_RESTO
  ? /Continuer avec cette carte/
  : /Continuer avec ces produits/;

fs.mkdirSync('qa/shots', { recursive: true });
const email = process.env.QA_EMAIL ?? `qa-onb${Date.now()}@test.local`;
// Jamais de mot de passe dans un fichier versionné (dépôt PUBLIC) : un compte
// neuf reçoit un mot de passe aléatoire, un compte existant le lit dans
// QA_PASSWORD.
const motDePasse = process.env.QA_PASSWORD ?? `Qa-${crypto.randomUUID()}`;
if (process.env.QA_EMAIL && !process.env.QA_PASSWORD) {
  console.error('QA_PASSWORD est requis avec QA_EMAIL');
  process.exit(2);
}
const erreurs = [];
let echecs = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) echecs++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => erreurs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('response', async (r) => {
  if (r.status() >= 400) {
    const corps = await r.text().catch(() => '');
    erreurs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '')} ${corps.slice(0, 160)}`);
  }
});

let n = 0;
const etape = async (nom) => {
  n++;
  await page.waitForTimeout(400);
  const deborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${nom} — pas de débordement horizontal à 375 px`, deborde <= 0, `${deborde} px`);
  await page.screenshot({ path: `qa/shots/onboarding-${String(n).padStart(2, '0')}-${nom}.png`, fullPage: true });
};

console.log(`▸ Onboarding ${ACTIVITE} / ${VOIE} — ${email}`);
const t0 = Date.now();

if (process.env.QA_EMAIL) {
  // Compte existant, onboarding remis à zéro en SQL : l'inscription est
  // limitée à quelques comptes par heure et par adresse IP.
  //
  // On passe par /connexion : la racine est la page publique (accueil) en
  // production, elle ne contient aucun champ. La saisie se fait au clavier
  // (`fill()` ne réveille pas toujours l'état React des champs contrôlés),
  // après l'hydratation du formulaire.
  await page.goto(`${BASE}/connexion`);
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.locator('#login-email').click();
  await page.locator('#login-email').pressSequentially(process.env.QA_EMAIL, { delay: 20 });
  await page.locator('#login-mdp').click();
  await page.locator('#login-mdp').pressSequentially(motDePasse, { delay: 20 });
  await page.locator('button[type="submit"]').first().click();
} else {
  await page.goto(`${BASE}/register`);
  await page.fill('#reg-email', email);
  await page.fill('#reg-mdp', motDePasse);
  await page.fill('#reg-boutique', `QA Onboarding ${ACTIVITE}`);
  await page.click('button[type="submit"]');
}

// Écran 1 — sauté si le compte reprend plus loin.
await page.getByText(/Bienvenue sur GestionLocal|Quel type de commerce/).first().waitFor({ timeout: 30000 });
ok('onboarding sans navigation', (await page.getByRole('button', { name: 'Ouvrir le menu' }).count()) === 0);
if (await page.getByText('Bienvenue sur GestionLocal').count()) {
  await etape('bienvenue');
  await page.getByRole('button', { name: /Commencer/ }).click();
}

// Écran 2
await page.getByText('Quel type de commerce avez-vous').waitFor();
await etape('activite');
await page.getByRole('button', { name: new RegExp(LIBELLES[ACTIVITE].replace('/', '\\/')) }).click();
await page.getByRole('button', { name: /^Continuer/ }).click();

// Écran 3
await page.getByText(TITRE_EXEMPLES).waitFor();
await etape('exemples');

if (EST_RESTO) {
  // La recette est visible AVANT de charger : le patron comprend que le plat
  // arrive avec ses ingrédients, et que c'est le stock qui sera déduit.
  ok(
    'la carte restaurant affiche la recette des plats',
    (await page.getByText(/Poulet entier × 1 pce/).count()) > 0
  );
  ok(
    'la carte restaurant annonce les ingrédients au stock',
    (await page.getByText(/ingrédients au stock/).count()) > 0
  );
}

// Reprise après rechargement : on revient au même écran.
await page.reload();
await page.getByText(TITRE_EXEMPLES).waitFor({ timeout: 20000 });
ok('rechargement : l\'assistant reprend à l\'écran 3', true);

let produit = EXEMPLE[ACTIVITE];
if (VOIE === 'exemples') {
  await page.getByRole('button', { name: BOUTON_EXEMPLES }).click();
} else {
  produit = 'Pagne wax QA';
  await page
    .getByRole('button', { name: EST_RESTO ? /Je préfère saisir ma carte/ : /Je préfère ajouter mes propres produits/ })
    .click();
  await page.fill('#ob-nom', produit);
  await page.fill('#ob-prix', '5000');
  await page.getByRole('button', { name: /Ajouter ce produit/ }).click();
  const alerte = page.locator('p[role="alert"]');
  await alerte.waitFor();
  ok('produit sans stock refusé', /en stock/.test(await alerte.innerText()));
  await page.fill('#ob-stock', '12');
  await page.getByRole('button', { name: /Ajouter ce produit/ }).click();
  await page.getByRole('list', { name: 'Produits ajoutés' }).getByText(produit).waitFor();
  await etape('mes-produits');
  await page.getByRole('button', { name: /^Continuer/ }).first().click();
}

// Écran 4
await page.getByText('Faites votre première vente').waitFor();
await etape('consigne-vente');
await page.getByRole('button', { name: /Aller à la caisse/ }).click();

// Caisse guidée
await page.getByText(produit, { exact: true }).first().waitFor({ timeout: 20000 });
ok('caisse guidée sans navigation', (await page.getByRole('button', { name: 'Ouvrir le menu' }).count()) === 0);
await etape('caisse-guidee');
await page.getByText(produit, { exact: true }).first().click();
await page.getByRole('button', { name: /Ouvrir le panier/ }).click();
await etape('panier');
await page.getByRole('button', { name: /^Encaisser/ }).last().click();
await page.getByText('Vente enregistrée').waitFor({ timeout: 20000 });
await etape('recu');
ok('le reçu reste affiché après la vente', await page.getByText('Vente enregistrée').isVisible());
await page.getByRole('button', { name: 'Fermer' }).last().click();

// Écran 5
await page.getByText('Première vente enregistrée').waitFor({ timeout: 20000 });
const duree = Math.round((Date.now() - t0) / 1000);
ok(`première vente en ${duree} s (automate) — objectif humain ≤ 240 s`, duree < 240);
await etape('felicitations');
await page.getByRole('button', { name: /Voir mes dettes clients/ }).click();

// Dettes, gratuites
await page.getByText('Carnet de dette').waitFor({ timeout: 20000 });
ok('le carnet de dettes s\'ouvre en plan gratuit', !(await page.getByText(/disponible à partir du plan/).count()));
await etape('dettes');

// Mode simple : la navigation
const nav = async () => {
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.waitForTimeout(300);
  const t = await page.locator('aside, nav').first().innerText();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return t;
};
let menu = await nav();
ok('mode simple : Rapports et Équipe masqués', !/Rapports|Équipe/.test(menu), menu.replace(/\s+/g, ' '));
ok('mode simple : Vente, Stock, Ventes, Dettes visibles', ['Vente', 'Stock', 'Ventes', 'Dettes'].every((m) => menu.includes(m)));
if (ACTIVITE === 'restaurant') ok('restaurant : Salle visible', menu.includes('Salle'));

// Bascule dans Paramètres
await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
await page.getByRole('button', { name: /Paramètres/ }).first().click();
await page.getByRole('button', { name: 'Passer en mode complet' }).waitFor();
await etape('parametres');
await page.getByRole('button', { name: 'Passer en mode complet' }).click();
await page.getByRole('button', { name: 'Revenir au mode simple' }).waitFor();

// Recettes : le contrôle qui compte. La carte a écrit les recettes, pas
// seulement les plats ; sans elles, un plat vendu ne déduit aucun ingrédient.
if (EST_RESTO) {
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.getByRole('button', { name: /Recettes/ }).first().click();
  await page.locator('#recipe-dish').waitFor({ timeout: 15000 });
  // Le select est rendu PENDANT le chargement, avec seulement « Choisir un
  // plat… ». Lire les options à cet instant ne prouve rien : on attend que les
  // plats soient arrivés.
  await page.waitForFunction(
    () => document.querySelectorAll('#recipe-dish option').length > 1,
    null,
    { timeout: 15000 }
  );
  const optionsRecettes = await page.locator('#recipe-dish option').allInnerTexts();
  ok(
    'recettes : les plats de la carte ont leurs ingrédients',
    optionsRecettes.some((o) => /Poulet braisé \(\d+ ingrédients\)/.test(o)),
    optionsRecettes.join(' | ')
  );
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.getByRole('button', { name: /Paramètres/ }).first().click();
  await page.getByRole('button', { name: 'Revenir au mode simple' }).waitFor();
}

menu = await nav();
ok('mode complet : Rapports et Équipe visibles', /Rapports/.test(menu) && /Équipe/.test(menu));
await page.getByRole('button', { name: 'Revenir au mode simple' }).click();
await page.getByRole('button', { name: 'Passer en mode complet' }).waitFor();
menu = await nav();
ok('retour au mode simple', !/Rapports/.test(menu));

const pertinentes = erreurs.filter((e) => !/favicon|Download the React DevTools|sentry/i.test(e));
ok('aucune erreur JavaScript', pertinentes.length === 0, pertinentes.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${echecs === 0 ? '✅' : '❌'} ${echecs} échec(s) — compte ${email}`);
process.exit(echecs ? 1 : 0);
