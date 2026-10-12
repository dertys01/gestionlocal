/**
 * PayDunya — squelette, AUCUN appel réseau (Sprint 19).
 *
 * Même contrat que FedaPay (voir fedapay.ts) : la forme est en place, les
 * appels non. PayDunya a été retenu comme alternative parce que sa
 * couverture inclut le Cameroun à côté de l'UEMOA — le choix définitif se
 * tranche à l'essai en bac à sable (évaluation, Sprint 19).
 *
 * Tant que `creerPaiement` rejette : route de commande en 503. Tant que
 * `verifierCallback` retourne null : webhook refusé (fail closed).
 */

import type { PaiementCree, Confirmation, Prestataire } from './types';

export class PayDunya implements Prestataire {
  readonly id = 'paydunya' as const;

  creerPaiement(): Promise<PaiementCree> {
    return Promise.reject(
      new Error('PayDunya : appels API non branchés : clés et endpoint à écrire après l’essai sandbox.'),
    );
  }

  verifierCallback(): Confirmation | null {
    return null;
  }
}
