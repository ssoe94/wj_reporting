// Fixed loopback proxy to the disposable synthetic API; never reaches production/MES.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import fixtures from '../frontend/tests/inspection-room-fixtures.cjs';
const root = resolve('output/plan-workflow-dist');
const origin = 'http://127.0.0.1:5198';
const pair = fixtures.authPair();
let conflictNext = false, workflowUnavailable = false;
const send = (res, status, value) => { res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});res.end(JSON.stringify(value)); };
const headers = {'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'"};
const bootstrap = language => `<script>if(location.origin===${JSON.stringify(origin)}){const pair=${JSON.stringify(pair)};localStorage.setItem('wj-auth-session-control-v2',JSON.stringify({id:'synthetic-plan-workflow',...pair}));for(const [key,value]of Object.entries({access_token:pair.access,wj_next_access_token:pair.access,refresh_token:pair.refresh,wj_next_refresh_token:pair.refresh,lang:${JSON.stringify(language)},wj_next_language:${JSON.stringify(language)}}))localStorage.setItem(key,value)}</script>`;
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
createServer(async (req,res) => {
 try {
  const url=new URL(req.url,origin);
  // Loopback QA controls, absent from the application and production server.
  if(req.method==='POST' && url.pathname==='/__fixture__/conflict-next') { conflictNext=true; return send(res,200,{fixture:true}); }
  if(req.method==='POST' && url.pathname==='/__fixture__/workflow-unavailable') { workflowUnavailable=url.searchParams.get('enabled')==='true'; return send(res,200,{fixture:true}); }
  if(url.pathname.startsWith('/api/')) {
   if(url.pathname==='/api/user/me/' || url.pathname==='/api/injection/user/me/') return send(res,200,{...fixtures.currentUser(),username:'SYNTHETIC PLAN QA'});
   if(url.pathname==='/api/auth/session/activity/') return send(res,200,fixtures.activityResponse(pair));
   if(['/api/production/plan-workflow/','/api/production/plans/'].includes(url.pathname)) {
    let body='';for await(const chunk of req){body+=chunk;if(body.length>128*1024)throw Error('body too large');}
    if(url.pathname==='/api/production/plan-workflow/') {
     if(workflowUnavailable) return send(res,503,{detail:'SYNTHETIC unavailable'});
     if(req.method==='POST' && conflictNext) { conflictNext=false; return send(res,409,{detail:'SYNTHETIC stale version'}); }
    }
    const response=await fetch('http://127.0.0.1:8029'+url.pathname+url.search,{method:req.method,headers:{'content-type':'application/json'},body:req.method==='GET'?undefined:body});
    res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});return res.end(await response.text());
   }
   if(url.pathname==='/api/production/plan-dates/') return send(res,200,{injection:['2026-10-08','2026-10-09','2026-10-10'],machining:[]});
   if(url.pathname==='/api/production/plan-summary/') return send(res,200,{injection:{records:[]},machining:{records:[]}});
   if(url.pathname==='/api/production/plan-change-logs/') return send(res,200,[]);
   return send(res,404,{detail:'SYNTHETIC unsupported API; no forwarding'});
  }
  const file=resolve(root,'.'+decodeURIComponent(url.pathname));
  if(file.startsWith(root+sep)&&existsSync(file)&&statSync(file).isFile()){
   res.writeHead(200,{...headers,'content-type':mime[extname(file)]||'application/octet-stream'});return res.end(readFileSync(file));
  }
  if(['/','/production/plan','/login'].includes(url.pathname)) {
   const language=url.searchParams.get('fixture_lang')==='zh'?'zh':'ko';
   res.writeHead(200,{...headers,'content-type':'text/html; charset=utf-8'});
   return res.end(readFileSync(resolve(root,'index.html'),'utf8').replace('<head>','<head>'+bootstrap(language)));
  }
  send(res,404,{detail:'SYNTHETIC missing asset'});
 } catch { if(res.headersSent) res.destroy(); else send(res,503,{detail:'SYNTHETIC fixture unavailable'}); }
}).listen(5198,'127.0.0.1',()=>console.log(origin+'/production/plan?fixture_lang=ko'));
