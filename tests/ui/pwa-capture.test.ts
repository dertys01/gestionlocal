import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * La capture de `beforeinstallprompt` doit être branchée par la coquille
 * montée dans le layout, pas par le tableau de bord.
 *
 * Le navigateur n'émet l'événement qu'une fois par chargement de page. Si le
 * module n'est chargé que par l'accueil du commerçant, un utilisateur qui
 * commence par /connexion ou /register (lien direct, favori) le rate : après
 * connexion, la bannière « Installer » n'a plus rien à afficher.
 */
describe('capture de l’invitation à installer', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('est branchée dès le chargement de la coquille, sans passer par le tableau de bord', async () => {
    vi.resetModules();

    // C'est le composant monté par le layout sur toutes les routes.
    await import('@/components/pwa/EnregistreurPWA');

    window.dispatchEvent(new Event('beforeinstallprompt'));

    const { lireInvite } = await import('@/lib/pwa/invite');
    expect(lireInvite()).not.toBeNull();
  });
});
