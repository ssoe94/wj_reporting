import {useEffect,useMemo,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {BarChart3,ChevronRight,Download,X} from 'lucide-react';
import {getAuthSessionSnapshot} from '../../domains/auth/auth-storage';
import {getShipments} from '../../domains/lgent/api';
import {fleetMetrics,shipmentMetrics,spreadsheetText} from '../../domains/lgent/analytics';
import {shanghaiDate,shiftDate,validShipmentRange} from '../../domains/lgent/shipments';
import type {Cart,ShipmentMode} from '../../domains/lgent/types';
import {useLang} from '../../i18n';
import './lgent-analytics.css';

const labels={
 ko:{title:'대차 운영 분석',bp:'BP 분석',close:'닫기',photo:'사진 최신율',grade:'등급 확인율',prepare:'출고 준비 분석',overview:'운영 요약',photos:'사진·등급',shipments:'출고 분석',export:'BP Excel',exporting:'내보내는 중',exportError:'파일을 만들지 못했습니다. 다시 시도하세요.',scope:'현재 수집·LG 확인 대차 기준입니다. 전체 할당·가용 대수가 아닙니다.',snapshot:'기준 시각',photoHint:'최신 사진 보유 대차 / LG 정보 확인 대차. 파일명 날짜 추정치를 포함합니다. Cloudinary 복제일은 갱신일로 세지 않습니다.',gradeHint:'등급이 등록된 대차 / LG 정보 확인 대차. 등급이 있다는 것이 사용 가능·수리 완료를 뜻하지 않습니다.',fresh:'최신',stale:'기한 초과',noPhoto:'사진 없음',unknownDate:'날짜 미확인',confirmed:'LG 정보 확인',unconfirmed:'정보 확인 필요',estimated:'최신 중 날짜 추정',verified:'최신 중 수정·저장 확인',unit:'대',rate:'비율',count:'대수',metric:'지표',value:'현재 값',basis:'집계 기준',utilization:'대차 사용률',rotation:'대차 회전수',recovery:'평균 회수일',repair:'수리 현황',pending:'집계 준비',utilHint:'전체 사용 대상 대차와 실제 출발 기록 연결 필요',rotationHint:'기간 평균 가용 대수와 실제 출발 횟수 확인 필요',recoveryHint:'같은 대차의 실제 출고·반납 이력 연결 필요',repairHint:'수리 접수·완료 이력 연결 필요. 등급만으로 수리 여부를 판단하지 않습니다.',photoBreakdown:'사진 상태',gradeBreakdown:'현재 등급 분포',unknownGrade:'등급 미확인',plan:'출고 계획',history:'출고 기록',start:'조회 시작일',end:'조회 종료일',apply:'조회',invalid:'조회 기간은 최대 31일입니다. 날짜를 확인하세요.',loading:'MES 출고 정보를 조회하고 있습니다.',failure:'MES 출고 조회에 실패했습니다.',retry:'다시 조회',permission:'MES 출고 조회 권한을 확인하세요.',partial:'일부 데이터만 수집되어 비율을 표시하지 않습니다.',ready:'사진 준비율',matched:'LG 확인 대차',attention:'사진 갱신 대상',unmatched:'대차 연결 필요',excluded:'제외 기록',recordCount:'출고단·번호 조합',recordUnit:'건',note:'출고 기록은 상차 준비 때 생성될 수 있어 실제 출발·회전수로 계산하지 않습니다. 취소 조합은 제외하며 계획에서는 완료·마감도 제외합니다.',readyHint:'최신 사진이 있는 LG 확인 고유 대차 / 연결된 LG 확인 고유 대차. 미연결 기록은 별도 집계합니다.',empty:'조회 조건에 맞는 기록이 없습니다.',cart:'대차번호',order:'출고단',date:'계획·기록일',state:'사진 상태',openCart:'대차 보기',freshDays:'사진 기준',day:'일 미만',source:'날짜 출처',lg_modified:'LG 수정일',verified_save:'LG 저장·재조회 확인',photo_file:'사진 파일명 날짜·추정',unknown:'미확인',historyLimit:'현재 상태의 스냅샷입니다. 과거 월별 실적·전월 증감은 누적 이력이 확보된 뒤 제공합니다.',exportHint:'현재 대차 스냅샷과 조회에 성공한 MES 자료를 내보냅니다.',filtered:'대차 목록',fetched:'MES 조회 시각',photoAt:'사진 기준일',gradeLabel:'등급',noData:'데이터 없음'},
 zh:{title:'台车运营分析',bp:'BP 分析',close:'关闭',photo:'照片有效率',grade:'等级登记率',prepare:'出库准备分析',overview:'运营概览',photos:'照片·等级',shipments:'出库分析',export:'BP Excel',exporting:'正在导出',exportError:'文件生成失败，请重试。',scope:'按当前已收集且 LG 核实的台车统计，并非全部分配或可用台车。',snapshot:'基准时间',photoHint:'有效期内有照片的台车 / LG 信息已核实台车。包含文件名日期推定值，不将 Cloudinary 复制日期算作更新时间。',gradeHint:'已登记等级的台车 / LG 信息已核实台车。已登记等级不代表可用或已完成维修。',fresh:'有效',stale:'已超期',noPhoto:'无照片',unknownDate:'日期不明',confirmed:'LG 信息已核实',unconfirmed:'信息待确认',estimated:'有效照片中日期推定',verified:'有效照片中修改·保存已核实',unit:'台',rate:'比例',count:'台数',metric:'指标',value:'当前值',basis:'统计口径',utilization:'台车使用率',rotation:'台车周转次数',recovery:'平均回收天数',repair:'维修情况',pending:'待建立统计',utilHint:'需确认使用对象台车总量并关联实际发车记录',rotationHint:'需确认期间平均可用台数及实际发车次数',recoveryHint:'需关联同一台车的实际出库及返还记录',repairHint:'需关联维修受理及完工履历，不按等级推断维修状态。',photoBreakdown:'照片状态',gradeBreakdown:'当前等级分布',unknownGrade:'等级待确认',plan:'出库计划',history:'出库记录',start:'查询开始日期',end:'查询结束日期',apply:'查询',invalid:'查询范围最多31天，请检查日期。',loading:'正在查询 MES 出库信息。',failure:'MES 出库查询失败。',retry:'重试',permission:'请确认 MES 出库查询权限。',partial:'数据未完整收集，暂不显示比例。',ready:'照片准备率',matched:'LG 已核实台车',attention:'照片待更新',unmatched:'台车待关联',excluded:'排除记录',recordCount:'出库单·编号组合',recordUnit:'条',note:'出库记录可在备车时生成，不计为实际发车或周转次数。排除冲销组合，计划另排除已完成及已关闭记录。',readyHint:'有效照片的 LG 已核实去重台车 / 已关联的 LG 已核实去重台车。未关联记录另行统计。',empty:'没有符合条件的记录。',cart:'台车编号',order:'出库单',date:'计划·记录日期',state:'照片状态',openCart:'查看台车',freshDays:'照片阈值',day:'天以内（不含）',source:'日期来源',lg_modified:'LG 修改日期',verified_save:'LG 保存及回读核实',photo_file:'照片文件名日期·推定',unknown:'未知',historyLimit:'这是当前状态快照，历史月度实绩及环比需积累履历后提供。',exportHint:'导出当前台车快照及成功查询的 MES 数据。',filtered:'台车清单',fetched:'MES 查询时间',photoAt:'照片基准日期',gradeLabel:'等级',noData:'暂无数据'},
};
export type AnalyticsTab='overview'|'photos'|'shipments';
const formatRate=(value:number|null)=>value===null?'—':`${value}%`;
const stamp=(value:string)=>value?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)): '—';

export function AnalyticsStrip({fleet,onOpen}:{fleet:Cart[];onOpen:(tab:AnalyticsTab)=>void}){
 const {lang}=useLang(),l=labels[lang],stats=useMemo(()=>fleetMetrics(fleet),[fleet]);
 return <section className="lgent-analytics-strip" aria-label={l.title}>
  <button type="button" className="lgent-analytics-open" onClick={()=>onOpen('overview')}><BarChart3 size={16}/><strong>{l.bp}</strong></button>
  <button type="button" onClick={()=>onOpen('photos')} title={l.photoHint}><span>{l.photo}</span><b>{formatRate(stats.freshRate)}</b><small>{stats.fresh}/{stats.total}</small></button>
  <button type="button" onClick={()=>onOpen('photos')} title={l.gradeHint}><span>{l.grade}</span><b>{formatRate(stats.gradeRate)}</b><small>{stats.graded}/{stats.total}</small></button>
  <button type="button" className="lgent-analytics-link" onClick={()=>onOpen('shipments')}>{l.prepare}<ChevronRight size={15}/></button>
 </section>;
}

export default function AnalyticsModal({fleet,staleDays,initialTab,onClose,onSelectCart}:{fleet:Cart[];staleDays:number;initialTab:AnalyticsTab;onClose:()=>void;onSelectCart:(id:string)=>void}){
 const {lang}=useLang(),l=labels[lang],dialog=useRef<HTMLDialogElement>(null);
 const [snapshot]=useState(()=>({fleet:[...fleet],at:new Date().toISOString(),days:staleDays}));
 const stats=useMemo(()=>fleetMetrics(snapshot.fleet),[snapshot]);
 const today=useRef(shanghaiDate()).current;
 const [tab,setTab]=useState<AnalyticsTab>(initialTab);
 const [mode,setMode]=useState<ShipmentMode>('plan'),[start,setStart]=useState(today),[end,setEnd]=useState(shiftDate(today,7));
 const [range,setRange]=useState({start:today,end:shiftDate(today,7)}),[requested,setRequested]=useState(initialTab==='shipments'),[invalid,setInvalid]=useState(false);
 const [exporting,setExporting]=useState(false),[exportError,setExportError]=useState(false);
 const session=getAuthSessionSnapshot().id;
 const query=useQuery({queryKey:['lgent','shipments',session,mode,range.start,range.end],queryFn:({signal})=>getShipments(mode,range.start,range.end,signal),enabled:!!session&&requested,staleTime:60000,gcTime:300000,retry:false});
 const shipment=useMemo(()=>shipmentMetrics(query.data?.rows||[],snapshot.fleet,mode==='plan'),[query.data,snapshot,mode]);
 const complete=!!query.data?.complete&&!query.isError;
 const permissionDenied=(query.error as {response?:{data?:{code?:string}}}|null)?.response?.data?.code==='mes_permission_denied';
 useEffect(()=>{dialog.current?.showModal();},[]);
 function chooseTab(value:typeof tab){setTab(value);if(value==='shipments')setRequested(true);}
 function changeMode(value:ShipmentMode){setMode(value);const a=value==='plan'?today:`${today.slice(0,7)}-01`,b=value==='plan'?shiftDate(today,7):today;setStart(a);setEnd(b);setRange({start:a,end:b});setInvalid(false);}
 const readinessLabel=mode==='plan'?l.ready:(lang==='ko'?'현재 사진 최신율':'当前照片有效率');
 const photoRows:[[string,number],[string,number],[string,number],[string,number]]=[[l.fresh,stats.fresh],[l.stale,stats.stale],[l.noPhoto,stats.noPhoto],[l.unknownDate,stats.unknownDate]];
 const state=(cart:Cart|undefined)=>!cart?l.unconfirmed:!cart.hasPhoto?l.noPhoto:cart.alert==='fresh'?l.fresh:cart.alert==='stale'?l.stale:l.unknownDate;
 async function exportWorkbook(){
  setExporting(true);setExportError(false);
  try{
   const XLSX=await import('xlsx');
   const workbook=XLSX.utils.book_new();
   const safe=(rows:(string|number|null)[][])=>rows.map(row=>row.map(cell=>typeof cell==='string'?spreadsheetText(cell):cell));
   const append=(name:string,rows:(string|number|null)[][])=>{const sheet=XLSX.utils.aoa_to_sheet(safe(rows));sheet['!cols']=[{wch:30},{wch:24},{wch:54},{wch:24},{wch:24},{wch:24}];XLSX.utils.book_append_sheet(workbook,sheet,name);};
   append(l.overview,[[l.metric,l.value,l.basis],[l.snapshot,stamp(snapshot.at),'Asia/Shanghai'],[l.confirmed,stats.total,l.scope],[l.unconfirmed,stats.unconfirmed,l.unconfirmed],[l.photo,stats.freshRate===null?null:stats.freshRate/100,l.photoHint],[l.grade,stats.gradeRate===null?null:stats.gradeRate/100,l.gradeHint],[l.freshDays,snapshot.days,l.day],...photoRows.map(([label,count])=>[label,count,l.unit] as (string|number)[]),[l.estimated,stats.estimatedFresh,l.photo_file],[l.verified,stats.verifiedFresh,`${l.lg_modified} / ${l.verified_save}`],[l.utilization,null,l.utilHint],[l.rotation,null,l.rotationHint],[l.recovery,null,l.recoveryHint],[l.repair,null,l.repairHint],[l.basis,l.historyLimit,l.exportHint]]);
   // Numeric rates retain their meaning when opened in Excel.
   for(const cell of ['B5','B6'])if(workbook.Sheets[l.overview][cell]?.t==='n')workbook.Sheets[l.overview][cell].z='0.0%';
   append(l.filtered,[[l.cart,l.gradeLabel,l.photoAt,l.source,l.state,l.snapshot],...snapshot.fleet.map(cart=>[cart.trolleyId,cart.grade,cart.displayAt,l[cart.dateSource],state(cart.photoKnown===false?undefined:cart),cart.checkedAt||''])]);
   append(l.gradeBreakdown,[[l.gradeLabel,l.count],...stats.grades.map(([grade,count])=>[grade==='unknown'?l.unknownGrade:grade,count])]);
   if(complete&&query.data){
    append(l.shipments,[[l.metric,l.value,l.basis],[lang==='ko'?'조회 구분':'查询类型',mode==='plan'?l.plan:l.history,`${range.start} ~ ${range.end}`],[l.fetched,stamp(query.data.fetchedAt),query.data.source],[l.matched,shipment.matched.length,l.unit],[readinessLabel,shipment.readyRate===null?null:shipment.readyRate/100,l.readyHint],[l.unmatched,shipment.unmatched,l.recordUnit],[l.excluded,shipment.excluded,l.recordUnit],[l.basis,l.note,l.scope],[],[l.order,l.cart,l.date,l.state],...shipment.rows.map(row=>[row.orderCode,row.cart?.trolleyId||row.identifier,(mode==='plan'?row.plannedAt:row.recordedAt),state(snapshot.fleet.find(cart=>cart.photoKnown!==false&&row.cart?.trolleyId===cart.trolleyId))])]);
    if(workbook.Sheets[l.shipments].B5?.t==='n')workbook.Sheets[l.shipments].B5.z='0.0%';
   }
   XLSX.writeFile(workbook,`LGENT-BP-${shanghaiDate(new Date(snapshot.at))}-${lang}.xlsx`);
  }catch{setExportError(true);}finally{setExporting(false);}
 }
 return <dialog ref={dialog} className="lgent-analytics-dialog" aria-labelledby="lgent-analytics-title" onCancel={onClose} onClose={onClose}>
  <header><h2 id="lgent-analytics-title"><BarChart3 size={20}/>{l.title}</h2><div><button type="button" onClick={()=>void exportWorkbook()} disabled={exporting}><Download size={15}/>{exporting?l.exporting:l.export}</button><button type="button" onClick={onClose} aria-label={l.close}><X size={20}/></button></div></header>
  <nav className="lgent-analytics-tabs" aria-label={l.title}>{(['overview','photos','shipments'] as const).map(key=><button key={key} type="button" aria-pressed={tab===key} onClick={()=>chooseTab(key)}>{l[key]}</button>)}<small>{l.snapshot} {stamp(snapshot.at)} · {l.freshDays} {snapshot.days}{l.day}</small></nav>
  <div className="lgent-analytics-body">
   {exportError&&<p role="alert" className="error">{l.exportError}</p>}
   {tab==='overview'&&<>
    <div className="lgent-analysis-kpis">
     <button type="button" onClick={()=>chooseTab('photos')} title={l.photoHint}><span>{l.photo}</span><b>{formatRate(stats.freshRate)}</b><small>{stats.fresh}/{stats.total}{l.unit}</small></button>
     <button type="button" onClick={()=>chooseTab('photos')} title={l.gradeHint}><span>{l.grade}</span><b>{formatRate(stats.gradeRate)}</b><small>{stats.graded}/{stats.total}{l.unit}</small></button>
     <button type="button" onClick={()=>chooseTab('shipments')} title={l.readyHint}><span>{readinessLabel}</span><b>{complete?formatRate(shipment.readyRate):'—'}</b><small>{complete?`${range.start.slice(5)} ~ ${range.end.slice(5)} · ${shipment.ready}/${shipment.matched.length}${l.unit}`:l.prepare}</small></button>
    </div>
    <p className="lgent-analysis-note">{l.scope} {l.confirmed} <b>{stats.total}</b> · {l.unconfirmed} <b>{stats.unconfirmed}</b></p>
    <div className="lgent-analysis-table"><table><thead><tr><th>{l.metric}</th><th>{l.value}</th><th>{l.basis}</th></tr></thead><tbody>
     {([[l.utilization,l.utilHint],[l.rotation,l.rotationHint],[l.recovery,l.recoveryHint],[l.repair,l.repairHint]]).map(([name,hint])=><tr key={name}><th>{name}</th><td><span className="lgent-state-badge">{l.pending}</span></td><td>{hint}</td></tr>)}
    </tbody></table></div><p className="lgent-analysis-note">{l.historyLimit}</p>
   </>}
   {tab==='photos'&&<div className="lgent-analysis-columns">
    <section><h3>{l.photoBreakdown}</h3><div className="lgent-analysis-table"><table><thead><tr><th>{l.state}</th><th>{l.count}</th><th>{l.rate}</th></tr></thead><tbody>{photoRows.map(([name,count])=><tr key={name}><th>{name}</th><td>{count}</td><td>{formatRate(stats.total?Math.round(count/stats.total*1000)/10:null)}</td></tr>)}</tbody></table></div><p className="lgent-analysis-note">{l.photoHint}</p><p className="lgent-analysis-note">{l.verified} <b>{stats.verifiedFresh}</b> · {l.estimated} <b>{stats.estimatedFresh}</b></p></section>
    <section><h3>{l.gradeBreakdown}</h3><div className="lgent-analysis-table"><table><thead><tr><th>{l.gradeLabel}</th><th>{l.count}</th><th>{l.rate}</th></tr></thead><tbody>{stats.grades.map(([grade,count])=><tr key={grade}><th>{grade==='unknown'?l.unknownGrade:grade}</th><td>{count}</td><td>{formatRate(stats.total?Math.round(count/stats.total*1000)/10:null)}</td></tr>)}</tbody></table>{!stats.total&&<p className="lgent-empty">{l.noData}</p>}</div><p className="lgent-analysis-note">{l.gradeHint} {l.repairHint}</p></section>
   </div>}
   {tab==='shipments'&&<>
    <form className="lgent-analysis-range" onSubmit={e=>{e.preventDefault();if(!validShipmentRange(start,end)){setInvalid(true);return;}setInvalid(false);setRange({start,end});if(start===range.start&&end===range.end)void query.refetch();}}>
     <div className="lgent-analysis-modes">{(['plan','history'] as const).map(key=><button key={key} type="button" aria-pressed={mode===key} onClick={()=>changeMode(key)}>{l[key]}</button>)}</div>
     <input type="date" aria-label={l.start} value={start} onChange={e=>setStart(e.target.value)} required/><span>–</span><input type="date" aria-label={l.end} value={end} onChange={e=>setEnd(e.target.value)} required/><button type="submit" disabled={query.isFetching}>{l.apply}</button>
    </form>
    {invalid&&<p role="alert" className="error">{l.invalid}</p>}
    {query.isFetching&&<p role="status" className="lgent-analysis-note">{l.loading}</p>}
    {query.isError?<p role="alert" className="error">{permissionDenied?l.permission:l.failure} <button type="button" onClick={()=>void query.refetch()}>{l.retry}</button></p>:query.data&&!complete?<p role="alert">{l.partial}</p>:complete&&<>
     <div className="lgent-analysis-totals"><span title={l.readyHint}>{readinessLabel} <b>{formatRate(shipment.readyRate)}</b></span><span>{l.matched} <b>{shipment.matched.length}</b>{l.unit}</span><span className="needs-update">{l.attention} <b>{shipment.needsUpdate}</b>{l.unit}</span><span>{l.unmatched} <b>{shipment.unmatched}</b>{l.recordUnit}</span><span>{l.excluded} <b>{shipment.excluded}</b>{l.recordUnit}</span></div>
     <div className="lgent-analysis-table"><table><thead><tr><th>{l.cart}</th><th>{l.order}</th><th>{l.date}</th><th>{l.state}</th></tr></thead><tbody>{shipment.rows.map(row=>{const cart=row.cart&&stats.confirmed.find(cart=>cart.trolleyId===row.cart?.trolleyId);return <tr key={row.id} className={cart&&(!cart.hasPhoto||cart.alert!=='fresh')?'needs-update':''}><td>{cart?<button type="button" className="lgent-analysis-cart" onClick={()=>onSelectCart(cart.trolleyId)} title={l.openCart}>{cart.trolleyId}</button>:row.identifier||'—'}</td><td>{row.orderCode}</td><td>{stamp((mode==='plan'?row.plannedAt:row.recordedAt))}</td><td><span className={`lgent-state-badge ${cart?.hasPhoto?cart.alert:'unknown'}`}>{state(cart||undefined)}</span></td></tr>;})}</tbody></table>{!shipment.rows.length&&<p className="lgent-empty">{l.empty}</p>}</div>
     <p className="lgent-analysis-note">{l.readyHint} {l.fetched} {stamp(query.data!.fetchedAt)}</p>
    </>}
    <p className="lgent-analysis-note">{l.note}</p>
   </>}
  </div><footer>{l.exportHint}</footer>
 </dialog>;
}
