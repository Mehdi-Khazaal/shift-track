// ══════════════════════════════
//  CONFIG
// ══════════════════════════════
const API = 'https://shift-track.duckdns.org';
let PP_ANCHOR = '2026-03-22'; // overwritten after login from /api/settings
const OT_THRESH = 40;

// ══════════════════════════════
//  AUTH
// ══════════════════════════════
function getToken(){ return localStorage.getItem('st_admin_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('st_admin_user')||'null'); }catch(e){ return null; } }
function setAuth(t,u){ localStorage.setItem('st_admin_token',t); localStorage.setItem('st_admin_user',JSON.stringify(u)); }
function clearAuth(){ localStorage.removeItem('st_admin_token'); localStorage.removeItem('st_admin_user'); }

async function apiFetch(path,opts={}){
  const token=getToken();
  const res=await fetch(API+path,{
    ...opts,
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(opts.headers||{})},
    body:opts.body?JSON.stringify(opts.body):undefined
  });
  const data=await res.json();
  if(res.status===401||res.status===403){ doLogout(); return null; }
  return data;
}

async function doLogin(){
  const email=document.getElementById('l-email').value.trim();
  const pass=document.getElementById('l-pass').value;
  const errEl=document.getElementById('login-err');
  const btn=document.getElementById('l-btn');
  if(!email||!pass){ errEl.textContent='Enter email and password'; errEl.style.display='block'; return; }
  btn.textContent='Signing in…'; btn.disabled=true; errEl.style.display='none';
  try{
    const data=await apiFetch('/api/auth/login',{method:'POST',body:{email,password:pass}});
    if(!data?.ok){ errEl.textContent=data?.error||'Invalid credentials'; errEl.style.display='block'; btn.textContent='Sign in as Admin'; btn.disabled=false; return; }
    if(data.user.role!=='admin'){ errEl.textContent='This account does not have admin access.'; errEl.style.display='block'; btn.textContent='Sign in as Admin'; btn.disabled=false; return; }
    setAuth(data.token,data.user);
    enterApp(data.user);
  }catch(e){
    errEl.textContent='Could not connect. Try again.'; errEl.style.display='block'; btn.textContent='Sign in as Admin'; btn.disabled=false;
  }
}

document.addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });

function doLogout(){
  clearAuth();
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('l-btn').textContent='Sign in as Admin';
  document.getElementById('l-btn').disabled=false;
}

function enterApp(user){
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.add('visible');
  document.getElementById('top-user').textContent=user.email;
  loadAll();
}

// Boot
(function(){
  const t=getToken(),u=getUser();
  if(t&&u&&u.role==='admin') enterApp(u);
})();

// ══════════════════════════════
//  TABS
// ══════════════════════════════
function switchTab(name,el){
  if(name === 'notify'){
    const overviewTab = document.querySelector('[onclick*="overview"]');
    switchTab('overview', overviewTab);
    document.getElementById('overview-notify-card')?.scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('panel-'+name).classList.add('active');
  updateTabIndicator();
  if(name==='staffing')    renderStaffing();
  if(name==='openshifts')  { populateOsForm(); loadOpenShifts(); }
  if(name==='swaps')       loadAdminSwaps();
}

// ══════════════════════════════
//  DATA
// ══════════════════════════════
let allUsers=[], allShifts={}, allSchedules={}, allLocs=[], allRegions=[], allSuppressed={}, openShiftsPendingCount=0;

async function loadAll(){
  showToast('Loading data…');
  try{
    const [usersRes,locsRes,regsRes]=await Promise.all([
      apiFetch('/api/admin/users'),
      apiFetch('/api/locations'),
      apiFetch('/api/regions')
    ]);
    if(usersRes?.ok) allUsers=usersRes.users;
    if(locsRes?.ok)  allLocs=locsRes.locations;
    if(regsRes?.ok)  allRegions=regsRes.regions;

    // Keep admin's pay-period anchor in sync with their personal settings
    const settingsRes = await apiFetch('/api/settings');
    if(settingsRes?.ok && settingsRes.settings?.pp_anchor)
      PP_ANCHOR = settingsRes.settings.pp_anchor.slice(0,10);

    // Load shifts + schedule for every user, and suppressed dates
    const suppRes = await apiFetch('/api/admin/suppressed-dates');
    allSuppressed = {};
    if(suppRes?.ok) {
      for(const row of suppRes.suppressed){
        if(!allSuppressed[row.user_id]) allSuppressed[row.user_id] = new Set();
        allSuppressed[row.user_id].add(row.date);
      }
    }

    await Promise.all(allUsers.map(async u=>{
      const [sr,scr]=await Promise.all([
        apiFetch(`/api/admin/users/${u.id}/shifts`),
        apiFetch(`/api/admin/users/${u.id}/schedule`)
      ]);
      if(sr?.ok)  allShifts[u.id]   = sr.shifts.map(normalizeShift);
      if(scr?.ok) allSchedules[u.id]= scr.schedule.map(normalizeBase);
    }));

    const osRes = await apiFetch('/api/open-shifts/admin');
    openShiftsPendingCount = osRes?.ok ? osRes.shifts.filter(s=>s.status==='open').length : 0;

    renderOverview();
    renderUsers();
    renderLocs();
    renderManageUsers();
    showToast('Ready ✓');
  }catch(e){
    showToast('Failed to load data',true);
  }
}

// ── Avatar helper (used in render functions) ──
function makeAvatar(name) {
  const initials = (name || '?').split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
  const colors = ['#5b8fff','#2ecc8a','#f5a623','#ff5f6d','#c77dff','#38bdf8','#fb923c','#f472b6'];
  const color = colors[(name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
  return `<div class="u-avatar" style="background:${color}">${initials}</div>`;
}

// ── Normalize ──
function normalizeShift(s){
  return { id:s.id, locationId:s.location_id, date:s.date.slice(0,10),
    start:s.start_time.slice(0,5), end:s.end_time.slice(0,5), notes:s.notes||'',
    adminNotes:s.admin_notes||'', openShiftId:s.open_shift_id||null, awardedBy:s.awarded_by_name||'',
    location_name:s.location_name, rate:parseFloat(s.rate) };
}
function normalizeBase(b){
  return { id:b.id, locationId:b.location_id, week:b.week, day:b.day_of_week,
    start:b.start_time.slice(0,5), end:b.end_time.slice(0,5),
    location_name:b.location_name, rate:parseFloat(b.rate) };
}

// ── Helpers ──
function shiftHours(start,end){
  const [sh,sm]=start.split(':').map(Number);
  const [eh,em]=end.split(':').map(Number);
  let mins=(eh*60+em)-(sh*60+sm);
  if(mins<=0) mins+=1440;
  return Math.round(mins/6)/10;
}
function formatPay(n){ return '$'+n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function toYMD(d){ if(!d||typeof d.toISOString!=='function') return null; return d.toISOString().slice(0,10); }
function fmt(d){ return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function fmtShort(d){ return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }

function getPayPeriods(){
  // Returns array of {start,end,w1ymds,w2ymds} from anchor to today + 1 period
  const anchor=new Date(PP_ANCHOR+'T00:00:00');
  const today=new Date(); today.setHours(0,0,0,0);
  const diffDays=Math.round((today-anchor)/86400000);
  const currentN=diffDays<0?Math.ceil(diffDays/14):Math.floor(diffDays/14);
  const periods=[];
  for(let n=0;n<=currentN;n++){
    const start=new Date(anchor); start.setDate(anchor.getDate()+n*14);
    const end=new Date(start); end.setDate(start.getDate()+13);
    const ymds=[];
    for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) ymds.push(toYMD(new Date(d)));
    periods.push({start,end,ymds,w1:ymds.slice(0,7),w2:ymds.slice(7,14)});
  }
  return periods.reverse(); // newest first
}

function payWeekOf(dateStr){
  const anchor=new Date(PP_ANCHOR+'T00:00:00');
  const d=new Date(dateStr+'T00:00:00');
  const diff=Math.round((d-anchor)/86400000);
  const inPeriod=((diff%14)+14)%14;
  return inPeriod<7?1:2;
}

function baseToDate(base,weekDates){
  if(!weekDates||!weekDates[0]) return null;
  const sundayStr=toYMD(weekDates[0]); if(!sundayStr) return null;
  if(payWeekOf(sundayStr)!==base.week) return null;
  const dd=weekDates[base.day]; if(!dd) return null;
  return toYMD(dd);
}

function computePayForShifts(shifts,schedules,ymds,userId){
  // Combine logged + base shifts for a given set of dates (two weeks = two separate OT windows)
  const suppressed = allSuppressed[userId] || new Set();
  function weekShifts(wkYMDs){
    const wkD=wkYMDs.map(y=>new Date(y+'T12:00:00'));
    const logged=shifts.filter(s=>wkYMDs.includes(s.date));
    const base=schedules
      .map(b=>({...b,date:baseToDate(b,wkD),isBase:true}))
      .filter(b=>b.date&&wkYMDs.includes(b.date)&&!suppressed.has(b.date));
    const all=[...base,...logged].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
    let regRun=0,pay=0,hrs=0,ot=0;
    for(const s of all){
      const h=shiftHours(s.start,s.end);
      const rate=s.rate||0;
      const reg=Math.max(0,Math.min(h,OT_THRESH-regRun));
      const otH=h-reg;
      pay+=reg*rate+otH*rate*1.5;
      regRun+=reg; hrs+=h; ot+=otH;
    }
    return {pay,hrs,ot,count:all.length};
  }
  const w1=ymds.slice(0,7),w2=ymds.slice(7,14);
  const r1=weekShifts(w1),r2=weekShifts(w2);
  return {pay:r1.pay+r2.pay,hrs:r1.hrs+r2.hrs,ot:r1.ot+r2.ot,count:r1.count+r2.count};
}

// ══════════════════════════════
//  OVERVIEW
// ══════════════════════════════
let overviewPPOffset=0;

function changeOverviewPP(dir){
  overviewPPOffset+=dir;
  renderOverview();
}

function renderOverview(){
  const periods=getPayPeriods();
  // Build the period for this offset dynamically (not limited to loaded periods array)
  const anchor=new Date(PP_ANCHOR+'T00:00:00');
  const today=new Date(); today.setHours(0,0,0,0);
  const diffDays=Math.round((today-anchor)/86400000);
  const currentN=diffDays<0?Math.ceil(diffDays/14):Math.floor(diffDays/14);
  const n=currentN+overviewPPOffset;
  const start=new Date(anchor); start.setDate(anchor.getDate()+n*14);
  const end=new Date(start); end.setDate(start.getDate()+13);
  const ymds=[];
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) ymds.push(toYMD(new Date(d)));

  document.getElementById('pp-label').textContent=`${fmtShort(start)} – ${fmtShort(end)}`;
  const today2=new Date(); today2.setHours(0,0,0,0);
  const isCurr=overviewPPOffset===0, isFut=start>today2;
  document.getElementById('ov-period-desc').textContent=isCurr
    ?'Current pay period — all employees'
    :isFut?`${overviewPPOffset} period${overviewPPOffset>1?'s':''} ahead — all employees`
    :`${Math.abs(overviewPPOffset)} period${Math.abs(overviewPPOffset)>1?'s':''} ago — all employees`;

  const rows=allUsers.map(u=>{
    const shifts=allShifts[u.id]||[];
    const sched=allSchedules[u.id]||[];
    const {pay,hrs,ot,count}=computePayForShifts(shifts,sched,ymds,u.id);
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px">${makeAvatar(u.name||u.email.split('@')[0])}<div><div style="font-weight:600">${u.name||u.email.split('@')[0]}</div><div class="muted" style="font-size:11px">${u.email}</div></div></div></td>
      <td class="mono">${hrs.toFixed(1)} hrs</td>
      <td class="mono" style="color:${ot>0?'var(--orange)':'var(--muted)'}">${ot.toFixed(1)} hrs</td>
      <td class="mono" style="color:var(--green);font-weight:700">${formatPay(pay)}</td>
      <td class="mono">${count}</td>
    </tr>`;
  });

  adminCountUp(document.getElementById('ov-users'), allUsers.length, 400, 'int');
  adminCountUp(document.getElementById('ov-open-shifts'), openShiftsPendingCount, 400, 'int');
  document.getElementById('overview-tbody').innerHTML=rows.join('')||'<tr><td colspan="5" class="empty">No employees yet</td></tr>';
}

// ══════════════════════════════
//  USERS — grouped by house
// ══════════════════════════════
const POSITIONS = ['SRC','DSP','PRN'];

function renderUsers(){
  const byLoc={}, unassigned=[];
  for(const u of allUsers){
    if(u.location_id){ (byLoc[u.location_id]||(byLoc[u.location_id]=[])).push(u); }
    else unassigned.push(u);
  }
  const activeCount = allUsers.filter(u => u.is_active !== false).length;

  let html='';
  for(const loc of allLocs){
    const users=byLoc[loc.id];
    if(!users||!users.length) continue;
    html+=`<div style="display:flex;align-items:center;gap:8px;padding:14px 0 8px">
      <div style="width:12px;height:12px;border-radius:3px;background:${loc.color};flex-shrink:0"></div>
      <span style="font-weight:700;font-size:15px">${loc.name}</span>
      <span style="font-size:11px;font-family:var(--mono);color:var(--muted)">${users.length} employee${users.length>1?'s':''}</span>
    </div>
    <div class="card" style="padding:0;margin-bottom:20px">${users.map(userRowHTML).join('')}</div>`;
  }
  if(unassigned.length){
    html+=`<div style="display:flex;align-items:center;gap:8px;padding:14px 0 8px">
      <div style="width:12px;height:12px;border-radius:3px;background:var(--border2);flex-shrink:0"></div>
      <span style="font-weight:700;font-size:15px;color:var(--muted)">Unassigned</span>
      <span style="font-size:11px;font-family:var(--mono);color:var(--dim)">${unassigned.length} employee${unassigned.length>1?'s':''}</span>
    </div>
    <div class="card" style="padding:0;margin-bottom:20px">${unassigned.map(userRowHTML).join('')}</div>`;
  }
  if(!allUsers.length) html='<div class="empty">No users yet</div>';

  document.getElementById('users-grouped-content').innerHTML=`
    <div class="sec-hd">
      <div><h2>Users</h2><p>${activeCount} active employees · create, edit, schedule, and review from one page</p></div>
    </div>
    <div class="admin-users-layout">
      <section class="users-main">
        <div class="section-label">Employees by house</div>
        ${html}
      </section>
      <aside class="users-side">
        <div class="section-label">Create Account</div>
        <div class="card account-card">
          <div class="form-group"><label>Full name</label><input type="text" id="new-name" placeholder="John Smith"/></div>
          <div class="form-group"><label>Email</label><input type="email" id="new-email" placeholder="john@email.com"/></div>
          <div class="form-group"><label>Password</label><input type="password" id="new-pass" placeholder="Temporary password"/></div>
          <div class="form-grid-compact">
            <div class="form-group">
              <label>Position</label>
              <select id="new-position"><option value="">None</option><option value="SRC">SRC</option><option value="DSP">DSP</option><option value="PRN">PRN</option></select>
            </div>
            <div class="form-group">
              <label>Main Location</label>
              <select id="new-location"><option value="">None</option></select>
            </div>
            <div class="form-group">
              <label>Hire Date <span style="color:var(--red);font-size:10px">*required</span></label>
              <input type="date" id="new-hire-date"/>
            </div>
            <div class="form-group">
              <label>Role</label>
              <select id="new-role"><option value="user">Employee</option><option value="specialist">Specialist</option><option value="admin">Admin</option></select>
            </div>
          </div>
          <div class="account-actions">
            <button class="btn btn-primary" onclick="createAccount()">Create Account</button>
            <button class="btn btn-ghost" onclick="clearCreateForm()">Clear</button>
          </div>
          <div id="create-result" class="inline-result"></div>
        </div>

      </aside>
    </div>`;
  populateNewLocationSelect();
}

function userRowHTML(u){
  const safeName=(u.name||u.email.split('@')[0]).replace(/'/g,"\\'");
  const inactive = u.is_active === false;
  return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);${inactive?'opacity:.5':''}">
    ${makeAvatar(u.name||u.email.split('@')[0])}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${u.name||'—'}
        ${u.position?`<span class="badge ${POSITIONS.includes(u.position)?u.position.toLowerCase():'pos'}">${u.position}</span>`:''}
        ${u.role==='admin'?'<span class="badge admin">admin</span>':u.role==='specialist'?'<span class="badge" style="background:rgba(197,119,255,.15);color:#c77dff;border:1px solid rgba(197,119,255,.3)">specialist</span>':''}
        ${inactive?'<span class="badge" style="background:rgba(255,95,109,.15);color:var(--red);border:1px solid rgba(255,95,109,.3)">inactive</span>':''}
      </div>
      <div style="font-size:11px;font-family:var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.email}</div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
      ${!inactive?`<button class="btn btn-ghost btn-sm" onclick="openUserDashboard('${u.id}')">View</button>`:''}
      <button class="btn btn-ghost btn-sm" onclick="openEditUserModal('${u.id}')">Edit</button>
      ${!inactive?`<button class="btn btn-ghost btn-sm" onclick="openScheduleModal('${u.id}','${safeName}')">Schedule</button>`:''}
      ${inactive
        ?`<button class="btn btn-ghost btn-sm" onclick="reactivateUser('${u.id}','${safeName}')">Reactivate</button>
           <button class="btn btn-danger btn-sm" onclick="permanentDeleteUser('${u.id}','${safeName}')">Delete</button>`
        :`<button class="btn btn-danger btn-sm" onclick="deactivateUser('${u.id}','${safeName}')">Deactivate</button>`
      }
    </div>
  </div>`;
}

// ══════════════════════════════
//  USER DASHBOARD MODAL
// ══════════════════════════════
let viewUserId='', viewUserPPOffset=0;
let _udashRows=[], _udashTotHrs=0, _udashTotPay=0, _udashPPLabel='';

function openUserDashboard(userId){
  viewUserId=userId; viewUserPPOffset=0;
  const u=allUsers.find(u=>u.id===userId);
  if(!u) return;
  document.getElementById('udash-name').textContent=u.name||u.email.split('@')[0];
  const meta=[u.email, u.position, u.location_name].filter(Boolean).join(' · ');
  document.getElementById('udash-meta').textContent=meta;
  renderUserDashboard();
  renderUserProfileGrid();
  loadUserProfileExtras(userId);
  document.getElementById('user-dash-modal').classList.add('open');
}
function closeUserDash(){ document.getElementById('user-dash-modal').classList.remove('open'); }
function changeUDashPP(dir){ viewUserPPOffset+=dir; renderUserDashboard(); }

function renderUserDashboard(){
  const anchor=new Date(PP_ANCHOR+'T00:00:00');
  const today=new Date(); today.setHours(0,0,0,0);
  const diffDays=Math.round((today-anchor)/86400000);
  const currentN=diffDays<0?Math.ceil(diffDays/14):Math.floor(diffDays/14);
  const n=currentN+viewUserPPOffset;
  const start=new Date(anchor); start.setDate(anchor.getDate()+n*14);
  const end=new Date(start); end.setDate(start.getDate()+13);
  const ymds=[];
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) ymds.push(toYMD(new Date(d)));

  document.getElementById('udash-pp-label').textContent=`${fmtShort(start)} – ${fmtShort(end)}`;
  const isFuture=start>today;
  document.getElementById('udash-period-desc').textContent=viewUserPPOffset===0?'Current pay period'
    :isFuture?`${viewUserPPOffset} period${viewUserPPOffset>1?'s':''} ahead`
    :`${Math.abs(viewUserPPOffset)} period${Math.abs(viewUserPPOffset)>1?'s':''} ago`;

  const shifts=allShifts[viewUserId]||[];
  const sched=allSchedules[viewUserId]||[];

  const suppressed=allSuppressed[viewUserId]||new Set();
  function weekRows(wkYMDs){
    const wkD=wkYMDs.map(y=>new Date(y+'T12:00:00'));
    const logged=shifts.filter(s=>wkYMDs.includes(s.date));
    const base=sched.map(b=>({...b,date:baseToDate(b,wkD),isBase:true})).filter(b=>b.date&&wkYMDs.includes(b.date)&&!suppressed.has(b.date));
    const all=[...base,...logged].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
    let regRun=0,totPay=0,totHrs=0,totOt=0;
    const rows=all.map(s=>{
      const h=shiftHours(s.start,s.end), rate=s.rate||0;
      const reg=Math.max(0,Math.min(h,OT_THRESH-regRun)), otH=h-reg;
      const p=reg*rate+otH*rate*1.5;
      regRun+=reg; totPay+=p; totHrs+=h; totOt+=otH;
      return {...s,h,otH,p};
    });
    return {rows,totPay,totHrs,totOt};
  }

  const w1=weekRows(ymds.slice(0,7)), w2=weekRows(ymds.slice(7,14));
  const allRows=[...w1.rows,...w2.rows];
  const totPay=w1.totPay+w2.totPay, totHrs=w1.totHrs+w2.totHrs, totOt=w1.totOt+w2.totOt;

  document.getElementById('udash-hrs').textContent=totHrs.toFixed(1);
  document.getElementById('udash-ot').textContent=totOt.toFixed(1);
  document.getElementById('udash-pay').textContent=formatPay(totPay);
  document.getElementById('udash-count').textContent=allRows.length;

  // Store for PDF export
  _udashRows=allRows; _udashTotHrs=totHrs; _udashTotPay=totPay;
  _udashPPLabel=document.getElementById('udash-pp-label').textContent;

  const tbody=document.getElementById('udash-tbody');
  if(!allRows.length){ tbody.innerHTML='<tr><td colspan="7" class="empty">No shifts this period</td></tr>'; return; }

  tbody.innerHTML=allRows.map(s=>{
    const loc=allLocs.find(l=>l.id===s.locationId);
    const d=new Date(s.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const noteBtn=s.isBase?'':`<button title="${s.adminNotes?s.adminNotes.slice(0,40):'Add admin note'}" onclick="editShiftNote('${s.id}',event)" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:${s.adminNotes?'var(--accent)':'var(--dim)'}">${s.adminNotes?'📝':'＋'}</button>`;
    return `<tr>
      <td class="mono" style="white-space:nowrap">${d}${s.isBase?` <span style="font-size:9px;color:var(--dim);font-family:var(--mono);margin-left:4px">base</span>`:''}</td>
      <td><div style="display:flex;align-items:center;gap:6px"><div style="width:8px;height:8px;border-radius:2px;background:${loc?.color||'#888'};flex-shrink:0"></div>${loc?.name||'—'}</div></td>
      <td class="mono">${s.start}</td>
      <td class="mono">${s.end}</td>
      <td class="mono">${s.h.toFixed(1)}h${s.otH>0?` <span style="color:var(--orange);font-size:11px">(${s.otH.toFixed(1)}h OT)</span>`:''}</td>
      <td class="mono" style="color:var(--green)">${formatPay(s.p)}</td>
      <td style="text-align:center">${noteBtn}</td>
    </tr>`;
  }).join('');
}

async function loadUserProfileExtras(userId){
  const grid=document.getElementById('udash-profile-grid');
  if(!grid) return;
  const [balRes, reqRes]=await Promise.all([
    apiFetch(`/api/leave/admin/balances/${userId}`),
    apiFetch(`/api/leave/admin/requests?user_id=${userId}`)
  ]);
  if(viewUserId!==userId) return;
  renderUserProfileGrid(balRes?.balances||[], reqRes?.requests||[]);
}

function renderUserProfileGrid(leaveBalances=[], leaveRequests=[]){
  const grid=document.getElementById('udash-profile-grid');
  if(!grid) return;
  const u=allUsers.find(x=>x.id===viewUserId);
  if(!u) return;
  const fmtDate=s=>new Date(s+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const today=new Date(); today.setHours(0,0,0,0);
  const todayY=toYMD(today);
  const shifts=(allShifts[viewUserId]||[]).filter(s=>s.date>=todayY).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  const sched=(allSchedules[viewUserId]||[]).sort((a,b)=>a.week-b.week||a.day-b.day||a.start.localeCompare(b.start));
  const notes=(allShifts[viewUserId]||[]).filter(s=>s.adminNotes).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3);

  const upcoming=shifts.slice(0,5).map(s=>`<div class="profile-line">
    <span>${fmtDate(s.date)}</span><b>${s.location_name||'Location'} · ${s.start}-${s.end}</b>
  </div>`).join('') || '<div class="profile-empty">No upcoming logged shifts</div>';

  const schedule=sched.slice(0,8).map(s=>`<div class="profile-line">
    <span>W${s.week} · ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.day]}</span><b>${s.location_name||'Location'} · ${s.start}-${s.end}</b>
  </div>`).join('') || '<div class="profile-empty">No base schedule</div>';

  const balances=leaveBalances.length
    ? leaveBalances.map(b=>`<div class="profile-balance">
        <span style="background:${b.type_color||'#888'}"></span>
        <div><b>${b.type_label||b.type_name}</b><em>${parseFloat(b.available_hours||0).toFixed(1)}h available</em></div>
      </div>`).join('')
    : '<div class="profile-empty">Loading leave balances...</div>';

  const requests=leaveRequests.slice(0,4).map(r=>`<div class="profile-line">
    <span>${String(r.date).slice(0,10)}</span><b>${r.type_label||r.type_name} · ${r.status}</b>
  </div>`).join('') || '<div class="profile-empty">No leave requests</div>';

  const adminNotes=notes.map(s=>`<div class="profile-note">
    <span>${fmtDate(s.date)} · ${s.location_name||'Location'}</span>
    <p>${s.adminNotes}</p>
  </div>`).join('') || '<div class="profile-empty">No admin notes</div>';

  const hire=u.hire_date ? new Date(u.hire_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'Not set';
  grid.innerHTML=`
    <div class="profile-card"><h4>Employee</h4>
      <div class="profile-line"><span>Position</span><b>${u.position||'None'}</b></div>
      <div class="profile-line"><span>Main house</span><b>${u.location_name||'None'}</b></div>
      <div class="profile-line"><span>Hire date</span><b>${hire}</b></div>
      <div class="profile-line"><span>Status</span><b>${u.is_active===false?'Inactive':'Active'}</b></div>
    </div>
    <div class="profile-card"><h4>Upcoming</h4>${upcoming}</div>
    <div class="profile-card"><h4>Base Schedule</h4>${schedule}</div>
    <div class="profile-card"><h4>Leave Balances</h4>${balances}</div>
    <div class="profile-card"><h4>Recent Leave</h4>${requests}</div>
    <div class="profile-card"><h4>Admin Notes</h4>${adminNotes}</div>`;
}

document.getElementById('user-dash-modal').addEventListener('click',e=>{ if(e.target===document.getElementById('user-dash-modal')) closeUserDash(); });

function exportPayrollPDF(){
  const u=allUsers.find(u=>u.id===viewUserId);
  const name=u?(u.name||u.email):'Employee';
  const rows=_udashRows, totHrs=_udashTotHrs, totPay=_udashTotPay, label=_udashPPLabel;
  if(!rows.length){ showToast('No shifts to export for this period',true); return; }
  const win=window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payroll — ${name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;color:#111;font-size:13px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
    h2{font-size:22px;font-weight:700;margin-bottom:4px}
    .sub{color:#666;font-size:12px}
    .print-btn{padding:8px 18px;background:#111;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px}
    table{width:100%;border-collapse:collapse;margin-top:4px}
    th{text-align:left;padding:9px 12px;background:#f4f4f4;border-bottom:2px solid #ddd;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    td{padding:8px 12px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums}
    .mono{font-family:'SF Mono',Menlo,monospace;font-size:12px}
    .green{color:#1a7f4b;font-weight:600}
    .foot td{font-weight:700;background:#f9f9f9;border-top:2px solid #ccc;border-bottom:none}
    .caption{margin-top:20px;font-size:11px;color:#aaa}
    @media print{.print-btn{display:none}body{padding:16px}}
  </style></head><body>
  <div class="header">
    <div>
      <h2>${name}</h2>
      <div class="sub">Pay Period: ${label}</div>
      <div class="sub" style="margin-top:2px">Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
    </div>
    <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Location</th><th>Start</th><th>End</th><th>Hours</th><th>Earnings</th></tr></thead>
    <tbody>
      ${rows.map(s=>`<tr>
        <td class="mono">${new Date(s.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</td>
        <td>${s.location_name||'—'}</td>
        <td class="mono">${s.start}</td>
        <td class="mono">${s.end}</td>
        <td class="mono">${s.h.toFixed(2)}h${s.otH>0?` <span style="color:#c07000">(${s.otH.toFixed(2)}h OT)</span>`:''}</td>
        <td class="mono green">${formatPay(s.p)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr class="foot">
      <td colspan="4">Total</td>
      <td class="mono">${totHrs.toFixed(2)}h</td>
      <td class="mono green">${formatPay(totPay)}</td>
    </tr></tfoot>
  </table>
  <div class="caption">ShiftTrack Payroll Export · Estimated earnings only</div>
  </body></html>`);
  win.document.close();
}

async function editShiftNote(shiftId, e){
  e.stopPropagation();
  const shift=Object.values(allShifts).flat().find(s=>s.id===shiftId);
  const current=shift?.adminNotes||'';
  const note=window.prompt('Admin note for this shift (visible to employee, not editable by them):', current);
  if(note===null) return;
  const data=await apiFetch(`/api/admin/shifts/${shiftId}/notes`,{method:'PATCH',body:{admin_notes:note.trim()}});
  if(data?.ok){
    if(shift) shift.adminNotes=note.trim();
    renderUserDashboard();
    showToast('Note saved');
  } else showToast(data?.error||'Failed to save note',true);
}

// ══════════════════════════════
//  MANAGE USERS (Accounts panel)
// ══════════════════════════════
function populateNewLocationSelect(){
  const sel=document.getElementById('new-location');
  if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">— None —</option>'+allLocs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  if(cur) sel.value=cur;
}

function renderManageUsers(){
  populateNewLocationSelect();
  const el=document.getElementById('manage-users-list');
  if(!el) return;
  if(!allUsers.length){ el.innerHTML='<div class="empty">No users yet</div>'; return; }
  el.innerHTML=allUsers.map((u,i)=>`
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;${i<allUsers.length-1?'border-bottom:1px solid var(--border)':''}">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
          ${u.name||'—'}
          ${u.position?`<span class="badge ${POSITIONS.includes(u.position)?u.position.toLowerCase():'pos'}">${u.position}</span>`:''}
        </div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.email}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openEditUserModal('${u.id}')">Edit</button>
    </div>`).join('');
}

function openEditUserModal(id){
  const u=allUsers.find(u=>u.id===id);
  if(!u) return;
  document.getElementById('edit-user-id').value=id;
  document.getElementById('edit-user-title').textContent=`Edit — ${u.name||u.email}`;
  document.getElementById('edit-name').value=u.name||'';
  document.getElementById('edit-email').value=u.email;
  document.getElementById('edit-position').value=u.position||'';
  document.getElementById('edit-role').value=u.role;
  document.getElementById('edit-password').value='';
  document.getElementById('edit-hire-date').value=u.hire_date?u.hire_date.slice(0,10):'';
  // Populate + set location
  const locSel=document.getElementById('edit-location');
  locSel.innerHTML='<option value="">— None —</option>'+allLocs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  locSel.value=u.location_id||'';
  document.getElementById('edit-user-modal').classList.add('open');
  setTimeout(()=>document.getElementById('edit-name').focus(),100);
}

function closeEditUserModal(){ document.getElementById('edit-user-modal').classList.remove('open'); }

async function saveEditUser(){
  const id=document.getElementById('edit-user-id').value;
  const name=document.getElementById('edit-name').value.trim();
  const email=document.getElementById('edit-email').value.trim();
  const position=document.getElementById('edit-position').value;
  const location_id=document.getElementById('edit-location').value||null;
  const role=document.getElementById('edit-role').value;
  const password=document.getElementById('edit-password').value.trim();
  const hire_date=document.getElementById('edit-hire-date').value;
  if(!name){ showToast('Enter a name',true); return; }
  if(!email){ showToast('Enter an email',true); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showToast('Enter a valid email address',true); return; }
  if(!hire_date){ showToast('Hire date is required',true); return; }
  if(password&&password.length<8){ showToast('Password must be at least 8 characters',true); return; }
  const body={name,email,position,location_id,role,hire_date};
  if(password) body.password=password;
  const res=await apiFetch(`/api/admin/users/${id}`,{method:'PATCH',body});
  if(!res?.ok){ showToast(res?.error||'Failed to save',true); return; }
  closeEditUserModal(); await loadAll(); showToast('User updated ✓');
}

document.getElementById('edit-user-modal').addEventListener('click',e=>{ if(e.target===document.getElementById('edit-user-modal')) closeEditUserModal(); });

function toggleUserDetail(id){
  const el=document.getElementById('detail-'+id);
  if(el) el.classList.toggle('open');
}

async function deactivateUser(id,name){
  if(!confirm(`Deactivate ${name}?\n\nThey will no longer be able to log in, but all their shift history will be preserved.`)) return;
  const res=await apiFetch(`/api/admin/users/${id}/deactivate`,{method:'PATCH'});
  if(res?.ok){ await loadAll(); showToast('User deactivated'); }
  else showToast(res?.error||'Failed to deactivate',true);
}

async function reactivateUser(id,name){
  if(!confirm(`Reactivate ${name}? They will be able to log in again.`)) return;
  const res=await apiFetch(`/api/admin/users/${id}/reactivate`,{method:'PATCH'});
  if(res?.ok){ await loadAll(); showToast('User reactivated'); }
  else showToast(res?.error||'Failed to reactivate',true);
}

async function permanentDeleteUser(id,name){
  if(!confirm(`Permanently delete ${name}?\n\nThis will remove their account and ALL shift history. This cannot be undone.`)) return;
  if(!confirm(`Are you sure? This is irreversible.\n\nType OK to confirm deletion of ${name}.`)) return;
  const res=await apiFetch(`/api/admin/users/${id}`,{method:'DELETE'});
  if(res?.ok){ await loadAll(); showToast(`${name} permanently deleted`); }
  else showToast(res?.error||'Failed to delete',true);
}

// ══════════════════════════════
//  LOCATIONS
// ══════════════════════════════
function renderLocs(){
  const container=document.getElementById('locs-container');
  if(!container) return;

  if(!allLocs.length && !allRegions.length){
    container.innerHTML=`<div class="loc-root-empty">
      <div class="loc-root-empty-icon">🏠</div>
      <div class="loc-root-empty-title">No locations yet</div>
      <div class="loc-root-empty-sub">Start by creating a region, then add locations to it</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="openRegionModal()">＋ Create first region</button>
    </div>`;
    return;
  }

  const byRegion={};
  const unassigned=[];
  for(const loc of allLocs){
    if(loc.region_id){ (byRegion[loc.region_id]=byRegion[loc.region_id]||[]).push(loc); }
    else { unassigned.push(loc); }
  }

  let html='';
  for(const region of allRegions){
    const locs=byRegion[region.id]||[];
    const addrHtml=region.office_address
      ?`<div class="region-haddr"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;flex-shrink:0"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${region.office_address}</div>`
      :'';
    const cardsHtml=locs.length
      ?locs.map(l=>renderLocCard(l)).join('')
      :`<div class="loc-empty-region">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:32px;height:32px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <div style="font-size:12px">No locations in this region yet</div>
          <button class="btn btn-ghost btn-xs" onclick="openLocModal(null,'${region.id}')">＋ Add Location</button>
        </div>`;
    html+=`<div class="region-group">
      <div class="region-header">
        <div class="region-header-left">
          <div class="region-title">Region</div>
          <div class="region-hname">${region.name}</div>
          ${addrHtml}
        </div>
        <div class="region-header-right">
          <span class="region-count">${locs.length} location${locs.length===1?'':'s'}</span>
          <button class="btn btn-ghost btn-xs" onclick="openRegionModal('${region.id}')">Edit</button>
          <button class="btn btn-ghost btn-xs" onclick="openLocModal(null,'${region.id}')">＋ Add</button>
        </div>
      </div>
      <div class="loc-grid">${cardsHtml}</div>
    </div>`;
  }

  if(unassigned.length){
    html+=`<div class="region-group unassigned-group">
      <div class="region-header">
        <div class="region-header-left">
          <div class="region-title">Unassigned</div>
          <div class="region-hname" style="color:var(--muted)">No Region</div>
        </div>
        <span class="region-count">${unassigned.length}</span>
      </div>
      <div class="loc-grid">${unassigned.map(l=>renderLocCard(l)).join('')}</div>
    </div>`;
  }

  if(!allRegions.length && !unassigned.length){
    html=`<div class="loc-root-empty">
      <div class="loc-root-empty-icon">🏠</div>
      <div class="loc-root-empty-title">No locations yet</div>
      <div class="loc-root-empty-sub">Add your first location to get started</div>
    </div>`;
  }

  container.innerHTML=html;
}

function renderLocCard(l){
  const rate=parseFloat(l.rate).toFixed(2);
  const specialist=l.specialist_name||null;
  const consumers=l.consumer_count||0;
  const addrBtn=l.address
    ?`<div class="loc-addr-row"><button data-addr="${l.address.replace(/"/g,'&quot;')}" onclick="openMapAddress(this.dataset.addr)" style="display:inline-flex;align-items:center;gap:5px;color:var(--accent);background:none;border:none;cursor:pointer;font-size:11px;font-family:var(--mono);padding:0;max-width:100%;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;flex-shrink:0"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.address}</span></button></div>`
    :'';
  return `<div class="loc-card">
    <div class="loc-card-accent" style="background:${l.color}"></div>
    <div class="loc-card-content">
      <div class="loc-card-top">
        <div class="loc-card-name">${l.name}</div>
        <button class="btn btn-ghost btn-xs" onclick="openLocModal('${l.id}')">Edit</button>
      </div>
      <div class="loc-stats">
        <div class="loc-stat"><span>Pay rate</span><b class="green">$${rate}/hr</b></div>
        <div class="loc-stat"><span>Consumers</span><b>${consumers}</b></div>
        <div class="loc-stat"><span>Specialist</span><b>${specialist||'<span style="color:var(--muted)">—</span>'}</b></div>
      </div>
      ${addrBtn}
    </div>
  </div>`;
}

function _populateLocModalDropdowns(presetRegionId=null){
  const regSel=document.getElementById('loc-region');
  regSel.innerHTML='<option value="">— None —</option>'+allRegions.map(r=>`<option value="${r.id}">${r.name}</option>`).join('');
  if(presetRegionId) regSel.value=presetRegionId;

  const specSel=document.getElementById('loc-specialist');
  const specialists=allUsers.filter(u=>u.role==='specialist');
  specSel.innerHTML='<option value="">— None —</option>'+specialists.map(u=>`<option value="${u.id}">${u.name}</option>`).join('');
  if(!specialists.length){
    specSel.innerHTML='<option value="" disabled>No specialists — create a user with Specialist role</option>';
  }
}

function openLocModal(id=null, presetRegionId=null){
  document.getElementById('loc-edit-id').value=id||'';
  document.getElementById('loc-modal-title').textContent=id?'Edit Location':'Add Location';
  document.getElementById('loc-delete-btn').style.display=id?'block':'none';
  document.querySelectorAll('.csw').forEach(s=>s.classList.remove('selected'));
  document.querySelector('.csw').classList.add('selected');
  document.getElementById('loc-name').value='';
  document.getElementById('loc-rate').value='';
  document.getElementById('loc-address').value='';
  document.getElementById('loc-consumers').value='0';
  _populateLocModalDropdowns(presetRegionId);
  if(id){
    const loc=allLocs.find(l=>l.id===id);
    if(loc){
      document.getElementById('loc-name').value=loc.name;
      document.getElementById('loc-rate').value=parseFloat(loc.rate).toFixed(2);
      document.getElementById('loc-address').value=loc.address||'';
      document.getElementById('loc-consumers').value=loc.consumer_count||0;
      document.querySelectorAll('.csw').forEach(s=>s.classList.toggle('selected',s.dataset.c===loc.color));
      document.getElementById('loc-region').value=loc.region_id||'';
      document.getElementById('loc-specialist').value=loc.specialist_id||'';
    }
  }
  document.getElementById('loc-modal').classList.add('open');
}
function closeLocModal(){ document.getElementById('loc-modal').classList.remove('open'); }
function pickColor(el){ document.querySelectorAll('.csw').forEach(s=>s.classList.remove('selected')); el.classList.add('selected'); }

async function saveLoc(){
  const name=document.getElementById('loc-name').value.trim();
  const rate=parseFloat(document.getElementById('loc-rate').value);
  const color=document.querySelector('.csw.selected')?.dataset.c||'#5b8fff';
  const address=document.getElementById('loc-address').value.trim();
  const region_id=document.getElementById('loc-region').value||null;
  const specialist_id=document.getElementById('loc-specialist').value||null;
  const consumer_count=parseInt(document.getElementById('loc-consumers').value)||0;
  if(!name){ showToast('Enter a name',true); return; }
  if(isNaN(rate)||rate<0){ showToast('Enter a valid rate',true); return; }
  const editId=document.getElementById('loc-edit-id').value;
  const res=await apiFetch(editId?`/api/locations/${editId}`:'/api/locations',
    {method:editId?'PUT':'POST',body:{name,rate,color,address,region_id,specialist_id,consumer_count}});
  if(!res?.ok){ showToast(res?.error||'Failed to save',true); return; }
  closeLocModal(); await loadAll(); showToast('Location saved');
}

async function deleteLoc(){
  const id=document.getElementById('loc-edit-id').value;
  if(!confirm('Delete this location? Shifts using it will lose their rate.')) return;
  const res=await apiFetch(`/api/locations/${id}`,{method:'DELETE'});
  if(res?.ok){ closeLocModal(); await loadAll(); showToast('Location deleted'); }
  else showToast('Failed to delete',true);
}

// ── REGION MODAL ──────────────────────────────────────────────
function openRegionModal(id=null){
  document.getElementById('region-edit-id').value=id||'';
  document.getElementById('region-modal-title').textContent=id?'Edit Region':'Add Region';
  document.getElementById('region-name').value='';
  document.getElementById('region-office-address').value='';
  if(id){
    const r=allRegions.find(r=>r.id===id);
    if(r){
      document.getElementById('region-name').value=r.name;
      document.getElementById('region-office-address').value=r.office_address||'';
    }
  }
  document.getElementById('region-modal').classList.add('open');
}

function openRegionModalInline(){
  closeLocModal();
  openRegionModal();
}

function closeRegionModal(){ document.getElementById('region-modal').classList.remove('open'); }

async function saveRegion(){
  const name=document.getElementById('region-name').value.trim();
  const office_address=document.getElementById('region-office-address').value.trim();
  if(!name){ showToast('Enter a region name',true); return; }
  const editId=document.getElementById('region-edit-id').value;
  const res=await apiFetch(editId?`/api/regions/${editId}`:'/api/regions',
    {method:editId?'PUT':'POST',body:{name,office_address}});
  if(!res?.ok){ showToast(res?.error||'Failed to save region',true); return; }
  closeRegionModal(); await loadAll(); showToast('Region saved');
}

// Close modals on backdrop click
document.getElementById('loc-modal').addEventListener('click',e=>{ if(e.target===document.getElementById('loc-modal')) closeLocModal(); });
document.getElementById('region-modal').addEventListener('click',e=>{ if(e.target===document.getElementById('region-modal')) closeRegionModal(); });

// ══════════════════════════════
//  CREATE ACCOUNT
// ══════════════════════════════
async function createAccount(){
  const name=document.getElementById('new-name').value.trim();
  const email=document.getElementById('new-email').value.trim();
  const password=document.getElementById('new-pass').value;
  const role=document.getElementById('new-role').value;
  const position=document.getElementById('new-position').value;
  const location_id=document.getElementById('new-location').value||null;
  const res=document.getElementById('create-result');

  const hire_date=document.getElementById('new-hire-date').value;
  if(!email||!password){ showToast('Email and password required',true); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showToast('Enter a valid email address',true); return; }
  if(password.length<8){ showToast('Password must be at least 8 characters',true); return; }
  if(!hire_date){ showToast('Hire date is required',true); return; }

  const data=await apiFetch('/api/admin/users',{method:'POST',body:{name,email,password,position,location_id,hire_date,role}});
  res.style.display='block';
  if(data?.ok){
    res.style.color='var(--green)';
    res.textContent=`✓ Account created for ${email}`;
    adminFireConfetti();
    clearCreateForm();
    await loadAll();
    showToast('Account created ✓');
  } else {
    res.style.color='var(--red)';
    res.textContent='✗ '+(data?.error||'Failed to create account');
  }
}

function clearCreateForm(){
  ['new-name','new-email','new-pass','new-hire-date'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('new-role').value='user';
  document.getElementById('new-position').value='';
  document.getElementById('new-location').value='';
  const r=document.getElementById('create-result');
  r.style.display='none'; r.textContent='';
}

const DAYS_FULL=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ══════════════════════════════
//  BASE SCHEDULE MANAGEMENT (ADMIN)
// ══════════════════════════════
let schedUserId = '';

async function openScheduleModal(userId, userName){
  schedUserId = userId;
  document.getElementById('sched-modal-title').textContent = `Schedule — ${userName}`;
  document.getElementById('sched-user-id').value = userId;
  const sel = document.getElementById('sched-loc');
  sel.innerHTML = allLocs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  // Pre-select user's main location
  const user = allUsers.find(u=>u.id===userId);
  if(user?.location_id) sel.value = user.location_id;
  await renderSchedList();
  document.getElementById('sched-modal').classList.add('open');
}

async function renderSchedList(){
  const res = await apiFetch(`/api/admin/users/${schedUserId}/schedule`);
  const sched = res?.ok ? res.schedule : [];
  const el = document.getElementById('sched-list');
  if(!sched.length){ el.innerHTML='<div class="empty" style="padding:14px">No base shifts yet</div>'; return; }
  el.innerHTML = sched.map(b=>`
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
      <div style="width:10px;height:10px;border-radius:2px;background:${b.color};flex-shrink:0"></div>
      <div style="flex:1;font-size:13px">
        <span style="font-weight:600">Week ${b.week} · ${DAYS_FULL[b.day_of_week]}</span>
        <span style="color:var(--muted);font-family:var(--mono);font-size:11px;margin-left:8px">${b.location_name} · ${b.start_time?.slice(0,5)}–${b.end_time?.slice(0,5)}</span>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteSchedEntry('${b.id}')">✕</button>
    </div>`).join('');
}

async function addSchedEntry(){
  const week       = parseInt(document.getElementById('sched-week').value);
  const day        = parseInt(document.getElementById('sched-day').value);
  const locationId = document.getElementById('sched-loc').value;
  const start      = document.getElementById('sched-start').value;
  const end        = document.getElementById('sched-end').value;
  if(!locationId||!start||!end){ showToast('Fill in all fields',true); return; }

  // Use the schedule route but impersonate — we need to post on behalf of user
  // We'll use a direct admin endpoint
  const res = await apiFetch('/api/admin/schedule', {
    method:'POST',
    body:{ user_id:schedUserId, week, day_of_week:day, location_id:locationId, start_time:start, end_time:end }
  });
  if(!res?.ok){ showToast(res?.error||'Failed to add',true); return; }
  await renderSchedList();
  showToast('Shift added');
}

async function deleteSchedEntry(id){
  const res = await apiFetch(`/api/admin/schedule/${id}`,{method:'DELETE'});
  if(!res?.ok){ showToast('Failed to delete',true); return; }
  await renderSchedList();
  showToast('Shift removed');
}

function closeSchedModal(){ document.getElementById('sched-modal').classList.remove('open'); }
document.getElementById('sched-modal').addEventListener('click',e=>{ if(e.target===document.getElementById('sched-modal')) closeSchedModal(); });

// ══════════════════════════════
//  MAP HELPER — lets the OS pick the app
// ══════════════════════════════
function openMapAddress(address){
  const q = encodeURIComponent(address);
  const ua = navigator.userAgent;
  const url = /iPad|iPhone|iPod/.test(ua)
    ? `maps://?q=${q}`
    : /Android/.test(ua)
    ? `geo:0,0?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ══════════════════════════════
//  TOAST
// ══════════════════════════════
function showToast(msg,isErr=false){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=isErr?'err':'';
  t.classList.add('show');
  clearTimeout(t._t);
  t._t=setTimeout(()=>t.classList.remove('show','err'),2500);
}

// ══════════════════════════════
//  STAFFING VIEW
// ══════════════════════════════
let staffingView = 'month';
let staffingAnchor = new Date();
let staffingGapsOpen = false;

function staffingGoToday(){ staffingAnchor = new Date(); renderStaffing(); }

function toggleStfCard(hd){
  hd.classList.toggle('open');
  const card = hd.closest('.stf-house-card');
  if(card) card.classList.toggle('open-card', hd.classList.contains('open'));
  const body = hd.nextElementSibling;
  if(body) body.classList.toggle('open');
  const chevron = hd.querySelector('.stf-chevron');
  if(chevron) chevron.style.transform = hd.classList.contains('open') ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function setStfView(v){
  staffingView = v;
  document.querySelectorAll('.stf-vtog').forEach(el => el.classList.remove('active'));
  document.getElementById('stf-v-' + v).classList.add('active');
  renderStaffing();
}

function staffingNav(dir){
  if(staffingView === 'month'){
    staffingAnchor = new Date(staffingAnchor.getFullYear(), staffingAnchor.getMonth() + dir, 1);
  } else if(staffingView === 'week'){
    const a = new Date(staffingAnchor); a.setDate(a.getDate() + dir * 7); staffingAnchor = a;
  } else {
    const a = new Date(staffingAnchor); a.setDate(a.getDate() + dir); staffingAnchor = a;
  }
  renderStaffing();
}

function toggleStaffingGaps(){
  staffingGapsOpen = !staffingGapsOpen;
  renderStaffing();
}

// Returns array of 7 Date objects for the week containing dateStr (Sun–Sat)
function weekDatesForDateStr(dateStr){
  const d = new Date(dateStr + 'T12:00:00');
  const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
  const dates = [];
  for(let i = 0; i < 7; i++){
    const dd = new Date(sun); dd.setDate(sun.getDate() + i); dates.push(dd);
  }
  return dates;
}

// Returns { locationId: [{ user, start, end, isBase }, ...] } for a date string
function getDetailedStaffingForDate(dateStr){
  const byLoc = {};
  const wkDates = weekDatesForDateStr(dateStr);
  for(const u of allUsers){
    const shifts = allShifts[u.id] || [];
    const sched  = allSchedules[u.id] || [];
    const seenLocs = new Set();
    for(const s of shifts){
      if(s.date === dateStr && !seenLocs.has(s.locationId)){
        seenLocs.add(s.locationId);
        (byLoc[s.locationId] = byLoc[s.locationId] || []).push({ user:u, start:s.start, end:s.end, isBase:false });
      }
    }
    for(const b of sched){
      const bDate = baseToDate(b, wkDates);
      if(bDate === dateStr && !seenLocs.has(b.locationId) && !allSuppressed[u.id]?.has(dateStr)){
        seenLocs.add(b.locationId);
        (byLoc[b.locationId] = byLoc[b.locationId] || []).push({ user:u, start:b.start, end:b.end, isBase:true });
      }
    }
  }
  return byLoc;
}

function renderStaffing(){
  const today = new Date(); today.setHours(0,0,0,0);
  const label = document.getElementById('staffing-label');
  document.getElementById('stf-gaps-btn')?.classList.toggle('active', staffingGapsOpen);
  if(staffingView === 'month'){
    const ref = new Date(staffingAnchor.getFullYear(), staffingAnchor.getMonth(), 1);
    label.textContent = ref.toLocaleDateString('en-US', { month:'long', year:'numeric' });
    renderStaffingMonth(ref, today);
  } else if(staffingView === 'week'){
    const wkDates = weekDatesForDateStr(toYMD(staffingAnchor));
    label.textContent = `${fmtShort(wkDates[0])} – ${fmtShort(wkDates[6])}`;
    renderStaffingWeek(wkDates, today);
  } else {
    const d = new Date(staffingAnchor); d.setHours(0,0,0,0);
    label.textContent = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    renderStaffingDay(toYMD(d), today);
  }
  renderStaffingGaps();
}

function getStaffingRangeDates(){
  if(staffingView === 'month'){
    const ref = new Date(staffingAnchor.getFullYear(), staffingAnchor.getMonth(), 1);
    const days = new Date(ref.getFullYear(), ref.getMonth()+1, 0).getDate();
    return Array.from({length:days},(_,i)=>toYMD(new Date(ref.getFullYear(), ref.getMonth(), i+1)));
  }
  if(staffingView === 'week') return weekDatesForDateStr(toYMD(staffingAnchor)).map(toYMD);
  return [toYMD(staffingAnchor)];
}

function renderStaffingGaps(){
  const panel=document.getElementById('staffing-gaps-panel');
  if(!panel) return;
  if(!staffingGapsOpen){ panel.style.display='none'; panel.innerHTML=''; return; }
  const dates=getStaffingRangeDates();
  const gaps=[];
  const thin=[];
  for(const dateStr of dates){
    const staffing=getDetailedStaffingForDate(dateStr);
    for(const loc of allLocs){
      const entries=staffing[loc.id]||[];
      const row={ dateStr, loc, entries };
      if(entries.length===0) gaps.push(row);
      else if(entries.length===1) thin.push(row);
    }
  }
  const fmtDate=s=>new Date(s+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const card=(r,kind)=>`<button class="stf-gap-item ${kind}" onclick="stfMonthDayClick('${r.dateStr}','${r.loc.id}')">
    <span class="stf-gap-dot" style="background:${r.loc.color||'#888'}"></span>
    <span><b>${r.loc.name}</b><em>${fmtDate(r.dateStr)}</em></span>
    <strong>${kind==='empty'?'No staff':'1 staff'}</strong>
  </button>`;
  panel.style.display='';
  panel.innerHTML=`<div class="stf-gap-panel">
    <div class="stf-gap-summary">
      <div><strong>${gaps.length}</strong><span>uncovered</span></div>
      <div><strong>${thin.length}</strong><span>single-staffed</span></div>
      <div><strong>${dates.length}</strong><span>days scanned</span></div>
    </div>
    <div class="stf-gap-list">
      ${gaps.slice(0,12).map(r=>card(r,'empty')).join('')}
      ${thin.slice(0,8).map(r=>card(r,'thin')).join('')}
      ${!gaps.length&&!thin.length?'<div class="empty" style="padding:16px">No coverage gaps in this view</div>':''}
    </div>
  </div>`;
}

function stfGroupedLocs(){
  const byRegion = {};
  const unassigned = [];
  for(const loc of allLocs){
    if(loc.region_id){ (byRegion[loc.region_id] = byRegion[loc.region_id] || []).push(loc); }
    else { unassigned.push(loc); }
  }
  const groups = allRegions
    .filter(r => byRegion[r.id])
    .map(r => ({ region: r, locs: byRegion[r.id] }));
  return { groups, unassigned };
}

function stfRenderLocCards(cardFn){
  const { groups, unassigned } = stfGroupedLocs();
  if(!groups.length){
    return allLocs.map(cardFn).join('') || '<div class="empty">No locations configured</div>';
  }
  let html = groups.map(({region, locs}) =>
    `<div class="stf-region-hd"><span>${region.name}</span><span class="stf-region-count">${locs.length}</span></div>` +
    locs.map(cardFn).join('')
  ).join('');
  if(unassigned.length){
    html += `<div class="stf-region-hd stf-region-hd-unassigned"><span>Unassigned</span><span class="stf-region-count">${unassigned.length}</span></div>` +
      unassigned.map(cardFn).join('');
  }
  return html || '<div class="empty">No locations configured</div>';
}

function renderStaffingMonth(ref, today){
  const todayYMD = toYMD(today);
  const firstDay = ref.getDay();
  const daysInMonth = new Date(ref.getFullYear(), ref.getMonth()+1, 0).getDate();
  const cells = [];
  for(let i=0;i<firstDay;i++){
    const d=new Date(ref.getFullYear(),ref.getMonth(),-firstDay+i+1); cells.push({date:d,other:true});
  }
  for(let i=1;i<=daysInMonth;i++) cells.push({date:new Date(ref.getFullYear(),ref.getMonth(),i),other:false});
  while(cells.length%7!==0){
    const last=cells[cells.length-1].date; const d=new Date(last); d.setDate(d.getDate()+1); cells.push({date:d,other:true});
  }
  const staffingByDate = {};
  cells.filter(c=>!c.other).forEach(c=>{ staffingByDate[toYMD(c.date)]=getDetailedStaffingForDate(toYMD(c.date)); });

  const chevronSvg = `<svg class="stf-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(-90deg)"><polyline points="6 9 12 15 18 9"/></svg>`;
  document.getElementById('staffing-body').innerHTML = `<div class="stf-location-grid">${stfRenderLocCards(loc => {
    const c = loc.color || '#888';
    let coveredDays = 0;
    let peakStaff = 0;
    cells.filter(cell => !cell.other).forEach(({date}) => {
      const staff = staffingByDate[toYMD(date)]?.[loc.id] || [];
      if(staff.length) coveredDays++;
      if(staff.length > peakStaff) peakStaff = staff.length;
    });
    const cellsHtml = cells.map(({date,other})=>{
      const ymd = toYMD(date);
      const staff = other ? [] : (staffingByDate[ymd]?.[loc.id] || []);
      const isToday = ymd === todayYMD;
      const cls = 'stf-mcell' + (other?' stf-mcell-other':'') + (isToday?' stf-mcell-today':'');
      const clickAttr = other ? '' : `onclick="stfMonthDayClick('${ymd}','${loc.id}')"`;
      return `<div class="${cls}" ${clickAttr}>
        <div class="stf-mcell-dn">${date.getDate()}</div>
        ${!other && staff.length ? `<div class="stf-mcell-count" style="color:${c}">${staff.length}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="stf-house-card stf-location-card">
      <div class="stf-house-hd" onclick="toggleStfCard(this)">
        <div style="width:12px;height:12px;border-radius:3px;background:${c};flex-shrink:0"></div>
        <div class="stf-house-title">
          <div class="stf-house-name">${loc.name}</div>
          <div class="stf-house-meta">${coveredDays}/${daysInMonth} days covered · peak ${peakStaff}</div>
        </div>
        <div class="stf-house-count" style="color:${c};background:${c}18">${coveredDays} days</div>
        ${chevronSvg}
      </div>
      <div class="stf-card-body">
        <div class="stf-card-inner">
          <div class="stf-month-dow"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
          <div class="stf-month-grid">${cellsHtml}</div>
        </div>
      </div>
    </div>`;
  })}</div>`;
}

function renderStaffingWeek(wkDates, today){
  const todayYMD = toYMD(today);
  const ymds = wkDates.map(toYMD);
  const staffingByDay = {};
  ymds.forEach(ymd => { staffingByDay[ymd] = getDetailedStaffingForDate(ymd); });
  const DAY_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const chevronSvg = `<svg class="stf-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(-90deg)"><polyline points="6 9 12 15 18 9"/></svg>`;

  document.getElementById('staffing-body').innerHTML = `<div class="stf-location-grid stf-week-grid">${stfRenderLocCards(loc => {
    const c = loc.color || '#888';
    const userMap = new Map();
    let staffedDays = 0;
    ymds.forEach(ymd => {
      const entries = staffingByDay[ymd]?.[loc.id] || [];
      if(entries.length) staffedDays++;
      entries.forEach(e => userMap.set(e.user.id, e.user));
    });
    const countBadge = userMap.size
      ? `<div class="stf-house-count" style="color:${c};background:${c}20">${userMap.size} staff</div>`
      : `<div class="stf-house-count" style="color:var(--dim);background:var(--bg3)">No staff</div>`;
    const dayHeaders = wkDates.map((d,i)=>{
      const isToday = ymds[i] === todayYMD;
      return `<th style="${isToday?'color:var(--accent)':''}">${DAY_ABBR[i]}<br><span style="font-size:9px;opacity:.7">${d.getDate()}</span></th>`;
    }).join('');
    const bodyContent = userMap.size
      ? `<div style="overflow-x:auto"><table class="stf-week-table">
          <thead><tr><th>Staff</th>${dayHeaders}</tr></thead>
          <tbody>${[...userMap.values()].map(u => {
            const cells = ymds.map(ymd => {
              const entry = (staffingByDay[ymd]?.[loc.id]||[]).find(e=>e.user.id===u.id);
              if(!entry) return '<td>—</td>';
              return `<td><span class="stf-shift-pill${entry.isBase?' base':''}">${entry.start}–${entry.end}</span></td>`;
            }).join('');
            const name = u.name || u.email.split('@')[0];
            return `<tr><td>${name}${u.position?` <span style="font-size:9px;color:var(--dim)">${u.position}</span>`:''}</td>${cells}</tr>`;
          }).join('')}</tbody>
        </table></div>`
      : '<div style="padding:14px 16px;font-size:12px;color:var(--dim);font-family:var(--mono)">No staff scheduled this week</div>';
    return `<div class="stf-house-card stf-location-card">
      <div class="stf-house-hd" onclick="toggleStfCard(this)">
        <div style="width:12px;height:12px;border-radius:3px;background:${c};flex-shrink:0"></div>
        <div class="stf-house-title">
          <div class="stf-house-name">${loc.name}</div>
          <div class="stf-house-meta">${staffedDays}/7 days covered · ${userMap.size || 0} unique staff</div>
        </div>
        ${countBadge}
        ${chevronSvg}
      </div>
      <div class="stf-card-body"><div class="stf-card-inner">${bodyContent}</div></div>
    </div>`;
  })}</div>`;
}

function renderStaffingDay(dateStr, today){
  const staffing = getDetailedStaffingForDate(dateStr);
  const d = new Date(dateStr + 'T12:00:00');
  const dayLabel = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const chevronSvg = `<svg class="stf-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(-90deg)"><polyline points="6 9 12 15 18 9"/></svg>`;
  document.getElementById('staffing-body').innerHTML = `<div class="stf-location-grid stf-day-grid">${stfRenderLocCards(loc => {
    const c = loc.color || '#888';
    const entries = (staffing[loc.id] || []).sort((a,b)=>a.start.localeCompare(b.start));
    const countBadge = entries.length
      ? `<div class="stf-house-count" style="color:${c};background:${c}20">${entries.length} staff</div>`
      : `<div class="stf-house-count" style="color:var(--dim);background:var(--bg3)">No staff</div>`;
    const listHtml = entries.length
      ? entries.map(e => {
          const name = e.user.name || e.user.email.split('@')[0];
          return `<div class="stf-day-row">
            <div class="stf-day-name">${name}</div>
            <div class="stf-day-time">${e.start} – ${e.end}</div>
            ${e.user.position?`<span class="badge ${POSITIONS.includes(e.user.position)?e.user.position.toLowerCase():'pos'}">${e.user.position}</span>`:''}
            ${e.isBase?`<span style="font-size:9px;color:var(--dim);font-family:var(--mono);margin-left:4px">base</span>`:''}
          </div>`;
        }).join('')
      : '<div style="padding:14px 16px;font-size:12px;color:var(--dim);font-family:var(--mono)">No staff scheduled</div>';
    return `<div class="stf-house-card stf-location-card">
      <div class="stf-house-hd" onclick="toggleStfCard(this)">
        <div style="width:12px;height:12px;border-radius:3px;background:${c};flex-shrink:0"></div>
        <div class="stf-house-title">
          <div class="stf-house-name">${loc.name}</div>
          <div class="stf-house-meta">${dayLabel} · ${entries.length ? `${entries.length} scheduled` : 'no coverage'}</div>
        </div>
        ${countBadge}
        ${chevronSvg}
      </div>
      <div class="stf-card-body"><div class="stf-card-inner">${listHtml}</div></div>
    </div>`;
  })}</div>`;
}

function stfMonthDayClick(dateStr, locId){
  const staffing = getDetailedStaffingForDate(dateStr);
  const entries  = staffing[locId] || [];
  const loc      = allLocs.find(l => l.id === locId);
  const d        = new Date(dateStr + 'T12:00:00');
  document.getElementById('staffing-day-title').textContent =
    `${loc?.name} · ${d.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'})}`;
  const content = document.getElementById('staffing-day-content');
  if(!entries.length){
    content.innerHTML = '<div class="empty" style="padding:20px 0">No staff scheduled</div>';
  } else {
    content.innerHTML = entries
      .sort((a,b)=>a.start.localeCompare(b.start))
      .map(e => {
        const name = e.user.name || e.user.email.split('@')[0];
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:13px;font-weight:500;flex:1">${name}</div>
          <div style="font-size:11px;font-family:var(--mono);color:var(--muted)">${e.start} – ${e.end}</div>
          ${e.user.position?`<span class="badge ${POSITIONS.includes(e.user.position)?e.user.position.toLowerCase():'pos'}">${e.user.position}</span>`:''}
          ${e.isBase?`<span style="font-size:9px;color:var(--dim);font-family:var(--mono)">base</span>`:''}
        </div>`;
      }).join('');
  }
  document.getElementById('staffing-day-modal').classList.add('open');
}

document.getElementById('staffing-day-modal').addEventListener('click', e => {
  if(e.target === document.getElementById('staffing-day-modal'))
    document.getElementById('staffing-day-modal').classList.remove('open');
});

// ══════════════════════════════
//  BROADCAST NOTIFICATIONS
// ══════════════════════════════
// Character counter for message textarea
document.getElementById('bc-body').addEventListener('input', function(){
  document.getElementById('bc-char-count').textContent = `${this.value.length} / 200`;
});

function initOverviewNotifyCard(){
  document.getElementById('panel-notify-legacy')?.remove();
  const card = document.getElementById('overview-notify-card');
  if(!card || card._wired) return;
  const mq = window.matchMedia('(max-width: 720px)');
  const apply = () => {
    if(mq.matches){
      if(!card.dataset.userToggled) card.open = false;
    } else {
      card.open = true;
      delete card.dataset.userToggled;
    }
  };
  card.addEventListener('toggle', () => {
    if(mq.matches) card.dataset.userToggled = '1';
  });
  mq.addEventListener?.('change', apply);
  card._wired = true;
  apply();
}

function toggleBcFilter(){
  const val    = document.getElementById('bc-filter').value;
  const row    = document.getElementById('bc-filter-val-row');
  const label  = document.getElementById('bc-filter-val-label');
  const select = document.getElementById('bc-filter-val');

  if(val === 'all'){
    row.style.display = 'none';
    return;
  }
  row.style.display = 'block';

  if(val === 'location'){
    label.textContent = 'Location';
    select.innerHTML  = allLocs.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  } else {
    label.textContent = 'Position';
    select.innerHTML  = ['SRC','DSP','PRN'].map(p => `<option value="${p}">${p}</option>`).join('');
  }
}

async function sendBroadcast(){
  const title       = document.getElementById('bc-title').value.trim();
  const body        = document.getElementById('bc-body').value.trim();
  const filterType  = document.getElementById('bc-filter').value;
  const filterValue = document.getElementById('bc-filter-val').value;
  const btn         = document.getElementById('bc-send-btn');
  const result      = document.getElementById('bc-result');

  if(!body){ showToast('Enter a message',true); return; }

  btn.textContent = 'Sending…'; btn.disabled = true;
  result.style.display = 'none';

  const payload = { title, body };
  if(filterType !== 'all'){ payload.filter_type = filterType; payload.filter_value = filterValue; }

  const data = await apiFetch('/api/notifications/broadcast', { method:'POST', body: payload });
  btn.textContent = 'Send Notification'; btn.disabled = false;

  if(data?.ok){
    result.style.display   = 'block';
    result.style.background = 'var(--green-bg)';
    result.style.color      = 'var(--green)';
    result.textContent      = `✓ Sent to ${data.sent} subscriber${data.sent!==1?'s':''} (${data.total} employee${data.total!==1?'s':''} matched)`;
    document.getElementById('bc-body').value = '';
    document.getElementById('bc-char-count').textContent = '0 / 200';
  } else {
    result.style.display   = 'block';
    result.style.background = 'var(--red-bg)';
    result.style.color      = 'var(--red)';
    result.textContent      = '✗ ' + (data?.error || 'Failed to send');
  }
}

// ══════════════════════════════
//  OPEN SHIFTS
// ══════════════════════════════
function populateOsForm(){
  const locSel = document.getElementById('os-location');
  if(!locSel) return;
  locSel.innerHTML = allLocs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  // Default date to tomorrow
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const dateEl = document.getElementById('os-date');
  if(!dateEl.value) dateEl.value = tomorrow.toISOString().slice(0,10);
  // Employee picker — reset selection and populate list
  empPickerSelected.clear();
  updateEmpPicker();
}

function toggleOsTarget(){
  const v = document.getElementById('os-target').value;
  document.getElementById('os-specific-row').style.display = v==='specific' ? '' : 'none';
}

async function postOpenShift(){
  const location_id   = document.getElementById('os-location').value;
  const date          = document.getElementById('os-date').value;
  const start_time    = document.getElementById('os-start').value;
  const end_time      = document.getElementById('os-end').value;
  const deadline_hours= document.getElementById('os-deadline').value;
  const target_type   = document.getElementById('os-target').value;
  const notes         = document.getElementById('os-notes').value.trim();
  const result        = document.getElementById('os-result');

  if(!location_id||!date||!start_time||!end_time){
    showToast('Fill in all required fields',true); return;
  }

  let target_user_ids = [];
  if(target_type === 'specific'){
    target_user_ids = Array.from(empPickerSelected);
    if(!target_user_ids.length){ showToast('Select at least one employee',true); return; }
  }

  const btn = event.target; btn.disabled=true; btn.textContent='Posting…';
  const data = await apiFetch('/api/open-shifts/admin',{method:'POST',body:{
    location_id,date,start_time,end_time,notes,target_type,target_user_ids,deadline_hours:Number(deadline_hours)
  }});
  btn.disabled=false; btn.textContent='Post Open Shift';

  result.style.display='block';
  if(data?.ok){
    result.style.color='var(--green)';
    result.textContent='✓ Open shift posted and notifications sent';
    document.getElementById('os-notes').value='';
    empPickerSelected.clear(); updateEmpPicker();
    loadOpenShifts();
  } else {
    result.style.color='var(--red)';
    result.textContent='✗ '+(data?.error||'Failed to post');
  }
}

// ── Employee Picker ─────────────────────────────────────────────
const empPickerSelected = new Set();

function updateEmpPicker(){
  renderEmpList();
  renderEmpChips();
  // Update trigger label
  const label = document.getElementById('emp-trigger-label');
  if(!label) return;
  const n = empPickerSelected.size;
  if(n === 0){ label.textContent='Choose employees…'; label.className='emp-trigger-label'; }
  else { label.textContent=`${n} employee${n>1?'s':''} selected`; label.className='emp-trigger-label has-sel'; }
}

function renderEmpList(){
  const el = document.getElementById('emp-list');
  if(!el) return;
  const q = (document.getElementById('emp-search')?.value||'').toLowerCase();
  const users = allUsers.filter(u=>u.role==='user'&&(u.name||u.email).toLowerCase().includes(q));
  if(!users.length){ el.innerHTML=`<div class="emp-empty">No employees found</div>`; return; }
  el.innerHTML = users.map(u=>{
    const name = u.name||u.email.split('@')[0];
    const initials = name.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
    const hire = u.hire_date ? 'Hired '+u.hire_date.slice(0,10) : '';
    const sel = empPickerSelected.has(u.id);
    return `<div class="emp-item${sel?' selected':''}" onclick="toggleEmpItem('${u.id}')">
      <div class="emp-avatar">${initials}</div>
      <div class="emp-item-info">
        <div class="emp-item-name">${name}</div>
        ${hire?`<div class="emp-item-hire">${hire}</div>`:''}
      </div>
      <div class="emp-item-check">✓</div>
    </div>`;
  }).join('');
}

function renderEmpChips(){
  const el = document.getElementById('emp-chips');
  if(!el) return;
  el.innerHTML = [...empPickerSelected].map(id=>{
    const u = allUsers.find(x=>x.id===id);
    if(!u) return '';
    const name = u.name||u.email.split('@')[0];
    return `<div class="emp-chip"><span>${name}</span><span class="emp-chip-x" onclick="removeEmpItem('${id}')">×</span></div>`;
  }).join('');
}

function toggleEmpItem(id){
  empPickerSelected.has(id)?empPickerSelected.delete(id):empPickerSelected.add(id);
  updateEmpPicker();
}

function removeEmpItem(id){
  empPickerSelected.delete(id);
  updateEmpPicker();
}

function toggleEmpPicker(e){
  e.stopPropagation();
  const dd = document.getElementById('emp-dropdown');
  const trigger = document.getElementById('emp-trigger');
  const isOpen = dd.classList.contains('open');
  if(isOpen){ dd.classList.remove('open'); trigger.classList.remove('open'); }
  else {
    dd.classList.add('open'); trigger.classList.add('open');
    document.getElementById('emp-search').value='';
    renderEmpList();
    setTimeout(()=>document.getElementById('emp-search').focus(),50);
  }
}

function filterEmpPicker(){ renderEmpList(); }

document.addEventListener('click', e=>{
  const picker = document.getElementById('emp-picker');
  if(picker && !picker.contains(e.target)){
    document.getElementById('emp-dropdown')?.classList.remove('open');
    document.getElementById('emp-trigger')?.classList.remove('open');
  }
});
// ────────────────────────────────────────────────────────────────

async function loadOpenShifts(){
  const data = await apiFetch('/api/open-shifts/admin');
  if(!data?.ok) return;
  renderOpenShiftsList(data.shifts);
}

function renderOpenShiftsList(shifts){
  const el = document.getElementById('os-list');
  if(!shifts.length){ el.innerHTML='<div class="empty">No open shifts yet</div>'; return; }

  const targetLabel = { everyone:'Everyone', house:'House', specific:'Specific' };

  function shiftCard(s){
    const dl=new Date(s.deadline);
    const dlStr=dl.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    const isPast=dl<new Date();
    const claimsHtml=s.claims.length
      ?s.claims.map((c,i)=>`<div style="font-size:11px;font-family:var(--mono);padding:2px 0;color:${c.response==='claimed'?'var(--green)':'var(--dim)'}">
          ${i===0&&s.target_type==='house'?'★ ':''}${c.name||c.email} · ${c.response} · hired ${c.hire_date?c.hire_date.slice(0,10):'?'}
        </div>`).join('')
      :'<div style="font-size:11px;font-family:var(--mono);color:var(--dim)">No responses yet</div>';
    return `<div class="card" style="margin-bottom:10px;padding:12px 14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <div style="font-family:var(--mono);font-size:13px;font-weight:600">${(s.date||'').slice(0,10)} &nbsp;${s.start_time.slice(0,5)}–${s.end_time.slice(0,5)}</div>
          <div style="font-size:11px;font-family:var(--mono);color:${isPast?'var(--dim)':'var(--muted)'};margin-top:3px">
            Deadline: ${dlStr}${isPast?' (passed)':''}
            ${s.claimed_by_name?` · <strong>${s.claimed_by_name}</strong>`:''}</div>
          <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
            <span style="font-size:10px;padding:2px 7px;border-radius:99px;font-family:var(--mono);background:var(--bg3);color:var(--muted)">${targetLabel[s.target_type]||s.target_type}</span>
          </div>
          ${s.notes?`<div style="font-size:11px;color:var(--muted);margin-top:4px">${s.notes}</div>`:''}
        </div>
        ${s.status==='open'?`<button class="btn btn-danger btn-sm" onclick="cancelOpenShift('${s.id}')">Cancel</button>`:''}
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">${claimsHtml}</div>
    </div>`;
  }

  function groupByLocation(list){
    const order=allLocs.map(l=>l.id);
    const groups={};
    for(const s of list){
      const key=s.location_name||'Unassigned';
      if(!groups[key]) groups[key]={color:s.location_color||'#888',locId:s.location_id,shifts:[]};
      groups[key].shifts.push(s);
    }
    // Sort by allLocs order
    return Object.entries(groups).sort(([,a],[,b])=>order.indexOf(a.locId)-order.indexOf(b.locId));
  }

  function renderGroups(list){
    return groupByLocation(list).map(([locName,g])=>`
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <div style="width:9px;height:9px;border-radius:2px;background:${g.color}"></div>
          <span style="font-weight:700;font-size:13px">${locName}</span>
          <span style="font-size:11px;font-family:var(--mono);color:var(--muted)">${g.shifts.length} shift${g.shifts.length>1?'s':''}</span>
        </div>
        ${g.shifts.map(shiftCard).join('')}
      </div>`).join('');
  }

  const open=shifts.filter(s=>s.status==='open');
  const claimed=shifts.filter(s=>s.status==='claimed');
  const expired=shifts.filter(s=>s.status==='expired');

  let html='';

  // Open
  html+=open.length?renderGroups(open):'<div class="empty" style="margin-bottom:20px">No open shifts pending</div>';

  // Claimed (collapsible, open by default)
  if(claimed.length) html+=`
    <div style="margin-top:20px">
      <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('.os-chev').style.transform=this.nextElementSibling.style.display==='none'?'rotate(-90deg)':''"
        style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:8px;user-select:none">
        <span class="os-chev" style="font-size:10px;transition:transform .2s">▼</span>
        <span style="font-weight:700;font-size:13px;color:var(--green)">Claimed</span>
        <span style="font-size:11px;font-family:var(--mono);color:var(--muted)">${claimed.length} shift${claimed.length>1?'s':''}</span>
      </div>
      <div>${renderGroups(claimed)}</div>
    </div>`;

  // Expired (collapsible, collapsed by default)
  if(expired.length) html+=`
    <div style="margin-top:16px">
      <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('.os-chev').style.transform=this.nextElementSibling.style.display==='none'?'rotate(-90deg)':''"
        style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:8px;user-select:none">
        <span class="os-chev" style="font-size:10px;transition:transform .2s;transform:rotate(-90deg)">▼</span>
        <span style="font-weight:700;font-size:13px;color:var(--dim)">Expired</span>
        <span style="font-size:11px;font-family:var(--mono);color:var(--muted)">${expired.length} shift${expired.length>1?'s':''}</span>
      </div>
      <div style="display:none">${renderGroups(expired)}</div>
    </div>`;

  el.innerHTML=html;
}

async function cancelOpenShift(id){
  if(!confirm('Cancel this open shift?')) return;
  const data = await apiFetch(`/api/open-shifts/admin/${id}`,{method:'DELETE'});
  if(data?.ok){ showToast('Open shift cancelled'); loadOpenShifts(); }
  else showToast(data?.error||'Failed to cancel',true);
}

// ══════════════════════════════
//  ADMIN SWAPS
// ══════════════════════════════
async function loadAdminSwaps(){
  const el = document.getElementById('admin-swaps-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const res = await apiFetch('/api/admin/swaps');
  if(!res?.ok){ el.innerHTML='<div class="empty">Failed to load swaps</div>'; return; }
  const swaps = res.swaps;
  if(!swaps.length){ el.innerHTML='<div class="empty">No swap requests yet</div>'; return; }

  const STATUS_BADGE = {
    pending:   `<span class="badge" style="background:rgba(245,166,35,.12);color:var(--orange);border:1px solid rgba(245,166,35,.3)">Pending</span>`,
    accepted:  `<span class="badge" style="background:rgba(46,204,138,.12);color:var(--green);border:1px solid rgba(46,204,138,.3)">Accepted</span>`,
    rejected:  `<span class="badge" style="background:rgba(255,95,109,.12);color:var(--red);border:1px solid rgba(255,95,109,.3)">Rejected</span>`,
    cancelled: `<span class="badge" style="background:var(--bg4);color:var(--muted);border:1px solid var(--border)">Cancelled</span>`,
  };

  el.innerHTML = swaps.map(s => {
    const iDate = s.initiator_date;
    const tDate = s.target_date;
    const canReject = s.status === 'pending' || s.status === 'accepted';
    const created = new Date(s.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    return `<div class="card" style="margin-bottom:10px;padding:16px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:600">${s.initiator_name}</span>
          <span style="color:var(--muted);font-size:12px;font-family:var(--mono);margin:0 6px">↔</span>
          <span style="font-weight:600">${s.target_name}</span>
          <span style="font-size:10px;font-family:var(--mono);color:var(--muted);margin-left:10px">${created}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${STATUS_BADGE[s.status] || STATUS_BADGE.cancelled}
          ${canReject ? `<button class="btn btn-danger btn-sm" onclick="rejectAdminSwap('${s.id}',this)">Reject${s.status==='accepted'?' & Undo':''}</button>` : ''}
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:12px;font-family:var(--mono);color:var(--muted)">
        <span>${s.initiator_name}: <strong style="color:var(--text)">${s.initiator_location_name}</strong> on ${iDate}</span>
        <span>→ works</span>
        <span>${s.target_name}: <strong style="color:var(--text)">${s.target_location_name}</strong> on ${tDate}</span>
      </div>
    </div>`;
  }).join('');
}

async function rejectAdminSwap(id, btn){
  const label = btn.textContent;
  if(!confirm(`${label} this swap? This cannot be undone.`)) return;
  btn.disabled = true;
  const res = await apiFetch(`/api/admin/swaps/${id}/reject`, { method:'PATCH' });
  if(res?.ok){
    showToast('Swap rejected');
    await loadAll();   // refresh shifts/suppressed so staffing view updates
    loadAdminSwaps();
  } else {
    showToast(res?.error || 'Failed to reject', true);
    btn.disabled = false;
  }
}

// Hook renderStaffing into loadAll (re-render when data changes)
const _origRenderAll = renderUsers;
// Patch loadAll to also render staffing after data loads
const _origLoadAll = loadAll;
loadAll = async function(){
  await _origLoadAll();
  renderStaffing();
  toggleBcFilter(); // populate filter dropdown with fresh loc data
  initOverviewNotifyCard();
  adminInitRipples();
  requestAnimationFrame(updateTabIndicator);
  refreshLeavePendingBadge();
};

// ══════════════════════════════
//  LEAVE MANAGEMENT
// ══════════════════════════════

async function refreshLeavePendingBadge() {
  const res = await apiFetch('/api/leave/admin/pending-count');
  const badge = document.getElementById('leave-pending-badge');
  if (!badge) return;
  const count = res?.count || 0;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

async function loadLeavePanel() {
  // Populate user filter + call-off employee picker
  const userSel = document.getElementById('leave-filter-user');
  const coUser  = document.getElementById('co-user');
  const active  = allUsers.filter(u => u.is_active !== false);
  const opts    = active.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
  if (userSel) userSel.innerHTML = '<option value="">All employees</option>' + opts;
  if (coUser)  coUser.innerHTML  = opts;
  if (!document.getElementById('co-date').value)
    document.getElementById('co-date').value = new Date().toISOString().slice(0,10);

  await Promise.all([loadLeavePending(), loadLeaveAll()]);
  refreshLeavePendingBadge();
}

async function loadLeavePending() {
  const el = document.getElementById('leave-pending-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const res = await apiFetch('/api/leave/admin/requests?status=pending');
  if (!res?.ok) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  const reqs = res.requests;
  if (!reqs.length) { el.innerHTML = '<div class="empty">No pending requests 🎉</div>'; return; }

  el.innerHTML = reqs.map(r => {
    const dateStr = String(r.date).slice(0,10);
    const d = new Date(dateStr + 'T12:00:00');
    const fmtDate = d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    const color = r.type_color || '#888';
    return `<div class="card" style="margin-bottom:10px;padding:14px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          ${makeAvatar(r.employee_name)}
          <div>
            <div style="font-weight:700;font-size:14px">${r.employee_name}</div>
            <div style="font-size:11px;font-family:var(--mono);color:var(--muted);margin-top:1px">${r.employee_position||'—'}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:11px;font-family:var(--mono);padding:2px 8px;border-radius:99px;background:rgba(${hexToRgb(color)}, .12);color:${color};border:1px solid rgba(${hexToRgb(color)},.3)">${r.type_label}</span>
          <span style="font-size:12px;font-family:var(--mono);color:var(--text)">${fmtDate}</span>
          <span style="font-size:13px;font-weight:700;font-family:var(--mono)">${parseFloat(r.hours_requested).toFixed(1)} hrs</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="approveLeave('${r.id}',this)">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="openDenyLeave('${r.id}')">Deny</button>
        </div>
      </div>
      ${r.notes ? `<div style="margin-top:10px;font-size:12px;font-family:var(--mono);color:var(--muted);padding:8px 10px;background:var(--bg3);border-radius:6px">${r.notes}</div>` : ''}
    </div>`;
  }).join('');
}

async function loadLeaveAll() {
  const tbody = document.getElementById('leave-all-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
  const status  = document.getElementById('leave-filter-status')?.value || '';
  const userId  = document.getElementById('leave-filter-user')?.value || '';
  let url = '/api/leave/admin/requests';
  const params = [];
  if (status)  params.push('status=' + status);
  if (userId)  params.push('user_id=' + userId);
  if (params.length) url += '?' + params.join('&');

  const res = await apiFetch(url);
  if (!res?.ok) { tbody.innerHTML = '<tr><td colspan="7" class="empty">Failed to load</td></tr>'; return; }
  const reqs = res.requests;
  if (!reqs.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No requests found</td></tr>'; return; }

  const STATUS_COLORS = {
    pending:   'var(--orange)',
    approved:  'var(--green)',
    denied:    'var(--red)',
    cancelled: 'var(--dim)',
  };

  tbody.innerHTML = reqs.map(r => {
    const dateStr = String(r.date).slice(0,10);
    const d = new Date(dateStr + 'T12:00:00');
    const fmtDate = d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const color = r.type_color || '#888';
    const noteOrReason = r.status === 'denied' && r.denial_reason
      ? `<span style="color:var(--red)">Denied: ${r.denial_reason}</span>`
      : (r.notes || '—');

    let actions = '';
    if (r.status === 'approved') {
      actions = `<button class="btn btn-ghost btn-sm" onclick="reverseLeave('${r.id}',this)" style="font-size:11px;color:var(--muted)">Reverse</button>`;
      if (r.type_name === 'call_off') {
        const applied = parseFloat(r.sick_hours_applied) || 0;
        const hrs = parseFloat(r.hours_requested);
        if (applied < hrs)
          actions += ` <button class="btn btn-ghost btn-sm" onclick="convertToSick('${r.id}',this)" style="font-size:11px;color:var(--green)">Apply Sick</button>`;
      }
    }
    if (r.status === 'pending') {
      actions = `<button class="btn btn-primary btn-sm" onclick="approveLeave('${r.id}',this)">✓</button>
                 <button class="btn btn-danger btn-sm" onclick="openDenyLeave('${r.id}')">✗</button>`;
    }

    const sickNote = r.type_name === 'call_off' && parseFloat(r.sick_hours_applied) > 0
      ? `<br><span style="font-size:10px;color:var(--green)">${parseFloat(r.sick_hours_applied).toFixed(2)} sick hrs applied</span>` : '';

    return `<tr>
      <td>${makeAvatar(r.employee_name)} <span style="margin-left:6px;font-weight:600">${r.employee_name}</span></td>
      <td><span style="font-size:11px;font-family:var(--mono);padding:2px 8px;border-radius:99px;background:rgba(${hexToRgb(color)},.12);color:${color}">${r.type_label}</span></td>
      <td class="mono">${fmtDate}</td>
      <td class="mono">${parseFloat(r.hours_requested).toFixed(1)}</td>
      <td><span style="font-size:11px;font-family:var(--mono);color:${STATUS_COLORS[r.status]||'var(--muted)'}">${r.status}</span>${sickNote}</td>
      <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${noteOrReason}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

// Helper: hex color → "r,g,b" string for rgba()
function hexToRgb(hex) {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const n = parseInt(hex, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

async function approveLeave(id, btn) {
  btn.disabled = true;
  const res = await apiFetch(`/api/leave/requests/${id}/approve`, { method:'PATCH' });
  if (!res?.ok) { showToast(res?.error || 'Failed to approve', true); btn.disabled=false; return; }
  showToast('Request approved ✓');
  await loadLeavePanel();
}

function openDenyLeave(id) {
  document.getElementById('deny-leave-id').value = id;
  document.getElementById('deny-leave-reason').value = '';
  document.getElementById('deny-leave-modal').classList.add('open');
}

async function confirmDenyLeave() {
  const id = document.getElementById('deny-leave-id').value;
  const reason = document.getElementById('deny-leave-reason').value.trim();
  if (!reason) { showToast('Please enter a denial reason', true); return; }
  const res = await apiFetch(`/api/leave/requests/${id}/deny`, { method:'PATCH', body:{ denial_reason: reason } });
  if (!res?.ok) { showToast(res?.error || 'Failed to deny', true); return; }
  document.getElementById('deny-leave-modal').classList.remove('open');
  showToast('Request denied');
  await loadLeavePanel();
}

async function reverseLeave(id, btn) {
  if (!confirm('Reverse this approval? The hours will be restored to the employee.')) return;
  btn.disabled = true;
  const res = await apiFetch(`/api/leave/requests/${id}/reverse`, { method:'PATCH' });
  if (!res?.ok) { showToast(res?.error || 'Failed to reverse', true); btn.disabled=false; return; }
  showToast('Request reversed — hours restored');
  await loadLeavePanel();
}

async function convertToSick(id, btn) {
  if (!confirm('Apply available sick time to this call-off?')) return;
  btn.disabled = true;
  const res = await apiFetch(`/api/leave/calloff/${id}/convert-sick`, { method:'PATCH' });
  if (!res?.ok) { showToast(res?.error || 'Failed to convert', true); btn.disabled=false; return; }
  showToast(`${res.sick_hours_added.toFixed(2)} sick hrs applied ✓`);
  await loadLeavePanel();
}

async function submitCallOff() {
  const userId = document.getElementById('co-user').value;
  const date   = document.getElementById('co-date').value;
  const hours  = parseFloat(document.getElementById('co-hours').value);
  const sick   = document.getElementById('co-sick').checked;
  const notes  = document.getElementById('co-notes').value.trim();
  const result = document.getElementById('co-result');

  if (!userId || !date || !hours || hours <= 0) {
    showToast('Please fill in all required fields', true); return;
  }

  result.style.display = 'none';
  const res = await apiFetch('/api/leave/calloff', {
    method: 'POST',
    body: { user_id: userId, date, hours_requested: hours, notes, apply_sick_time: sick }
  });

  if (!res?.ok) {
    result.style.cssText = 'display:block;color:var(--red);margin-top:10px;font-size:12px;font-family:var(--mono)';
    result.textContent = res?.error || 'Failed to record call-off';
    return;
  }

  let msg = `Call-off recorded.`;
  if (res.sick_hours_applied > 0) msg += ` ${res.sick_hours_applied.toFixed(2)} sick hrs applied.`;
  result.style.cssText = 'display:block;color:var(--green);margin-top:10px;font-size:12px;font-family:var(--mono)';
  result.textContent = msg;

  // Reset form
  document.getElementById('co-hours').value = '8';
  document.getElementById('co-sick').checked = false;
  document.getElementById('co-notes').value  = '';

  showToast('Call-off recorded ✓');
  await loadLeaveAll();
  refreshLeavePendingBadge();
}

// Wire leave tab into switchTab
const _origSwitchTab = switchTab;
switchTab = function(name, el) {
  _origSwitchTab(name, el);
  if (name === 'leave') loadLeavePanel();
};

// ══════════════════════════════
//  UI UPGRADES
// ══════════════════════════════

// ─── Count-up ───
function adminCountUp(el, target, dur=600, fmt='int') {
  if (!el) return;
  const startT = performance.now();
  el.classList.remove('val-pop');
  void el.offsetWidth;
  el.classList.add('val-pop');
  el.addEventListener('animationend', () => el.classList.remove('val-pop'), { once: true });
  function tick(now) {
    const t = Math.min((now - startT) / dur, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    const val = target * ease;
    if (fmt === 'currency') el.textContent = '$' + val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    else if (fmt === 'float1') el.textContent = val.toFixed(1);
    else el.textContent = Math.round(val);
    if (t < 1) requestAnimationFrame(tick);
    else {
      if (fmt === 'currency') el.textContent = '$' + target.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      else if (fmt === 'float1') el.textContent = target.toFixed(1);
      else el.textContent = Math.round(target);
    }
  }
  requestAnimationFrame(tick);
}

// ─── Confetti ───
function adminFireConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  const cols = ['#5b8fff','#a78bfa','#2ecc8a','#f5a623','#f472b6','#38bdf8','#ff5f6d'];
  const ps = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width, y: -20 - Math.random() * 60,
    vx: (Math.random() - .5) * 5, vy: Math.random() * 3 + 1.5,
    color: cols[Math.floor(Math.random() * cols.length)],
    w: Math.random() * 9 + 4, h: Math.random() * 5 + 3,
    rot: Math.random() * Math.PI * 2, vrot: (Math.random() - .5) * .18, life: 1,
  }));
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.vy += .07; p.rot += p.vrot; p.life -= .007;
      if (p.y < canvas.height && p.life > 0) {
        alive = true;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    if (alive) requestAnimationFrame(draw);
    else { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
  }
  requestAnimationFrame(draw);
}

// ─── Ripple ───
function adminAddRipple(e) {
  const el = e.currentTarget;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.5;
  const r = document.createElement('span');
  r.className = 'ripple-ring';
  r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove(), { once: true });
}
function adminInitRipples() {
  document.querySelectorAll('.btn').forEach(el => {
    el.classList.add('ripple-host');
    el.addEventListener('click', adminAddRipple);
  });
}

// ─── Sliding tab indicator ───
function updateTabIndicator() {
  const active = document.querySelector('.tabs .tab.active');
  const ind = document.getElementById('tab-indicator');
  const tabs = document.querySelector('.tabs');
  if (!active || !ind || !tabs) return;
  const tabsRect = tabs.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  ind.style.left = (rect.left - tabsRect.left + tabs.scrollLeft) + 'px';
  ind.style.width = rect.width + 'px';
}

window.addEventListener('resize', updateTabIndicator);
