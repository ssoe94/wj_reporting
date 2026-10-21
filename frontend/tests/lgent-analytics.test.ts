import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetMetrics,percentage,shipmentMetrics,spreadsheetText} from '../src/domains/lgent/analytics.ts';
import type {Cart,ShipmentRow} from '../src/domains/lgent/types.ts';

const cart:Cart={trolleyId:'TT0940001',grade:'B',displayAt:'2026-10-21T08:00:00+08:00',dateSource:'photo_file',ageDays:0,alert:'fresh',hasPhoto:true,photoKnown:true,photoVersion:'1'};
const row:ShipmentRow={id:'1',orderCode:'LGENT-1',identifier:cart.trolleyId,trolleyId:cart.trolleyId,cart,plannedAt:'2026-10-21T09:00:00+08:00',recordedAt:'2026-10-21T08:00:00+08:00',status:'in_execution',recordCount:4};

test('rates are unknown, never zero or 100%, without a confirmed denominator',()=>{
 assert.equal(percentage(0,0),null);assert.equal(fleetMetrics([]).freshRate,null);
 assert.equal(shipmentMetrics([],[],true).readyRate,null);
});
test('fleet rates exclude unconfirmed information; no-photo and unknown-date stay in denominator',()=>{
 const result=fleetMetrics([cart,{...cart,trolleyId:'2',hasPhoto:false,alert:'unknown',grade:''},{...cart,trolleyId:'3',alert:'unknown'},{...cart,trolleyId:'4',photoKnown:false}]);
 assert.equal(result.total,3);assert.equal(result.unconfirmed,1);assert.equal(result.freshRate,33.3);
 assert.equal(result.noPhoto,1);assert.equal(result.unknownDate,1);assert.equal(result.gradeRate,66.7);
 assert.equal(result.grades.reduce((total,[,count])=>total+count,0),3);
});
test('file-derived freshness remains separate from LG modification/save verification',()=>{
 const result=fleetMetrics([cart,{...cart,trolleyId:'2',dateSource:'verified_save'},{...cart,trolleyId:'3',dateSource:'lg_modified'},{...cart,trolleyId:'4',alert:'stale'}]);
 assert.equal(result.fresh,3);assert.equal(result.estimatedFresh,1);assert.equal(result.verifiedFresh,2);assert.equal(result.stale,1);
});
test('plan readiness deduplicates trolleys across orders and ignores item counts',()=>{
 const result=shipmentMetrics([row,{...row,id:'2',orderCode:'LGENT-2'},{...row,id:'3',recordCount:20}],[cart],true);
 assert.equal(result.matched.length,1);assert.equal(result.ready,1);assert.equal(result.pairs,2);assert.equal(result.readyRate,100);
});
test('cancelled combinations and completed plans are excluded conservatively',()=>{
 const data=[row,{...row,id:'2',status:'reversed'},{...row,id:'3',orderCode:'2',status:'completed'},{...row,id:'4',orderCode:'3',status:'closed'}];
 assert.equal(shipmentMetrics(data,[cart],true).rows.length,0);
 const history=shipmentMetrics(data,[cart],false);assert.equal(history.rows.length,2);assert.equal(history.matched.length,1);
});
test('a TT094 prefix or unjoined identifier never becomes ownership or ready evidence',()=>{
 const result=shipmentMetrics([{...row,cart:null},{...row,id:'2',identifier:'TT0949999',cart:{...cart,trolleyId:'TT0949999'}}],[cart],true);
 assert.equal(result.matched.length,0);assert.equal(result.unmatched,2);assert.equal(result.readyRate,null);
});
test('the frozen fleet photo state takes priority over a separately fetched MES join',()=>{
 const result=shipmentMetrics([row],[{...cart,hasPhoto:false,alert:'unknown'}],true);
 assert.equal(result.ready,0);assert.equal(result.needsUpdate,1);assert.equal(result.readyRate,0);
});
test('spreadsheet export neutralizes source strings that Excel could evaluate',()=>{
 for(const value of ['=1+1',' +SUM(A1)','@cmd','-1+2','\t=HYPERLINK("x")'])assert.equal(spreadsheetText(value),`'${value}`);
 assert.equal(spreadsheetText('TT0940001'),'TT0940001');assert.equal(spreadsheetText('2026-10-21'),'2026-10-21');
});
