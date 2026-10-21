import type {Cart,Workspace} from './types';

// Replace only changed cards, retaining queue/drafts and all unchanged images.
export function applyFleetDelta(workspace:Workspace|undefined,updated:Cart[],removed:string[]):Workspace|undefined{
 if(!workspace||!updated.length&&!removed.length)return workspace;
 const replacements=new Map(updated.map(cart=>[cart.trolleyId,cart]));
 const excluded=new Set(removed);
 const fleet=workspace.fleet.filter(cart=>!excluded.has(cart.trolleyId)).map(cart=>{
  const replacement=replacements.get(cart.trolleyId);replacements.delete(cart.trolleyId);return replacement||cart;
 });
 fleet.push(...[...replacements.values()].filter(cart=>!excluded.has(cart.trolleyId)));
 return {...workspace,fleet,fleetVersion:undefined};
}
