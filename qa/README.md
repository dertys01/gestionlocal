# QA navigateur

Deux outils qui pilotent l'application dans un vrai navigateur, sur des
comptes réels et une vraie base. Ils ont été écrits parce que les tests
existants (`npm test`) ne voient que la logique : **aucun d'eux n'a de
navigateur**, et les défauts les plus graves de ce projet sont visuels — un
panier qui déborde hors de l'écran, un tiroir qui recouvre toute
l'application, un montant de dette écrasé à 2 px.

Ils ne font pas partie de `npm test` : ils demandent un navigateur, un serveur
de développement qui tourne, et une base peuplée. Ils se lancent à la main.

## Prérequis

```bash
npm install                      # installe playwright
npx playwright install chromium  # ~100 Mo, une fois, puis mis en cache
```

Si vous préférez ne pas télécharger Chromium, posez
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` avant `npm install` : le reste du projet
fonctionne, seuls ces deux scripts seront indisponibles.

## Utilisation

Le serveur doit tourner sur le port attendu (3001 par défaut, ou
`QA_BASE=http://localhost:3000`) :

```bash
npm run dev
```

Puis, dans un autre terminal, pour un compte **commerce** et un compte
**restaurant** :

```bash
npm run qa:audit    -- <email> <motdepasse> [retail|restaurant]
npm run qa:parcours -- <email> <motdepasse> [retail|restaurant]
```

Les identifiants de comptes de test ne sont jamais écrits dans un fichier
versionné : ce sont des arguments de ligne de commande, pour qu'ils ne se
retrouvent ni dans l'historique de git ni dans un `.env` partagé.

Le projet Supabase ciblé n'est **jamais** codé en dur : `parcours.mjs` lit
`NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` depuis
`.env.local` (le même projet que l'app testée), surchargeables par
`QA_SUPABASE_URL` / `QA_SUPABASE_KEY`. Un script QA ne peut donc pas écrire dans
la production par accident. `QA_BASE` choisit l'URL de l'app.

## `audit.mjs` — le balayage visuel

Ouvre une session, puis passe onglet par onglet à cinq largeurs (390, 320,
768, 1280 et 1920 px). Pour chaque écran il signale :

- débordement horizontal de la page ;
- texte tronqué alors qu'il devrait tenir ;
- élément visible mais hors de son cadre ;
- cible tactile trop petite pour le doigt ;
- bouton ou icône sans nom accessible ;
- `NaN`, `undefined`, `null` affichés tels quels ;
- capture d'écran dans `qa/shots/` (jamais versionnée).

C'est cet outil qui a trouvé les deux défauts qui **empêchaient de travailler** :
le panier hors écran à 1280 px (le total et le bouton « Encaisser » étaient
hors d'atteinte), et le tiroir panier qui, à cette même largeur, passait en
couche fixe `inset-0` et recouvrait la navigation entière.

### Les deux seuils de cible tactile

L'audit applique deux règles distinctes, et ne les confond pas :

| Seuil | Norme | Effet |
|---|---|---|
| **24 px** | WCAG 2.2 AA (2.5.8) | **fait échouer** l'écran |
| **44 px** | WCAG 2.5.5 AAA, confort du doigt | **avertissement** seulement |

Cette distinction est délibérée. En faisant échouer l'audit dès 44 px, une
trentaine d'écrans échouaient en permanence — et un rapport qui crie en
permanence ne signale plus ce qui est réellement nouveau.

Ce qui reste en dessous de 44 px sur les formats tactiles, et qui est donc
signalé sans être bloquant :

- les entrées du tiroir de navigation (47 × 40) ;
- les boutons icônes (32 × 32) ;
- les filtres de période des rapports (24 px de haut) ;
- les puces de catégorie du point de vente (30 px de haut).

Les porter à 44 px est une amélioration de confort réelle, mais elle touche
beaucoup d'écrans à la fois : elle mérite son propre passage, avec un test de
non-régression par écran, plutôt qu'être faite au fil de l'eau.

## `parcours.mjs` — le parcours métier

Agit comme un commerçant et vérifie **l'écran et la base** après chaque geste.
La double vérification est délibérée : la majorité des bugs de cette
application sont « l'écran dit que c'est bon, la base dit le contraire ».

Le parcours commun aux deux profils :

- une vente complète, de la ligne ajoutée au reçu ;
- « Reprendre la dernière vente » ;
- le chiffre d'affaires du journal suit l'encaissement ;
- une vente à crédit : apparaît-elle dans le carnet de dette, et entre-t-elle
  dans le chiffre d'affaires ;
- un règlement de dette change-t-il le chiffre d'affaires ;
- un réapprovisionnement de 7 unités ;
- un produit créé depuis le formulaire, prix et stock compris ;
- un rayon ne se propose pas deux fois.

S'y ajoutent, sur le profil restaurant, la salle (tables et zones), les
recettes, et une **commande de bout en bout** : une table libre est choisie en
base — pas à l'écran, sinon le test pourrait rouvrir la commande d'un autre
serveur et vérifier à côté — un plat est ajouté, puis l'addition encaissée, ce
qui est vérifié trois fois : la confirmation à l'écran, la vente écrite, et la
table libérée.

Un échec est daté et nommé (`29b. le numéro évite la facture manuelle`), pas
seulement compté.

### Attendre, ne pas deviner

Aucune étape ne lit l'écran après un délai fixe quand elle attend une
confirmation. Un délai fixe marche jusqu'au jour où la machine est chargée :
le reçu n'est pas encore monté, le script lit le squelette de la page, et le
test échoue sur un écran qui finira par s'afficher. C'est ainsi que « le reçu
distingue la vente à crédit » échouait une fois sur quatre sans qu'aucune
ligne de l'application change. `attendTexte()` attend un texte donné, borné :
au terme du délai l'assertion échoue donc pour de bon.

## Après une modification

Relancer les deux sur les deux profils. Les chiffres attendus au moment de la
rédaction : 63 écrans en commerce et 68 en restaurant, 0 problème ; 30 et 41
vérifications de parcours, 0 échec.

Les parcours écrivent dans la base : ventes, dettes, produits « Produit QA » et
commandes de table s'accumulent d'une exécution à l'autre. C'est voulu — ils
vérifient ce qui est réellement écrit — mais la boutique de test finit par
s'encombrer, et il faut la reseed de temps en temps.

Un `npm test` vert ne dit pas que l'application est utilisable : il dit que la
logique est cohérente. Ces deux scripts disent la seconde chose.
## `onboarding.mjs` — le premier lancement

Crée un compte neuf et joue l'assistant jusqu'à la première vente, à 375 px :
capture de chaque écran, débordement horizontal, erreurs HTTP et JS, mode
simple puis bascule en mode complet.

```bash
QA_BASE=http://localhost:3001 node qa/onboarding.mjs [epicerie|boutique|restaurant|autre] [exemples|mes-produits]
```

L'inscription est limitée à quelques comptes par heure et par adresse IP.
Au-delà, rejouez sur un compte existant dont l'onboarding a été remis à zéro
(`onboarding_done = false`, `onboarding_step = 'business'`) avec
`QA_EMAIL=<email> QA_PASSWORD=<mot de passe>`.

## `scripts/supabase-sql.mjs` — SQL sur la base de recette

Applique une migration ou une requête via l'API de gestion Supabase. Demande
`SUPABASE_ACCESS_TOKEN` (jeton personnel) dans `.env.local`.

```bash
node scripts/supabase-sql.mjs supabase/migration_x.sql
node scripts/supabase-sql.mjs --query "SELECT count(*) FROM organizations"
```

## `accueil.mjs` — la journée d'un compte existant

Accueil, Journal du jour et caisse, à la largeur voulue : chiffres affichés,
débordement, libellé du tri, erreurs HTTP et JS.

```bash
QA_PASSWORD=<mot de passe> node qa/accueil.mjs <email> 375 gratuit
```

## `exports.mjs` — relance et exports

Liens « Relancer » au format international, Excel des dettes et des ventes
(séparateur `;`), PDF lisible à 375 px. Compte en plan Starter ou Pro.

## `captures-accueil.mjs` — les captures de la page d'accueil

Refait `public/captures/{tableau-du-jour,caisse,journal}.png` (375 x 812)
depuis un compte réel : le tableau du jour, la caisse, le journal. Le bandeau
« version de test » est masqué. À relancer quand l'interface change, sinon la
page d'accueil montre une application qui n'existe plus.

```bash
QA_BASE=https://... QA_PASSWORD=<mot de passe> node qa/captures-accueil.mjs <email>
```

La connexion se fait au clavier (`pressSequentially`), pas par `fill()` : les
champs contrôlés de React ne réagissent pas au `fill`, et Supabase recevait un
e-mail vide (« missing email or phone »).```bash
QA_PASSWORD=<mot de passe> node qa/exports.mjs <email>
```
