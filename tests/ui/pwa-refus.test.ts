import { describe, it, expect, afterEach } from 'vitest';

/**
 * Mémorisation du refus d'installer l'application.
 *
 * Le point important : si `localStorage` est indisponible (navigation privée,
 * stockage plein) ou que ses méthodes lèvent, RIEN ne doit planter — au pire
 * le refus n'est pas retenu.
 *
 * jsdom n'implémente pas `localStorage` : on le simule.
 */

import { lireRefus, marquerRefus, reinitialiserRefus } from '@/lib/pwa/refus';

function storageQuiMarche() {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  });
  return store;
}
const sansStorage = () =>
  Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
const storageQuiEchoue = () =>
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new Error('privé'); },
      setItem() { throw new Error('plein'); },
      removeItem() { throw new Error('privé'); },
    },
  });

afterEach(() => { sansStorage(); });

describe('pwa/refus', () => {
  it('retient le refus', () => {
    storageQuiMarche();
    expect(lireRefus()).toBe(false);
    marquerRefus();
    expect(lireRefus()).toBe(true);
    reinitialiserRefus();
    expect(lireRefus()).toBe(false);
  });

  it('sans localStorage : ne plante pas, refus non retenu', () => {
    sansStorage();
    expect(() => marquerRefus()).not.toThrow();
    expect(lireRefus()).toBe(false);
    expect(() => reinitialiserRefus()).not.toThrow();
  });

  it('localStorage qui lève : ne plante pas', () => {
    storageQuiEchoue();
    expect(() => marquerRefus()).not.toThrow();
    expect(lireRefus()).toBe(false);
    expect(() => reinitialiserRefus()).not.toThrow();
  });

  it('oublie un refus vieux de plus d’un mois', () => {
    // Un refus éternel rendait l'option « Installer » introuvable pour
    // toujours, sans aucun moyen de la retrouver depuis l'application.
    const store = storageQuiMarche();
    store.set('gl:installation-refusee', String(Date.now() - 31 * 24 * 60 * 60 * 1000));
    expect(lireRefus()).toBe(false);
  });

  it('rend une chance à un refus enregistré sans date (ancien format)', () => {
    const store = storageQuiMarche();
    store.set('gl:installation-refusee', '1');
    expect(lireRefus()).toBe(false);
    expect(store.has('gl:installation-refusee')).toBe(false);
  });
});
