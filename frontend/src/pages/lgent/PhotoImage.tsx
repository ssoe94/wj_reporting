import {useEffect,useMemo,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useLang} from '../../i18n';
import {getAuthSessionSnapshot} from '../../domains/auth/auth-storage';
import {trackImageUrls} from '../../domains/lgent/image-cache';
import {createImageLoader} from '../../domains/lgent/image-loader';
import * as api from '../../domains/lgent/api';

// React Query owns the session-scoped cache and clears it on WJ logout.
const loader=createImageLoader(2,0,300_000,url=>URL.revokeObjectURL(url));
export default function PhotoImage({kind,id,version,enabled,paused=false,absent=false,thumbnailUrl,imageUrl,onView}:{
  kind:'cart'|'photo';id:string|number;version:string;enabled:boolean;paused?:boolean;absent?:boolean;thumbnailUrl?:string;imageUrl?:string;onView:(src:string)=>void;
}) {
  const ref=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false),[opening,setOpening]=useState(false),[openFailed,setOpenFailed]=useState(false);
  const {lang}=useLang(),queryClient=useQueryClient(),session=getAuthSessionSnapshot().id;
  const [failedUrl,setFailedUrl]=useState('');
  const direct=thumbnailUrl&&failedUrl!==thumbnailUrl?thumbnailUrl:undefined,canLoad=enabled||!!thumbnailUrl;
  useEffect(()=>trackImageUrls(queryClient.getQueryCache()),[queryClient]);
  const queryKey=useMemo(()=>['lgent','image',session,kind,id,version],[session,kind,id,version]);
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'80px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  const query=useQuery({queryKey,
    enabled:!!session&&canLoad&&!direct&&!absent&&!paused&&visible,staleTime:300_000,gcTime:300_000,retry:thumbnailUrl?false:1,
    queryFn:async({signal})=>{
      const request=loader.acquire(`${session}:${kind}:${id}:${version}`,async queueSignal=>
        kind==='cart'?api.cartImage(String(id),queueSignal,false,version):api.photoImage(Number(id),queueSignal,false,version));
      signal.addEventListener('abort',request.release,{once:true});
      try{return await request.promise;}finally{signal.removeEventListener('abort',request.release);request.release();}
    }});
  useEffect(()=>{
    if(paused||!visible||!canLoad||absent||direct)void queryClient.cancelQueries({queryKey,exact:true});
  },[paused,visible,canLoad,absent,direct,queryClient,queryKey]);
  async function view(){
    if(query.isError&&!direct){void query.refetch();return;}
    if((!direct&&!query.data)||opening)return;
    setOpening(true);setOpenFailed(false);
    try{
      if(imageUrl&&direct){onView(imageUrl);return;}
      const image=await queryClient.fetchQuery({queryKey:['lgent','full-image',session,kind,id,version],staleTime:300_000,gcTime:60_000,
        queryFn:({signal})=>kind==='cart'?api.cartImage(String(id),signal,true,version):api.photoImage(Number(id),signal,true,version)});
      if(image)onView(image);
    }catch{setOpenFailed(true);}finally{setOpening(false);}
  }
  const failed=(!direct&&query.isError)||openFailed;
  const label=absent||(!direct&&query.data===null)?(lang==='ko'?'사진 없음':'无照片'):!canLoad?(lang==='ko'?'LG 연결 후 사진 조회':'连接 LG 后查看照片'):failed?(lang==='ko'?'사진 로딩 실패 · 클릭하여 재시도':'照片加载失败 · 点击重试'):'…';
  return <button ref={ref} className={`lgent-image ${kind==='photo'?'queue-image':''}`} onClick={view}
    aria-label={`${id} ${lang==='ko'?'사진 보기':'查看照片'}`} title={failed?label:undefined} type="button" disabled={opening||paused}>
    {direct?<img src={direct} alt={`${id}`} loading="lazy" onError={()=>setFailedUrl(direct)}/>:query.data?<img src={query.data} alt={`${id}`} loading="lazy"/>:<span>{label}</span>}
    {(opening||openFailed)&&<span className="lgent-image-status">{opening?(lang==='ko'?'원본 로딩 중':'加载原图'):label}</span>}
  </button>;
}
