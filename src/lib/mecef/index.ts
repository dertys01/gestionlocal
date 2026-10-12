/**
 * e-MECeF — machine électronique de facturation certifiée (DGI du Bénin).
 *
 * Modèle, tel qu'il est décidé et ne bougera plus :
 *   • l'application joue le rôle de SFE (système de facturation électronique)
 *     pour la boutique : c'est elle qui émet et transmet les factures ;
 *   • le lien avec la DGI exige un jeton délivré après agrément, qui vit
 *     ICI, côté serveur, dans MECEF_TOKEN — jamais dans le dépôt, jamais
 *     dans le navigateur, comme les clés de paiement ;
 *   • la caisse n'offre la délivrance d'une facture que si l'IFU est
 *     enregistré ET si cette connexion est ouverte (voir ./gate.ts).
 *
 * Les appels réels vivent dans ./client.ts et ./invoice.ts ; ils ne partent
 * que lorsque le DOUBLE verrou est ouvert : `APPELS_DGI` (le code est écrit)
 * ET `MECEF_TOKEN` (les accès DGI sont là). Sans jeton, on refuse — la caisse
 * affiche le motif de connexion et le reçu simple reste le seul papier. On
 * vend explicitement « pas encore », jamais une facture qui n'arriverait
 * nulle part.
 */

import { MecefClient, BASE_URL_DGI } from './client';
import { construireFacture, type VenteAFacturer } from './invoice';

export type { VenteAFacturer, LigneVente, PaiementVente } from './invoice';
export { construireFacture, modePaiementMecef, GROUPE_TAXATION_DEFAUT } from './invoice';
export { MecefClient, MecefError, BASE_URL_DGI } from './client';
export type * from './types';

/** État de la connexion à la DGI, tel que vu par le serveur. */
export interface EtatLiaison {
  branche: boolean;
  /** Raison du verrou, pour les logs serveur (jamais pour le navigateur). */
  motif: string;
}

/**
 * Le jeton DGI est la moitié du lien : l'autre moitié est la ligne d'appel,
 * désormais écrite (./client.ts). On garde un drapeau explicite, comme
 * `PAYMENTS_SANDBOX` : même avec un jeton posé, rien ne part tant que le code
 * n'est pas déclaré prêt. Il l'est maintenant — il ne reste que les accès.
 */
const APPELS_DGI = true;

/** Environnement minimal lu par la couche e-MECeF. */
export interface EnvMecef {
  MECEF_TOKEN?: string;
  MECEF_BASE_URL?: string;
}

/**
 * État de la connexion, pour /api/mecef/status.
 *
 * Seul un booléen sortira vers le navigateur : le motif parle de jeton et
 * d'appels, c'est de la diagnostique serveur.
 */
export function etatLiaison(env: NodeJS.ProcessEnv | EnvMecef = process.env): EtatLiaison {
  if (!APPELS_DGI) {
    return { branche: false, motif: 'Appels DGI non branchés (accès en attente)' };
  }
  if (!env.MECEF_TOKEN?.trim()) {
    return { branche: false, motif: 'MECEF_TOKEN absent' };
  }
  return { branche: true, motif: '' };
}

/** Facture normalisée, telle que renvoyée par la DGI. */
export interface FactureEmise {
  uid: string;
  /** Code MECeF/DGI signé (24 caractères). */
  codeMECeFDGI: string;
  /** QR code, image base64. */
  qrCode: string;
  /** NIM de la machine signataire. */
  nim: string;
  /** Date/heure de normalisation (ISO). */
  dateTime: string;
  /** Total calculé par la DGI. */
  total: number;
}

/**
 * Émission d'une facture normalisée : soumission puis confirmation auprès de
 * la DGI, et retour des éléments de sécurité (code MECeF, QR, NIM).
 *
 * Refuse si le verrou est fermé (pas de jeton) : aucune facture de façade.
 */
export async function emettreFacture(
  vente: VenteAFacturer,
  env: NodeJS.ProcessEnv | EnvMecef = process.env,
): Promise<FactureEmise> {
  const etat = etatLiaison(env);
  if (!etat.branche) {
    throw new Error(`e-MECeF : ${etat.motif}`);
  }

  const demande = construireFacture(vente);
  const client = new MecefClient({
    baseUrl: env.MECEF_BASE_URL?.trim() || BASE_URL_DGI,
    token: (env.MECEF_TOKEN ?? '').trim(),
  });

  const { invoice, security } = await client.normalizeInvoice(demande);
  return {
    uid: invoice.uid,
    codeMECeFDGI: security.codeMECeFDGI,
    qrCode: security.qrCode,
    nim: security.nim,
    dateTime: security.dateTime,
    total: Number(invoice.total ?? 0),
  };
}
