/**
 * Contrôle d'accès éditeur.
 *
 * La liste vit dans ADMIN_EMAILS (serveur) : c'est elle qui ouvre la lecture
 * des retours de toutes les boutiques. Fonction pure, testable sans serveur.
 */
export function estAdmin(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv | { ADMIN_EMAILS?: string } = process.env,
): boolean {
  const liste = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && liste.includes(email.toLowerCase());
}
