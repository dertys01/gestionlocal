-- ─── Retours utilisateurs (bêta) ──────────────────────────────────────────
--
-- Un bouton « Signaler / Suggérer » dans l'application range ici ce que les
-- premiers utilisateurs remontent : le bug ou l'idée, la page, la boutique, et
-- un peu de contexte technique (navigateur, version). Sans ça, un retour arrive
-- par téléphone sans l'heure ni l'écran, et il n'est pas exploitable.
--
-- Chaque boutique lit SES retours (le patron peut suivre ceux de son équipe) ;
-- l'éditeur les lit tous via la clé service role (route admin protégée).

CREATE TABLE IF NOT EXISTS feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_email text,
  kind         text NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('bug', 'idea', 'question', 'other')),
  message      text NOT NULL,
  page         text,
  context      jsonb,
  status       text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'seen', 'done')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_message_len CHECK (length(btrim(message)) BETWEEN 3 AND 4000)
);

CREATE INDEX IF NOT EXISTS idx_feedback_owner ON feedback(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Un membre écrit un retour pour SA boutique ; le champ est libre, pas de
-- condition de rôle : c'est au patron de lire, pas de filtrer à l'écriture.
DROP POLICY IF EXISTS "feedback_insert" ON feedback;
CREATE POLICY "feedback_insert" ON feedback
  FOR INSERT WITH CHECK (owner_id = get_business_owner_id());

-- Lecture : la boutique voit ses retours (patron comme équipe).
DROP POLICY IF EXISTS "feedback_read" ON feedback;
CREATE POLICY "feedback_read" ON feedback
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Pas d'UPDATE/DELETE côté client : le statut se gère côté éditeur (service
-- role). Un retour ne se réécrit pas après coup.
