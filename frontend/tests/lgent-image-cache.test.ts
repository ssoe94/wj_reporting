import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/react-query';
import {trackImageUrls} from '../src/domains/lgent/image-cache.ts';

test('replacement, garbage collection and WJ logout release gallery object URLs once',()=>{
  const client=new QueryClient(),released:string[]=[];
  const revoke=test.mock.method(URL,'revokeObjectURL',(url:string)=>released.push(url));
  try{
    trackImageUrls(client.getQueryCache());trackImageUrls(client.getQueryCache());
    const key=['lgent','image','session-a','cart','TT0940306','v1'];
    client.setQueryData(key,'blob:first');client.setQueryData(key,'blob:second');
    assert.deepEqual(released,['blob:first']);
    client.removeQueries({queryKey:key});assert.deepEqual(released,['blob:first','blob:second']);
    client.setQueryData(['lgent','full-image','session-a','cart','TT0940306','v1'],'blob:original');
    client.setQueryData(['other','image'],'blob:other');client.clear();
    assert.deepEqual(released,['blob:first','blob:second','blob:original']);
  }finally{revoke.mock.restore();client.clear();}
});
