-- ─── Tailles et variantes ────────────────────────────────────────────────
--
-- Une « taille » est une variante de prix : « demi portion » coûte MOINS,
-- « grande portion » coûte PLUS. Le modèle des options (product_modifiers)
-- portait déjà le supplément, mais le CHECK interdisait extra_price < 0 : une
-- taille « demi » était donc impossible.
--
-- On ouvre le signe, en bornant des deux côtés (une faute de frappe à
-- 1 000 000 F sur une option serait pire qu'un refus).

ALTER TABLE product_modifiers DROP CONSTRAINT IF EXISTS product_modifiers_extra_price_check;
ALTER TABLE product_modifiers ADD CONSTRAINT product_modifiers_extra_price_check
  CHECK (extra_price >= -1000000 AND extra_price <= 1000000);

COMMENT ON COLUMN product_modifiers.extra_price IS
  'Supplément (positif) ou remise (négatif) de l''option : une taille « demi » coûte moins.';
