/**
 * Construction de la demande de facture e-MECeF à partir d'une vente.
 *
 * Fonction PURE (aucun réseau) : c'est ici que la vente de l'application
 * devient le document attendu par la DGI. Elle est testée sans serveur.
 *
 * Ce qui manque encore pour une facture parfaitement juste : le GROUPE DE
 * TAXATION de chaque article (A = exonéré, B = 18 % TVA…). L'application ne
 * le stocke pas encore ; le défaut est B, et `taxGroup` peut être fourni par
 * ligne. À trancher avec la DGI/comptable avant la production.
 */

import type {
  DemandeFacture,
  LigneFacture,
  ModePaiement,
  PaiementFacture,
} from './types';

/** Groupe de taxation par défaut (B = 18 % TVA). À paramétrer par article. */
export const GROUPE_TAXATION_DEFAUT = 'B';

export interface LigneVente {
  name: string;
  /** Prix réellement facturé (prix convenu, supplément compris). */
  unitPrice: number;
  quantity: number;
  /** Prix catalogue, pour tracer une remise négociée. */
  listPrice?: number | null;
  /** Groupe de taxation ; absent = GROUPE_TAXATION_DEFAUT. */
  taxGroup?: string | null;
}

export interface PaiementVente {
  /** Moyen interne : cash, momo, credit, mixed. */
  method: 'cash' | 'momo' | 'credit' | 'mixed';
  amount: number;
}

export interface VenteAFacturer {
  /** Numéro de facture attribué par create_sale (FAC-AAAA-NNNNN). */
  numero: string;
  /** IFU de la boutique (13 caractères). */
  ifu: string;
  lignes: LigneVente[];
  paiements: PaiementVente[];
  clientName?: string | null;
  clientIfu?: string | null;
  operateur?: string | null;
}

/** Traduit un moyen de paiement interne vers le vocabulaire de la DGI. */
export function modePaiementMecef(method: PaiementVente['method']): ModePaiement {
  switch (method) {
    case 'momo':
      return 'MOBILEMONEY';
    case 'credit':
      return 'CREDIT';
    case 'mixed':
      // Un paiement mixte est ventilé par l'appelant (sale_payments) ; ce
      // cas ne devrait pas arriver. Espèces par défaut, jamais un crash.
      return 'ESPECES';
    case 'cash':
    default:
      return 'ESPECES';
  }
}

/**
 * Construit la demande de facture. Lève si aucune ligne n'est facturable :
 * une facture sans article est refusée par la DGI (code 8).
 */
export function construireFacture(vente: VenteAFacturer): DemandeFacture {
  const items: LigneFacture[] = vente.lignes
    .filter((l) => l.quantity > 0)
    .map((l) => {
      const remise =
        l.listPrice != null && l.listPrice > l.unitPrice ? l.listPrice - l.unitPrice : 0;
      return {
        name: l.name,
        price: l.unitPrice,
        quantity: l.quantity,
        taxGroup: (l.taxGroup ?? '').trim() || GROUPE_TAXATION_DEFAUT,
        ...(remise > 0 ? { discount: remise } : {}),
      };
    });

  if (items.length === 0) {
    throw new Error('e-MECeF : la facture doit contenir au moins un article.');
  }

  const payment: PaiementFacture[] = vente.paiements
    .filter((p) => p.amount > 0)
    .map((p) => ({ name: modePaiementMecef(p.method), amount: p.amount }));

  return {
    ifu: vente.ifu.trim(),
    type: 'FV',
    items,
    ...(vente.clientName || vente.clientIfu
      ? {
          client: {
            ...(vente.clientIfu ? { ifu: vente.clientIfu.trim() } : {}),
            ...(vente.clientName ? { name: vente.clientName.trim() } : {}),
          },
        }
      : {}),
    ...(vente.operateur ? { operator: { name: vente.operateur } } : {}),
    payment,
    reference: vente.numero,
  };
}
