// Keep gallery reads from flooding the API and starving workspace/mutation reads.
export function createImageLoader(limit = 2, maxEntries = 160, ttl = 5 * 60_000,dispose:(value:string)=>void=()=>{}) {
  type Entry = {key:string; load:(signal:AbortSignal)=>Promise<string|null>; controller:AbortController; users:number;
    promise:Promise<string|null>; resolve:(value:string|null)=>void; reject:(reason:unknown)=>void};
  const cache = new Map<string, {value:string|null; at:number}>();
  const pending = new Map<string, Entry>();
  const queue:Entry[] = [];
  let active = 0;
  function pump() {
    while (active < limit && queue.length) {
      const entry = queue.shift()!;
      if (!entry.users || entry.controller.signal.aborted) continue;
      active++;
      Promise.resolve().then(()=>entry.load(entry.controller.signal)).then(value=>{
        if(entry.controller.signal.aborted&&value)dispose(value);
        if (!entry.controller.signal.aborted) {
          cache.delete(entry.key);cache.set(entry.key,{value,at:Date.now()});
          while(cache.size>maxEntries)cache.delete(cache.keys().next().value!);
        }
        entry.resolve(value);
      },entry.reject).finally(()=>{
        if(pending.get(entry.key)===entry)pending.delete(entry.key);
        active--;pump();
      });
    }
  }
  function acquire(key:string,load:Entry['load']) {
    const hit=cache.get(key);
    if(hit&&Date.now()-hit.at<ttl)return {promise:Promise.resolve(hit.value),release:()=>{}};
    cache.delete(key);
    let entry=pending.get(key);
    if(!entry){
      let resolve!:Entry['resolve'],reject!:Entry['reject'];
      const promise=new Promise<string|null>((ok,fail)=>{resolve=ok;reject=fail;});
      entry={key,load,controller:new AbortController(),users:0,promise,resolve,reject};
      pending.set(key,entry);queue.push(entry);
    }
    const current=entry;current.users++;pump();let released=false;
    return {promise:current.promise,release:()=>{
      if(released)return;released=true;
      if(--current.users===0&&pending.get(key)===current){
        pending.delete(key);current.controller.abort();current.reject(new Error('Image request canceled'));
      }
    }};
  }
  function clear(){cache.clear();for(const entry of pending.values()){entry.controller.abort();entry.reject(new Error('Image cache cleared'));}pending.clear();queue.length=0;}
  return {acquire,clear};
}
