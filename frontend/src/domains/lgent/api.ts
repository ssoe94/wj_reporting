import api from '@/lib/api';
import type {Photo,Workspace} from './types';
export const getWorkspace=async()=> (await api.get<Workspace>('/lgent/workspace/')).data;
export const connectLg=async(userId:string,password:string)=>api.post('/lgent/login/',{userId,password},{timeout:120000});
export const disconnectLg=async()=>api.post('/lgent/logout/',{});
export const setThreshold=async(staleDays:number)=>api.post('/lgent/settings/',{staleDays});
type SyncReply={discovered:number;remaining:number;cursor:string|null;errors:number};
export async function syncFleet(progress:(done:number,total:number)=>void){let cursor:string|null=null;let count=0;do{const result:{data:SyncReply}=await api.post<SyncReply>('/lgent/sync/',cursor?{cursor}:{},{timeout:45000});cursor=result.data.cursor;count=result.data.discovered;progress(count-result.data.remaining,count);}while(cursor);return count;}
export const lookupCart=async(trolleyId:string)=>(await api.post('/lgent/lookup/',{trolleyId})).data;
export const cartImage=async(id:string)=>(await api.get<{photoData:string|null}>(`/lgent/carts/${encodeURIComponent(id)}/photo/`)).data.photoData;
export const photoImage=async(id:number)=>(await api.get<{photoData:string|null}>(`/lgent/photos/${id}/image/`)).data.photoData;
export async function uploadPhoto(file:Blob,filename:string){const data=new FormData();data.append('file',file,filename);return (await api.post<Photo>('/lgent/photos/',data,{headers:{'Content-Type':'multipart/form-data'}})).data;}
export const analyzePhotos=async(ids:number[])=>api.post('/lgent/photos/analyze/',{ids});
export async function verifyPhotos(ids:number[]){for(let i=0;i<ids.length;i+=1)await api.post('/lgent/photos/verify/',{ids:ids.slice(i,i+1)},{timeout:60000});}
export const matchPhoto=async(id:number,trolleyId:string,confirmed:boolean)=>api.post(`/lgent/photos/${id}/match/`,{trolleyId,confirmed});
export const removePhoto=async(id:number)=>api.post(`/lgent/photos/${id}/remove/`,{});
export async function savePhotos(ids:number[],progress:(done:number)=>void){const results:{id:number;status:string;message:string}[]=[];for(let i=0;i<ids.length;i+=1){const result=await api.post<{results:{id:number;status:string;message:string}[]}>('/lgent/photos/save/',{ids:ids.slice(i,i+1),confirmed:true},{skipAuthRefresh:true,timeout:120000});result.data.results.forEach(value=>results.push(value));progress(results.length);}return results;}

export const reconcilePhoto=async(id:number)=>(await api.post<{verified:boolean}>(`/lgent/photos/${id}/reconcile/`,{},{timeout:60000})).data;
