-- ─── Factures normalisées e-MECeF (piste d'audit) ─────────────────────────
--
-- Une facture normalisée ne se réimprime pas de mémoire : les éléments de
-- sécurité (code MECeF 24 caractères, QR code, NIM, date de normalisation)
-- viennent de la DGI et doivent survivre à la session. Cette table les garde,
-- une ligne par vente — c'est aussi la trace vérifiable en cas de contrôle.
--
-- `status` distingue une facture en attente (soumise, non confirmée) d'une
-- facture normalisée : seule cette dernière a une valeur fiscale.

CREATE TABLE IF NOT EXISTS mecef_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sale_id       uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  uid           text,
  code_mecef    text,
  qr_code       text,
  nim           text,
  normalized_at timestamptz,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'normalized', 'failed')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mecef_invoices_sale_unique UNIQUE (sale_id)
);

CREATE INDEX IF NOT EXISTS idx_mecef_invoices_owner ON mecef_invoices(owner_id, created_at DESC);

ALTER TABLE mecef_invoices ENABLE ROW LEVEL SECURITY;

-- Lecture et écriture par l'équipe de la boutique : un·e caissier·e délivre
-- la facture au comptoir, comme il·elle délivre le reçu. Le code MECeF est de
-- toute façon vérifiable sur le registre de la DGI — une ligne forgée se voit.
DROP POLICY IF EXISTS "mecef_invoices_read" ON mecef_invoices;
CREATE POLICY "mecef_invoices_read" ON mecef_invoices
  FOR SELECT USING (owner_id = get_business_owner_id());

DROP POLICY IF EXISTS "mecef_invoices_write" ON mecef_invoices;
CREATE POLICY "mecef_invoices_write" ON mecef_invoices
  FOR ALL
  USING (owner_id = get_business_owner_id())
  WITH CHECK (owner_id = get_business_owner_id());
