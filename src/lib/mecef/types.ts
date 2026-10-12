/**
 * Types de l'API e-MECeF (DGI du Bénin).
 *
 * Reconstruits d'après la documentation publique (Swagger
 * `developper.impots.bj/sygmef-emcf/swagger`, bibliothèques tierces) : la
 * référence exacte est le Swagger de la DGI, à re-vérifier le jour où les
 * accès de test sont ouverts. Aucun appel réseau n'est fait ici.
 */

/** Type de facture : vente, avoir, export de vente / avoir. */
export type TypeFacture = 'FV' | 'FA' | 'EV' | 'EA';

/** Groupe de taxation d'une ligne (A = exonéré, B = 18 % TVA, etc.). */
export type GroupeTaxation = string;

/** Mode de règlement reconnu par l'e-MECeF. */
export type ModePaiement =
  | 'ESPECES'
  | 'MOBILEMONEY'
  | 'CHEQUE'
  | 'VIREMENT'
  | 'CARTEBANCAIRE'
  | 'CREDIT';

/** Une ligne de facture. */
export interface LigneFacture {
  name: string;
  price: number;
  quantity: number;
  taxGroup: GroupeTaxation;
  /** Remise sur la ligne, si le commerçant a négocié. */
  discount?: number;
}

/** Le client de la facture (facultatif en B2C). */
export interface ClientFacture {
  ifu?: string;
  name?: string;
  contact?: string;
  address?: string;
}

/** L'opérateur (le caissier) qui a saisi la facture. */
export interface OperateurFacture {
  name: string;
}

/** Un règlement de la facture. */
export interface PaiementFacture {
  name: ModePaiement;
  amount: number;
}

/** Corps envoyé à `POST /api/invoice`. */
export interface DemandeFacture {
  ifu: string;
  type: TypeFacture;
  items: LigneFacture[];
  client?: ClientFacture;
  operator?: OperateurFacture;
  payment: PaiementFacture[];
  /** Référence interne (idempotence côté éditeur). */
  reference?: string;
}

/** Totaux renvoyés par la soumission. */
export interface ReponseFacture {
  uid: string;
  total: number;
  totalTVA?: number;
  totalHT?: number;
  [cle: string]: unknown;
}

/** Éléments de sécurité délivrés par la confirmation. */
export interface ElementsSecurite {
  /** Code MECeF/DGI signé (24 caractères). */
  codeMECeFDGI: string;
  /** QR code, image encodée en base64. */
  qrCode: string;
  /** Numéro d'Identification Machine signataire. */
  nim: string;
  /** Date/heure exacte de la normalisation (ISO). */
  dateTime: string;
}

/** Facture normalisée : totaux + éléments de sécurité. */
export interface FactureNormalisee {
  invoice: ReponseFacture;
  security: ElementsSecurite;
}

/** État de l'API e-MECeF (requêtes en attente). */
export interface EtatApiMecef {
  pendingRequests?: number;
  [cle: string]: unknown;
}
