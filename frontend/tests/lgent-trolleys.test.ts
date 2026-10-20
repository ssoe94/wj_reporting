import test from 'node:test';
import assert from 'node:assert/strict';
import {isImage,filesFromEntry,hasDuplicateCarts,sortCarts,uniqueReadyPhotos,suggestedTrolleyId} from '../src/domains/lgent/helpers.ts';
import {canAccessLgent,isLgentRoute} from '../src/domains/auth/lgent-access.ts';
import type {Cart,Photo} from '../src/domains/lgent/types.ts';
import type {DirectoryEntry} from '../src/domains/lgent/helpers.ts';
const photo=(id:number,trolleyId:string,status:Photo['status']='ready'):Photo=>({id,trolleyId,status,filename:'a.jpg',note:''});
const cart=(trolleyId:string,displayAt:string):Cart=>({trolleyId,displayAt,dateSource:displayAt?'photo_file':'unknown',grade:'B',ageDays:displayAt?238:null,alert:displayAt?'stale':'unknown',hasPhoto:true,photoVersion:'1'});
test('only unique verified photos are selected automatically',()=>{assert.deepEqual(uniqueReadyPhotos([photo(1,'A'),photo(2,'A'),photo(3,'B'),photo(4,'C','review')]),[3]);});
test('two photos for one trolley cannot be saved together',()=>{const photos=[photo(1,'A'),photo(2,'A'),photo(3,'B')];assert.equal(hasDuplicateCarts(photos,[1,2]),true);assert.equal(hasDuplicateCarts(photos,[1,3]),false);});
test('unknown dates remain separate and sort after dated carts',()=>{const records=[cart('unknown',''),cart('new','2026-09-01'),cart('old','2025-03-01')];assert.deepEqual(sortCarts(records,'oldest').map(c=>c.trolleyId),['old','new','unknown']);assert.deepEqual(sortCarts(records,'newest').map(c=>c.trolleyId),['new','old','unknown']);assert.equal(records[0].trolleyId,'unknown');});
test('folder filtering ignores hidden and non-image files',()=>{assert.equal(isImage({name:'.DS_Store',type:''}),false);assert.equal(isImage({name:'guide.pdf',type:'application/pdf'}),false);assert.equal(isImage({name:'照片.JPG',type:''}),true);});
test('directory traversal includes nested images and all read batches',async()=>{const file=(name:string):DirectoryEntry=>({name,isFile:true,isDirectory:false,file:ok=>ok({name,type:name.endsWith('.jpg')?'image/jpeg':'text/plain'} as File)});const directory=(name:string,entries:DirectoryEntry[]):DirectoryEntry=>({name,isFile:false,isDirectory:true,createReader:()=>{let i=0;return {readEntries:ok=>ok(i++===0?entries:[])};}});const root=directory('photos',[file('one.jpg'),directory('child',[file('two.jpg'),file('notes.txt')]),file('.hidden.jpg')]);assert.deepEqual((await filesFromEntry(root)).map(f=>f.name),['one.jpg','two.jpg']);});
test('sales access is fail closed and inactive accounts are denied',()=>{assert.equal(canAccessLgent(null),false);assert.equal(canAccessLgent({}),false);assert.equal(canAccessLgent({permissions:{can_view_sales:true}}),true);assert.equal(canAccessLgent({is_staff:true,is_active:false}),false);assert.equal(canAccessLgent({is_staff:true}),true);});
test('new route guard is bounded to the trolley screen',()=>{assert.equal(isLgentRoute('/sales/trolleys'),true);assert.equal(isLgentRoute('/sales/trolleys/record'),true);assert.equal(isLgentRoute('/sales/trolleyshop'),false);assert.equal(isLgentRoute('/sales/raw-materials'),false);});

test('only a single server-proposed known ID is offered for manual review, never selected for saving',()=>{
 const fleet=[cart('TT0940306','2026-10-20')];
 const review={...photo(1,'TT094O306','review'),recognizedIds:['TT0940306']};
 assert.equal(suggestedTrolleyId(review,fleet),'TT0940306');
 assert.deepEqual(uniqueReadyPhotos([review]),[]);
 assert.equal(suggestedTrolleyId({...review,recognizedIds:['TT0940306','TT0940308']},fleet),'');
 assert.equal(suggestedTrolleyId({...review,recognizedIds:['OTHER-123']},fleet),'');
 assert.equal(suggestedTrolleyId({...review,status:'recognized'},fleet),'');
 assert.equal(suggestedTrolleyId({...review,trolleyId:'TT0940306'},fleet),'');
});
