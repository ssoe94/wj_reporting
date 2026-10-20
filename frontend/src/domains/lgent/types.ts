export type Cart = {trolleyId:string;grade:string;displayAt:string;dateSource:'lg_modified'|'verified_save'|'photo_file'|'unknown';ageDays:number|null;alert:'fresh'|'stale'|'unknown';hasPhoto:boolean;photoKnown?:boolean;photoVersion:string;lastHistoryAt?:string;checkedAt?:string;thumbnailUrl?:string;imageUrl?:string};
export type PhotoStatus='pending'|'queued'|'analyzing'|'recognized'|'ready'|'review'|'error'|'saving'|'saved'|'accepted'|'uncertain';
export type Photo={id:number;filename:string;trolleyId:string;status:PhotoStatus;note:string;grade?:string;recognizedIds?:string[];jobStatus?:string;photoVersion?:string};
export type Workspace={connection:{authenticated:boolean;userName?:string;expiresAt?:string};company:{name:string;code:string};fleet:Cart[];fleetVersion?:string;queue:Photo[];settings:{staleDays:number};worker:{state:string;modelName?:string};capabilities?:{canEdit:boolean}};
export type ShipmentMode='plan'|'history';
export type ShipmentRow={id:string;orderCode:string;identifier:string;trolleyId:string;plannedAt:string;recordedAt:string;status:string;recordCount:number;cart:Cart|null};
export type ShipmentOverview={mode:ShipmentMode;start:string;end:string;rows:ShipmentRow[];fetchedAt:string;complete:boolean;source:string};
