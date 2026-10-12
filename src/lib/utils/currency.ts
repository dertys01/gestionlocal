/**
 * Formate un montant en FCFA (format Bénin)
 * Ex: 1500 → "1.500 F"
 */

// Instancié une seule fois au chargement du module. Construire un
// Intl.NumberFormat est coûteux, et formatCFA est appelé par cellule de grille,
// par ligne de tableau et par entrée de prévision.
const CFA_FORMATTER = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCFA(amount: number): string {
  // `Intl.format(NaN)` produit « NaN » : un montant non fini (calcul à zéro
  // dénominateur, donnée manquante) affichait « NaN F » à l'écran. On rend
  // « — », la convention « inconnu » du reste de l'application — un « 0 F »
  // serait un chiffre plausible mais faux.
  if (!Number.isFinite(amount)) return '-';
  return CFA_FORMATTER.format(amount) + ' F';
}

/**
 * Quantité affichée : « 1,5 » et non « 1.50000001 ».
 *
 * Le point décimal est LOCAL — un montant brut s'affiche avec un point chez les
 * anglophones, une virgule chez nous. `maximumFractionDigits: 3` évite la
 * notation scientifique et les zéros de fin sur les gros nombres.
 */
const QTY_FORMATTER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

export function formatQty(n: number): string {
  return QTY_FORMATTER.format(n);
}
