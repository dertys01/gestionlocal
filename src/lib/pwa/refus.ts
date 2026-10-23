/**
 * Mémorisation du refus de la bannière d'installation (P2).
 *
 * On préfère `localStorage` : le refus survit aux visites. S'il est
 * indisponible (navigateur privé, stockage plein, environnement de test),
 * le refus vaut le temps de la session — c'est le composant qui
 * l'applique alors ; il ne faut surtout pas que ce détail fasse planter
 * l'accueil.
 *
 * Le refus n'est pas éternel : il expire au bout d'un mois. Une bannière
 * qu'on ne peut plus jamais revoir n'est pas un choix de l'utilisateur,
 * c'est une option qui a disparu — exactement ce qu'il faut éviter.
 */

const CLE = 'gl:installation-refusee';
const DUREE_REFUS_MS = 30 * 24 * 60 * 60 * 1000;

export function lireRefus(): boolean {
  try {
    const valeur = window.localStorage?.getItem(CLE);
    if (!valeur) return false;

    // Ancien format : « 1 », sans date. Il rendait le refus définitif ; on
    // le considère comme expiré une fois, pour rendre l'invitation aux
    // personnes qui l'avaient fermée avant cette règle.
    if (valeur === '1') {
      window.localStorage?.removeItem(CLE);
      return false;
    }

    const date = Number(valeur);
    if (!Number.isFinite(date)) return false;
    return Date.now() - date < DUREE_REFUS_MS;
  } catch {
    return false;
  }
}

export function marquerRefus(): void {
  try {
    window.localStorage?.setItem(CLE, String(Date.now()));
  } catch {
    /* stockage plein/privé : le refus reste porté par le composant */
  }
}

/**
 * Oublie un refus exprimé. Aucun écran n'appelle cette fonction :
 * c'est le harnais de test qui isole ainsi ses cas.
 */
export function reinitialiserRefus(): void {
  try {
    window.localStorage?.removeItem(CLE);
  } catch {
    /* rien à oublier */
  }
}
