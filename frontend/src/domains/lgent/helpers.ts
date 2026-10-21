import type {Cart,Photo} from './types';
export const isImage=(file:Pick<File,'name'|'type'>)=>!file.name.startsWith('.')&&(file.type.startsWith('image/')||/\.(jpe?g|png|webp|heic|heif|avif|bmp|gif|tiff?)$/i.test(file.name));
export function uniqueReadyPhotos(photos:Photo[]){const counts=new Map<string,number>();for(const photo of photos)if(photo.status==='ready')counts.set(photo.trolleyId,(counts.get(photo.trolleyId)||0)+1);return photos.filter(photo=>photo.status==='ready'&&counts.get(photo.trolleyId)===1).map(photo=>photo.id);}
export function hasDuplicateCarts(photos:Photo[],ids:number[]){const chosen=photos.filter(photo=>ids.includes(photo.id));return new Set(chosen.map(photo=>photo.trolleyId)).size!==chosen.length;}
export function sortCarts(carts:Cart[],sort:string){return [...carts].sort((a,b)=>{if(sort==='number')return a.trolleyId.localeCompare(b.trolleyId,undefined,{numeric:true});if(sort==='grade')return a.grade.localeCompare(b.grade);if(sort==='candidate')return (b.photoCandidateAt||'').localeCompare(a.photoCandidateAt||'');if(!a.displayAt)return b.displayAt?1:0;if(!b.displayAt)return -1;return sort==='newest'?b.displayAt.localeCompare(a.displayAt):a.displayAt.localeCompare(b.displayAt);});}
export interface DirectoryEntry {isFile:boolean;isDirectory:boolean;name:string;file?:(ok:(file:File)=>void,fail:()=>void)=>void;createReader?:()=>{readEntries:(ok:(entries:DirectoryEntry[])=>void,fail:()=>void)=>void}}
export async function filesFromEntry(entry:DirectoryEntry,limit=500):Promise<File[]>{if(entry.name.startsWith('.'))return [];if(entry.isFile&&entry.file)return new Promise(resolve=>entry.file!(file=>resolve(isImage(file)?[file]:[]),()=>resolve([])));if(!entry.isDirectory||!entry.createReader)return [];const reader=entry.createReader(),files:File[]=[];while(true){const entries=await new Promise<DirectoryEntry[]>(resolve=>reader.readEntries(resolve,()=>resolve([])));if(!entries.length)break;for(const item of entries){const nested=await filesFromEntry(item,limit-files.length);nested.forEach(file=>files.push(file));if(files.length>limit)return files;}}return files;}
export async function filesFromDrop(data:DataTransfer){const entries=Array.from(data.items).map(item=>(item as unknown as {webkitGetAsEntry?:()=>DirectoryEntry|null}).webkitGetAsEntry?.()).filter((entry):entry is DirectoryEntry=>!!entry);if(!entries.length)return Array.from(data.files).filter(isImage);const result:File[]=[];for(const entry of entries){const nested=await filesFromEntry(entry,500-result.length);nested.forEach(file=>result.push(file));if(result.length>500)break;}return result;}
export async function photoJpeg(file:File){if(file.size>30*1024*1024)throw new Error('invalid_photo');const img=new Image(),url=URL.createObjectURL(file);try{img.src=url;await img.decode();const scale=Math.min(1,1440/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext('2d');if(!ctx)throw new Error('invalid_photo');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));if(!blob||blob.size>3*1024*1024)throw new Error('invalid_photo');return blob;}finally{URL.revokeObjectURL(url);}}

export function suggestedTrolleyId(photo:Photo,fleet:Cart[]){
 const known=new Set(fleet.map(cart=>cart.trolleyId));
 if(photo.status!=='review'||known.has(photo.trolleyId)||photo.recognizedIds?.length!==1)return '';
 const candidate=photo.recognizedIds[0];return known.has(candidate)?candidate:'';
}

// Run at most `limit` tasks at once; every item is processed even if some fail inside `fn`.
export async function forEachLimit<T>(items:T[],limit:number,fn:(item:T,index:number)=>Promise<void>){
 let next=0;
 const lane=async()=>{while(next<items.length){const index=next++;await fn(items[index],index);}};
 await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length))},lane));
}

// One task at a time: canvas decoding of full-size phone photos is memory heavy.
export function exclusive(){
 let tail:Promise<unknown>=Promise.resolve();
 return <T>(task:()=>Promise<T>)=>{const run=tail.then(task,task);tail=run.catch(()=>undefined);return run;};
}
