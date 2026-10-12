import Link from 'next/link';
import {
  ArrowRight,
  BarChart2,
  Handshake,
  MessageCircle,
  Package,
  ShoppingCart,
} from 'lucide-react';

/**
 * Page d'accueil publique (P8 — évaluation §6).
 *
 * Avant : l'adresse du site ouvrait le formulaire de connexion. Maintenant
 * elle ouvre celle-ci, le formulaire est à /connexion. Composant pur : ni
 * état, ni accès session — le serveur peut le rendre, un test peut le lire.
 *
 * La copie ne contient AUCUNE valeur d'offre (prix, plafond, durée) : le
 * dépôt est public, et l'écran n'est pas l'endroit où les chiffres vivent —
 * voir src/lib/utils/plans.ts. Le seul chiffre de ce fichier est le numéro
 * WhatsApp du commerce, qui est fait pour être public.
 */

/** Canal de contact direct — bouton vert du héros et de l'appel final. */
const WHATSAPP_SALES =
  'https://wa.me/2290197633529?text=' +
  encodeURIComponent('Bonjour, je veux créer ma boutique sur GestionLocal.');

const CAPTURES = [
  {
    src: '/captures/tableau-du-jour.png',
    alt: "Le tableau du jour : encaissé, nombre de ventes et somme à recouvrer",
    legende: 'Le tableau du jour',
    detail: "Le total encaissé, le nombre de ventes et ce qu'il reste à recouvrer, sur un écran.",
  },
  {
    src: '/captures/caisse.png',
    alt: 'Le point de vente : recherche de produit, catégories et panier',
    legende: 'La caisse',
    detail: 'Un produit se trouve en un geste : recherche, catégories, code-barres.',
  },
  {
    src: '/captures/journal.png',
    alt: 'Le journal des ventes du jour avec le chiffre d’affaires',
    legende: 'Le journal des ventes',
    detail: 'Chaque vente du jour, avec son mode de paiement et son article.',
  },
] as const;

const FONCTIONS = [
  {
    icon: ShoppingCart,
    titre: 'Caisse et codes-barres',
    texte:
      "Encaissez en espèces ou par Mobile Money, à crédit aussi. Le reçu part sur WhatsApp en un geste.",
  },
  {
    icon: Handshake,
    titre: 'Dettes clients',
    texte:
      "Le carnet de dettes : qui doit quoi, depuis quand. Relance en un clic, versements encaissés au fur et à mesure.",
  },
  {
    icon: Package,
    titre: 'Stocks sous contrôle',
    texte:
      "Chaque vente décrémente le stock. Les articles qui s'épuisent remontent d'eux-mêmes.",
  },
  {
    icon: BarChart2,
    titre: 'Le chiffre du jour',
    texte:
      "Journal, rentabilité et prévisions de réapprovisionnement : l'essentiel tout de suite, les rapports selon la formule.",
  },
] as const;

/** L'appel à l'action — répété en haut et en bas, jamais enterré. */
function Appels({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-col gap-3 ${compact ? 'sm:flex-row' : 'sm:flex-row sm:items-center'}`}>
      <Link
        href="/register"
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 h-12 transition-colors"
      >
        Créer ma boutique
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </Link>
      <a
        href={WHATSAPP_SALES}
        target="_blank"
        rel="noopener noreferrer"
        // Vert WhatsApp FONCÉ, pas le #25D366 de la marque : le blanc sur ce
        // vert clair ne donne qu'un contraste de 1,98:1 (Lighthouse le relève).
        // #0f7a3d monte à ~5,4:1 et reste reconnaissable.
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0f7a3d] hover:bg-[#0c6631] text-white font-semibold px-6 h-12 transition-colors"
      >
        <MessageCircle className="w-4 h-4" aria-hidden="true" />
        Parler sur WhatsApp
      </a>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col">
      {/* ── En-tête ── */}
      <header className="border-b border-slate-100">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <span className="flex items-center gap-2 font-bold text-lg">
            {/* eslint-disable-next-line @next/next/no-img-element -- icône locale48 px : l'optimiseur d'images n'apporte rien et coûte une configuration */}
            <img src="/icon-192x192.png" alt="" width={32} height={32} className="w-8 h-8" />
            GestionLocal
          </span>
          <nav className="flex items-center gap-2 sm:gap-4 text-sm">
            <Link href="/tarifs" className="text-slate-600 hover:text-slate-900 px-2 py-2">
              Tarifs
            </Link>
            <Link
              href="/connexion"
              className="text-slate-600 hover:text-slate-900 px-2 py-2"
            >
              Se connecter
            </Link>
            <Link
              href="/register"
              className="hidden sm:inline-flex items-center rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 transition-colors"
            >
              Créer ma boutique
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Héros ── */}
        <section className="max-w-5xl mx-auto px-4 pt-14 pb-10 sm:pt-20 sm:pb-14 text-center">
          <p className="inline-block rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold px-3 py-1 mb-5">
            Gratuit pour commencer, sans carte bancaire
          </p>
          <h1 className="text-3xl sm:text-5xl font-bold leading-tight tracking-tight">
            La caisse qui suit vos ventes,
            <br className="hidden sm:block" /> vos stocks et vos dettes.
          </h1>
          <p className="mt-5 text-slate-600 text-lg max-w-2xl mx-auto">
            GestionLocal est l&apos;application des commerçants : encaissez au
            comptoir, relevez ce que les clients vous doivent, et sachez à tout
            moment ce qu&apos;il vous reste en stock. Le tout, depuis votre téléphone.
          </p>
          <div className="mt-8 flex justify-center">
            <Appels />
          </div>
          <p className="mt-4 text-sm">
            <Link href="/tarifs" className="text-indigo-600 hover:text-indigo-800 underline">
              Voir les tarifs
            </Link>
          </p>
        </section>

        {/* ── Captures ── */}
        <section aria-labelledby="captures-titre" className="bg-slate-50 border-y border-slate-100 py-12 sm:py-16">
          <div className="max-w-5xl mx-auto px-4">
            <h2 id="captures-titre" className="text-2xl font-bold text-center mb-8">
              L&apos;application, telle qu&apos;elle est
            </h2>
            <ul className="grid gap-6 sm:grid-cols-3">
              {CAPTURES.map((c) => (
                <li key={c.src} className="bg-white rounded-2xl border border-slate-200 p-3 shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element -- capture locale déjà au bon format (375 px) : sans configureur d'images, pas de gaspillage d'optimisation */}
                  <img
                    src={c.src}
                    alt={c.alt}
                    width={375}
                    height={812}
                    loading="lazy"
                    className="w-full h-auto rounded-xl border border-slate-100"
                  />
                  <p className="mt-3 font-semibold text-sm">{c.legende}</p>
                  <p className="text-slate-600 text-sm mt-1">{c.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Fonctions ── */}
        <section aria-labelledby="fonctions-titre" className="max-w-5xl mx-auto px-4 py-12 sm:py-16">
          <h2 id="fonctions-titre" className="text-2xl font-bold text-center mb-10">
            Ce que fait GestionLocal
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FONCTIONS.map((f) => (
              <li key={f.titre} className="rounded-2xl border border-slate-200 p-5">
                <f.icon className="w-6 h-6 text-indigo-600 mb-3" aria-hidden="true" />
                <h3 className="font-semibold">{f.titre}</h3>
                <p className="text-slate-600 text-sm mt-2">{f.texte}</p>
              </li>
            ))}
          </ul>
          <p className="text-center text-sm text-slate-500 mt-8">
            Les rapports et les exports figurent dans les formules payantes :{' '}
            <Link href="/tarifs" className="text-indigo-600 hover:text-indigo-800 underline">
              comparaison sur la page tarifs
            </Link>
            .
          </p>
        </section>

        {/* ── Appel final ── */}
        <section className="bg-indigo-600 text-white py-12 sm:py-16">
          <div className="max-w-3xl mx-auto px-4 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold">
              Votre boutique mérite mieux qu&apos;un cahier.
            </h2>
            <p className="mt-3 text-indigo-100">
              Créez-la en deux minutes, ou posez vos questions sur WhatsApp :
              on répond nous-mêmes.
            </p>
            <div className="mt-7 flex justify-center">
              <Appels compact />
            </div>
          </div>
        </section>
      </main>

      {/* ── Pied de page ── */}
      <footer className="border-t border-slate-100">
        <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-slate-500">
          <span>© GestionLocal</span>
          <nav className="flex gap-5">
            <Link href="/tarifs" className="hover:text-slate-900">
              Tarifs
            </Link>
            <Link href="/connexion" className="hover:text-slate-900">
              Se connecter
            </Link>
            <a href={WHATSAPP_SALES} target="_blank" rel="noopener noreferrer" className="hover:text-slate-900">
              WhatsApp
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
