/**
 * Client HTTP de l'API e-MECeF (DGI du Bénin).
 *
 * Il n'est appelé QUE lorsque le double verrou est ouvert (voir ./index.ts) :
 * les accès de test de la DGI, puis la production. Aucun appel n'est fait
 * au chargement du module, et `fetch` est injectable pour les tests.
 *
 * Le flux est en deux temps (soumission → confirmation) : une facture
 * soumise mais non confirmée n'a PAS de code MECeF, donc pas de valeur
 * fiscale. `normalizeInvoice()` enchaîne les deux pour le cas courant.
 */

import type {
  DemandeFacture,
  ReponseFacture,
  ElementsSecurite,
  FactureNormalisee,
  EtatApiMecef,
} from './types';

/** URL de base par défaut : environnement développeur/test de la DGI. */
export const BASE_URL_DGI = 'https://developper.impots.bj/sygmef-emcf/api';

export interface MecefConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Injectable pour les tests ; `fetch` global en production. */
  fetchImpl?: typeof fetch;
}

/** Erreur de l'API e-MECeF, avec le code applicatif de la DGI. */
export class MecefError extends Error {
  readonly code: string;
  readonly description: string;
  readonly httpStatus: number | null;

  constructor(code: string, description: string, httpStatus: number | null = null) {
    super(description || code);
    this.name = 'MecefError';
    this.code = code;
    this.description = description;
    this.httpStatus = httpStatus;
  }
}

export class MecefClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: MecefConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.token = cfg.token;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async requete<T>(chemin: string, init: RequestInit = {}): Promise<T> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);
    let reponse: Response;
    try {
      reponse = await this.fetchImpl(`${this.baseUrl}${chemin}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
        signal: controleur.signal,
      });
    } catch (e) {
      // Réseau coupé, DNS, timeout : jamais un crash brut, un code clair.
      clearTimeout(minuteur);
      const raison = e instanceof Error && e.name === 'AbortError'
        ? 'Délai dépassé en contactant la DGI'
        : 'Connexion à la DGI impossible';
      throw new MecefError('NETWORK_ERROR', raison);
    }
    clearTimeout(minuteur);

    const texte = await reponse.text();
    let corps: unknown = null;
    try {
      corps = texte ? JSON.parse(texte) : null;
    } catch {
      corps = null;
    }

    if (!reponse.ok) {
      const obj = (corps ?? {}) as Record<string, unknown>;
      const code = String(obj.code ?? obj.errorCode ?? reponse.status);
      const description = String(
        obj.description ?? obj.message ?? obj.error ?? `Erreur HTTP ${reponse.status}`,
      );
      throw new MecefError(code, description, reponse.status);
    }

    return corps as T;
  }

  /** Soumet une facture. Retourne l'uid et les totaux calculés par la DGI. */
  createInvoice(data: DemandeFacture): Promise<ReponseFacture> {
    return this.requete<ReponseFacture>('/invoice', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** Confirme une facture en attente : code MECeF, QR code, NIM. */
  confirmInvoice(uid: string): Promise<ElementsSecurite> {
    return this.requete<ElementsSecurite>(`/invoice/${encodeURIComponent(uid)}/confirm`, {
      method: 'PUT',
    });
  }

  /** Annule une facture EN ATTENTE (une facture finalisée ne s'annule pas). */
  cancelInvoice(uid: string): Promise<void> {
    return this.requete<void>(`/invoice/${encodeURIComponent(uid)}/cancel`, {
      method: 'PUT',
    });
  }

  /** Détails d'une facture en attente. */
  getInvoiceDetails(uid: string): Promise<ReponseFacture> {
    return this.requete<ReponseFacture>(`/invoice/${encodeURIComponent(uid)}`);
  }

  /** État de l'API (requêtes en attente, disponibilité). */
  getStatus(): Promise<EtatApiMecef> {
    return this.requete<EtatApiMecef>('/status');
  }

  /** Soumission + confirmation en un seul appel : le cas courant. */
  async normalizeInvoice(data: DemandeFacture): Promise<FactureNormalisee> {
    const invoice = await this.createInvoice(data);
    const security = await this.confirmInvoice(invoice.uid);
    return { invoice, security };
  }
}
