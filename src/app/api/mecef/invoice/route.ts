import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readUser, clientFor } from '@/lib/utils/user-client';
import { emettreFacture, etatLiaison, type VenteAFacturer } from '@/lib/mecef';
import { ifuValide } from '@/lib/mecef/gate';
import { sanitizeError, serverError } from '@/lib/utils/server';

/**
 * POST /api/mecef/invoice — délivrer une facture normalisée (e-MECeF).
 *
 * La caisse envoie l'identifiant de la vente ; TOUT le reste est reconstruit
 * ici, côté serveur, à partir de la base : le navigateur ne dicte ni le
 * montant, ni les lignes, ni l'IFU. Le jeton DGI reste serveur.
 *
 * Une facture déjà normalisée se renvoie telle quelle (idempotence) : un
 * second clic ne crée pas une seconde facture.
 *
 * En cas d'échec DGI, la ligne `mecef_invoices` passe en « failed » avec le
 * message (assaini) — jamais de facture de façade, et le reçu simple reste
 * disponible.
 */

const Corps = z.object({ saleId: z.string().uuid() });

const INDISPONIBLE = 'Facture normalisée indisponible pour le moment';

type LigneVenteRow = {
  product_name: string;
  unit_price: number | string;
  quantity: number | string;
  list_price: number | string | null;
};

export async function POST(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const parse = Corps.safeParse(await req.json().catch(() => null));
    if (!parse.success) {
      return NextResponse.json({ error: 'Demande invalide' }, { status: 400 });
    }
    const { saleId } = parse.data;

    // Verrou serveur : sans jeton DGI, on refuse — pas de facture de façade.
    if (!etatLiaison().branche) {
      return NextResponse.json({ error: INDISPONIBLE }, { status: 503 });
    }

    const db = clientFor(req);

    // Idempotence : une facture déjà normalisée se renvoie telle quelle.
    const { data: deja } = await db
      .from('mecef_invoices')
      .select('uid, code_mecef, qr_code, nim, normalized_at, status')
      .eq('sale_id', saleId)
      .maybeSingle();
    if (deja?.status === 'normalized' && deja.code_mecef) {
      return NextResponse.json({
        uid: deja.uid,
        codeMECeFDGI: deja.code_mecef,
        qrCode: deja.qr_code,
        nim: deja.nim,
        dateTime: deja.normalized_at,
      });
    }

    const { data: vente, error: e1 } = await db
      .from('sales')
      .select('id, user_id, invoice_number, total_amount, payment_method, client_name')
      .eq('id', saleId)
      .maybeSingle();
    if (e1) throw e1;
    if (!vente) return NextResponse.json({ error: 'Vente introuvable' }, { status: 404 });
    if (!vente.invoice_number) {
      return NextResponse.json(
        { error: 'Vente sans numéro de facture (Plan Pro requis)' },
        { status: 409 },
      );
    }

    const { data: org, error: e2 } = await db
      .from('organizations')
      .select('ifu')
      .eq('id', vente.user_id)
      .maybeSingle();
    if (e2) throw e2;
    const ifuBoutique = org?.ifu ?? null;
    if (!ifuValide(ifuBoutique)) {
      return NextResponse.json(
        { error: 'IFU de la boutique manquant ou invalide' },
        { status: 409 },
      );
    }

    const { data: lignes, error: e3 } = await db
      .from('sale_items')
      .select('product_name, unit_price, quantity, list_price')
      .eq('sale_id', saleId);
    if (e3) throw e3;

    // Paiements : le détail s'il est multiple (sale_payments), sinon le moyen
    // unique de la vente.
    const { data: paies } = await db
      .from('sale_payments')
      .select('method, amount')
      .eq('sale_id', saleId);
    const paiements: VenteAFacturer['paiements'] =
      paies && paies.length > 0
        ? paies.map((p) => ({ method: p.method as 'cash' | 'momo', amount: Number(p.amount) }))
        : [{
            method:
              vente.payment_method === 'credit'
                ? 'credit'
                : vente.payment_method === 'momo'
                  ? 'momo'
                  : 'cash',
            amount: Number(vente.total_amount),
          }];

    const aFacturer: VenteAFacturer = {
      numero: vente.invoice_number,
      ifu: ifuBoutique as string,
      lignes: ((lignes ?? []) as LigneVenteRow[]).map((l) => ({
        name: l.product_name,
        unitPrice: Number(l.unit_price),
        quantity: Number(l.quantity),
        listPrice: l.list_price != null ? Number(l.list_price) : null,
      })),
      paiements,
      clientName: vente.client_name,
    };

    let emise;
    try {
      emise = await emettreFacture(aFacturer);
    } catch (e) {
      const message = sanitizeError(e);
      console.error('[mecef/invoice] emission :', message);
      await db.from('mecef_invoices').upsert(
        {
          owner_id: vente.user_id,
          sale_id: saleId,
          status: 'failed',
          error: message,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'sale_id' },
      );
      return NextResponse.json({ error: INDISPONIBLE }, { status: 502 });
    }

    await db.from('mecef_invoices').upsert(
      {
        owner_id: vente.user_id,
        sale_id: saleId,
        uid: emise.uid,
        code_mecef: emise.codeMECeFDGI,
        qr_code: emise.qrCode,
        nim: emise.nim,
        normalized_at: emise.dateTime,
        status: 'normalized',
        error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'sale_id' },
    );

    return NextResponse.json({
      uid: emise.uid,
      codeMECeFDGI: emise.codeMECeFDGI,
      qrCode: emise.qrCode,
      nim: emise.nim,
      dateTime: emise.dateTime,
    });
  } catch (e) {
    return NextResponse.json(serverError('mecef/invoice', e), { status: 500 });
  }
}
