import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Bien démarrer — GestionLocal',
  description:
    'Guide de démarrage pour les premiers utilisateurs : créer le compte, choisir son activité, faire sa première vente, inviter un employé et signaler un bug.',
};

/**
 * Guide public « Bien démarrer ».
 *
 * Une page sans authentification, à partager par lien aux premiers
 * utilisateurs. Elle vit hors de l'application : le patron la lit avant même
 * d'avoir un compte, et la garde sous la main.
 */

const etapes = [
  {
    n: 1,
    titre: 'Créer votre compte',
    texte:
      'Ouvrez le lien reçu, cliquez sur « Créer un compte ». Renseignez le nom de votre boutique, votre e-mail et un mot de passe (6 caractères minimum). Aucune confirmation par e-mail : vous entrez directement.',
  },
  {
    n: 2,
    titre: 'Choisir votre activité',
    texte:
      'Boutique / Commerce, ou Restaurant / Maquis. Ce choix décide des écrans : une boutique a la caisse et les prévisions, un restaurant a en plus la Salle, la Cuisine, les Recettes et les Formules. Il reste modifiable dans Paramètres.',
  },
  {
    n: 3,
    titre: 'Ajouter vos produits',
    texte:
      'Un catalogue d’exemple est déjà là pour que vous voyiez tout de suite. Remplacez-le par vos articles : Stock → Ajouter un produit (nom, prix de vente, quantité). Les articles d’exemple portent un code « DEMO- » : retirez-les d’un clic quand vous n’en avez plus besoin.',
  },
  {
    n: 4,
    titre: 'Faire votre première vente',
    texte:
      'Boutique : onglet Caisse → touchez un article → Encaisser. Restaurant : onglet Salle → touchez une table → ajoutez les plats → Imprimer le ticket cuisine → Encaisser. Le stock se décrémente à l’encaissement, jamais avant.',
  },
  {
    n: 5,
    titre: 'Inviter un employé',
    texte:
      'Paramètres → Équipe → Invitez par e-mail. Votre employé reçoit un lien, crée son mot de passe, et voit l’application avec des droits limités (il vend, il ne gère pas les prix ni l’équipe).',
  },
  {
    n: 6,
    titre: 'Installer l’application sur le téléphone',
    texte:
      'Sur Android (Chrome) ou iPhone (Safari) : menu du navigateur → « Ajouter à l’écran d’accueil ». Elle s’ouvre alors comme une application, et la caisse fonctionne même quand le réseau coupe (les ventes partent à la reconnexion).',
  },
];

export default function GuidePage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-2xl p-5 space-y-6">
        <header className="space-y-2">
          <p className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
            Version de test
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Bien démarrer avec GestionLocal</h1>
          <p className="text-slate-600">
            Merci de nous aider à mettre l’application au point. Vous êtes parmi les premiers à
            l’utiliser pour de vrai : vos remarques valent de l’or.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold text-slate-800 mb-2">Ce qu’il vous faut</h2>
          <ul className="list-disc pl-5 text-sm text-slate-600 space-y-1">
            <li>Un téléphone, une tablette ou un ordinateur avec un navigateur récent.</li>
            <li>Une connexion internet (la caisse gère les coupures et reprend après).</li>
            <li>Cinq minutes pour la première vente.</li>
          </ul>
        </section>

        <ol className="space-y-3">
          {etapes.map((e) => (
            <li key={e.n} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start gap-3">
                <span className="shrink-0 h-7 w-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  {e.n}
                </span>
                <div className="space-y-1">
                  <h2 className="font-semibold text-slate-800">{e.titre}</h2>
                  <p className="text-sm text-slate-600">{e.texte}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
          <h2 className="font-semibold text-amber-900">Signaler un bug ou une idée</h2>
          <p className="text-sm text-amber-800">
            Dans l’application, en bas à droite : le bouton{' '}
            <strong>« Un retour ? »</strong>. Choisissez « Un bug », « Une idée » ou « Une question »,
            écrivez ce qui s’est passé — l’écran, le navigateur et l’heure sont joints
            automatiquement. C’est ce qui nous permet de corriger vite.
          </p>
          <p className="text-sm text-amber-800">
            Pas d’inquiétude si l’application paraît brute : c’est justement le but de cette phase.
            Dites-nous tout, même ce qui vous semble anodin.
          </p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <h2 className="font-semibold text-slate-800">Bon à savoir</h2>
          <ul className="list-disc pl-5 text-sm text-slate-600 space-y-1">
            <li>Vos données sont isolées : chaque boutique ne voit que les siennes.</li>
            <li>Vous démarrez sur le plan gratuit. Un essai de 14 jours (sans carte) débloque les
              rapports et les exports si vous en avez besoin.</li>
            <li>Le reçu simple s’imprime toujours, même sans facture normalisée.</li>
          </ul>
        </section>

        <footer className="text-center text-xs text-slate-400 pb-6">
          GestionLocal — merci de votre confiance.
        </footer>
      </div>
    </main>
  );
}
