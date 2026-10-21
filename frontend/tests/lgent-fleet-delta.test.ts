import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFleetDelta} from '../src/domains/lgent/fleet-delta.ts';
import type {Cart,Workspace} from '../src/domains/lgent/types.ts';
const a={trolleyId:'TT0940001',grade:'B',photoVersion:'old'} as Cart;
const b={trolleyId:'TT0940002',grade:'B',photoVersion:'unchanged'} as Cart;
const workspace={fleet:[a,b],fleetVersion:'old-fleet',queue:[{id:1,status:'ready'}]} as Workspace;
test('external update replaces only its card and keeps queue/unchanged image identity',()=>{
 const changed={...a,grade:'A',photoVersion:'new'};
 const next=applyFleetDelta(workspace,[changed],[])!;
 assert.equal(next.fleet[0],changed);assert.equal(next.fleet[1],b);
 assert.equal(next.queue,workspace.queue);assert.equal(next.fleetVersion,undefined);
 assert.equal(workspace.fleet[0],a);assert.equal(workspace.fleetVersion,'old-fleet');
});
test('empty result does not replace workspace or trigger unchanged photographs',()=>{
 assert.equal(applyFleetDelta(workspace,[],[]),workspace);
 assert.equal(applyFleetDelta(undefined,[a],[]),undefined);
});
test('removed membership wins and repeated updates cannot duplicate carts',()=>{
 const c={...a,trolleyId:'TT0940003'};
 const next=applyFleetDelta(workspace,[a,c],['TT0940001'])!;
 assert.deepEqual(next.fleet.map(cart=>cart.trolleyId),['TT0940002','TT0940003']);
 assert.deepEqual(applyFleetDelta(next,[c],[])!.fleet.map(cart=>cart.trolleyId),['TT0940002','TT0940003']);
});
