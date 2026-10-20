import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useLang} from '../../i18n';
import {getAuthSessionSnapshot} from '../../domains/auth/auth-storage';
import {createImageLoader} from '../../domains/lgent/image-loader';
import * as api from '../../domains/lgent/api';

// React Query owns the session-scoped cache and clears it on WJ logout.
const loader=createImageLoader(2,0);
export default function PhotoImage({kind,id,version,enabled,paused=false,absent=false,onView}:{
  kind:'cart'|'photo';id:string|number;version:string;enabled:boolean;paused?:boolean;absent?:boolean;onView:(src:string)=>void;
}) {
  const ref=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false),[opening,setOpening]=useState(false),[openFailed,setOpenFailed]=useState(false);
  const {lang}=useLang(),queryClient=useQueryClient(),session=getAuthSessionSnapshot().id;
  useEffect(()=>{if(!ref.current)return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'80px'});observer.observe(ref.current);return()=>observer.disconnect();},[]);
  const query=useQuery({queryKey:['lgent','image',session,kind,id,version],
    enabled:!!session&&enabled&&!absent&&!paused&&visible,staleTime:300_000,gcTime:300_000,retry:false,
    queryFn:async({signal})=>{
      const request=loader.acquire(`${session}:${kind}:${id}:${version}`,async queueSignal=>
        kind==='cart'?api.cartImage(String(id),queueSignal):api.photoImage(Number(id),queueSignal));
      signal.addEventListener('abort',request.release,{once:true});
      try{return await request.promise;}finally{signal.removeEventListener('abort',request.release);request.release();}
    }});
  async function view(){
    if(query.isError){void query.refetch();return;}
    if(!query.data||opening)return;
    setOpening(true);setOpenFailed(false);
    try{
      const image=await queryClient.fetchQuery({queryKey:['lgent','full-image',session,kind,id,version],staleTime:300_000,gcTime:60_000,
        queryFn:({signal})=>kind==='cart'?api.cartImage(String(id),signal,true):api.photoImage(Number(id),signal,true)});
      if(image)onView(image);
    }catch{setOpenFailed(true);}finally{setOpening(false);}
  }
  const failed=query.isError||openFailed;
  const label=absent||query.data===null?(lang==='ko'?'사진 없음':'无照片'):!enabled?(lang==='ko'?'LG 연결 후 사진 조회':'连接 LG 后查看照片'):failed?(lang==='ko'?'사진 로딩 실패 · 클릭하여 재시도':'照片加载失败 · 点击重试'):'…';
  return <button ref={ref} className={`lgent-image ${kind==='photo'?'queue-image':''}`} onClick={view}
    aria-label={`${id} ${lang==='ko'?'사진 보기':'查看照片'}`} title={failed?label:undefined} type="button" disabled={opening||paused}>
    {query.data?<img src={query.data} alt={`${id}`} loading="lazy"/>:<span>{label}</span>}
    {(opening||openFailed)&&<span className="lgent-image-status">{opening?(lang==='ko'?'원본 로딩 중':'加载原图'):label}</span>}
  </button>;
}
