import api from '@/lib/api';
import type {Photo,Workspace} from './types';
export const getWorkspace=async(signal?:AbortSignal)=> (await api.get<Workspace>('/lgent/workspace/',{signal})).data;
export const connectLg=async(userId:string,password:string)=>api.post('/lgent/login/',{userId,password},{timeout:120000});
export const disconnectLg=async()=>api.post('/lgent/logout/',{});
export const setThreshold=async(staleDays:number)=>api.post('/lgent/settings/',{staleDays});
type SyncReply={discovered:number;processed?:number;remaining:number;cursor:string|null;errors:number;mirrorErrors?:number;photoCursor?:string|null;photoRemaining?:number};
export async function syncFleet(progress:(done:number,total:number)=>void,days?:number){let cursor:string|null=null;let count=0,errors=0;let last:SyncReply;do{const result:{data:SyncReply}=await api.post<SyncReply>('/lgent/sync/',cursor?{cursor}:days?{days}:{},{timeout:45000});last=result.data;cursor=last.cursor;count=last.discovered;errors+=last.errors;progress(count-last.remaining,count);}while(cursor);return {count,errors,photoCursor:last.photoCursor||null,photoRemaining:last.photoRemaining||0};}
export const copyPhotoPage=async(cursor:string)=>(await api.post<SyncReply>('/lgent/sync/',{cursor},{timeout:45000})).data;
export const lookupCart=async(trolleyId:string)=>(await api.post('/lgent/lookup/',{trolleyId})).data;
async function image(path:string,signal?:AbortSignal,full=false,version?:string){
 const response=await api.get<Blob>(path,{signal,responseType:'blob',params:{...(full?{}:{size:'thumbnail'}),v:version}});
 if(response.status===204||!response.data.size)return null;
 return URL.createObjectURL(response.data);
}
export const cartImage=(id:string,signal?:AbortSignal,full=false,version?:string)=>image(`/lgent/carts/${encodeURIComponent(id)}/photo/`,signal,full,version);
export const photoImage=(id:number,signal?:AbortSignal,full=false,version?:string)=>image(`/lgent/photos/${id}/image/`,signal,full,version);
export async function uploadPhoto(file:Blob,filename:string){const data=new FormData();data.append('file',file,filename);return (await api.post<Photo>('/lgent/photos/',data,{headers:{'Content-Type':'multipart/form-data'}})).data;}
export const analyzePhotos=async(ids:number[])=>api.post('/lgent/photos/analyze/',{ids});
export async function verifyPhotos(ids:number[]){for(let i=0;i<ids.length;i+=1)await api.post('/lgent/photos/verify/',{ids:ids.slice(i,i+1)},{timeout:60000});}
export const matchPhoto=async(id:number,trolleyId:string,confirmed:boolean)=>api.post(`/lgent/photos/${id}/match/`,{trolleyId,confirmed});
export const removePhoto=async(id:number)=>api.post(`/lgent/photos/${id}/remove/`,{});
export async function savePhotos(ids:number[],progress:(done:number)=>void){const results:{id:number;status:string;message:string}[]=[];for(let i=0;i<ids.length;i+=1){const result=await api.post<{results:{id:number;status:string;message:string}[]}>('/lgent/photos/save/',{ids:ids.slice(i,i+1),confirmed:true},{skipAuthRefresh:true,timeout:120000});result.data.results.forEach(value=>results.push(value));progress(results.length);}return results;}

export const reconcilePhoto=async(id:number)=>(await api.post<{verified:boolean}>(`/lgent/photos/${id}/reconcile/`,{},{timeout:60000})).data;

export const getShipments=async(mode:import('./types').ShipmentMode,start:string,end:string,signal?:AbortSignal)=>(await api.get<import('./types').ShipmentOverview>('/lgent/shipments/',{params:{mode,start,end},signal,timeout:30000})).data;
