import type {ShipmentMode,ShipmentRow} from './types';
export function shanghaiDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function shiftDate(value:string,days:number){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
export function shipmentDate(row:ShipmentRow,mode:ShipmentMode){return (mode==='plan'?row.plannedAt:row.recordedAt).slice(0,10);}
export function photoStatus(row:ShipmentRow){return !row.cart?'unassigned':row.cart.photoKnown!==false&&!row.cart.hasPhoto?'no-photo':row.cart.alert;}
export function validShipmentRange(start:string,end:string){const parsed=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;return parsed(start)&&parsed(end)&&end>=start&&(Date.parse(end)-Date.parse(start))/86400000<=30;}
export type LgMatchStatus='lg-confirmed'|'lg-review'|'identifier-review'|'unassigned';
export function lgMatchStatus(row:ShipmentRow):LgMatchStatus{
 if(row.cart)return 'lg-confirmed';
 const id=row.identifier.trim();
 if(!id)return 'unassigned';
 // A TT094 prefix is only a lookup candidate, never proof of LG ownership.
 return /^TT094[A-Z0-9_-]+$/i.test(id)?'lg-review':'identifier-review';
}
export function prioritizeLgCarts(rows:ShipmentRow[]){
 const rank:Record<LgMatchStatus,number>={'lg-confirmed':0,'lg-review':1,'identifier-review':2,unassigned:3};
 return rows.map((row,index)=>({row,index})).sort((a,b)=>rank[lgMatchStatus(a.row)]-rank[lgMatchStatus(b.row)]||a.index-b.index).map(({row})=>row);
}
export function filterShipments(rows:ShipmentRow[],mode:ShipmentMode,date:string,status:string,mesStatus='all',lgStatus='all'){return rows.filter(row=>(!date||shipmentDate(row,mode)===date)&&(status==='all'||photoStatus(row)===status)&&(mesStatus==='all'||row.status===mesStatus)&&(lgStatus==='all'||lgMatchStatus(row)===lgStatus));}
