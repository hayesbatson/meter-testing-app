/* Batch testing for the Meter Testing App. Ported from the batch prototype (v11).
   Loaded by index.html after its main script; uses the app's Store, S, putConfig, updateJson, put, toast, esc, offer, go.
   Data: batch/<orderId>/job.json (locked-up meters, photos, schedule, approval, manifests used)
         batch/<orderId>/runs-NNN.json (bench runs, 25 per file)
         customers/<customer>/manifests/<id>.json (parsed manifest) + the original file
   Customer settings: config "batchCust". Bench settings: S.settings.batch. */
(function(){
"use strict";
const num=v=>{if(v===""||v==null)return null;const n=Number(String(v).replace(/,/g,""));return isFinite(n)?n:null};
const normSer=s=>String(s||"").trim().toUpperCase().replace(/^0+(?=.)/,"");
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const fmtD=d=>{const x=new Date(d);return x.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+x.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})};
const $=s=>document.querySelector(s);
const LIMITS=[[0.985,1.015],[0.985,1.015],[0.95,1.01]]; // displacement: high, med, low
const NCT="Could not test – locked up";
const ME=()=>S.myTech||(typeof account!=="undefined"&&account&&account.name)||userName();
const TECHS=()=>S.lists.techs||[];
/* sizes: bench positions [current, new], default flow rates (GPM), and which sizes can share a run */
const SIZES={'5/8"':{pos:[6,12],flow:[15,2,0.25],grp:"58"},'5/8 x 1/2"':{pos:[6,12],flow:[15,2,0.25],grp:"58"},'5/8 x 3/4"':{pos:[6,12],flow:[15,2,0.25],grp:"58"},
  '3/4"':{pos:[6,9],flow:[25,3,0.5],grp:"34"},'3/4 x 3/4"':{pos:[6,9],flow:[25,3,0.5],grp:"34"},'1"':{pos:[4,8],flow:[40,4,0.75],grp:"1"}};
const BENCH=()=>((S.settings.batch||{}).bench)||0;
const posFor=size=>SIZES[size]?SIZES[size].pos[BENCH()]:6;
const emptyRow=()=>({ser:"",wo:"",arrive:"",b1:"",e1:"",b2:"",e2:"",b3:"",e3:"",nct:"",size:"",make:"",model:""});
function blankRun(no,n){return {no,date:today(),tech:"",size:"",make:"",model:"",unit:"",flow:["","",""],vol:["","",""],mixed:false,showBeg:false,log:[],saved:false,rows:Array.from({length:n||6},emptyRow)}}
function nextRunFrom(prev,no){const r=blankRun(no,posFor(prev.size));["date","tech","size","make","model","unit","mixed"].forEach(k=>r[k]=prev[k]);r.flow=[...prev.flow];r.date=today();return r}
const DEFAULT_OPTS={mult:1,tol:1,check:true,reg:"both",pf:true,untested:"list"};
const custKey=c=>String(c||"").trim().toLowerCase();
const custRec=c=>{S.batchCust=S.batchCust||{};const k=custKey(c);return S.batchCust[k]||(S.batchCust[k]={name:c,opts:{},manifests:[]})};
const safe=x=>String(x||"").replace(/[\\/:*?"<>|#%]+/g," ").trim().slice(0,80)||"customer";

/* ---------- state ---------- */
const B={oid:null,state:"idle",err:"",job:null,view:null,tab:"job",woPool:[],timer:null,dirty:new Set(),saving:0,saveMsg:"",photoUrls:{},mf:null,qrFor:""};
const J=()=>B.view;const R=()=>B.view&&B.view.runs[B.view.cur];
const jobPath=()=>`batch/${B.oid}/job.json`;
const blockPath=n=>`batch/${B.oid}/runs-${String(n).padStart(3,"0")}.json`;
const blockOf=no=>Math.ceil(no/25);
const newJobData=()=>({v:1,blocks:0,blocked:[],photos:[],sched:{start:today(),manifestSize:"58",sizes:{},edits:{}},manifests:[],approved:false});
function bindJob(d){const v=B.view;B.job=d;v.blocked=d.blocked||(d.blocked=[]);v.photos=d.photos||(d.photos=[]);v.sched=d.sched||(d.sched=newJobData().sched);v.sched.edits=v.sched.edits||{};v.sched.sizes=v.sched.sizes||{};
  v.approved=!!d.approved;v.files=d.manifests||(d.manifests=[])}
async function load(oid){
  B.oid=oid;B.state="loading";B.err="";B.view=null;B.woPool=[];B.dirty.clear();
  try{
    const o=S.orders.get(oid);if(!o)throw new Error("Job not found");
    const {data}=await Store.getJson(jobPath());const d=data||newJobData();
    const blocks=await Promise.all(Array.from({length:d.blocks||0},(_,i)=>Store.getJson(blockPath(i+1))));
    const runs=blocks.flatMap(b=>(b.data&&b.data.runs)||[]).sort((a,b)=>a.no-b.no);
    B.view={client:o.client,name:(o.batch&&o.batch.name)||jobName(o),estimate:o.estimate||"",opts:{...DEFAULT_OPTS,...custRec(o.client).opts},manifest:[],earlier:{},runs:runs.length?runs:[blankRun(1,posFor(""))],cur:0};
    bindJob(d);await loadManifests();
    const firstOpen=B.view.runs.findIndex(r=>!runDone(r));B.view.cur=firstOpen>=0?firstOpen:B.view.runs.length-1;
    B.state="ready";
  }catch(e){B.state="error";B.err=e.message}
  softRender();
}
async function loadManifests(){const v=B.view;const seen=new Set();v.manifest=[];
  const lists=await Promise.all(v.files.map(f=>Store.getJson(`customers/${safe(v.client)}/manifests/${f.id}.json`).then(r=>(r.data&&r.data.rows)||[]).catch(()=>[])));
  lists.flat().forEach(m=>{const k=normSer(m.ser);if(k&&!seen.has(k)){seen.add(k);v.manifest.push(m)}})}

/* ---------- saving ---------- */
function setSaveMsg(m){B.saveMsg=m;const el=document.getElementById("b-savestate");if(el)el.textContent=m}
function touchRun(run){B.dirty.add(run.no);setSaveMsg("Not saved yet");clearTimeout(B.timer);B.timer=setTimeout(flush,1500)}
async function saveRun(run){const copy=JSON.parse(JSON.stringify(run)),n=blockOf(run.no);
  await updateJson(blockPath(n),d=>{d.runs=d.runs||[];const i=d.runs.findIndex(x=>x.no===copy.no);if(i>=0)d.runs[i]=copy;else d.runs.push(copy);d.runs.sort((a,b)=>a.no-b.no);return d},{runs:[]});
  if((B.job.blocks||0)<n)await saveJob(d=>{d.blocks=Math.max(d.blocks||0,n)})}
async function flush(){clearTimeout(B.timer);if(!B.view||!B.dirty.size)return;const nos=[...B.dirty];B.dirty.clear();B.saving++;setSaveMsg("Saving…");
  try{for(const no of nos){const run=B.view.runs.find(r=>r.no===no);if(run)await saveRun(run)}setSaveMsg("All changes saved");summary()}
  catch(e){nos.forEach(n=>B.dirty.add(n));setSaveMsg("Couldn't save: "+e.message);toast("Couldn't save the run: "+e.message)}
  finally{B.saving--}}
async function saveJob(fn){const oid=B.oid;const next=await updateJson(`batch/${oid}/job.json`,d=>{fn(d);return d},newJobData());if(B.oid===oid&&B.view)bindJob(next);summary();return next}
let sumTimer=null;
function summary(){clearTimeout(sumTimer);sumTimer=setTimeout(async()=>{if(!B.view)return;const o=S.orders.get(B.oid);if(!o)return;const j=B.view,rows=allRows();
  const s={name:j.name,approved:j.approved,runsN:j.runs.length,entered:rows.length+j.blocked.length,pass:rows.filter(x=>x.c.overall==="pass").length,fail:rows.filter(x=>x.c.overall==="fail").length,
    locked:j.blocked.length,openRuns:j.runs.filter(r=>r.rows.some(x=>x.ser.trim())&&!runDone(r)).length,look:rows.filter(x=>rowWarnings(x.r,x.run,j).length).length,manifestN:j.manifest.length,finish:(()=>{try{const i=schedInfo(j);return (i.likely&&i.likely.finish)||(i.plan&&i.plan.finish)||""}catch(e){return ""}})()};
  const cur=o.batch||{};if(Object.keys(s).every(k=>cur[k]===s[k]))return;
  try{await put("orders",o.id,{...S.orders.get(o.id),batch:{...cur,...s}})}catch(e){}},2500)}
/* WO numbers come from the app's sequence; a block the size of the bench is reserved at a time */
async function reserveWos(n){let fresh=null;try{fresh=S.configIds.settings&&await Store.get("config",S.configIds.settings)}catch(e){}
  S.settings.woReserved=Math.max(num(S.settings.woReserved)||0,num(fresh&&fresh.woReserved)||0);
  const start=num(nextWo())||1;S.settings.woReserved=start+n-1;await putConfig("settings",S.settings);
  return Array.from({length:n},(_,i)=>String(start+i))}
let woQ=Promise.resolve();
function ensureWo(run,row){if(row.wo)return;woQ=woQ.then(async()=>{if(row.wo||!row.ser.trim())return;
    if(!B.woPool.length)B.woPool.push(...await reserveWos(Math.max(6,posFor(run.size))));
    row.wo=B.woPool.shift();touchRun(run);const i=run.rows.indexOf(row),el=document.getElementById(`r${i}-wo`);if(el)el.textContent="WO "+row.wo})
  .catch(e=>toast("Couldn't get work order numbers: "+e.message))}

const eff=(row,run,k)=>run.mixed&&row[k]?row[k]:run[k];
const begOf=(row,t)=>t===0?row.b1:t===1?(row.b2!==""?row.b2:row.e1):(row.b3!==""?row.b3:row.e2);
const LBL={arrive:"arrival read",b1:"test 1 begin",e1:"test 1 end",b2:"test 2 begin",e2:"test 2 end",b3:"test 3 begin",e3:"test 3 end"};
function calc(row,run){
  const r={acc:[null,null,null],pass:[null,null,null],flags:[],bad:new Set(),overall:"incomplete",done:false};
  const v=run.vol.map(num);
  for(let t=0;t<3;t++){const b=num(begOf(row,t)),e=num(row["e"+(t+1)]);if(b!=null&&e!=null&&v[t]){const a=(e-b)/v[t];r.acc[t]=Math.round(a*1000)/1000;r.pass[t]=r.acc[t]>=LIMITS[t][0]&&r.acc[t]<=LIMITS[t][1]}}
  if(row.nct){r.overall="nct";r.done=true;return r}
  // same check as the Excel sheet: no read may be lower than the read before it
  const seq=[["arrive",row.arrive],["b1",row.b1],["e1",row.e1],["b2",begOf(row,1)],["e2",row.e2],["b3",begOf(row,2)],["e3",row.e3]].map(([k,x])=>[k,num(x)]).filter(x=>x[1]!=null);
  for(let i=1;i<seq.length;i++)if(seq[i][1]<seq[i-1][1]&&seq[i][0]!==seq[i-1][0]){r.flags.push(["bad",`${cap(LBL[seq[i][0]])} is lower than ${LBL[seq[i-1][0]]}`,"lower"]);r.bad.add(seq[i][0])}
  // likely typo: accuracy far outside any normal result
  r.acc.forEach((a,t)=>{if(a!=null&&(a<0.9||a>1.1)){r.flags.push(["bad",`Test ${t+1} is ${pct(a)}. Check the reads.`,"typo"+t]);r.bad.add("e"+(t+1))}});
  if(r.pass.every(p=>p!==null)){r.overall=r.pass.every(Boolean)?"pass":"fail";r.done=true}
  return r;
}
const cap=s=>s[0].toUpperCase()+s.slice(1);
function serialStatus(row,job){
  const s=normSer(row.ser);if(!s)return null;
  if(job.runs.some(x=>x.rows.some(y=>y!==row&&normSer(y.ser)===s)))return ["bad","Already entered in this job","dup"];
  if(job.blocked.some(b=>normSer(b.ser)===s))return ["bad","Already marked locked up in this job","dup"];
  if(job.earlier[s])return ["warn","Tested before: "+job.earlier[s],"earlier"];
  if(!job.manifest.length)return null;
  return job.manifest.some(x=>normSer(x.ser)===s)?["ok","On the manifest"]:["bad","Not on the manifest","manifest"];
}
function readCheck(row,job){
  if(!job.opts.check||row.nct)return null;const s=normSer(row.ser);const m=job.manifest.find(x=>normSer(x.ser)===s);
  if(!m||m.read==null)return null;const a=num(row.arrive);const want=m.read;
  if(a==null)return null;
  const diff=a/job.opts.mult-want;return Math.abs(diff)<=job.opts.tol?["ok","Matches the client read"]:["warn",`Arrival read is off by ${Math.round(diff*job.opts.mult).toLocaleString()} from the client read`,"read"];
}
const pct=a=>a==null?"":(a*100).toFixed(1)+"%";
/* the client's read from the manifest, shown under the arrival read the whole time so the tech can compare */
function clientRead(row,job){if(!job.opts.check||!row.ser.trim())return "";const m=job.manifest.find(x=>normSer(x.ser)===normSer(row.ser));if(!m||m.read==null)return "";
  const k=job.opts.mult;return `Client read ${m.read.toLocaleString()}${k>1?` ×${k} = ${(m.read*k).toLocaleString()}`:""}`}
/* photos: prompted when a serial isn't on the manifest or the arrival read doesn't match; kept with the job */
function allWarnings(row,run,job){const out=[...calc(row,run).flags];const st=serialStatus(row,job);if(st&&(st[0]==="bad"||st[0]==="warn"))out.push(st);const rc=readCheck(row,job);if(rc&&rc[0]==="warn")out.push(rc);return out}
/* warnings that can be marked "checked" when the data is right (the others must be fixed) */
const CAN_CHECK=c=>/^(manifest|earlier|read|typo\d)$/.test(c||"");
const isChecked=(row,f)=>row.ok&&f[2]&&row.ok[f[2]];
const rowWarnings=(row,run,job)=>allWarnings(row,run,job).filter(f=>!isChecked(row,f));
const checkedWarnings=(row,run,job)=>allWarnings(row,run,job).filter(f=>isChecked(row,f));
function flagHtml(f,row,ri,pi,lock){
  if(isChecked(row,f)){const k=row.ok[f[2]];return `<span class="flag info">✓ ${esc(f[1])} · checked by ${esc(k.by)}</span>`}
  return `<span class="flag ${f[0]}">${esc(f[1])}${CAN_CHECK(f[2])&&!lock&&f[0]!=="ok"&&f[0]!=="info"?` <button class="linkbtn" data-act="b-ok" data-ri="${ri}" data-pi="${pi}" data-code="${f[2]}">Mark checked</button>`:""}</span>`}
function runMissing(run){ // what's left before a run is complete
  const used=run.rows.filter(r=>r.ser.trim());const miss=[];
  if(!used.length)return ["serials"];
  if(!run.tech)miss.push("tech");if(!run.size)miss.push("size");if(!run.mixed&&(!run.make||!run.model))miss.push("make and model");
  if(run.mixed&&used.some(r=>!eff(r,run,"make")||!eff(r,run,"model")))miss.push("make and model for each meter");
  if(run.vol.some(v=>num(v)==null))miss.push("test volumes");
  const open=used.filter(r=>!calc(r,run).done).map(r=>run.rows.indexOf(r)+1);if(open.length)miss.push(`reads for position${open.length>1?"s":""} ${open.join(", ")}`);
  return miss;
}
const runDone=run=>!runMissing(run).length;

function jobHead(){const j=J();const open=j.runs.filter(r=>!runDone(r)).length;return `<div><div class="crumb"><a href="#jobs">Jobs &amp; meters</a> › ${esc(j.client)} · ${esc(j.name)}</div>
  <div class="row spread"><h1>${esc(j.client)} · ${esc(j.name)} <span class="jstat ${j.approved?"approved":"info"}" style="vertical-align:middle">${j.approved?"Approved by manager":"Service in progress"}</span></h1><span class="note">Batch job${j.estimate?" · QBO estimate "+esc(j.estimate):""}</span></div>${jobTabs()}</div>`}
const statusChip=run=>runDone(run)?'<span class="jstat approved">Complete</span>':run.rows.some(r=>r.ser)?'<span class="jstat warn">In progress</span>':'<span class="jstat">Not started</span>';
function viewRun(){
  const j=J(),run=R(),lock=j.approved,szs=Object.keys(SIZES);const dis=lock?"disabled":"";
  const grpSizes=run.size?szs.filter(s=>SIZES[s].grp===SIZES[run.size].grp):szs;
  const hand=run.rows.some(r=>r.b2!==""||r.b3!=="");const showBeg=run.showBeg;
  const rows=run.rows.map((row,i)=>{
    const c=calc(row,run),st=serialStatus(row,j),rc=readCheck(row,j);const id=k=>`r${i}-${k}`;
    const auto={b2:row.e1,b3:row.e2};
    const inp=k=>`<input id="${id(k)}" data-r="${i}" data-k="${k}" class="num ${c.bad.has(k)?"bad":""} ${(k==="b2"||k==="b3")&&row[k]!==""?"hand":""}" inputmode="decimal" autocomplete="off" value="${esc(row[k])}" ${(k==="b2"||k==="b3")?`placeholder="${esc(auto[k])}"`:""} ${row.nct?"tabindex=-1":""} ${dis} aria-label="Position ${i+1} ${LBL[k]||k}">`;
    const acc=t=>c.acc[t]==null?'<span class="acc"></span>':`<span class="acc ${c.pass[t]?"pass":"fail"}">${pct(c.acc[t])}</span>`;
    const handNote=!showBeg&&(row.b2!==""||row.b3!=="")?`<span class="flag warn">${row.b2!==""?"Test 2":"Test 3"} begin read entered by hand</span>`:"";
    const mixedCells=run.mixed?`<td class="gl"><select id="${id("size")}" data-r="${i}" data-k="size" ${dis} aria-label="Position ${i+1} size"><option value="">${esc(run.size||"Size")}</option>${grpSizes.filter(s=>s!==run.size).map(s=>`<option ${row.size===s?"selected":""}>${esc(s)}</option>`).join("")}</select></td>
      <td><input id="${id("make")}" data-r="${i}" data-k="make" value="${esc(row.make)}" placeholder="${esc(run.make)}" ${dis} aria-label="Position ${i+1} make" style="min-width:100px;font-family:var(--f-body)"></td>
      <td><input id="${id("model")}" data-r="${i}" data-k="model" value="${esc(row.model)}" placeholder="${esc(run.model)}" ${dis} aria-label="Position ${i+1} model" style="min-width:80px;font-family:var(--f-body)"></td>`:"";
    return `<tr class="${row.nct?"nct":""}"><td class="pos">${i+1}</td>
      <td><input id="${id("ser")}" data-r="${i}" data-k="ser" class="ser" autocomplete="off" value="${esc(row.ser)}" placeholder="Enter serial" ${dis} aria-label="Position ${i+1} serial">${st?flagHtml(st,row,j.cur,i,lock):""}<span class="flag info" id="r${i}-wo">${row.wo?"WO "+esc(row.wo):""}</span></td>
      ${mixedCells}
      <td class="gl">${inp("arrive")}${clientRead(row,j)?`<span class="flag info">${esc(clientRead(row,j))}</span>`:""}${rc?flagHtml(rc,row,j.cur,i,lock):""}</td>
      <td class="gl">${inp("b1")}</td><td>${inp("e1")}${acc(0)}</td>
      ${showBeg?`<td class="gl">${inp("b2")}</td><td>`:`<td class="gl">`}${inp("e2")}${acc(1)}</td>
      ${showBeg?`<td class="gl">${inp("b3")}</td><td>`:`<td class="gl">`}${inp("e3")}${acc(2)}</td>
      <td class="gl" style="min-width:170px">${row.nct?`<span class="chip none">Not tested</span><span class="flag info">${esc(row.nct)}</span>${lock?"":`<button class="btn small" data-act="b-nct-undo" data-r="${i}" style="margin-top:4px">Undo</button>`}`
        :`${c.overall==="pass"?'<span class="chip pass">Pass</span>':c.overall==="fail"?'<span class="chip fail">Fail</span>':'<span class="chip none">—</span>'}
        ${c.flags.map(f=>flagHtml(f,row,j.cur,i,lock)).join("")}${handNote}
        ${photoCell(row,j.cur,i,lock)}
        ${lock||!row.ser?"":`<button class="linkbtn" data-act="b-blocked" data-r="${i}" style="display:block;margin-top:6px">Locked up – replace</button>`}`}</td></tr>`}).join("");
  const blockedHere=j.blocked.filter(b=>b.run===run.no);
  const unit=run.unit==="CF"?"cu ft":run.unit==="Gallons"?"gal":"";
  const idx=j.cur,prev=j.runs[idx-1],next=j.runs[idx+1];const miss=runMissing(run);
  return `<div class="stack">${jobHead()}
  <div class="panel"><div class="hd">
    <div class="runnav">${prev?`<button class="btn small" data-act="b-go-run" data-i="${idx-1}" aria-label="Previous run">‹ Run ${prev.no}</button>`:""}<h2>Bench run ${run.no} <span class="muted" style="font-weight:600">of ${j.runs.length}</span></h2>${statusChip(run)}${next?`<button class="btn small" data-act="b-go-run" data-i="${idx+1}" aria-label="Next run">Run ${next.no} ›</button>`:""}</div>
    <div class="row">${lock?'<span class="note">The job is approved, so runs are locked.</span>':`<button class="btn" data-act="b-save">Save</button><button class="btn primary" data-act="b-save-next">${next?`Save and go to run ${next.no}`:"Save run and start the next one"}</button>`}</div></div>
   <div class="bd stack">
    ${!lock&&miss.length&&run.rows.some(r=>r.ser)?`<div class="callout info">Still needed to finish this run: ${esc(miss.join(", "))}.</div>`:""}
    <div class="runset">
      <label class="f">Test date<input id="rs-date" type="date" data-rs="date" value="${esc(run.date)}" ${dis}></label>
      <label class="f">Tech<select id="rs-tech" data-rs="tech" ${dis}><option value="">Choose…</option>${TECHS().map(t=>`<option ${run.tech===t?"selected":""}>${t}</option>`).join("")}</select></label>
      <label class="f">Size<select id="rs-size" data-rs="size" ${dis}><option value="">Choose…</option>${szs.map(s=>`<option ${run.size===s?"selected":""}>${esc(s)}</option>`).join("")}</select></label>
      <label class="f">Make<input id="rs-make" data-rs="make" value="${esc(run.make)}" ${dis}></label>
      <label class="f">Model<input id="rs-model" data-rs="model" value="${esc(run.model)}" ${dis}></label>
      <label class="f">Volume unit<select id="rs-unit" data-rs="unit" ${dis}><option value="">Choose…</option><option ${run.unit==="Gallons"?"selected":""}>Gallons</option><option value="CF" ${run.unit==="CF"?"selected":""}>Cubic feet</option></select></label>
      <label class="f">Bench<select id="rs-bench" ${dis}><option value="0" ${BENCH()===0?"selected":""}>Current (6/6/4)</option><option value="1" ${BENCH()===1?"selected":""}>New (12/9/8)</option></select></label>
    </div>
    <div class="trio"><span></span><span class="h">Test 1 · High</span><span class="h">Test 2 · Med</span><span class="h">Test 3 · Low</span>
      <span class="note">Flow rate (GPM)</span>${[0,1,2].map(t=>`<input id="rs-flow${t}" class="num" data-flow="${t}" value="${esc(run.flow[t])}" ${dis} aria-label="Test ${t+1} flow rate">`).join("")}
      <span class="note">Test volume${unit?` (${unit})`:""}</span>${[0,1,2].map(t=>`<input id="rs-vol${t}" class="num" data-vol="${t}" value="${esc(run.vol[t])}" placeholder="From the bench" ${dis} aria-label="Test ${t+1} volume">`).join("")}
      <span class="note">Limits</span>${LIMITS.map(l=>`<span class="note mono">${(l[0]*100).toFixed(1)}–${(l[1]*100).toFixed(1)}%</span>`).join("")}
    </div>
    <div class="tools">
      <button class="btn small ${showBeg?"on":""}" data-act="b-toggle-beg" aria-pressed="${showBeg}">${showBeg?"Hide":"Show"} test 2 &amp; 3 begin reads${hand&&!showBeg?" (some entered by hand)":""}</button>
      <button class="btn small ${run.mixed?"on":""}" data-act="b-toggle-mixed" aria-pressed="${run.mixed}" ${dis}>${run.mixed?"Same make and model for all meters":"Different makes or models in this run"}</button>
    </div>
    <div class="note">Type the serial, then the reads. <span class="kbd">Enter</span> moves to the next box across the row, then down to the next position. Test 2 begins where test 1 ended, and test 3 where test 2 ended. If the bench needed a purge between tests, show the begin reads and type the real one.${run.mixed?" Leave size, make or model blank on a row to use the run's values shown in grey.":""}</div>
   </div>
   <div class="tablewrap"><table class="bench"><thead>
    <tr><th></th><th></th>${run.mixed?'<th class="grp" colspan="3">Meter</th>':""}<th class="grp">Register</th><th class="grp" colspan="2">Test 1 · High (after purge)</th><th class="grp" ${showBeg?'colspan="2"':""}>Test 2 · Med</th><th class="grp" ${showBeg?'colspan="2"':""}>Test 3 · Low</th><th class="grp"></th></tr>
    <tr><th>Pos</th><th>Serial</th>${run.mixed?'<th class="grp">Size</th><th>Make</th><th>Model</th>':""}<th class="grp">Arrival read</th><th class="grp">Begin read</th><th>End read</th>${showBeg?'<th class="grp">Begin read</th><th>End read</th>':'<th class="grp">End read</th>'}${showBeg?'<th class="grp">Begin read</th><th>End read</th>':'<th class="grp">End read</th>'}<th class="grp">Result</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
   ${blockedHere.length?`<div class="bd note">Locked up and replaced in this run: ${blockedHere.map(b=>`<span class="mono">${esc(b.ser)}</span> (position ${b.pos}, WO ${esc(b.wo)})`).join(", ")}. They're listed under Locked-up meters on the Batch job screen.</div>`:""}
   ${run.log.length?`<div class="bd"><h3 style="margin-bottom:6px">Changes after the run was finished</h3><ul class="log">${run.log.map(l=>`<li>${esc(fmtD(l.at))} · ${esc(l.by)} · ${esc(l.what)}</li>`).join("")}</ul></div>`:""}
  </div></div>`;
}
function runSummary(run){const cs=run.rows.filter(r=>r.ser).map(r=>calc(r,run));return {n:cs.length,p:cs.filter(c=>c.overall==="pass").length,f:cs.filter(c=>c.overall==="fail").length,x:J().blocked.filter(b=>b.run===run.no).length}}
function allRows(){const j=J();return j.runs.flatMap((run,ri)=>run.rows.map((r,pi)=>({r,run,ri,pos:pi+1,c:calc(r,run)})).filter(x=>x.r.ser.trim()))}
function viewJob(){
  const j=J(),rows=allRows();const p=rows.filter(x=>x.c.overall==="pass").length,f=rows.filter(x=>x.c.overall==="fail").length,x=j.blocked.length,waiting=rows.filter(x=>!x.c.done).length;
  const look=rows.map(x=>({...x,w:rowWarnings(x.r,x.run,j)})).filter(x=>x.w.length);const kept=rows.map(x=>({...x,w:checkedWarnings(x.r,x.run,j)})).filter(x=>x.w.length);
  const entered=new Set([...rows.map(x=>normSer(x.r.ser)),...j.blocked.map(b=>normSer(b.ser))]);const notYet=j.manifest.filter(m=>!entered.has(normSer(m.ser)));
  const tot=(rows.length+x)||1;const o=j.opts;const openRuns=j.runs.filter(r=>!runDone(r));
  const opt=(k,label,choices)=>`<label class="f">${label}<select id="op-${k}" data-op="${k}">${choices.map(([v,t])=>`<option value="${v}" ${String(o[k])===String(v)?"selected":""}>${t}</option>`).join("")}</select></label>`;
  const stat=(cls,n,label,hint)=>`<div class="stat ${cls}"><b>${n}</b><span>${label}</span><div class="note" style="margin-top:4px">${hint}</div></div>`;
  return `<div class="stack">${jobHead()}${mfPicker()}
   <div class="panel"><div class="hd"><h2>Progress</h2><div class="row"><a class="btn" href="#batch-${B.oid}.run">Go to bench run</a><button class="btn ${j.approved?"":"primary"}" data-act="b-approve">${j.approved?"Undo approval":"Approve job"}</button></div></div><div class="bd stack">
    <div class="stats">
      ${stat("",rows.length+x,"Meters entered","Serials typed in so far, including locked-up meters")}
      ${stat("pass",p,"Pass","All three tests in limits")}
      ${stat("fail",f,"Fail","At least one test out of limits")}
      ${stat("",waiting,"Still testing","Serial entered, reads not finished")}
      ${stat("",x,"Locked up","Couldn't be tested; replaced on the bench (listed below)")}
      ${stat("warn",look.length,"Need a look","Have a warning to check (listed below)")}
      ${j.manifest.length?stat("",notYet.length,"Not tested yet","On the manifest, not entered in any run yet"):""}
    </div>
    <div class="bar" aria-hidden="true"><i class="p" style="width:${p/tot*100}%"></i><i class="f" style="width:${f/tot*100}%"></i><i class="n" style="width:${x/tot*100}%"></i></div>
    <div class="note">${openRuns.length?`Run${openRuns.length>1?"s":""} ${openRuns.map(r=>r.no).join(" and ")} ${openRuns.length>1?"aren't":"isn't"} finished yet. `:""}The manager approves the whole job once every run is finished. Until then, anyone can open a run and correct a read. Approval locks the runs.</div>
   </div></div>
   ${look.length?`<div class="panel"><div class="hd"><h2>Meters that need a look</h2><span class="note">Fix the read, or mark it checked if it's right</span></div><div class="tablewrap"><table class="list"><thead><tr><th>Run</th><th>Pos</th><th>Serial</th><th>WO</th><th>Warning</th><th>Photo</th><th></th></tr></thead><tbody>
     ${look.map(x=>`<tr><td>${x.run.no}</td><td>${x.pos}</td><td class="mono">${esc(x.r.ser)}</td><td class="mono">${esc(x.r.wo)}</td><td style="white-space:normal">${x.w.map(w=>`<div class="row" style="gap:8px;margin:2px 0"><span class="flag ${w[0]}" style="max-width:none;margin:0">${esc(w[1])}</span>${CAN_CHECK(w[2])&&!j.approved?`<button class="btn small" data-act="b-ok" data-ri="${x.ri}" data-pi="${x.pos-1}" data-code="${w[2]}">Mark checked</button>`:""}</div>`).join("")}</td><td>${photosOf(x.r,j).length?`${phImg(photosOf(x.r,j)[0])}`:photoCodes(x.r).length?'<span class="flag warn" style="margin:0">None yet</span>':'<span class="muted">—</span>'}</td><td><button class="btn small" data-act="b-go-run" data-i="${x.ri}" data-focus="r${x.pos-1}-ser">Open run</button></td></tr>`).join("")}
   </tbody></table></div><div class="bd note">"Not on the manifest", "Tested before", a client read that doesn't match, and an unusual test result can be marked checked when they're right. A read lower than the one before it, or a serial entered twice, has to be fixed.</div></div>`:""}
   ${kept.length?`<div class="panel"><div class="bd"><details><summary>${kept.length} meter${kept.length>1?"s":""} checked and kept</summary><div class="tablewrap" style="margin-top:8px"><table class="list"><thead><tr><th>Run</th><th>Pos</th><th>Serial</th><th>Warning</th><th>Checked by</th><th></th></tr></thead><tbody>
     ${kept.flatMap(x=>x.w.map(w=>`<tr><td>${x.run.no}</td><td>${x.pos}</td><td class="mono">${esc(x.r.ser)}</td><td style="white-space:normal">${esc(w[1])}</td><td>${esc(x.r.ok[w[2]].by)} · ${esc(fmtD(x.r.ok[w[2]].at))}</td><td>${j.approved?"":`<button class="btn small" data-act="b-unok" data-ri="${x.ri}" data-pi="${x.pos-1}" data-code="${w[2]}">Undo</button>`}</td></tr>`)).join("")}
   </tbody></table></div></details></div></div>`:""}
   <div class="panel"><div class="hd"><h2>Locked-up meters</h2><span class="note">${x} meter${x===1?"":"s"} · "${NCT}" in the client file</span></div>
    ${x?`<div class="tablewrap"><table class="list"><thead><tr><th>Serial</th><th>WO</th><th class="num">Arrival read</th><th>Found</th><th>Date</th><th>Tech</th><th></th></tr></thead><tbody>
     ${j.blocked.map((b,i)=>`<tr><td class="mono">${esc(b.ser)}</td><td class="mono">${esc(b.wo)}</td><td class="num">${esc(b.arrive)||'<span class="muted">—</span>'}</td><td>${b.run?`Run ${b.run}, position ${b.pos}`:"Before testing"}</td><td>${esc(dayLbl(b.date))}</td><td>${esc(b.tech||b.by)}</td>
       <td>${j.approved?"":`<button class="btn small" data-act="b-bl-rm" data-i="${i}">Remove</button>`}</td></tr>`).join("")}
    </tbody></table></div>`:""}
    <div class="bd stack">
     <div class="note">On the bench run, <b>Locked up – replace</b> moves a meter here and clears its position for the replacement, so every run ends with only tested meters. Meters found locked up before they reach the bench can be added here.</div>
     ${j.approved?"":`<div class="row" style="align-items:flex-end"><label class="f">Serial<input id="bl-ser" autocomplete="off" style="min-width:150px"></label><label class="f">Arrival read<input id="bl-arr" class="num" inputmode="decimal" style="min-width:120px"></label><button class="btn small" data-act="b-bl-add">Add locked-up meter</button></div>`}
    </div></div>
   ${j.photos.length?`<div class="panel"><div class="hd"><h2>Photos</h2><span class="note">${j.photos.length} photo${j.photos.length>1?"s":""} saved with this job</span></div><div class="bd"><div class="photogrid">${j.photos.map(ph=>`<figure>${phImg(ph,"")}<figcaption><b class="mono">${esc(ph.ser)}</b> · WO ${esc(ph.wo)}<br>Run ${ph.run}, position ${ph.pos} · ${esc(ph.reason)}<br><span class="muted">${esc(ph.by)} · ${esc(fmtD(ph.at))}</span></figcaption></figure>`).join("")}</div></div></div>`:""}
   <div class="panel"><div class="hd"><h2>Bench runs</h2></div><div class="tablewrap"><table class="list"><thead><tr><th>Run</th><th>Status</th><th>Date</th><th>Tech</th><th>Meters</th><th>Volumes</th><th class="num">Entered</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Locked up</th><th></th></tr></thead><tbody>
     ${[...j.runs].map((run,i)=>({run,i})).reverse().map(({run,i})=>{const s=runSummary(run);return `<tr><td><b>${run.no}</b></td><td>${statusChip(run)}</td><td>${esc(run.date)}</td><td>${esc(run.tech)}</td><td>${run.mixed?"Mixed":esc([run.size,run.make,run.model].filter(Boolean).join(" "))}</td><td class="mono">${run.vol.some(v=>v!=="")?esc(run.vol.join(" / ")):'<span class="muted">—</span>'}</td><td class="num">${s.n}</td><td class="num">${s.p}</td><td class="num" style="color:${s.f?"var(--fail)":"inherit"}">${s.f}</td><td class="num">${s.x}</td><td><button class="btn small" data-act="b-go-run" data-i="${i}">Open</button></td></tr>`}).join("")}
   </tbody></table></div></div>
   <div class="panel"><div class="hd"><h2>Settings for ${esc(j.client)}</h2><span class="note">Saved with the customer, so every ${esc(j.client)} job uses them</span></div><div class="bd stack">
    <div class="opts">
     ${opt("check","Check arrival reads against the manifest",[[true,"Yes"],[false,"No (e.g. our own registers)"]])}
     ${opt("mult","Client reads are in",[[1,"Same units as the register"],[10,"Tens (multiply by 10)"],[100,"Hundreds (multiply by 100)"]])}
     ${opt("tol","Allowed difference (client units)",[[0,"Exact"],[1,"± 1"],[2,"± 2"],[5,"± 5"]])}
     ${opt("reg","Register column in the client file",[["both","Beginning + Ending"],["client","Client Reading (from manifest)"]])}
     ${opt("pf","Pass/fail in the client file",[[true,"Show"],[false,"Hide"]])}
     ${opt("untested","Meters that couldn't be tested",[["list","List them as locked up"],["omit","Leave them out"]])}
    </div></div></div>
   <div class="panel"><div class="hd"><h2>Manifest files</h2><div class="row">${j.files.length?`<span class="note">${j.manifest.length.toLocaleString()} serials to check against</span>`:""}<label class="btn small ${j.approved?"":"primary"}" ${j.approved?'aria-disabled="true"':""}>Upload a manifest<input type="file" id="mf-up" accept=".xlsx,.xls,.csv" hidden ${j.approved?"disabled":""}></label></div></div>
    ${j.files.length?`<div class="tablewrap"><table class="list"><thead><tr><th>File</th><th class="num">Serials</th><th>Uploaded</th><th>Also used by</th><th></th></tr></thead><tbody>
     ${j.files.map((f,i)=>`<tr><td><b>${esc(f.name)}</b>${f.note?`<div class="note">${esc(f.note)}</div>`:""}</td><td class="num">${f.n?f.n.toLocaleString():"—"}</td><td>${esc(f.by)} · ${esc(dayLbl(f.at))}</td><td>${f.shared&&f.shared.length?esc(f.shared.join(", ")):'<span class="muted">—</span>'}</td>
       <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn small" data-act="b-mf-dl" data-i="${i}">Download</button>${j.approved?"":`<button class="btn small" data-act="b-mf-rm" data-i="${i}">Remove from job</button>`}</div></td></tr>`).join("")}
    </tbody></table></div>`:""}
    <div class="bd stack">
    ${j.files.length?`<p class="note" style="margin:0">The original files are kept in SharePoint with the customer, so they can be downloaded any time, even after the job is closed. This job checks serials against the files listed here. Leading zeros are ignored when matching (01106513 = 1106513).${j.manifest.length&&j.manifest[0].extra?" Extra columns such as address and location stay here for lookup and don't go in the client file.":""}</p>
      ${j.manifest.length?`<details><summary>${notYet.length} serials on the manifest not entered yet</summary><div class="sergrid">${notYet.slice(0,120).map(m=>`<span title="${esc(m.extra||"")}">${esc(m.ser)}</span>`).join("")}</div></details>`:""}`
    :`<p class="note" style="margin:0">No manifest for this job. Serials are typed in as meters go on the bench, and the app doesn't check them against a list.</p>`}
    ${(()=>{const saved=(custRec(j.client).manifests||[]).filter(f=>!j.files.some(x=>x.id===f.id));return saved.length&&!j.approved?`<div class="row"><span class="note">Use a manifest already saved for ${esc(j.client)}:</span>${saved.map(f=>`<button class="btn small" data-act="b-mf-add" data-id="${esc(f.id)}">${esc(f.name)} (${(f.n||0).toLocaleString()})</button>`).join("")}</div>`:""})()}
   </div></div></div>`;
}
function fileRows(){
  const j=J(),o=j.opts;const rows=allRows().filter(x=>x.c.done&&(o.untested==="list"||x.c.overall!=="nct"));
  return rows.map(({r,run,c})=>{const m=j.manifest.find(x=>normSer(x.ser)===normSer(r.ser));const nct=c.overall==="nct";
    // shown the way the Excel cells display: reads and volumes 0.000, accuracy and limits 0.0%, dates mm/dd/yy
    const d3=v=>num(v)==null?"":num(v).toFixed(3),p1=a=>a==null?"":(a*100).toFixed(1)+"%",dt=d=>d?d.slice(5,7)+"/"+d.slice(8,10)+"/"+d.slice(2,4):"";
    const reg=o.reg==="both"?[d3(r.arrive),nct?"":d3(r.e3)]:[m&&m.read!=null?String(m.read):""];
    const t=i=>[run.flow[i],p1(LIMITS[i][0]),p1(LIMITS[i][1]),d3(begOf(r,i)),d3(r["e"+(i+1)]),d3(run.vol[i]),p1(c.acc[i]),...(o.pf?[c.pass[i]==null?"":c.pass[i]?"Pass":"Fail"]:[])];
    return [r.ser,...(nct?["","",""]:c.acc.map(p1)),...(o.pf?[nct?"Not tested":c.overall==="pass"?"Pass":"Fail"]:[]),eff(r,run,"size"),eff(r,run,"make"),eff(r,run,"model"),run.unit,"GPM",dt(run.date),run.tech,...reg,
      ...(nct?[r.nct]:[...t(0),...t(1),...t(2)])]}).concat(o.untested==="list"?j.blocked.map(b=>{const run=j.runs.find(x=>x.no===b.run)||j.runs[0];const d3=v=>num(v)==null?"":num(v).toFixed(3);const m=j.manifest.find(x=>normSer(x.ser)===normSer(b.ser));
        return [b.ser,"","","",...(o.pf?["Not tested"]:[]),run.size,run.make,run.model,run.unit,"GPM",b.date?b.date.slice(5,7)+"/"+b.date.slice(8,10)+"/"+b.date.slice(2,4):"",b.tech||"",...(o.reg==="both"?[d3(b.arrive),""]:[m&&m.read!=null?String(m.read):""]),NCT]}):[]);
}
function viewFile(){
  const j=J(),o=j.opts;const tb=["Flow Rate","AWWA Low","AWWA High","Beg Read","End Read","Test Volume","Accuracy",...(o.pf?["Pass/Fail"]:[])];
  const head=["Serial #","High Flow","Med Flow","Low Flow",...(o.pf?["Pass/Fail"]:[]),"Size","Make","Model","Volume","Flow Rate","Test Date","Operator",...(o.reg==="both"?["Reg. Beginning","Reg. Ending"]:["Client Reading"]),...["High","Med","Low"].flatMap(t=>tb.map(h=>`${t}: ${h}`))];
  const rows=fileRows();
  return `<div class="stack">${jobHead()}
   <div class="panel"><div class="hd"><h2>Client file</h2><div class="row"><button class="btn primary" data-act="b-dl">Download Excel</button></div></div><div class="bd stack">
    <div class="note">The same layout as your Keystone, Woodland and GCWW sheets: data only, no check columns or manifest. Number formats match your sheets: reads and test volumes to 3 decimals (0.000), accuracy and AWWA limits as percents to 1 decimal (100.4%, stored as 1.004), dates as mm/dd/yy, and serials as text so leading zeros stay. Only finished meters are included. This preview follows the settings on the Batch job tab: register column <b>${o.reg==="both"?"Beginning + Ending":"Client Reading"}</b>, pass/fail <b>${o.pf?"shown":"hidden"}</b>, untested meters <b>${o.untested==="list"?"listed":"left out"}</b>.</div>
    <div class="row"><span class="note">Client Name: <b>${esc(j.client)}</b></span><span class="note">Job Name or #: <b>${esc(j.name)}</b></span><span class="note">${rows.length} rows</span></div>
   </div><div class="tablewrap"><table class="list filetbl"><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(r=>`<tr>${r.map(v=>`<td class="mono">${esc(v)}</td>`).join("")}</tr>`).join("")||`<tr><td colspan="${head.length}"><div class="note" style="padding:20px">Finish a bench run to see rows here.</div></td></tr>`}
   </tbody></table></div></div></div>`;
}
// MAM is closed 6 days a year. A holiday on a Saturday is taken the Friday before, on a Sunday the Monday after.
function nthWeekday(y,m,wd,n){const d=new Date(Date.UTC(y,m,1));const add=(wd-d.getUTCDay()+7)%7+(n-1)*7;d.setUTCDate(1+add);return d}
function lastWeekday(y,m,wd){const d=new Date(Date.UTC(y,m+1,0));d.setUTCDate(d.getUTCDate()-((d.getUTCDay()-wd+7)%7));return d}
function observed(d){const w=d.getUTCDay();if(w===6)d.setUTCDate(d.getUTCDate()-1);if(w===0)d.setUTCDate(d.getUTCDate()+1);return d}
const iso=d=>d.toISOString().slice(0,10);
const HOL_CACHE={};
function holidays(y){if(HOL_CACHE[y])return HOL_CACHE[y];const h={};const add=(d,n)=>{h[iso(d)]=n};
  add(observed(new Date(Date.UTC(y,0,1))),"New Year's Day");add(lastWeekday(y,4,1),"Memorial Day");add(observed(new Date(Date.UTC(y,6,4))),"Independence Day");
  add(nthWeekday(y,8,1,1),"Labor Day");add(nthWeekday(y,10,4,4),"Thanksgiving");add(observed(new Date(Date.UTC(y,11,25))),"Christmas");
  const ny=observed(new Date(Date.UTC(y+1,0,1)));if(ny.getUTCFullYear()===y)add(ny,"New Year's Day");
  return HOL_CACHE[y]=h}
const holidayName=ds=>holidays(+ds.slice(0,4))[ds]||null;
const addDay=ds=>{const d=new Date(ds+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);return iso(d)};
const isWeekend=ds=>{const w=new Date(ds+"T00:00:00Z").getUTCDay();return w===0||w===6};
const dayLbl=ds=>new Date(ds+"T12:00:00Z").toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"});
const longDay=ds=>new Date(ds+"T12:00:00Z").toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:"UTC"});

/* sizes on the schedule, smallest first. 5/8x5/8 and 5/8x3/4 share a bench run, so they plan together. */
const SGRP=[{k:"58",label:'5/8"',bench:'5/8 x 3/4"',perDay:8},{k:"34",label:'3/4"',bench:'3/4"',perDay:9},{k:"1",label:'1"',bench:'1"',perDay:10}];
const grpOf=size=>SIZES[size]?SIZES[size].grp:null;
function sizeRows(j){const sc=j.sched;
  return SGRP.map(g=>{const z=sc.sizes[g.k]||{};const fromManifest=g.k===sc.manifestSize&&j.manifest.length;
    const meters=z.meters!=null?z.meters:(fromManifest?j.manifest.length:0);
    return {...g,meters,fromManifest,overridden:z.meters!=null&&fromManifest,per:z.per||posFor(g.bench),perDay:z.perDay||g.perDay,
      batches:Math.ceil(meters/(z.per||posFor(g.bench)))||0}})}
/* Lay batches onto business days in size order. A day holds 1 full day of bench time:
   8 batches of 5/8, 9 of 3/4 or 10 of 1" (so a day can finish one size and start the next).
   A day you edited holds exactly the batches you entered. */
function layOut(j,sizes,startDay,leftBatches,leftMeters){
  const sc=j.sched;const rows=[];const closed=[];let d=startDay;const left={...leftBatches},mleft={...leftMeters};
  for(let guard=0;guard<1500&&SGRP.some(g=>left[g.k]>0);guard++,d=addDay(d)){
    if(isWeekend(d))continue;const h=holidayName(d);if(h){closed.push({date:d,name:h});continue}
    const manual=SGRP.some(g=>sc.edits[d+"|"+g.k]!=null);let room=1;
    for(const z of sizes){if(!(left[z.k]>0))continue;
      let n;if(manual){const e=sc.edits[d+"|"+z.k];if(e==null)continue;n=Math.min(e,left[z.k])}
      else{n=Math.min(left[z.k],Math.floor(room*z.perDay+1e-9));if(n<=0)break;room-=n/z.perDay}
      if(n<=0&&!manual)continue;
      const m=Math.min(n*z.per,mleft[z.k]);left[z.k]-=n;mleft[z.k]-=m;
      rows.push({date:d,k:z.k,label:z.label,batches:n,meters:m,edited:sc.edits[d+"|"+z.k]!=null});
      if(!manual&&room<1/z.perDay-1e-9&&left[z.k]>0)break;
    }
    if(manual&&!rows.some(r=>r.date===d))rows.push({date:d,k:null,label:"",batches:0,meters:0,edited:true,empty:true});
  }
  const last=rows.filter(r=>r.batches>0).slice(-1)[0];
  return {rows,closed,finish:last?last.date:null};
}
function actuals(j){const act={};
  j.runs.forEach(run=>{if(!run.date)return;run.rows.forEach(r=>{if(!r.ser.trim()||!calc(r,run).done)return;const k=grpOf(eff(r,run,"size"))||"58";const a=act[run.date+"|"+k]||(act[run.date+"|"+k]={b:0,m:0,runs:new Set()});a.m++;if(runDone(run))a.runs.add(run.no)})});
  j.blocked.forEach(b=>{if(!b.date)return;const run=j.runs.find(x=>x.no===b.run);const k=grpOf(run&&run.size)||"58";const a=act[b.date+"|"+k]||(act[b.date+"|"+k]={b:0,m:0,runs:new Set()});a.m++});
  Object.values(act).forEach(a=>a.b=a.runs.size);return act}
function schedInfo(j){
  const sc=j.sched,t=today();const sizes=sizeRows(j);
  const lb={},lm={};sizes.forEach(z=>{lb[z.k]=z.batches;lm[z.k]=z.meters});
  const plan=layOut(j,sizes,sc.start,lb,lm);
  const act=actuals(j);
  // likely finish: what's left after today's actuals, laid out from the next business day at the same pace
  const doneM={},doneB={};Object.entries(act).forEach(([key,a])=>{const k=key.split("|")[1];doneM[k]=(doneM[k]||0)+a.m});
  const rb={},rm={};sizes.forEach(z=>{rm[z.k]=Math.max(0,z.meters-(doneM[z.k]||0));rb[z.k]=Math.ceil(rm[z.k]/z.per)});
  const likely=sc.start>t?plan:layOut(j,sizes,addDay(t),rb,rm);
  const total=sizes.reduce((s,z)=>s+z.meters,0),batches=sizes.reduce((s,z)=>s+z.batches,0);
  const doneAll=Object.values(act).reduce((s,a)=>s+a.m,0);
  const days=[...new Set(plan.rows.map(r=>r.date))];
  // per-day rows, with actuals for any size worked that day
  const byDay=new Map();days.forEach(d=>byDay.set(d,[]));
  plan.rows.forEach(r=>byDay.get(r.date).push({...r}));
  Object.entries(act).forEach(([key,a])=>{const [d,k]=key.split("|");if(!byDay.has(d))return;const list=byDay.get(d);let r=list.find(x=>x.k===k);
    if(!r){const empty=list.find(x=>x.empty);if(empty){Object.assign(empty,{k,label:SGRP.find(g=>g.k===k).label,empty:false});r=empty}else{r={date:d,k,label:SGRP.find(g=>g.k===k).label,batches:0,meters:0,extra:true};list.push(r)}}
    r.ab=a.b;r.am=a.m});
  let cumP=0,cumA=0;const dayRows=days.map(d=>{const list=byDay.get(d);cumP+=list.reduce((s,r)=>s+r.meters,0);const past=d<=t;if(past)cumA+=list.reduce((s,r)=>s+(r.am||0),0);return {date:d,list,cumP,cumA:past?cumA:null}});
  const tod=dayRows.filter(x=>x.date<=t);const pToDate=tod.length?tod[tod.length-1].cumP:0,aToDate=tod.reduce((s,x)=>s+x.list.reduce((a,r)=>a+(r.am||0),0),0);
  return {sizes,total,batches,plan,likely,dayRows,closed:plan.closed,doneAll,pToDate,aToDate,days:days.length}
}
function viewSched(){
  const j=J(),sc=j.sched,x=schedInfo(j),t=today();const diff=x.aToDate-x.pToDate;
  const rows=[...x.dayRows.map(d=>({...d,kind:"day"})),...x.closed.map(c=>({...c,kind:"closed"}))].sort((a,b)=>a.date<b.date?-1:1);
  const manualNote=sc.manifestSize&&j.manifest.length?`The manifest has ${j.manifest.length.toLocaleString()} serials but no sizes, so they start under ${SGRP.find(g=>g.k===sc.manifestSize).label}. Type the count for each size to change it.`:j.manifest.length?"":`${esc(j.client)} has no manifest, so type the meters for each size.`;
  const body=rows.map(p=>{
    if(p.kind==="closed")return `<tr><td class="muted">${esc(dayLbl(p.date))}</td><td colspan="8" class="muted">Closed · ${esc(p.name)}</td></tr>`;
    const n=p.list.length,isT=p.date===t,past=p.date<=t,d=past?p.cumA-p.cumP:null;const bg=isT?' style="background:var(--accent-soft)"':"";
    return p.list.map((r,i)=>`<tr${bg}>${i===0?`<td rowspan="${n}" style="vertical-align:top">${esc(dayLbl(p.date))}${isT?' <span class="jstat ok">Today</span>':""}</td>`:""}
      <td>${esc(r.label)||'<span class="muted">—</span>'}</td>
      <td class="num">${r.k&&!r.extra?`<input id="sc-d-${p.date}-${r.k}" data-day="${p.date}|${r.k}" class="num ${r.edited?"hand":""}" inputmode="numeric" value="${r.batches}" style="width:70px;padding:4px 6px" aria-label="Planned ${esc(r.label)} batches ${esc(dayLbl(p.date))}">`:r.empty?`<button class="linkbtn" data-act="b-sc-clear" data-date="${p.date}">Undo day off</button>`:'<span class="muted">0</span>'}</td>
      <td class="num">${r.meters}</td>
      ${i===0?`<td class="num" rowspan="${n}" style="vertical-align:top">${p.cumP.toLocaleString()}</td>`:""}
      <td class="num">${past?(r.ab||0):""}</td><td class="num">${past?(r.am||0):""}</td>
      ${i===0?`<td class="num" rowspan="${n}" style="vertical-align:top">${past?p.cumA.toLocaleString():""}</td><td class="num" rowspan="${n}" style="vertical-align:top;color:${d==null?"inherit":d<0?"var(--fail)":"var(--pass)"};font-weight:600">${d==null?"":(d>0?"+":"")+d}</td>`:""}</tr>`).join("")}).join("");
  return `<div class="stack">${jobHead()}
   <div class="panel"><div class="hd"><h2>Job schedule</h2><button class="btn small" data-act="b-sc-reset" ${Object.keys(sc.edits).length?"":"disabled"}>Clear my changes</button></div><div class="bd stack">
    <div class="row" style="align-items:flex-end"><label class="f" style="max-width:200px">Start date<input id="sc-start" type="date" data-sc="start" value="${esc(sc.start)}"></label>
      <div class="note" style="flex:1;min-width:240px">Sizes are tested smallest to largest. A full day is 8 batches of 5/8", 9 of 3/4" or 10 of 1", so a day can finish one size and start the next. Business days skip weekends and the 6 days the shop is closed.</div></div>
    <div class="tablewrap"><table class="list" style="max-width:820px"><thead><tr><th>Meter size</th><th class="num">Meters in job</th><th class="num">Meters per batch</th><th class="num">Batches per day</th><th class="num">Batches needed</th><th class="num">Days of testing</th></tr></thead><tbody>
      ${x.sizes.map(z=>`<tr><td><b>${esc(z.label)}</b>${z.fromManifest&&!z.overridden?' <span class="note">from manifest</span>':""}</td>
        <td class="num"><input id="sc-m-${z.k}" data-scz="${z.k}|meters" class="num ${z.overridden?"hand":""}" inputmode="numeric" value="${z.meters||""}" placeholder="0" style="width:90px;padding:4px 6px" aria-label="${esc(z.label)} meters in job"></td>
        <td class="num"><input id="sc-p-${z.k}" data-scz="${z.k}|per" class="num" inputmode="numeric" value="${z.per}" style="width:70px;padding:4px 6px" aria-label="${esc(z.label)} meters per batch"></td>
        <td class="num"><input id="sc-r-${z.k}" data-scz="${z.k}|perDay" class="num" inputmode="numeric" value="${z.perDay}" style="width:70px;padding:4px 6px" aria-label="${esc(z.label)} batches per day"></td>
        <td class="num">${z.batches}</td><td class="num">${z.batches?(z.batches/z.perDay).toFixed(1):""}</td></tr>`).join("")}
      <tr><td><b>Total</b></td><td class="num"><b>${x.total.toLocaleString()}</b></td><td></td><td></td><td class="num"><b>${x.batches}</b></td><td class="num"><b>${x.sizes.reduce((s,z)=>s+(z.batches?z.batches/z.perDay:0),0).toFixed(1)}</b></td></tr>
    </tbody></table></div>
    ${manualNote?`<div class="note">${manualNote}${x.sizes.some(z=>z.overridden)?` <button class="linkbtn" data-act="b-sc-manifest">Use the manifest count</button>`:""}</div>`:""}
    <div class="stats">
      <div class="stat"><b>${x.plan.finish?esc(dayLbl(x.plan.finish)):"—"}</b><span>Planned finish</span><div class="note" style="margin-top:4px">${x.days} business days</div></div>
      <div class="stat ${x.likely.finish&&x.plan.finish&&x.likely.finish>x.plan.finish?"fail":""}"><b>${x.likely.finish?esc(dayLbl(x.likely.finish)):"—"}</b><span>Likely finish</span><div class="note" style="margin-top:4px">${x.likely.finish&&x.plan.finish&&x.likely.finish!==x.plan.finish?"If the rest goes as planned from tomorrow":"On plan"}</div></div>
      <div class="stat"><b>${x.doneAll.toLocaleString()}</b><span>Meters done</span><div class="note" style="margin-top:4px">of ${x.total.toLocaleString()}</div></div>
      <div class="stat ${diff<0?"fail":"pass"}"><b>${diff>0?"+":""}${diff.toLocaleString()}</b><span>${diff<0?"Behind":"Ahead"} today</span><div class="note" style="margin-top:4px">Planned to date ${x.pToDate.toLocaleString()} meters</div></div>
    </div>
    <div class="note">Change any day's planned batches to plan around other work or a longer day. Later days move to fit, and the planned finish updates. To take a day off batch testing, set its batches to 0.</div>
   </div>
   <div class="tablewrap"><table class="list"><thead><tr><th>Day</th><th>Meter size</th><th class="num">Planned batches</th><th class="num">Planned meters</th><th class="num">Planned to date</th><th class="num">Actual batches</th><th class="num">Actual meters</th><th class="num">Actual to date</th><th class="num">Ahead / behind</th></tr></thead><tbody>
    ${body||`<tr><td colspan="9"><div class="note" style="padding:16px">Enter a start date and the meters for at least one size.</div></td></tr>`}
   </tbody></table></div>
   <div class="bd note">Actuals fill in as bench runs are finished: a meter counts on its run's test date, including meters marked could not test. Days you changed are highlighted.</div></div></div>`;
}

/* ---------- Jobs & meters list (one-off and batch jobs together) ---------- */
// The three example batch jobs are live; the rest are sample rows that show how the list reads.
function jobTabs(){const r=B.tab;return `<nav class="subtabs" aria-label="Batch job screens">${[["job","Batch job"],["run","Bench run"],["file","Client file"],["sched","Job schedule"]].map(([h,t])=>`<a href="#batch-${B.oid}.${h}" class="${r===h?"on":""}">${t}</a>`).join("")}</nav>`}

/* ---------- photos (kept with the job in SharePoint) ---------- */
const photoCodes=row=>{const j=J();const out=[];const st=serialStatus(row,j);if(st&&st[2]==="manifest")out.push("Serial not on the manifest");const rc=readCheck(row,j);if(rc&&rc[2]==="read")out.push("Arrival read doesn't match the client read");return out};
const photosOf=(row,j)=>j.photos.filter(ph=>ph.ser&&normSer(ph.ser)===normSer(row.ser)&&ph.wo===row.wo);
const phImg=(ph,cls)=>`<img data-bph="${esc(ph.id)}" alt="Photo of ${esc(ph.ser)}" class="${cls||"thumb"}" src="${esc(B.photoUrls[ph.id]||"")}">`;
function photoCell(row,ri,pi,lock){const j=J();const need=photoCodes(row),have=photosOf(row,j);if(!need.length&&!have.length)return "";
  const k=`${ri}|${pi}`;
  return `<div class="photorow">${have.map(ph=>phImg(ph)).join("")}
    ${lock?"":`<button type="button" class="btn small ${have.length?"":"warnbtn"}" data-act="b-photo-qr" data-k="${k}">${have.length?"Add photo":"Take photo"}</button>`}</div>
    ${!lock&&B.qrFor===k?`<div class="callout info" style="margin-top:6px"><div class="row" style="align-items:flex-start;gap:14px">
      <div class="bqr" data-url="${esc(location.origin+location.pathname+"#bphone-"+B.oid)}" style="background:#fff;padding:6px;border-radius:6px;min-width:120px;min-height:120px"></div>
      <div class="stack" style="gap:6px;max-width:46ch"><b>Scan with your phone's camera</b><span>Your phone opens this job's photo page, which lists every meter that needs a photo, including <b>${esc(row.ser)}</b>. Take the photo there and it appears here within a few seconds. Keep that page open on the phone for the rest of the job.</span>
        <div class="row" style="gap:8px;flex-wrap:wrap"><label class="btn small">Choose a file on this computer<input type="file" accept="image/*" hidden data-bphoto="${k}"></label><button type="button" class="btn small" data-act="b-photo-close">Close</button></div>
        <span class="note">The phone needs to be signed in to the app once with a company Microsoft account.</span></div></div></div>`:""}
    ${have.length?`<span class="flag ok">Photo saved to the job</span>`:`<span class="flag warn">Take a photo of the ${need.some(n=>/Serial/.test(n))?"serial plate":"register"} so the office can check it</span>`}`}
async function addPhoto(file,row,run,pi){const j=J();const id="ph"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const path=`batch/${B.oid}/photos/WO${safe(row.wo)}_${safe(row.ser)}_${id}.jpg`;
  const blob=typeof shrink==="function"?await shrink(file):file;const it=await Store.putFile(path,blob);
  const ph={id:it.id||id,path,ser:row.ser,wo:row.wo,run:run.no,pos:pi+1,reason:photoCodes(row).join("; ")||"Photo",by:ME(),at:new Date().toISOString()};
  try{B.photoUrls[ph.id]=URL.createObjectURL(blob)}catch(e){}
  await saveJob(d=>{d.photos=d.photos||[];d.photos.push(ph)});return ph}
function fillPhotoUrls(){document.querySelectorAll("img[data-bph]").forEach(async img=>{const id=img.dataset.bph;if(B.photoUrls[id]){img.src=B.photoUrls[id];return}
  try{const u=await Store.fileUrl(id);B.photoUrls[id]=u;img.src=u}catch(e){}})}

/* ---------- manifest upload: pick the columns, then the serials are read in ---------- */
function mfPicker(){const m=B.mf;if(!m)return "";const opts=(sel,none)=>`${none?`<option value="-1">${none}</option>`:""}${m.head.map((h,i)=>`<option value="${i}" ${sel===i?"selected":""}>${esc(h||"Column "+(i+1))}</option>`).join("")}`;
  const sample=m.rows.slice(m.h+1,m.h+6);
  return `<div class="panel" style="border-color:var(--accent)"><div class="hd"><h2>New manifest: ${esc(m.file.name)}</h2><span class="note">${(m.rows.length-m.h-1).toLocaleString()} rows</span></div><div class="bd stack">
    <div class="grid g3"><label class="f">Serial number column<select data-mfc="ser">${opts(m.cols.ser)}</select></label><label class="f">Client read column<select data-mfc="read">${opts(m.cols.read,"None")}</select></label><label class="f">Meter size column<select data-mfc="size">${opts(m.cols.size,"None")}</select></label></div>
    <div class="tablewrap"><table class="list"><thead><tr>${m.head.map((h,i)=>`<th class="${i===m.cols.ser||i===m.cols.read||i===m.cols.size?"":"muted"}">${esc(h||"")}</th>`).join("")}</tr></thead><tbody>${sample.map(r=>`<tr>${m.head.map((h,i)=>`<td class="mono">${esc(r[i]==null?"":r[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="note">The app keeps the original file with ${esc(J().client)}, reads the serials (and reads and sizes, if chosen), and remembers these columns for ${esc(J().client)}'s next manifest. Other columns stay in the original file for lookup.</div>
    <div class="row"><button class="btn primary" data-act="b-mf-save">Save manifest and use it for this job</button><button class="btn" data-act="b-mf-cancel">Cancel</button></div></div></div>`}
async function mfRead(file){if(!window.XLSX)throw new Error("The Excel tool didn't load. Reload the page and try again.");
  const wb=XLSX.read(await file.arrayBuffer(),{type:"array"});const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
  let h=rows.findIndex(r=>(r||[]).some(c=>/serial/i.test(String(c))));if(h<0)h=0;const head=(rows[h]||[]).map(c=>String(c||"").trim());
  const saved=(custRec(J().client).cols)||{};const find=(re,ex)=>{const i=head.findIndex(x=>re.test(x)&&!(ex&&ex.test(x)));return i};
  const col=(k,re,ex)=>saved[k]!=null&&head[saved[k]]!=null&&saved.names&&saved.names[k]===head[saved[k]]?saved[k]:find(re,ex);
  B.mf={file,rows,h,head,cols:{ser:Math.max(0,col("ser",/serial/i)),read:col("read",/read|last|index|register/i,/date/i),size:col("size",/size/i)}}}
async function mfSave(btn){const m=B.mf,j=J();if(!m)return;btn.disabled=true;btn.textContent="Saving…";
  try{const c=m.cols;const out=[];const seen=new Set();
    m.rows.slice(m.h+1).forEach(r=>{const ser=String(r[c.ser]==null?"":r[c.ser]).trim();if(!ser||seen.has(normSer(ser)))return;seen.add(normSer(ser));
      out.push({ser,read:c.read>=0?num(r[c.read]):null,size:c.size>=0?String(r[c.size]||"").trim():""})});
    if(!out.length)throw new Error("No serial numbers found in that column.");
    const id="m"+Date.now().toString(36);const dir=`customers/${safe(j.client)}/manifests`;
    await Store.putFile(`${dir}/${id}-${safe(m.file.name)}`,m.file);
    await Store.putJsonIf(`${dir}/${id}.json`,{name:m.file.name,cols:c,rows:out},null);
    const meta={id,name:m.file.name,orig:`${dir}/${id}-${safe(m.file.name)}`,n:out.length,by:ME(),at:today(),reads:c.read>=0,sizes:c.size>=0};
    const cr=custRec(j.client);cr.cols={...c,names:{ser:m.head[c.ser],read:m.head[c.read],size:m.head[c.size]}};cr.manifests=[...(cr.manifests||[]),meta];
    await putConfig("batchCust",{cust:S.batchCust});
    await saveJob(d=>{d.manifests=d.manifests||[];d.manifests.push(meta)});B.mf=null;await loadManifests();
    toast(`${out.length.toLocaleString()} serials read from ${m.file.name}. Saved with ${j.client}.`)}
  catch(e){toast("Couldn't save the manifest: "+e.message);btn.disabled=false;btn.textContent="Save manifest and use it for this job"}
  render()}

/* ---------- client file download (Excel, formats like the clients' sheets) ---------- */
function downloadFile(){const j=J(),o=j.opts;if(!window.XLSX){toast("The Excel tool didn't load. Reload and try again.");return}
  const tb=["Flow Rate","AWWA Low","AWWA High","Beg Read","End Read","Test Volume","Accuracy",...(o.pf?["Pass/Fail"]:[])];
  const head=["Serial #","High Flow","Med Flow","Low Flow",...(o.pf?["Pass/Fail"]:[]),"Size","Make","Model","Volume","Flow Rate","Test Date","Operator",...(o.reg==="both"?["Reg. Beginning","Reg. Ending"]:["Client Reading"]),...["High","Med","Low"].flatMap(t=>tb.map(h=>`${t}: ${h}`))];
  const rows=fileRows();const aoa=[["Client Name:",j.client],["Job Name or #:",j.name],[],head,...rows];const ws=XLSX.utils.aoa_to_sheet(aoa);
  for(let r=4;r<aoa.length;r++)aoa[r].forEach((v,c)=>{const ref=XLSX.utils.encode_cell({r,c});const cell=ws[ref];if(!cell||c===0||typeof v!=="string")return;
    let m=v.match(/^(-?\d+(?:\.\d+)?)%$/);if(m){cell.t="n";cell.v=+(+m[1]/100).toFixed(4);cell.z="0.0%";return}
    m=v.match(/^-?\d+\.\d{3}$/);if(m){cell.t="n";cell.v=+v;cell.z="0.000";return}
    if(/^-?\d+(\.\d+)?$/.test(v)&&!/Operator|Date/.test(head[c])){cell.t="n";cell.v=+v}});
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Results");
  XLSX.writeFile(wb,`${safe(j.client)} ${safe(j.name)} results.xlsx`)}

/* ---------- screens ---------- */
function view(oid,tab,runNo){
  if(B.oid!==oid||B.state==="idle"){if(B.dirty.size)flush();load(oid);return `<div class="empty">Loading the batch job…</div>`}
  if(B.state==="loading")return `<div class="empty">Loading the batch job…</div>`;
  if(B.state==="error")return `<div class="empty">Couldn't load this batch job: ${esc(B.err)} <button class="btn small" data-act="b-reload">Try again</button></div>`;
  B.tab=tab||"job";const j=J();
  if(runNo){const i=j.runs.findIndex(r=>r.no===+runNo);if(i>=0)j.cur=i}
  const html=B.tab==="run"?viewRun():B.tab==="file"?viewFile():B.tab==="sched"?viewSched():viewJob();
  setTimeout(()=>{document.querySelectorAll(".bqr").forEach(el=>{if(el.childNodes.length)return;if(window.QRCode)new QRCode(el,{text:el.dataset.url,width:120,height:120,correctLevel:QRCode.CorrectLevel.M});else el.textContent=el.dataset.url});fillPhotoUrls()},0);
  return `<div class="batchv">${html}</div>`}
const render=()=>window.render();
/* phone page (opened from the QR code): every meter in the job that still needs a photo, newest run first */
function phoneView(oid){
  if(B.oid!==oid||B.state==="idle"){load(oid);return `<div class="empty">Loading…</div>`}
  if(B.state!=="ready")return B.state==="error"?`<div class="empty">Couldn't load: ${esc(B.err)}</div>`:`<div class="empty">Loading…</div>`;
  const j=J();const need=[];j.runs.forEach((run,ri)=>run.rows.forEach((row,pi)=>{if(row.ser.trim()&&photoCodes(row).length&&!photosOf(row,j).length)need.push({run,ri,row,pi})}));need.reverse();
  const done=j.photos.slice(-6).reverse();
  setTimeout(fillPhotoUrls,0);
  return `<div class="batchv stack"><h1 style="font-size:22px">${esc(j.client)} · ${esc(j.name)}</h1><div class="note">Photos for meters that don't match the manifest. This page updates by itself; keep it open while you work.</div>
    ${need.length?need.map(x=>`<div class="panel"><div class="bd stack" style="gap:8px"><div><b class="mono" style="font-size:20px">${esc(x.row.ser)}</b> <span class="note">Run ${x.run.no}, position ${x.pi+1} · WO ${esc(x.row.wo)}</span></div>
      <div class="flag warn" style="max-width:none">${esc(photoCodes(x.row).join("; "))}: photograph the ${photoCodes(x.row).some(n=>/Serial/.test(n))?"serial plate":"register"}</div>
      <label class="btn primary" style="justify-content:center;padding:14px">Take photo<input type="file" accept="image/*" capture="environment" hidden data-bphoto="${x.ri}|${x.pi}"></label></div></div>`).join("")
      :`<div class="panel"><div class="bd"><b>Nothing needs a photo right now.</b><div class="note">When a serial isn't on the manifest or a read doesn't match, the meter shows up here.</div></div></div>`}
    ${done.length?`<div class="panel"><div class="hd"><h2>Latest photos</h2></div><div class="bd"><div class="photogrid">${done.map(ph=>`<figure>${phImg(ph,"")}<figcaption><b class="mono">${esc(ph.ser)}</b> · ${esc(fmtD(ph.at))}</figcaption></figure>`).join("")}</div></div></div>`:""}</div>`}
/* keep the job's photos and runs fresh while a phone may be adding photos */
setInterval(async()=>{const r=typeof route==="function"?route():{};if(!B.view||B.state!=="ready")return;
  const phone=r.v==="bphone";if(!phone&&!B.qrFor)return;if(document.hidden||B.dirty.size||userBusy())return;
  try{const {data}=await Store.getJson(jobPath());if(!data)return;const before=(B.job.photos||[]).length;
    if(phone){const blocks=await Promise.all(Array.from({length:data.blocks||0},(_,i)=>Store.getJson(blockPath(i+1))));const runs=blocks.flatMap(b=>(b.data&&b.data.runs)||[]).sort((a,b)=>a.no-b.no);if(runs.length)B.view.runs=runs}
    bindJob(data);if(phone||(data.photos||[]).length!==before)softRender()}catch(e){}},6000);
const inBatch=t=>t&&t.closest&&t.closest(".batchv");

/* ---------- events (only inside the batch screens) ---------- */
document.addEventListener("focusin",e=>{const t=e.target;if(inBatch(t)&&t.dataset&&t.dataset.r!==undefined)t.dataset.old=t.value},true);
document.addEventListener("input",e=>{const t=e.target;if(!inBatch(t)||!B.view)return;const run=R();if(!run)return;
  if(t.dataset.r!==undefined&&t.dataset.k){e.stopPropagation();const row=run.rows[+t.dataset.r];row[t.dataset.k]=t.value;if(t.dataset.k==="ser"){if(t.value.trim())ensureWo(run,row);}touchRun(run);return}
  if(t.dataset.vol!==undefined){e.stopPropagation();run.vol[+t.dataset.vol]=t.value;touchRun(run);return}
  if(t.dataset.flow!==undefined){e.stopPropagation();run.flow[+t.dataset.flow]=t.value;touchRun(run);return}
  if(t.dataset.rs&&t.tagName==="INPUT"&&t.type!=="date"){e.stopPropagation();run[t.dataset.rs]=t.value;touchRun(run);return}
},true);
document.addEventListener("change",async e=>{const t=e.target;if(!inBatch(t)||!B.view)return;e.stopPropagation();const j=J(),run=R();
  if(t.dataset.bphoto){const f=t.files[0];t.value="";if(!f)return;const [ri,pi]=t.dataset.bphoto.split("|").map(Number);const rn=j.runs[ri],row=rn.rows[pi];
    toast("Saving the photo…");try{await addPhoto(f,row,rn,pi);B.qrFor="";toast(`Photo saved to the job for ${row.ser}.`)}catch(err){toast("Couldn't save the photo: "+err.message)}render();return}
  if(t.id==="mf-up"){const f=t.files[0];t.value="";if(!f)return;try{await mfRead(f)}catch(err){toast("Couldn't read that file: "+err.message)}render();window.scrollTo(0,0);return}
  if(t.dataset.mfc){B.mf.cols[t.dataset.mfc]=+t.value;render();return}
  if(t.dataset.sc){j.sched[t.dataset.sc]=t.value;render();saveSched();return}
  if(t.dataset.scz){const [k,f]=t.dataset.scz.split("|");const z=j.sched.sizes[k]||(j.sched.sizes[k]={});const v=t.value.trim()===""?null:Math.max(f==="meters"?0:1,Math.round(num(t.value)||0));
    z[f]=(f==="meters"&&v==null&&j.sched.manifestSize!==k)?0:v;render();saveSched();return}
  if(t.dataset.day){const v=num(t.value);if(v==null||v<0){render();return}j.sched.edits[t.dataset.day]=Math.round(v);render();saveSched();return}
  if(t.dataset.r!==undefined){const row=run.rows[+t.dataset.r];if(t.tagName==="SELECT")row[t.dataset.k]=t.value;
    if(run.wasDone&&t.dataset.old!==undefined&&t.dataset.old!==t.value){run.log=run.log||[];run.log.push({at:new Date().toISOString(),by:ME(),what:`Position ${+t.dataset.r+1}, ${LBL[t.dataset.k]||t.dataset.k}: ${t.dataset.old||"(blank)"} → ${t.value||"(blank)"}`});t.dataset.old=t.value}
    touchRun(run);later();return}
  if(t.dataset.vol!==undefined||t.dataset.flow!==undefined){later();return}
  if(t.id==="rs-bench"){S.settings.batch={...(S.settings.batch||{}),bench:+t.value};putConfig("settings",S.settings).catch(()=>{});resize(run);touchRun(run);render();return}
  if(t.dataset.rs){run[t.dataset.rs]=t.value;if(t.dataset.rs==="size"&&t.value){if(run.flow.every(f=>f===""))run.flow=[...SIZES[t.value].flow];resize(run)}touchRun(run);later();return}
  if(t.dataset.op){const v=t.value;j.opts[t.dataset.op]=v==="true"?true:v==="false"?false:isNaN(+v)?v:+v;const cr=custRec(j.client);cr.opts={...cr.opts,[t.dataset.op]:j.opts[t.dataset.op]};
    try{await putConfig("batchCust",{cust:S.batchCust});toast("Saved for "+j.client)}catch(err){toast("Couldn't save: "+err.message)}render();return}
},true);
/* redraw after the browser has moved focus to the next box (a change event fires while focus is leaving), so typing carries on in the right box */
let laterT=null;function later(){clearTimeout(laterT);laterT=setTimeout(()=>render(),0)}
let schedTimer=null;function saveSched(){clearTimeout(schedTimer);schedTimer=setTimeout(()=>{const s=JSON.parse(JSON.stringify(J().sched));saveJob(d=>{d.sched=s}).catch(e=>toast("Couldn't save the schedule: "+e.message))},800)}
function resize(run){const n=posFor(run.size);while(run.rows.length<n)run.rows.push(emptyRow());
  if(run.rows.length>n){if(run.rows.slice(n).some(r=>r.ser))toast(`Positions ${n+1} and up still have meters. Clear them first.`);else run.rows.length=n}}
document.addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;const t=e.target;if(!inBatch(t)||!t.closest("table.bench")||!/INPUT|SELECT/.test(t.tagName))return;e.preventDefault();e.stopPropagation();
  const f=[...document.querySelectorAll("table.bench input:not([tabindex='-1']):not(:disabled), table.bench select:not(:disabled)")];const n=f[f.indexOf(t)+1];if(n){n.focus();if(n.select)n.select()}else t.blur();
},true);
function markSaved(run){run.saved=true;if(runDone(run))run.wasDone=true;touchRun(run)}
const goRun=i=>{B.view.cur=i;const no=B.view.runs[i].no;if(location.hash==="#batch-"+B.oid+".run")render();else location.hash="batch-"+B.oid+".run"};
document.addEventListener("click",async e=>{const a=e.target.closest("[data-act]");if(!a||!a.dataset.act.startsWith("b-")||!B.view)return;e.preventDefault();e.stopPropagation();
  const j=J(),run=R(),act=a.dataset.act.slice(2);
  if(act==="reload"){B.state="idle";render();return}
  if(act==="photo-qr"){B.qrFor=B.qrFor===a.dataset.k?"":a.dataset.k;render();return}
  if(act==="photo-close"){B.qrFor="";render();return}
  if(j.approved&&!["go-run","approve","mf-dl","dl","sc-reset","sc-manifest","sc-clear","mf-cancel"].includes(act)){toast("The job is approved, so it's locked. Undo the approval to change it.");return}
  if(act==="nct"){run.rows[+a.dataset.r].nct=NCT;touchRun(run);render();return}
  if(act==="blocked"){const i=+a.dataset.r,row=run.rows[i];if(!row.ser.trim()){toast("Enter the serial first.");return}
    const b={ser:row.ser,wo:row.wo,arrive:row.arrive,run:run.no,pos:i+1,date:run.date||today(),tech:run.tech,by:ME()};
    const nr=emptyRow();["size","make","model"].forEach(k=>nr[k]=row[k]);run.rows[i]=nr;j.blocked.push(b);touchRun(run);render();
    toast(`${row.ser} moved to Locked-up meters. Enter the replacement meter in position ${i+1}.`);const f=document.getElementById(`r${i}-ser`);if(f)f.focus();
    try{await flush();await saveJob(d=>{d.blocked=d.blocked||[];if(!d.blocked.some(x=>normSer(x.ser)===normSer(b.ser)))d.blocked.push(b)})}catch(err){toast("Couldn't save: "+err.message)}return}
  if(act==="bl-rm"){if(!confirmClick(a,"Click again to remove"))return;const b=j.blocked[+a.dataset.i];
    try{await saveJob(d=>{d.blocked=(d.blocked||[]).filter(x=>normSer(x.ser)!==normSer(b.ser))});toast(`${b.ser} removed from Locked-up meters.`)}catch(err){toast("Couldn't save: "+err.message)}render();return}
  if(act==="bl-add"){const ser=($("#bl-ser").value||"").trim(),arr=($("#bl-arr").value||"").trim();if(!ser){toast("Enter the serial.");$("#bl-ser").focus();return}
    const dup=serialStatus({ser,wo:"",arrive:""},j);if(dup&&dup[2]==="dup"){toast(`${ser} is already in this job.`);return}
    a.disabled=true;try{const [wo]=await reserveWos(1);const b={ser,wo,arrive:arr,run:null,pos:null,date:today(),tech:ME(),by:ME()};
      await saveJob(d=>{d.blocked=d.blocked||[];d.blocked.push(b)});toast(`${ser} added as locked up (WO ${wo}).`)}catch(err){toast("Couldn't save: "+err.message)}render();return}
  if(act==="nct-undo"){run.rows[+a.dataset.r].nct="";touchRun(run);render();return}
  if(act==="toggle-beg"){run.showBeg=!run.showBeg;touchRun(run);render();return}
  if(act==="toggle-mixed"){run.mixed=!run.mixed;touchRun(run);render();return}
  if(act==="go-run"){const i=+a.dataset.i;if(!j.runs[i])return;if(run)markSaved(run);flush();goRun(i);window.scrollTo(0,0);const fid=a.dataset.focus;if(fid)setTimeout(()=>{const f=document.getElementById(fid);if(f)f.focus()},50);return}
  if(act==="save"){markSaved(run);await flush();toast(`Run ${run.no} saved${runDone(run)?"":". It isn't finished yet"}.`);location.hash="batch-"+B.oid+".job";return}
  if(act==="save-next"){
    if(!run.rows.some(r=>r.ser.trim())){toast("Enter at least one serial first.");return}
    markSaved(run);
    if(j.runs[j.cur+1]){flush();j.cur++;render();window.scrollTo(0,0);toast(`Run ${run.no} saved.`);return}
    const behind=j.runs.slice(0,j.cur).filter(r=>!runDone(r));
    if(behind.length){toast(`Finish run ${behind[0].no} first (${runMissing(behind[0]).join(", ")}). You can work one run ahead, no further.`);return}
    if(!run.size){toast("Choose the size first, so the next run gets the right number of positions.");$("#rs-size").focus();return}
    const nx=nextRunFrom(run,j.runs[j.runs.length-1].no+1);j.runs.push(nx);j.cur=j.runs.length-1;touchRun(nx);flush();render();window.scrollTo(0,0);
    toast(runDone(run)?`Run ${run.no} saved. Enter the serials for run ${nx.no}; volumes start blank.`:`Run ${run.no} saved, not finished yet. Line up run ${nx.no}, then go back with ‹ Run ${run.no} to finish it.`);
    const f=$("#r0-ser");if(f)f.focus();return}
  if(act==="ok"||act==="unok"){const rn=j.runs[+a.dataset.ri],row=rn.rows[+a.dataset.pi];row.ok=row.ok||{};
    if(act==="ok"){row.ok[a.dataset.code]={by:ME(),at:new Date().toISOString()};toast("Marked checked. It's off the Need a look list.")}else{delete row.ok[a.dataset.code];toast("Back on the Need a look list.")}touchRun(rn);render();return}
  if(act==="approve"){
    if(!j.approved){const open=j.runs.filter(r=>!runDone(r)&&r.rows.some(x=>x.ser));if(open.length){toast(`Finish run${open.length>1?"s":""} ${open.map(r=>r.no).join(" and ")} before approving.`);return}
      const n=allRows().filter(x=>rowWarnings(x.r,x.run,j).length).length;if(n){toast(`${n} meter${n>1?"s":""} still need${n>1?"":"s"} a look. Fix ${n>1?"them":"it"} or mark ${n>1?"them":"it"} checked before approving.`);return}}
    await flush();const to=!j.approved;
    try{await saveJob(d=>{d.approved=to;d.approvedBy=to?ME():"";d.approvedAt=to?Date.now():0});toast(to?"Job approved. Runs are locked.":"Approval removed. Runs can be changed again.");
      const o=S.orders.get(B.oid);if(o&&to&&o.status!=="Approved by manager"&&o.status!=="Ready to ship"&&o.status!=="Complete"){await put("orders",o.id,{...o,status:"Approved by manager",statusLog:[...(o.statusLog||[]),{status:"Approved by manager",at:Date.now(),by:ME()}]})}}catch(err){toast("Couldn't save: "+err.message)}render();return}
  if(act==="sc-reset"){j.sched.edits={};render();saveSched();toast("Your changes are cleared. The plan is back to full days.");return}
  if(act==="sc-manifest"){const z=j.sched.sizes[j.sched.manifestSize];if(z)z.meters=null;render();saveSched();return}
  if(act==="sc-clear"){Object.keys(j.sched.edits).forEach(k=>{if(k.startsWith(a.dataset.date+"|"))delete j.sched.edits[k]});render();saveSched();return}
  if(act==="mf-cancel"){B.mf=null;render();return}
  if(act==="mf-save"){await mfSave(a);return}
  if(act==="mf-dl"){const f=j.files[+a.dataset.i];try{const r=await Store.getFile(f.orig);offer(f.name,await r.blob())}catch(err){toast("Couldn't download: "+err.message)}return}
  if(act==="mf-rm"){if(!confirmClick(a,"Click again to remove"))return;const f=j.files[+a.dataset.i];
    try{await saveJob(d=>{d.manifests=(d.manifests||[]).filter(x=>x.id!==f.id)});await loadManifests();toast(`${f.name} is no longer used by this job. It's still saved with ${j.client}.`)}catch(err){toast("Couldn't save: "+err.message)}render();return}
  if(act==="mf-add"){const f=(custRec(j.client).manifests||[]).find(x=>x.id===a.dataset.id);if(!f)return;
    try{await saveJob(d=>{d.manifests=d.manifests||[];if(!d.manifests.some(x=>x.id===f.id))d.manifests.push(f)});await loadManifests();toast(`${f.name} added. Its serials are now checked for this job.`)}catch(err){toast("Couldn't save: "+err.message)}render();return}
  if(act==="dl"){downloadFile();return}
},true);
window.addEventListener("hashchange",()=>{if(B.dirty.size)flush()});
window.addEventListener("beforeunload",e=>{if(B.dirty.size||B.saving){flush();e.preventDefault();e.returnValue=""}});
window.BATCH={view,phoneView,flush,get state(){return B},SIZES,blankRun,today};
})();
if(location.hash.startsWith("#batch-")&&typeof window.render==="function")setTimeout(()=>{try{window.render()}catch(e){}},0);
