// Refait les captures de la page d'accueil (public/captures) depuis un compte
// réel, en 375x812 : le tableau du jour, la caisse, le journal des ventes.
//
// Usage (app servie, prod ou locale) :
//   QA_BASE=https://... QA_PASSWORD=<mot de passe> node qa/captures-accueil.mjs <email>
//
// Les identifiants ne sont jamais écrits dans un fichier versionné : le mot de
// passe vient de l'environnement, l'e-mail d'un argument.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const email = process.argv[2];
if (!email || !process.env.QA_PASSWORD) {
  console.error('Usage : QA_BASE=<url> QA_PASSWORD=<mot de passe> node qa/captures-accueil.mjs <email>');
  process.exit(1);
}
const base = process.env.QA_BASE ?? 'http://localhost:3001';
const sortie = path.resolve('public/captures');
fs.mkdirSync(sortie, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 1,
  locale: 'fr-FR',
  timezoneId: 'Africa/Porto-Novo',
});
const p = await ctx.newPage();

// Masquer le bandeau « version de test » : il est masquable par l'utilisateur,
// et il n'a pas sa place en haut d'une capture de présentation.
await p.addInitScript(() => {
  try { localStorage.setItem('beta:banner:vu', '1'); } catch { /* stockage indisponible */ }
});

// Connexion. Saisie au clavier : `fill()` pose la valeur dans le DOM sans
// réveiller l'état React des champs contrôlés, et Supabase recevait un e-mail
// vide (« missing email or phone »).
await p.goto(`${base}/connexion`, { waitUntil: 'domcontentloaded' });
await p.locator('#login-email').click();
await p.locator('#login-email').pressSequentially(email, { delay: 15 });
await p.locator('#login-mdp').click();
await p.locator('#login-mdp').pressSequentially(process.env.QA_PASSWORD, { delay: 15 });
await p.locator('form').getByRole('button', { name: 'Se connecter' }).click();

// Attendre le tableau de bord, puis la fin des chargements (le « … »).
await p.getByText(/Encaissé aujourd/).waitFor({ timeout: 45_000 });
await p.waitForFunction(() => !document.body.innerText.includes('…'), null, { timeout: 15_000 }).catch(() => {});
await p.waitForTimeout(1200);

/** Ouvre un onglet ; sur mobile, la navigation passe par le tiroir. */
async function aller(nom) {
  const menu = p.getByRole('button', { name: 'Ouvrir le menu' });
  if (await menu.isVisible().catch(() => false)) await menu.click();
  await p.getByRole('button', { name: nom, exact: true }).first().click();
  await p.waitForTimeout(2200);
}

await p.screenshot({ path: `${sortie}/tableau-du-jour.png` });
console.log('tableau :', (await p.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 200));
await aller('Caisse');
await p.screenshot({ path: `${sortie}/caisse.png` });
console.log('caisse  :', (await p.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 200));
await aller('Ventes');
await p.screenshot({ path: `${sortie}/journal.png` });
console.log('journal :', (await p.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 200));

for (const f of ['tableau-du-jour', 'caisse', 'journal']) {
  const plein = `${sortie}/${f}.png`;
  console.log(`${f}.png : ${fs.statSync(plein).size} octets`);
}
await b.close();
