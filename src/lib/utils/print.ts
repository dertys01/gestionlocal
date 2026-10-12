import type { CartItem, Organization } from '@/types';
import { formatQty } from '@/lib/utils/currency';
import { planEffectif } from '@/lib/utils/plans';
import { piedDiffusion } from '@/lib/utils/whatsapp';
import { ifuValide } from '@/lib/mecef/gate';
import { escapeHtml } from '@/lib/utils/html';

// Réexporté : `rapport.ts` importait `escapeHtml` depuis ce module. L'unique
// implémentation vit dans `html.ts` (voir son en-tête).
export { escapeHtml };

interface PrintData {
  items: CartItem[];
  total: number;
  /** 'credit' = cession à crédit : le stock est parti, l'argent est dû. */
  paymentMethod: 'cash' | 'momo' | 'credit';
  clientName: string;
  amountGiven: number;
  change: number;
  date: Date;
  /** Numéro de facture normalisée ; absent/null sur les plans non-Pro. */
  invoiceNumber?: string | null;
  /** Éléments de sécurité e-MECeF (DGI) : code, QR, NIM. */
  mecef?: { code: string; qrCode: string; nim: string } | null;
  /** En crédit : acompte versé sur-le-champ, et reste à recouvrer. */
  advance?: number;
  due?: number;
  org: Organization;
}

function fmtCFA(n: number) {
  return n.toLocaleString('fr-FR') + ' FCFA';
}

export function printReceipt(data: PrintData) {
  // Double verrou (défense en profondeur) : un papier ne dit « FACTURE N° »
  // que s'il porte un numéro ET un IFU valide. La caisse vérifie déjà le
  // verrou complet (lib/mecef/gate.ts) ; si ce point d'entrée est appelé
  // ailleurs, un reçu sans IFU sort en reçu, jamais en facture de façade.
  const isNormalized = !!data.invoiceNumber && ifuValide(data.org?.ifu);
  const dateStr = data.date.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // Prix réellement encaissé, pas le prix catalogue : un reçu qui affiche
  // 15 000 F pour une ligne négociée à 12 000 F est un reçu faux, et c'est
  // le client qui le garde.
  const rows = data.items.map((i) => {
    const prix = i.unitPrice ?? i.product.price_sell;
    const remise = i.product.price_sell - prix;
    return [
      `<tr>`,
      `<td>${escapeHtml(i.product.name)}` +
        (remise > 0
          ? `<br><span style="color:#b45309">remise ${escapeHtml(fmtCFA(remise))}/u</span>`
          : '') +
        `</td>`,
      `<td style="text-align:center">${escapeHtml(formatQty(i.quantity))}</td>`,
      `<td style="text-align:right">${escapeHtml(fmtCFA(prix))}</td>`,
      `<td style="text-align:right">${escapeHtml(fmtCFA(prix * i.quantity))}</td>`,
      `</tr>`,
    ].join('');
  }).join('');

  const vendorBlock = isNormalized ? [
    `<p class="bold fs13">FACTURE N° ${escapeHtml(data.invoiceNumber)}</p>`,
    `<p class="label">Date : ${escapeHtml(dateStr)}</p>`,
    `<div class="divider"></div>`,
    `<p class="bold">VENDEUR</p>`,
    `<p>${escapeHtml(data.org.name)}</p>`,
    data.org.address ? `<p>${escapeHtml(data.org.address)}</p>` : '',
    data.org.ifu    ? `<p>IFU : ${escapeHtml(data.org.ifu)}</p>` : '',
  ].join('') : [
    `<h1>${escapeHtml(data.org.name)}</h1>`,
    `<p class="center label">${escapeHtml(dateStr)}</p>`,
  ].join('');

  const clientBlock = isNormalized && data.clientName ? [
    `<div class="divider"></div>`,
    `<p class="bold">CLIENT</p>`,
    `<p>${escapeHtml(data.clientName)}</p>`,
  ].join('') : '';

  // P4 : le pied de diffusion n'existe que sur le gratuit — au plan * effectif, l'essai compte comme Starter et ne porte donc pas la marque.
  // Ligne vide retirée : en HTML, le séparateur est déjà le passage à la ligne.
  const diffusion = piedDiffusion(
    planEffectif(data.org.plan, data.org.trial_ends_at, data.org.plan_valid_until),
  );
  const footer = [
    !isNormalized
      ? `<div class="divider"></div><p class="center mt8">Merci de votre visite !</p>`
      : '',
    ...diffusion
      .filter(Boolean)
      .map((l) => `<p class="center label">${escapeHtml(l)}</p>`),
  ].join('');

  const html = [
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">`,
    `<title>${escapeHtml(isNormalized ? data.invoiceNumber : 'Reçu')}</title>`,
    `<style>`,
    `*{margin:0;padding:0;box-sizing:border-box}`,
    `body{font-family:'Courier New',monospace;font-size:12px;color:#000;padding:16px;max-width:320px;margin:auto}`,
    `h1{font-size:16px;text-align:center;font-weight:bold;margin-bottom:2px}`,
    `.center{text-align:center}.divider{border-top:1px dashed #000;margin:8px 0}`,
    `.bold{font-weight:bold}.label{color:#555;font-size:11px}.fs13{font-size:13px}.mt8{margin-top:8px}`,
    `table{width:100%;border-collapse:collapse;margin:8px 0}`,
    `th{font-size:10px;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:4px}`,
    `td{padding:2px 0;vertical-align:top}`,
    `.total-row td{font-size:14px;font-weight:bold;border-top:1px solid #000;padding-top:6px}`,
    `@media print{button{display:none}}`,
    `</style></head><body>`,
    vendorBlock,
    clientBlock,
    `<div class="divider"></div>`,
    `<table><thead><tr>`,
    `<th style="text-align:left">Article</th>`,
    `<th style="text-align:center">Qté</th>`,
    `<th style="text-align:right">P.U.</th>`,
    `<th style="text-align:right">Total</th>`,
    `</tr></thead><tbody>${rows}</tbody></table>`,
    `<div class="divider"></div>`,
    `<table>`,
    `<tr class="total-row"><td colspan="3">TOTAL</td><td style="text-align:right">${escapeHtml(fmtCFA(data.total))}</td></tr>`,
    `<tr><td colspan="3" class="label">Paiement</td><td style="text-align:right">${
      data.paymentMethod === 'momo' ? 'Mobile Money'
      : data.paymentMethod === 'credit' ? 'Crédit (à recouvrer)'
      : 'Espèces'
    }</td></tr>`,
    data.paymentMethod === 'cash' && data.amountGiven >= data.total
      ? `<tr><td colspan="3" class="label">Reçu</td><td style="text-align:right">${escapeHtml(fmtCFA(data.amountGiven))}</td></tr>` +
        `<tr><td colspan="3" class="label bold">Monnaie</td><td style="text-align:right" class="bold">${escapeHtml(fmtCFA(data.change))}</td></tr>`
      : '',
    // Sur un reçu de crédit, l'acompte et le reste dû sont les deux seules
    // lignes qui comptent. Sans elles, le papier dit « 130 000 à crédit » alors
    // que 50 000 sont dans la caisse : le client, et le commerçant dans six mois,
    // n'ont aucun moyen de savoir que la vente était à moitié réglée.
    //
    // Même règle que sur WhatsApp : si l'appelant omet `due`, le reste dû vaut le
    // prix. Un reçu de crédit ne doit jamais laisser croire que la vente est
    // réglée.
    data.paymentMethod === 'credit'
      ? (data.advance ?? 0) > 0
        ? `<tr><td colspan="3" class="label">Déjà versé</td><td style="text-align:right">${escapeHtml(fmtCFA(data.advance ?? 0))}</td></tr>`
        : ''
      : '',
    data.paymentMethod === 'credit'
      ? (() => {
          const avance = data.advance ?? 0;
          // Reste dû : ce que l'appelant a indiqué, sinon le prix. Un reçu de
          // crédit ne doit jamais laisser croire que la vente est réglée.
          const reste =
            (data.due ?? 0) > 0 || avance > 0 ? (data.due ?? 0) : data.total;
          return reste > 0
            ? `<tr><td colspan="3" class="label bold">Reste à régler</td><td style="text-align:right" class="bold">${escapeHtml(fmtCFA(reste))}</td></tr>`
            : '';
        })()
      : '',
    `</table>`,
    // Éléments de sécurité e-MECeF : sans eux, le papier n'est pas une
    // facture normalisée vérifiable (code MECeF, NIM, QR). Rendus uniquement
    // quand la DGI les a réellement délivrés.
    isNormalized && data.mecef
      ? [
          `<div class="divider"></div>`,
          `<p class="bold center">FACTURE NORMALISÉE</p>`,
          `<p class="center label">Code MECeF/DGI : ${escapeHtml(data.mecef.code)}</p>`,
          `<p class="center label">NIM : ${escapeHtml(data.mecef.nim)}</p>`,
          data.mecef.qrCode
            ? `<p class="center"><img alt="QR e-MECeF" style="width:120px;height:120px" src="${
                data.mecef.qrCode.startsWith('data:')
                  ? escapeHtml(data.mecef.qrCode)
                  : `data:image/png;base64,${escapeHtml(data.mecef.qrCode)}`
              }"></p>`
            : '',
        ].join('')
      : '',
    footer,
    `<div style="margin-top:16px;text-align:center">`,
    `<button onclick="window.print()" style="padding:8px 20px;cursor:pointer;border:1px solid #000;background:#fff;font-size:12px">`,
    `Imprimer</button></div>`,
    `</body></html>`,
  ].join('');

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'width=420,height=620');

  if (!popup) {
    // Popup bloquée : libérer l'URL plutôt que de la laisser fuiter.
    URL.revokeObjectURL(url);
    return;
  }
  // Alias non nullable : le typeScript ne propage pas le narrowing de `popup`
  // dans une déclaration de fonction hissée.
  const win = popup;

  let settled = false;
  // Déclaration de fonction : hissée, donc utilisable dans le callback plus bas.
  function close() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    win.close();
    URL.revokeObjectURL(url);
  }

  const timer = setTimeout(() => { win.print(); }, 400);

  // Enregistré avant l'appel à print() : sinon la fermeture peut survenir
  // avant que le gestionnaire ne soit affecté.
  win.addEventListener('afterprint', close, { once: true });

  win.focus();
}
