import type {Cart, ShipmentRow} from './types';

export const percentage = (part:number, total:number):number|null => total ? Math.round(part / total * 1000) / 10 : null;

/** Current observed fleet only: never an allocated/available asset denominator. */
export function fleetMetrics(fleet:Cart[]) {
 const confirmed=fleet.filter(cart=>cart.photoKnown!==false);
 const photos=confirmed.filter(cart=>cart.hasPhoto);
 const fresh=photos.filter(cart=>cart.alert==='fresh');
 const grades=new Map<string,number>();
 for(const cart of confirmed){const grade=cart.grade.trim()||'unknown';grades.set(grade,(grades.get(grade)||0)+1);}
 return {
  confirmed, total:confirmed.length, unconfirmed:fleet.length-confirmed.length,
  fresh:fresh.length, estimatedFresh:fresh.filter(cart=>cart.dateSource==='photo_file').length,
  verifiedFresh:fresh.filter(cart=>cart.dateSource==='verified_save'||cart.dateSource==='lg_modified').length,
  stale:photos.filter(cart=>cart.alert==='stale').length,
  unknownDate:photos.filter(cart=>cart.alert==='unknown').length,
  noPhoto:confirmed.length-photos.length,
  freshRate:percentage(fresh.length,confirmed.length),
  graded:confirmed.filter(cart=>!!cart.grade.trim()).length,
  gradeRate:percentage(confirmed.filter(cart=>!!cart.grade.trim()).length,confirmed.length),
  grades:[...grades].sort(([a],[b])=>a.localeCompare(b)),
 };
}

/** A record is not proof of departure. Conservatively exclude reversed order/cart pairs. */
export function shipmentMetrics(rows:ShipmentRow[], fleet:Cart[], plan:boolean) {
 const known=new Map(fleet.filter(cart=>cart.photoKnown!==false).map(cart=>[cart.trolleyId,cart]));
 const key=(row:ShipmentRow)=>JSON.stringify([row.orderCode,row.identifier.trim()]);
 const reversed=new Set(rows.filter(row=>row.status==='reversed').map(key));
 const eligible=rows.filter(row=>row.status!=='reversed'&&!reversed.has(key(row))&&(!plan||!['completed','closed'].includes(row.status)));
 const pairs=new Map<string,ShipmentRow>();
 for(const row of eligible)pairs.set(key(row),row);
 const carts=new Map<string,Cart>();
 for(const row of pairs.values()){
  // Prefixes and unjoined MES identifiers do not prove ownership.
  const cart=row.cart&&known.get(row.cart.trolleyId);
  if(cart)carts.set(cart.trolleyId,cart);
 }
 const matched=[...carts.values()];
 const ready=matched.filter(cart=>cart.hasPhoto&&cart.alert==='fresh');
 return {rows:eligible, matched, pairs:pairs.size, ready:ready.length,
  needsUpdate:matched.filter(cart=>!cart.hasPhoto||cart.alert!=='fresh').length,
  unmatched:[...pairs.values()].filter(row=>!row.cart||!known.has(row.cart.trolleyId)).length,
  excluded:rows.length-eligible.length,
  readyRate:percentage(ready.length,matched.length),
 };
}

/** Spreadsheet formula injection protection for source-controlled text cells. */
export function spreadsheetText(value:string){return /^[\s]*[=+@-]/.test(value)?`'${value}`:value;}
