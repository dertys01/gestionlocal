/**
 * Audit visuel et logique multi-écrans, dans le navigateur.
 *
 * Ouverture d'une session existante (jeton injecté dans localStorage), puis
 * passage onglet par onglet à plusieurs largeurs — téléphone, tablette,
 * portable, grand écran. Pour chaque écran : débordement horizontal, texte
 * tronqué, éléments hors cadre, cibles tactiles trop petites, boutons sans
 * nom, valeurs « NaN » / « undefined », et capture d'écran.
 *
 *   node qa/audit.mjs <email> <motdepasse> [profil]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [, , EMAIL = '', PASSWORD = '', PROFIL = 'retail'] = process.argv;
if (!EMAIL || !PASSWORD) {
  console.error('usage: node qa/audit.mjs <email> <motdepasse> [retail|restaurant]');
  process.exit(1);
}

const BASE = process.env.QA_BASE ?? 'http://localhost:3001';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const FORMATS = [
  { nom: 'iphone', width: 390, height: 844, tactile: true },
  { nom: 'small', width: 320, height: 640, tactile: true },
  { nom: 'tablette', width: 768, height: 1024, tactile: true },
  { nom: 'laptop', width: 1280, height: 800, tactile: false },
  { nom: 'large', width: 1920, height: 1080, tactile: false },
];

/**
 * Onglets de la barre latérale, par aria-label — c'est le seul sélecteur qui
 * marche à la fois au clic et après l'ouverture du tiroir mobile. Le nom de
 * l'onglet est aussi le titre attendu à l'écran : le contrôle sert donc aussi
 * à vérifier que le clic a bien changé de module.
 */
const ONGLETS = [
  ['Accueil', 'Accueil', "Aujourd'hui"],
  ['Caisse', 'Caisse', 'Point de vente'],
  ['Salle', 'Salle', 'Salle'],
  ['Recettes', 'Recettes', 'Recettes'],
  ['Stock', 'Stock', 'Inventaire'],
  ['Ventes', 'Ventes', 'Journal du jour'],
  ['Dettes', 'Dettes', 'Carnet de dette'],
  ['Rapports', 'Rapports', 'Rapports'],
  ['Prévisions', 'Prévisions', 'Prévisions'],
  ['Équipe', 'Équipe', 'Équipe'],
  ['Paramètres', 'Paramètres', 'Paramètres'],
];

/** Le contrôle principal, exécuté dans la page. */
const AUDIT = () => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = {
    largeur: vw,
    debordement: doc.scrollWidth - vw,
    tronques: [],
    horsCadre: [],
    valeurs: [],
    petites: [],
    sansNom: [],
    labels: [],
    zonesClic: [],
  };

  const nom = (el) => {
    const cls = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} «${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 40)}»`;
  };

  const visibles = (el, cs) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!visibles(el, cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    // Texte tronqué sans ellipse ni行本 defilement : une information perdue.
    if (
      el.children.length === 0 &&
      el.scrollWidth > el.clientWidth + 2 &&
      cs.overflowX !== 'visible' &&
      cs.textOverflow !== 'ellipsis' &&
      el.clientWidth > 0
    ) {
      out.tronques.push(`${nom(el)} ${el.scrollWidth}>${el.clientWidth}`);
    }

    // Débordement à droite.
    if (
      r.right > vw + 2 &&
      cs.position !== 'fixed' &&
      !el.closest('.overflow-x-auto, .overflow-x-scroll, [data-qa-allow-overflow]')
    ) {
      out.horsCadre.push(`${nom(el)} droite=${Math.round(r.right)}/${vw}`);
    }

    // Valeurs cassées.
    const texte = (el.innerText || '').trim();
    if (
      texte &&
      texte.length < 200 &&
      /NaN|undefined|Infinity|\[object Object\]|null F|F F/.test(texte)
    ) {
      out.valeurs.push(nom(el));
    }

    const tag = el.tagName.toLowerCase();
    const interactif =
      tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';

    if (interactif && el.offsetParent !== null && r.width >= 2 && r.height >= 2) {
      // Cible tactile : 44 px est le plancher recommandé (WCAG 2.5.5 AAA,
      // 24 px minimum AA). Sous 24 px, on le signale séparément.
      if (r.height < 24 || r.width < 24) out.petites.push(`${nom(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      else if (r.height < 44) out.zonesClic.push(`${nom(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);

      // Bouton icône sans nom accessible.
      if (
        tag === 'button' &&
        !el.innerText.trim() &&
        !el.getAttribute('aria-label') &&
        !el.getAttribute('title') &&
        !el.getAttribute('aria-labelledby')
      ) {
        out.sansNom.push(nom(el));
      }
    }

    // Champ sans étiquette.
    if (tag === 'input' && !el.getAttribute('aria-label') && !el.getAttribute('type')?.match(/hidden|submit|button/)) {
      const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      if (!lab && !el.closest('label')) out.labels.push(`${nom(el)} placeholder=${el.placeholder || '—'}`);
    }
  }

  for (const cle of Object.keys(out)) {
    if (Array.isArray(out[cle])) out[cle] = [...new Set(out[cle])].slice(0, 8);
  }
  return out;
};

/** Attend que l'écran cesse de changer (fin des chargements). */
async function stabilise(page, ms = 4000) {
  let precedent = null;
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const courant = await page.evaluate(() => document.body.innerText.length + '|' + document.body.innerText.slice(0, 100));
    if (courant === precedent) return true;
    precedent = courant;
    await page.waitForTimeout(500);
  }
  return false;
}

const navigateur = await chromium.launch();
const rapport = [];
const erreursConsole = [];
/** Session réutilisée d'un format à l'autre (voir addInitScript). */
let jeton = null;

for (const format of FORMATS) {
  if (process.env.QA_TRACE) console.error(`→ ${format.nom}`);
  const contexte = await navigateur.newContext({
    viewport: { width: format.width, height: format.height },
    deviceScaleFactor: 2,
    hasTouch: format.width < 768,
    locale: 'fr-FR',
    timezoneId: 'Africa/Porto-Novo',
  });

  const page = await contexte.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') erreursConsole.push(`[${format.nom}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => erreursConsole.push(`[${format.nom}] pageerror: ${e.message.slice(0, 200)}`));

  // Une seule connexion pour tous les formats : le jeton est réutilisé depuis
  // localStorage. Se reconnecter à chaque largeur epitope le compteur
  // d'inscriptions et l'audit échouait sur « connexion impossible » sans que
  // rien de l'application soit en cause.
  if (jeton) {
    await page.addInitScript((donnees) => {
      for (const [cle, valeur] of Object.entries(donnees)) localStorage.setItem(cle, valeur);
    }, jeton);
  }

  await page.goto(BASE + '/connexion', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const ecranConnexion = () =>
    page.locator('input[type="email"]').first().isVisible().catch(() => false);

  // La barre latérale prouve que la session est établie ET que le module a été
  // résolu — deux choses que l'absence du formulaire ne prouve pas. C'est
  // aussi le seul point où l'audit peut attendre : avant lui, on ne sait pas
  // si la page a fini de charger.
  const aLaBarre = async () =>
    page.locator('button[aria-label="Accueil"]').first().isVisible().catch(() => false);

  const tenterConnexion = async () => {
    if (await aLaBarre()) return true;
    // Saisie au clavier, après l'hydratation du formulaire. `fill()` pose la
    // valeur dans le DOM sans réveiller l'état React des champs contrôlés :
    // Supabase recevait un e-mail vide et l'audit concluait « connexion
    // impossible », alors que rien dans l'application n'était en cause.
    const email = page.locator('#login-email, input[type="email"]').first();
    const mdp = page.locator('#login-mdp, input[type="password"]').first();
    // Le formulaire peut disparaître entre sa détection et la saisie : une
    // session restaurée depuis le jeton injecté redirige vers le tableau de
    // bord. Son absence n'est donc pas un échec, c'est peut-être une réussite.
    const pret = await email.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (!pret) return aLaBarre();
    await page.waitForTimeout(1200);
    try {
      await email.click({ timeout: 5_000 });
      await email.pressSequentially(EMAIL, { delay: 15 });
      await mdp.click({ timeout: 5_000 });
      await mdp.pressSequentially(PASSWORD, { delay: 15 });
      await page.locator('button[type="submit"]').first().click({ timeout: 8_000 });
    } catch {
      return aLaBarre();
    }
    await page.waitForTimeout(4000);
    for (let i = 0; i < 20 && !(await aLaBarre()); i++) await page.waitForTimeout(500);
    return aLaBarre();
  };

  // Attente inconditionnelle, même avec un jeton injecté : la barre n'apparaît
  // qu'après la résolution de l'organisation et le chargement du catalogue,
  // quelques secondes plus tard. Sans ce délai, un jeton parfaitement valide
  // était déclaré « connexion impossible ».
  for (let i = 0; i < 30 && !(await aLaBarre()); i++) await page.waitForTimeout(500);

  // Un jeton injecté qui n'aboutit pas n'est pas forcément un jeton invalide :
  // le chargement du premier écran après restauration de session est le plus
  // lent, et il échoue si on ne le retente pas. On recharge donc avant de
  // conclure — sans cela le DERNIER format de la liste échouait presque à
  // chaque exécution, pour une raison qui n'avait rien à voir avec l'écran
  // audité.
  if (!(await aLaBarre()) && jeton) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 30 && !(await aLaBarre()); i++) await page.waitForTimeout(500);
  }

  if (!(await aLaBarre()) && (await ecranConnexion())) {
    // Deux essais suffisent en temps normal ; le troisième, après une pause,
    // couvre la limite de débit de GoTrue — enchaîner deux audits depuis la
    // même adresse la déclenche, et l'audit échouait alors sur les formats
    // suivants avec « connexion impossible », sans rapport avec l'application.
    if (!(await tenterConnexion())) {
      await page.waitForTimeout(20000);
      await tenterConnexion();
    }
  }

  if (!(await aLaBarre())) {
    rapport.push({ format: format.nom, erreur: 'connexion impossible' });
    await contexte.close();
    continue;
  }

  // Mémorise la session pour les formats suivants.
  jeton = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

  const jetonUtilisateur = EMAIL.split('@')[0].slice(0, 12);

  // Sur mobile, la navigation vit dans un tiroir hors écran. Playwright
  // considère un tiroir fermé « visible » — il a une boîte, simplement
  // décalée hors du viewport — et isVisible() ne dit donc rien. On regarde
  // si la cible est réellement dans la fenêtre.
  // Un élément en `display: none` (bouton mobile sur grand écran) a un
  // rectangle à zéro : sans le test de taille, il passait pour « dans la
  // fenêtre » et le clic suivant expirait dessus.
  const dansLaFenetre = async (loc) =>
    loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    }).catch(() => false);

  const ouvrirMenu = async () => {
    const burger = page.locator('button[aria-label="Ouvrir le menu"]').first();
    if (!(await dansLaFenetre(burger))) return false;
    await burger.click();
    await page.waitForTimeout(600);
    return true;
  };

  for (const [libelle, motif, titreAttendu] of ONGLETS) {
    const cible = page.locator(`button[aria-label="${motif}"]`).first();

    if (!(await cible.count())) continue;
    if (!(await dansLaFenetre(cible))) {
      if (!(await ouvrirMenu())) continue;
    }
    if (!(await dansLaFenetre(cible))) continue;

    // Le tiroir reste ouvert après un clic si la cible était hors cadre :
    // on le referme pour que l'audit porte sur l'écran, pas sur le menu.
    await cible.click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    await stabilise(page);

    // Vérification : le module attendu est-il bien celui affiché ? Sans ce
    // contrôle, un tiroir mal ouvert fait passer l'audit sur l'écran précédent.
    const titreVu = await page.evaluate(
      (t) => document.body.innerText.includes(t),
      titreAttendu
    );
    if (!titreVu) {
      rapport.push({
        format: format.nom,
        ecran: libelle,
        ok: false,
        problemes: [`clic sans effet : « ${titreAttendu} » absent de l'écran`],
      });
      continue;
    }

    const audit = await page.evaluate(AUDIT);
    const nomFichier = `${format.nom}-${jetonUtilisateur}-${libelle.toLowerCase().replace(/[^a-z]/g, '')}`;
    await page.screenshot({ path: `${SHOTS}${nomFichier}.png`, fullPage: true });

    const problemes = [];
    if (audit.debordement > 2) problemes.push(`débordement ${audit.debordement}px`);
    if (audit.tronques.length) problemes.push(`tronqué: ${audit.tronques.join(' / ')}`);
    if (audit.horsCadre.length) problemes.push(`hors cadre: ${audit.horsCadre.join(' / ')}`);
    if (audit.valeurs.length) problemes.push(`valeur: ${audit.valeurs.join(' / ')}`);
    if (audit.petites.length) problemes.push(`cible <24px: ${audit.petites.join(' / ')}`);
    if (audit.sansNom.length) problemes.push(`sans nom: ${audit.sansNom.join(' / ')}`);
    if (audit.labels.length) problemes.push(`champ sans étiquette: ${audit.labels.join(' / ')}`);

    // Deux seuils, deux Gravités — les confondre rendrait l'audit inutile.
    //
    //   24 px : WCAG 2.2 AA (2.5.8). Un écran qui échoue ici est réellement
    //           inutilisable au doigt, et doit faire échouer l'audit.
    //   44 px : WCAG 2.5.5 AAA et recommandation Apple.agréable mais non
    //           obligatoire ; l'appliquer ici produirait une trentaine de
    //           écrans en échec en permanence, et l'audit cesserait de
    //           signaler ce qui est vraiment nouveau.
    //
    // Le second est donc un AVERTISSEMENT : compté, affiché, jamais bloquant.
    const avertissements = [];
    if (format.tactile && audit.zonesClic.length) {
      avertissements.push(
        `${audit.zonesClic.length} cible(s) sous 44 px : ${audit.zonesClic.join(' / ')}`
      );
    }

    rapport.push({
      format: format.nom,
      ecran: libelle,
      largeur: audit.largeur,
      tactile: format.tactile,
      ok: problemes.length === 0,
      problemes,
      avertissements,
      capture: `qa/shots/${nomFichier}.png`,
    });
  }

  // ─── Le panier ne doit jamais confisquer l'application ─────────────
  // Onglet par onglet, l'audit ne voit que des écrans au repos : or le bug du
  // panier plein écran n'apparaît qu'APRÈS un geste. Deux gestes distincts,
  // parce que les deux écrans n'ont pas la même commande :
  //   - « Reprendre la dernière vente », qui ouvre la caisse partout ;
  //   - la barre du bas, qui est LA commande d'ouverture sur téléphone.
  if (!(await dansLaFenetre(page.locator('button[aria-label="Caisse"]').first()))) await ouvrirMenu();
  await page.locator('button[aria-label="Caisse"]').first().click({ timeout: 8000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await stabilise(page);

  // Un produit au panier d'abord.
  const premiereLigne = page.locator('.divide-y.divide-slate-100 > button').first();
  if (!(await premiereLigne.isVisible().catch(() => false))) {
    await contexte.close();
    continue;
  }
  await premiereLigne.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);

  const lecturePanier = () =>
    page.evaluate(() => {
      const panneau = [...document.querySelectorAll('div')].find(
        (d) => String(d.className).includes('lg:w-80') || String(d.className).includes('inset-0 z-40')
      );
      const cs = panneau ? getComputedStyle(panneau) : null;
      // Qui reçoit un clic au milieu de la zone de navigation ?
      const nav = document.querySelector('button[aria-label="Stock"]');
      const nr = nav?.getBoundingClientRect();
      const auDessus = nr
        ? document.elementFromPoint(Math.round(nr.left + nr.width / 2), Math.round(nr.top + nr.height / 2))
        : null;
      return {
        pleinEcran: Boolean(cs && cs.position === 'fixed'),
        navRecouverte: Boolean(auDessus && auDessus.tagName !== 'BUTTON'),
        fermable: Boolean(
          [...document.querySelectorAll('button')].find((b) =>
            /Fermer le panier/.test(b.getAttribute('aria-label') || '')
          )
        ),
      };
    });

  // Sur téléphone, c'est la barre du bas qui ouvre la caisse — un clic sur un
  // produit ne doit PAS déclencher le panneau plein écran, sinon chaque ajout
  // interromprait la saisie des articles suivants.
  if (format.width < 1024) {
    const apresAjout = await lecturePanier();
    rapport.push({
      format: format.nom,
      ecran: 'Ajout sans écran bloqué',
      ok: !apresAjout.pleinEcran && !apresAjout.navRecouverte,
      problemes: [
        ...(apresAjout.pleinEcran
          ? ['un simple ajout ouvre le panier plein écran : la saisie est interrompue']
          : []),
        ...(apresAjout.navRecouverte ? ['la navigation est recouverte'] : []),
      ],
    });

    // Le libellé exact est « Ouvrir le panier : N articles, total X F ».
    // Un `*="panier"` large aurait aussi attrapé le bouton du reçu et la barre
    // de paiement du panneau.
    const barre = page.locator('button[aria-label^="Ouvrir le panier"]').first();
    if (await barre.isVisible().catch(() => false)) {
      await barre.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
    const ouvert = await lecturePanier();
    rapport.push({
      format: format.nom,
      ecran: 'Panier plein écran',
      ok: ouvert.pleinEcran && ouvert.fermable,
      problemes: [
        ...(ouvert.pleinEcran ? [] : ['la barre du bas n\'ouvre pas le panier plein écran']),
        ...(ouvert.fermable ? [] : ['aucun bouton pour refermer le panier']),
      ],
    });
  } else {
    // Sur grand écran, le panier est une colonne : « Reprendre la dernière
    // vente » ne doit surtout pas le transformer en calque plein écran — c'est
    // exactement le bug qui rendait l'application inutilisable.
    const reprise = page.locator('button:has-text("Reprendre la dernière vente")');
    if (await reprise.isVisible().catch(() => false)) {
      await reprise.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
    const etat = await lecturePanier();
    rapport.push({
      format: format.nom,
      ecran: 'Panier après reprise',
      ok: !etat.pleinEcran && !etat.navRecouverte,
      problemes: [
        ...(etat.pleinEcran
          ? ['le panier devient un calque plein écran alors que la colonne suffit']
          : []),
        ...(etat.navRecouverte ? ['la navigation est recouverte : écran mort'] : []),
      ],
    });
  }

  await page.screenshot({
    path: `${SHOTS}${format.nom}-${jetonUtilisateur}-panier.png`,
    fullPage: true,
  });

  // Refermer, puis vérifier que l'application redevient utilisable. Tant que
  // le panneau plein écran est ouvert, il passe devant le bouton de menu
  // (z-40 contre z-30) — c'est normal, il est modal : la fermeture doit donc
  // être réussie AVANT toute navigation, sinon le clic suivant échoue.
  // Libellé exact : « Fermer le panier et revenir aux produits ». Une
  // égalité stricte ne le trouvait pas, le panneau restait ouvert, et le
  // rapport annonçait un bug qui n'existait pas.
  const fermeture = page.locator('button[aria-label^="Fermer le panier"]').first();
  if (await fermeture.isVisible().catch(() => false)) {
    await fermeture.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  const encoreOuvert = await page.evaluate(() =>
    Boolean(document.querySelector('.fixed.inset-0.z-40.bg-white'))
  );
  rapport.push({
    format: format.nom,
    ecran: 'Fermeture du panier',
    ok: !encoreOuvert,
    problemes: encoreOuvert ? ['le panier ne se referme pas'] : [],
  });

  if (!encoreOuvert) {
    if (!(await dansLaFenetre(page.locator('button[aria-label="Stock"]').first()))) await ouvrirMenu();
    const rejouable = await page
      .locator('button[aria-label="Stock"]')
      .first()
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    rapport.push({
      format: format.nom,
      ecran: 'Navigation après panier',
      ok: rejouable,
      problemes: rejouable ? [] : ['la navigation ne répond plus après usage du panier'],
    });
  }

  await contexte.close();
}

await navigateur.close();

let ko = 0;
let avertis = 0;
for (const ligne of rapport) {
  if (ligne.erreur) { console.log(`✗ ${ligne.format} — ${ligne.erreur}`); ko++; continue; }
  if (ligne.ok) {
    const note = ligne.avertissements?.length ? `  ⚠ ${ligne.avertissements[0].split(' : ')[0]}` : '';
    if (note) avertis++;
    console.log(`✓ ${ligne.format.padEnd(8)} ${ligne.ecran.padEnd(28)}${note}`);
    // Le détail des cibles sous 44 px est consultable à part : le lister sur
    // chaque ligne noierait le rapport.
    if (ligne.avertissements?.length) {
      for (const a of ligne.avertissements) console.log(`    ${a}`);
    }
  } else {
    ko++;
    console.log(`✗ ${ligne.format.padEnd(8)} ${ligne.ecran}`);
    for (const p of ligne.problemes) console.log(`    ${p}`);
  }
}
if (avertis) {
  console.log(
    `\n${avertis} écran(s) sous 44 px de cible tactile — conformes au WCAG 2.2 AA (24 px),\n` +
    '  inconfortables au doigt. Signalés, non bloquants : voir la note du README.'
  );
}

if (erreursConsole.length) {
  console.log('\nErreurs console :');
  for (const e of [...new Set(erreursConsole)].slice(0, 20)) console.log(`  ${e}`);
}

console.log(`\n${rapport.length} écrans vérifiés, ${ko} avec problème. Profil : ${PROFIL}`);
process.exit(ko ? 1 : 0);
