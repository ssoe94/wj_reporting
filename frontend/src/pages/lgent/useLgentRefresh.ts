import {useEffect,useRef,useState} from 'react';
import {getAuthSessionSnapshot} from '../../domains/auth/auth-storage';
import {refreshFleetPage} from '../../domains/lgent/api';
import type {Cart} from '../../domains/lgent/types';

// The workspace poll reads WJ only. This separate bounded loop reads live LG
// metadata, without setting the page's business-operation busy flag.
export default function useLgentRefresh({session,connected,paused,onChanged,onPhotos}:{session:string|null;connected:boolean;paused:boolean;onChanged:(updated:Cart[],removed:string[])=>void;onPhotos:(cursor:string,total:number)=>void}){
 const latest=useRef({paused,onChanged,onPhotos});latest.current={paused,onChanged,onPhotos};
 const wake=useRef<(force?:boolean)=>void>(()=>{});
 const [status,setStatus]=useState<{running:boolean;done:number;total:number;errors:number;failed:boolean}>({running:false,done:0,total:0,errors:0,failed:false});
 useEffect(()=>{
  if(!session||!connected)return;
  let active=true,inFlight=false,cursor:string|null=null,force=false,done=0,total=0,errors=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  const current=()=>active&&getAuthSessionSnapshot().id===session;
  const schedule=(delay:number)=>{clearTimeout(timer);if(current())timer=setTimeout(()=>void tick(),delay);};
  async function tick(manual=false){
   if(!current()||inFlight)return;
   if(manual){cursor=null;force=true;done=total=errors=0;}
   if(document.visibilityState==='hidden'||latest.current.paused){schedule(5000);return;}
   inFlight=true;
   try{
    const result=await refreshFleetPage(cursor,force,controller.signal);
    if(!current())return;
    if(result.busy){schedule(5000);return;}
    done+=result.processed;total=Math.max(total,done+(result.remaining||0));errors+=result.errors;cursor=result.cursor;
    setStatus({running:!!cursor,done,total,errors,failed:false});
    if(result.changed)latest.current.onChanged(result.updated||[],result.removed||[]);
    if(!current())return;
    if(result.photoCursor)latest.current.onPhotos(result.photoCursor,result.photoRemaining||0);
    if(!cursor){force=false;done=total=errors=0;}
    schedule(cursor?500:60000);
   }catch(error){
    const code=(error as {response?:{data?:{code?:string}}}).response?.data?.code;
    // A tab may have been hidden longer than the signed cursor's lifetime.
    if(code==='invalid_cursor'){cursor=null;force=false;done=total=errors=0;}
    if(current()){setStatus(previous=>({...previous,running:false,failed:true}));schedule(60000);}
   }finally{inFlight=false;}
  }
  wake.current=(manual=false)=>{clearTimeout(timer);void tick(manual);};
  const visible=()=>{if(document.visibilityState==='visible')wake.current();};
  document.addEventListener('visibilitychange',visible);void tick();
  return()=>{active=false;clearTimeout(timer);controller.abort();wake.current=()=>{};document.removeEventListener('visibilitychange',visible);};
 },[session,connected]);
 return {...status,checkNow:()=>wake.current(true)};
}
