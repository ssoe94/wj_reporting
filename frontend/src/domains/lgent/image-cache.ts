import type {QueryCache} from '@tanstack/react-query';
const tracked=new WeakSet<QueryCache>();

// One listener per app cache; logout/GC and a replacement response release URLs.
export function trackImageUrls(cache:QueryCache){
  if(tracked.has(cache))return;
  tracked.add(cache);
  const urls=new Map<unknown,string>();
  cache.subscribe(event=>{
    const query=event.query,key=query.queryKey;
    if(key[0]!=='lgent'||!['image','full-image'].includes(String(key[1])))return;
    const previous=urls.get(query),value=query.state.data;
    const next=event.type==='removed'?undefined:typeof value==='string'&&value.startsWith('blob:')?value:undefined;
    if(previous&&previous!==next)URL.revokeObjectURL(previous);
    if(next)urls.set(query,next);else urls.delete(query);
  });
}
