'use client';

import { Component, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Nom de la zone (« dashboard », « pos »…), pour le message et Sentry. */
  zone?: string;
}
interface State {
  erreur: Error | null;
}

/**
 * Frontière d'erreur d'un module.
 *
 * Sans elle, une exception dans UN écran (une donnée inattendue, un index hors
 * bornes) faisait planter tout le tableau de bord : l'application entière
 * devenait une page blanche. Ici, seul l'écran fautif est remplacé par un
 * message et un bouton « Réessayer » — le reste de la caisse reste utilisable.
 *
 * L'erreur part dans Sentry (avec la zone) pour être corrigée, mais jamais
 * l'écran ne la montre brute.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { erreur: null };

  static getDerivedStateFromError(erreur: Error): State {
    return { erreur };
  }

  componentDidCatch(erreur: Error, info: { componentStack?: string | null }) {
    console.error(`[ui:${this.props.zone ?? 'module'}]`, erreur);
    Sentry.captureException(erreur, {
      extra: { zone: this.props.zone, componentStack: info.componentStack },
    });
  }

  render() {
    if (this.state.erreur) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 space-y-3">
          <div>
            <p className="font-semibold">Cet écran n&apos;a pas pu s&apos;afficher.</p>
            <p className="text-xs mt-1">
              Vos données ne sont pas perdues. Réessayez, ou changez d&apos;onglet : le reste de
              l&apos;application fonctionne.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => this.setState({ erreur: null })}
            className="border-red-300 text-red-700 hover:bg-red-100"
          >
            Réessayer
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
