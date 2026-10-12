# Sécurité — incident de fuite de clés

## Où on en est : clos

Les clés Supabase commitées dans l'historique git ont été **révoquées puis
purgées**, dans cet ordre. Les deux étapes sont vérifiées, pas déclarées.

### 1. Les clés sont mortes (le geste qui compte)

Les trois clés trouvées dans l'historique ont été appelées en direct après
leur révocation :

| Clé | Rôle | Réponse du serveur |
|---|---|---|
| `ec8f258f60b9…` | `service_role` | `401 — Legacy API keys are disabled` |
| `b7564ae9779a…` | `anon` | `401 — Legacy API keys are disabled` |
| `2c7008007ed5…` | `anon` (périmée) | `401 — Invalid API key` |

C'est la preuve qui ferme l'incident : une clé révoquée ne se dévalue pas
« un jour », elle est rejetée maintenant, par le serveur.

### 2. L'historique a été réécrit

`scripts/purge-secrets.sh --purge` : 123 commits réécrits, remplacement des
**valeurs exactes** des clés (pas « tout ce qui ressemble à un JWT » — la clé
anon est publique par principe, elle sert au navigateur, et l'abraser n'aurait
rien protégé). Force-push effectué.

Contrôles après réécriture : 0 clé entière dans l'historique, arbre du dernier
commit identique bit pour bit, 178 tests verts, 0 échec du harnais SQL.

### 3. Ce qui reste — et n'est pas un risque

GitHub sert encore les anciens objets par leur SHA, et c'est vérifiable :
l'API renvoie le contenu d'un vieux fichier contenant l'ancienne clé anon. Le
dépôt n'est plus privately accessible, mais les objets existent jusqu'au
prochain ramasse-miettes de GitHub.

Sans importance, maintenant : ces clés sont **révoquées**. Un objet lisible qui
ne vaut rien n'est pas une fuite.

Pour les faire disparaître quand même, il faut passer par le support GitHub
(leur équipe peut forcer un GC sur demande, uniquement pour une fuite de
secret avérée). À faire seulement si tu veux que le dépôt soit propre sur le
plan documentaire — pas pour la sécurité.

## Les clés actuelles

| Variable | Format | Où |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | — | inchangée |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_…` | Vercel (tous les environnements) + `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` (`default`) | Vercel (Production) + `.env.local` |

Les clés JWT héritées sont désactivées au niveau du projet
(*Disable JWT-based API keys*). L'application ne dépend plus d'elles : le
navigateur utilise la clé publishable, le serveur la secret key.

### Où la clé service role est réellement utilisée

Une clé `service_role` contourne toute la RLS. Elle n'est donc employée que là
où il n'existe pas de session à utiliser, c'est-à-dire trois cas :

| Route | Pourquoi |
|---|---|
| `/api/register` | crée le compte Auth, et le limiteur doit être partagé entre les instances serverless |
| `/api/invitations/accept` | `redeem_invitation()` est privileged : l'appelant est anonyme, c'est le jeton d'invitation qui fait foi |
| `/api/payments/order` | `payment_orders` n'a **aucune écriture client** (INSERT/UPDATE/DELETE révoqués) : la commande naît ici, après `requirePatron()` |
| `/api/payments/callback/[provider]` | appelant anonyme — le fournisseur appelle sans session ; `activate_prepaid_plan()` est la seule écriture possible d'un plan payant |
| `/api/stripe/*` | abonnements et webhooks |

L'**écran Équipe et les invitations** n'en ont plus besoin. Ils utilisaient la
clé pour lire `business_members` — alors que la policy
`owner_manage_members_select` (`auth.uid() = owner_id`) autorise déjà le patron
à lire sa propre équipe — et pour écrire dans `employee_invitations`, dont la
policy est déjà `FOR ALL` sur son propriétaire. Autrement dit, la clé service
réouvrait exactement ce que `migration_security.sql` avait refermé.

Les deux écritures qui restaient (changer un rôle, retirer un membre) passent
désormais par `business_members_set_role()` et `business_members_remove()`, en
SECURITY DEFINER : la table n'a toujours aucune écriture client, et la
vérification « l'appelant est-il le patron de cette équipe ? » vit dans la
fonction, où elle ne peut pas être oubliée.

Conséquence pratique : **sans `SUPABASE_SERVICE_ROLE_KEY`, l'application
démarre, se construit en développement et fonctionne**. Seules l'inscription,
la facturation et les paiements répondent 503, ce qui est exact.

## Ce que le freemium a ajouté (Sprint 19)

Le dépôt est **public** : c'est la donnée qui doit être protégée, pas le code.

- **Ni prix ni quota dans le dépôt.** Les valeurs vivent dans
  `NEXT_PUBLIC_PLANS_CONFIG` (`.env.local` + dashboard du déploiement, lues au
  build) et dans `plan_config`, table **vide dans le dépôt** remplie par
  `npm run sync:plans`. Un garde-fou refuse tout commit contenant une valeur
  d'offre. `plan_config` est soumis à RLS et révoqué de `anon` comme
  d'authenticated : le navigateur n'y touche pas, ce sont les fonctions
  SECURITY DEFINER qui la lisent.
- **`payment_orders`** : SELECT limité à `user_id = auth.uid()` — le patron
  voit ses commandes, l'employé rien ; toute écriture passe par les routes
  avec la clé service.
- **`activate_prepaid_plan()`** : SECURITY DEFINER, exécutable par
  `service_role` uniquement, idempotente (pending → paid atomiquement),
  prolongation ajoutée à la fin de la période en cours — jamais un remplacement
  silencieux.
- **Le callback fournisseur** échoue fermé : le domaine appelant doit être
  celui du fournisseur configuré. Le parcours sandbox ne s'active qu'avec
  `PAYMENTS_SANDBOX=1`, vérifié à la création comme au callback.
- **L'essai de 14 jours** : `start_free_trial()`, une seule fois par
  organisation, déclenché par un bouton — jamais automatique à l'inscription.
- **Échec = fail-open assumé** : sans configuration, pas de quota (les quotas
  ne se devinent jamais) et pas de prix vendus — d'où l'ordre de déploiement
  ci-dessous, qui n'est pas une recommandation.

## Facture normalisée e-MECeF (DGI Bénin)

L'application jouera le rôle de SFE (système de facturation électronique) pour
les boutiques : IFU enregistré + connexion DGI ouverte = la caisse délivre une
facture ; sinon seul le reçu simple sort. Tant que la DGI n'a pas délivré ses
accès, **personne ne peut délivrer de facture** — c'est le choix assumé.

- **`MECEF_TOKEN`** : clé de connexion à la DGI, serveur uniquement, jamais dans
  le dépôt ni dans le navigateur (`.env.local.example` n'en montre que le nom).
  Comme `PAYMENTS_SANDBOX`, le verrou est **double** : un jeton posé n'ouvre
  rien tant que `APPELS_DGI` dans `src/lib/mecef/index.ts` n'est pas passé à
  true — dans le même commit que les appels réels. On ne peut donc ni oublier
  les accès, ni faire croire à une facturation qui n'arriverait nulle part.
- **`/api/mecef/status`** : GET répond `{ branche: boolean }` après une session
  (caissier·e ou patron·ne — les deux impriment). Aucun jeton, aucun motif de
  diagnostique ne sort de cette route. Sans session : 401, et le verrou client
  reste fermé (fail-closed, y compris hors-ligne).
- **`src/lib/mecef/gate.ts`** : le verrou pur (IFU 13 caractères + connexion),
  partagé par la caisse et les Paramètres, testé sans serveur. `printReceipt()`
  applique le même invariant en défense : un papier sans IFU valide ne dit
  jamais « FACTURE N° ».
- **Le reçu simple n'est jamais bloqué** : c'est l'article non négociable. Le
  reçu est imprimé SANS numéro ; « FACTURE N° » n'existe que sur le bouton
  facture, une fois les trois conditions réunies.
- **`emettreFacture()`** : appelle réellement la DGI — soumission
  (`POST /api/invoice`) puis confirmation (`PUT /api/invoice/{uid}/confirm`),
  via `src/lib/mecef/client.ts`. `src/lib/mecef/invoice.ts` construit la
  demande depuis la vente (fonction pure, testée sans réseau). Sans jeton, la
  fonction refuse : aucune facture de façade.
- **`POST /api/mecef/invoice`** : délivre une facture. Le navigateur n'envoie
  que l'identifiant de la vente ; la route relit montant, lignes et IFU en
  base, appelle la DGI, et range les éléments de sécurité (code MECeF, QR,
  NIM) dans `mecef_invoices` (une ligne par vente, RLS équipe, unicité sur
  `sale_id`). Une facture déjà normalisée se renvoie telle quelle (idempotence).

## Ce qui empêche le retour

- **Gitleaks en CI** (`.github/workflows/ci.yml`) : toute nouvelle fuite fait
  échouer le build.
- **`requireEnv()`** : une variable manquante échoue bruyamment au démarrage,
  au lieu de retomber sur une valeur codée en dur. C'est ce qui avait permis à
  la clé de vivre dans le code.
- **`sanitizeError()`** : plus aucun en-tête `Authorization` dans les logs.
- **`.env.local` en `600`** et non versionné.

## Si une clé privileged fuite un jour

Une clé `service_role` contourne toute la RLS : elle lit les emails de tous les
comptes, toutes les dettes avec numéros de téléphone, et écrit dans n'importe
quelle boutique. Le réflexe, dans l'ordre :

1. **Révoquer** sur le dashboard — c'est le geste qui stoppe l'accès, tout le
   reste est de la propreté.
2. Migrer vers `sb_secret_…` + désactiver les clés JWT héritées.
3. Vérifier, **en appelant l'ancienne clé** et en montrant le 401.
4. Purger l'historique.
5. Auditer ce qui a pu être lu : ventes, dettes, contacts. Et prévenir les
   personnes concernées — c'est la partie qu'on oublie toujours.

## Déployer une mise à jour (runbook)

Ordre **non négociable** — l'étape 4 sans les étapes 1-3 ne casse rien, mais
applique la code sans quotas ; les étapes 1-3 sans la 4 non plus, pour la
même raison. Les deux moitiés vont ensemble.

1. `node scripts/supabase-sql.mjs supabase/migration_trial.sql`
2. `node scripts/supabase-sql.mjs supabase/migration_mobilemoney.sql`
3. `node scripts/supabase-sql.mjs supabase/migration_plan_config.sql`
4. `npm run sync:plans` — **sans lui, aucun quota n'est appliqué** (fail-open
   documenté dans `migration_plan_config.sql`).
5. Vercel : `NEXT_PUBLIC_PLANS_CONFIG` identique à `.env.local`, puis
   redéployer — les variables `NEXT_PUBLIC_*` sont lues **au build**, un
   changement de dashboard ne se répercute pas sur un déploiement existant.
6. Push : Vercel déploie.

Contrôles après déploiement : `plan_config` renvoie 9 lignes,
`/tarifs` affiche les prix (jamais « — »), `current_org_plan()` répond.

Côté paiements, tant que les clés fournisseur n'arrivent pas :
`PAYMENTS_PROVIDER` absent (donc sandbox) **sans** `PAYMENTS_SANDBOX` — la
commande répond 503, ce qui est exact. **`PAYMENTS_SANDBOX=1` ne doit jamais
exister sur un déploiement réel** ; les clés FedaPay/PayDunya, quand elles
arriveront, vivent dans le dashboard et `.env.local`, nulle part ailleurs.