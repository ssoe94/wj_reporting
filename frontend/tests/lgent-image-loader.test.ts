import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageLoader} from '../src/domains/lgent/image-loader.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('gallery bounds simultaneous reads, shares one in-flight image and reuses results',async()=>{
  const loader=createImageLoader(2);let running=0,peak=0,calls=0;
  const finish:(()=>void)[]=[];
  const load=async()=>{calls++;running++;peak=Math.max(peak,running);await new Promise<void>(resolve=>finish.push(resolve));running--;return 'image';};
  const requests=[loader.acquire('session:a',load),loader.acquire('session:a',load),loader.acquire('session:b',load),loader.acquire('session:c',load)];
  await tick();assert.equal(calls,2);assert.equal(peak,2);
  finish.shift()!();await tick();assert.equal(calls,3);assert.equal(peak,2);
  for(const resolve of finish)resolve();await Promise.all(requests.map(request=>request.promise));
  assert.equal(await loader.acquire('session:a',load).promise,'image');assert.equal(calls,3);
});
test('unmounted queued images do not reach the server; active read aborts only after last subscriber',async()=>{
  const loader=createImageLoader(1);let calls=0,aborted=false;
  const load=(signal:AbortSignal)=>new Promise<string>((_,reject)=>{calls++;signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});});
  const a=loader.acquire('a',load),shared=loader.acquire('a',load),waiting=loader.acquire('b',load);
  const settled=Promise.allSettled([a.promise,shared.promise,waiting.promise]);
  await tick();a.release();assert.equal(aborted,false);waiting.release();shared.release();
  await settled;await tick();assert.equal(aborted,true);assert.equal(calls,1);
});
test('failures remain retryable and different sessions never share cached photographs',async()=>{
  const loader=createImageLoader();let calls=0;
  await assert.rejects(loader.acquire('first:a',async()=>{throw new Error('timeout');}).promise);
  await tick();
  const load=async()=>`image-${++calls}`;
  assert.equal(await loader.acquire('first:a',load).promise,'image-1');
  assert.equal(await loader.acquire('second:a',load).promise,'image-2');
  loader.clear();assert.equal(await loader.acquire('second:a',load).promise,'image-3');
});
test('a canceled response that completes late disposes its unclaimed object URL',async()=>{
  const released:string[]=[];const loader=createImageLoader(1,0,300_000,url=>released.push(url));
  let finish!:(value:string)=>void;
  const request=loader.acquire('a',()=>new Promise<string>(resolve=>{finish=resolve;}));
  const settled=Promise.allSettled([request.promise]);await tick();request.release();
  finish('blob:aborted');await settled;await tick();assert.deepEqual(released,['blob:aborted']);
});
