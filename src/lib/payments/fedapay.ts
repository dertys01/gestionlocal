/**
 * FedaPay — squelette, AUCUN appel réseau (Sprint 19).
 *
 * Ce qui est décidé ici, et ne bougera plus :
 *   • `creerPaiement` crée une transaction côté serveur et renvoie l'URL de
 *     paiement hébergée par FedaPay (MTN, Moov, Celtiis — 1,8 % relevés par
 *     l'évaluation) ;
 *   • `verifierCallback` valide la signature du webhook FedaPay avant de
 *     laisser la route appeler activate_prepaid_plan(). Tant que la
 *     vérification n'est pas écrite, elle retourne null : un webhook
 *     FedaPay reçu aujourd'hui serait REFUSÉ, pas deviné.
 *
 * Ce qui manque, et qu'aucun montage ne peut devancer : les clés de sandbox,
 * puis la ligne d'appel HTTP elle-même — à écrire après l'essai en bac à
 * sable prévu au Sprint 19 (l'évaluation : « à trancher par un essai en bac
 * à sable, comme prévu au sprint 19 »).
 *
 * Tant que `creerPaiement` rejette, la route de commande répond 503 :
 * « paiement indisponible pour le moment ». On vend explicitement « pas
 * encore », jamais un parcours cassé.
 */

import type { PaiementCree, Confirmation, Prestataire } from './types';

export class FedaPay implements Prestataire {
  readonly id = 'fedapay' as const;

  creerPaiement(): Promise<PaiementCree> {
    return Promise.reject(
      new Error('FedaPay : appels API non branchés : clés et endpoint à écrire après l’essai sandbox.'),
    );
  }

  verifierCallback(): Confirmation | null {
    return null;
  }
}
