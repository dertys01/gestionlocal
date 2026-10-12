import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Règle de copie : aucun tiret cadratin « — » ni emoji dans le texte de
 * l'application.
 *
 * Le garde-fou lit le code source, retire les commentaires, et refuse ce qui
 * reste. Les commentaires sont exclus : « — » y est une ponctuation de
 * rédaction interne, pas du texte que l'utilisateur lit.
 *
 * Sans ce test, la règle se perd au premier copier-coller.
 */

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, '../../src');

/** Liste récursive des .ts / .tsx sous src. */
function fichiersSource(dir: string): string[] {
  const sortie: string[] = [];
  for (const entree of fs.readdirSync(dir, { withFileTypes: true })) {
    const plein = path.join(dir, entree.name);
    if (entree.isDirectory()) sortie.push(...fichiersSource(plein));
    else if (/\.tsx?$/.test(entree.name)) sortie.push(plein);
  }
  return sortie;
}

/**
 * Retire commentaires de ligne, commentaires de bloc et commentaires JSX.
 * Les chaînes (simples, doubles, gabarits) sont respectées : un `//` dans une
 * URL ne doit pas couper la lecture.
 */
function sansCommentaires(code: string): string {
  let sortie = '';
  let i = 0;
  let etat: 'code' | 'ligne' | 'bloc' | 'simple' | 'double' | 'gabarit' = 'code';
  while (i < code.length) {
    const c = code[i];
    const c2 = code[i + 1] ?? '';
    if (etat === 'code') {
      if (c === '/' && c2 === '/') { etat = 'ligne'; i += 2; continue; }
      if (c === '/' && c2 === '*') { etat = 'bloc'; i += 2; continue; }
      if (c === "'") { etat = 'simple'; sortie += c; i += 1; continue; }
      if (c === '"') { etat = 'double'; sortie += c; i += 1; continue; }
      if (c === '`') { etat = 'gabarit'; sortie += c; i += 1; continue; }
      sortie += c; i += 1; continue;
    }
    if (etat === 'ligne') {
      if (c === '\n') { etat = 'code'; sortie += c; }
      i += 1; continue;
    }
    if (etat === 'bloc') {
      if (c === '*' && c2 === '/') { etat = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    // Dans une chaîne : les échappements sautent deux caractères.
    if (c === '\\') { sortie += c + c2; i += 2; continue; }
    if ((etat === 'simple' && c === "'") || (etat === 'double' && c === '"') || (etat === 'gabarit' && c === '`')) {
      etat = 'code';
    }
    sortie += c; i += 1; continue;
  }
  return sortie;
}

/** Ce qui ne doit jamais apparaître dans le texte rendu. */
const INTERDITS: Array<{ nom: string; re: RegExp }> = [
  { nom: 'tiret cadratin (—)', re: /\u2014/ },
  {
    nom: 'emoji ou dingbat',
    re: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u,
  },
];

describe('Copie — pas de tiret cadratin ni d’emoji', () => {
  const fichiers = fichiersSource(RACINE);

  it('au moins un fichier est lu (le scan fonctionne)', () => {
    expect(fichiers.length).toBeGreaterThan(50);
  });

  for (const { nom, re } of INTERDITS) {
    it(`aucun ${nom} dans le code`, () => {
      const coupables: string[] = [];
      for (const f of fichiers) {
        const code = sansCommentaires(fs.readFileSync(f, 'utf8'));
        code.split('\n').forEach((ligne, n) => {
          if (re.test(ligne)) {
            coupables.push(`${path.relative(RACINE, f)}:${n + 1} ${ligne.trim().slice(0, 80)}`);
          }
        });
      }
      expect(coupables, `\n${coupables.join('\n')}\n`).toEqual([]);
    });
  }
});
