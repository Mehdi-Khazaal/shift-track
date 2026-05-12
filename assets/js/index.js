// ═══════════════════════════════════════
//  CONFIG & AUTH
// ═══════════════════════════════════════
const API = 'https://shift-track.duckdns.org';

function getToken(){ return localStorage.getItem('st_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('st_user')||'null'); }catch(e){ return null; } }
function setAuth(token,user){ localStorage.setItem('st_token',token); localStorage.setItem('st_user',JSON.stringify(user)); }
function clearAuth(){ localStorage.removeItem('st_token'); localStorage.removeItem('st_user'); }

async function apiFetch(path,options={}){
  const token=getToken();
  const res=await fetch(API+path,{
    ...options,
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(options.headers||{})},
    body:options.body?JSON.stringify(options.body):undefined
  });
  const data=await res.json();
  if(res.status===401){ doLogout(true); return null; }
  return data;
}

async function doLogin(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const errEl=document.getElementById('login-error');
  const btn=document.getElementById('login-btn');
  if(!email||!password){ errEl.textContent='Please enter your email and password.'; errEl.style.display='block'; return; }
  btn.textContent='Signing in…'; btn.disabled=true; errEl.style.display='none';
  try{
    const data=await apiFetch('/api/auth/login',{method:'POST',body:{email,password}});
    if(!data?.ok){ errEl.textContent=data?.error||'Invalid email or password.'; errEl.style.display='block'; btn.textContent='Sign in'; btn.disabled=false; return; }
    setAuth(data.token,data.user);
    enterApp(data.user);
  }catch(e){
    errEl.textContent='Could not connect to server. Try again.'; errEl.style.display='block'; btn.textContent='Sign in'; btn.disabled=false;
  }
}

function doLogout(force=false){
  if(!force && !confirm('Sign out of ShiftTrack?')) return;
  clearAuth();
  cache.locations=[]; cache.shifts=[]; cache.base=[]; cache.settings=null; cache.suppressedBases=[]; cache.loaded=false; cache.allShiftsLoaded=false;
  swapsData=[];
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-email').value='';
  document.getElementById('login-password').value='';
  document.getElementById('login-btn').textContent='Sign in';
  document.getElementById('login-btn').disabled=false;
  document.getElementById('login-error').style.display='none';
}

function enterApp(user){
  document.getElementById('login-screen').classList.add('hidden');
  const firstName=(user.name||user.email.split('@')[0]).split(' ')[0];
  const nameEl=document.getElementById('dash-user-name');
  if(nameEl) nameEl.textContent=firstName;
  const av=document.getElementById('dash-user-avatar');
  if(av) av.textContent=(user.name||user.email).split(' ').slice(0,2).map(n=>n[0]).join('').toUpperCase().slice(0,2);
  loadAllData();
  // Pre-warm leave cache in background (runs after login regardless of retry state)
  setTimeout(()=>{ loadLeaveData().catch(()=>{}); }, 2000);
}

document.addEventListener('DOMContentLoaded',()=>{
  ['login-email','login-password'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  });
  initRipples();
  requestAnimationFrame(updateNavIndicator);
  const token=getToken(), user=getUser();
  if(token&&user) enterApp(user);
});

// ═══════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════
const MAX_DAY_HOURS = 18;
// Pay period anchor: March 22, 2026
const DEFAULT_ANCHOR = '2026-03-22';

// ═══════════════════════════════════════
//  DATA LAYER — API-backed with local cache
//  All data lives in Neon via the Render API.
//  We keep an in-memory cache so renders are instant.
// ═══════════════════════════════════════
const cache = { locations:[], shifts:[], base:[], settings:null, unavailability:[], suppressedBases:[], loaded:false, allShiftsLoaded:false };

function getLocations(){ return cache.locations; }
function getShifts()   { return cache.shifts;    }
function getBase()     { return cache.base;      }
function getSettings() {
  const s = cache.settings || {};
  // ppAnchor may come back as full ISO timestamp "2026-03-22T00:00:00.000Z" — strip to date only
  const rawAnchor = s.pp_anchor || DEFAULT_ANCHOR;
  const ppAnchor = rawAnchor.slice(0,10);
  const otThreshold = parseFloat(s.ot_threshold) || 40;
  return { otThreshold, ppAnchor };
}

// Load all data via the bootstrap endpoint (1 request, 1 auth check, 6 parallel DB queries).
// Shifts are filtered to the last 12 weeks on startup; older history loads on demand.
// Retries up to 3 times with increasing delays (handles Render cold start).
async function loadAllData(attempt=1){
  const MAX = 3;
  showToast(attempt===1 ? 'Loading your data…' : `Connecting… (${attempt}/${MAX})`, false, 20000);
  const from = toYMD(new Date(Date.now() - 84 * 86400000)); // 12 weeks back
  try {
    const res = await apiFetch('/api/bootstrap?from=' + from);
    if(!res?.ok) throw new Error(res?.error || 'Bootstrap failed');
    cache.locations       = res.locations.map(normalizeLocation);
    cache.shifts          = res.shifts.map(normalizeShift);
    cache.suppressedBases = res.suppressed_bases || [];
    cache.base            = res.schedule.map(normalizeBase);
    cache.settings        = res.settings;
    cache.unavailability  = res.unavailability.map(normalizeUnavail);
    cache.allShiftsLoaded = !res.shifts_partial;
    cache.loaded = true;
    showToast('Ready ✓');
    renderDash();
    renderAllShifts();
    renderSchedule();
    renderSettings();
    renderCalendar();
    loadSwaps();
    startLiveTicker();
  } catch(e) {
    console.error('Failed to load data (attempt '+attempt+'):', e);
    if(attempt < MAX){
      const delay = attempt * 15000; // 15s, 30s
      showToast(`Server waking up… retrying in ${delay/1000}s`, false, delay+2000);
      setTimeout(() => loadAllData(attempt+1), delay);
    } else {
      showToast('Could not connect. Tap here to retry.', true);
      document.getElementById('toast').onclick = () => loadAllData(1);
    }
  }
}

async function loadAllShiftHistory(options={}){
  const shouldRender = options.render !== false;
  if(cache.allShiftsLoaded) return true;
  showToast('Loading older history...', false, 20000);
  const res = await apiFetch('/api/shifts');
  if(!res?.ok){ showToast('Failed to load history', true); return false; }
  cache.shifts          = res.shifts.map(normalizeShift);
  cache.suppressedBases = res.suppressed_bases || [];
  cache.allShiftsLoaded = true;
  if(shouldRender){
    renderAllShifts();
    renderDash();
    showToast('History loaded');
  }
  return true;
}

// Normalize API response fields to match what the app expects
function normalizeLocation(l){
  return {
    id:l.id, name:l.name, color:l.color, rate:parseFloat(l.rate), address:l.address||'',
    phone:l.phone||'', regionName:l.region_name||'', specialistName:l.specialist_name||'', consumerCount:l.consumer_count||0
  };
}
function normalizeShift(s){
  return {
    id:          s.id,
    locationId:  s.location_id,
    date:        s.date.slice(0,10),
    start:       s.start_time.slice(0,5),
    end:         s.end_time.slice(0,5),
    notes:       s.notes||'',
    adminNotes:  s.admin_notes||'',
    openShiftId: s.open_shift_id||null,
    awardedBy:   s.awarded_by_name||'',
    locked:      !!s.open_shift_id,
    isBase:      false,
    isPulled:    !!s.is_pulled,
    pulledFromLocationName: s.from_location_name||null,
    pullBonus:   parseFloat(s.pull_bonus)||0,
  };
}
function normalizeBase(b){
  return {
    id:         b.id,
    locationId: b.location_id,
    week:       b.week,
    day:        b.day_of_week,
    start:      b.start_time.slice(0,5),
    end:        b.end_time.slice(0,5),
  };
}
function normalizeUnavail(u){
  return {
    id:        u.id,
    startDate: (u.start_date||'').slice(0,10),
    endDate:   (u.end_date||'').slice(0,10),
    startTime: u.start_time ? u.start_time.slice(0,5) : null,
    endTime:   u.end_time   ? u.end_time.slice(0,5)   : null,
    note:      u.note||'',
  };
}
function getUnavailForDate(dateStr){
  return cache.unavailability.filter(u=>dateStr>=u.startDate && dateStr<=u.endDate);
}

async function saveSettings(){
  // Company-fixed settings — nothing to save
}

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

function parseTimeString(t){
  if(!t) return null;
  const raw=String(t).trim().toUpperCase();

  // Handles values like 07:00, 15:00, 07:00 AM, 3:00 PM, and 15:00:00
  const match=raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/);
  if(!match) return null;

  let h=parseInt(match[1],10);
  const m=parseInt(match[2],10);
  const meridiem=match[3]||'';

  if(meridiem==='AM'){
    if(h===12) h=0;
  } else if(meridiem==='PM'){
    if(h!==12) h+=12;
  }

  return { h, m, total: h*60+m };
}

function fmtTime(t){
  const parsed=parseTimeString(t);
  if(!parsed) return '—';
  const { h, m } = parsed;
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}

// Hours between two times. Handles overnight when end <= start.
function shiftHours(start,end){
  const s=parseTimeString(start);
  const e=parseTimeString(end);
  if(!s||!e) return 0;
  let mins=e.total-s.total;
  if(mins<=0) mins+=1440;
  return Math.round((mins/60)*10)/10; // 1 decimal
}

function formatPay(n){ return '$'+n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function toYMD(d){
  if(!d || typeof d.toISOString !== 'function') return null;
  return d.toISOString().slice(0,10);
}
function getLocById(id){ return getLocations().find(l=>l.id===id); }

function getAssignedLocation(){
  const user=getUser();
  if(!user?.location_id) return null;
  return getLocById(user.location_id) || null;
}

// ─── Pay period ───
// Anchor: first day of a known period. Every 14 days from there is a new period.
function getPayPeriod(offset=0){
  const { ppAnchor } = getSettings();
  const anchor = new Date(ppAnchor+'T00:00:00');
  const today  = new Date(); today.setHours(0,0,0,0);
  const diffDays = Math.round((today-anchor)/86400000);
  const n = diffDays<0 ? Math.ceil(diffDays/14) : Math.floor(diffDays/14);
  const start = new Date(anchor); start.setDate(anchor.getDate()+(n+offset)*14);
  const end   = new Date(start);  end.setDate(start.getDate()+13);
  return { start, end };
}

// ─── Week helpers ───
function getWeekStart(offset=0){
  const d=new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate()-d.getDay()+offset*7);
  return d;
}
function getWeekDates(offset=0){
  const s=getWeekStart(offset);
  return Array.from({length:7},(_,i)=>{ const d=new Date(s); d.setDate(s.getDate()+i); return d; });
}
function weekDatesForDate(dateStr){
  const d=new Date(dateStr+'T12:00:00');
  const sun=new Date(d); sun.setDate(d.getDate()-d.getDay()); sun.setHours(0,0,0,0);
  return Array.from({length:7},(_,i)=>{ const x=new Date(sun); x.setDate(sun.getDate()+i); return x; });
}

// ─── Pay-period week number (1 or 2) for a given date ───
function payWeekOf(dateStr){
  const { ppAnchor }=getSettings();
  const anchor=new Date(ppAnchor+'T00:00:00');
  const d=new Date(dateStr+'T00:00:00');
  const diff=Math.round((d-anchor)/86400000);
  const inPeriod=((diff%14)+14)%14;
  return inPeriod<7?1:2;
}

// ─── Resolve a base schedule entry to a concrete date within a given week ───
// Returns null if the date is suppressed (e.g. due to a swap)
function baseToDate(base, weekDates){
  if(!weekDates || !weekDates[0]) return null;
  const sundayStr=toYMD(weekDates[0]);
  if(!sundayStr) return null;
  if(payWeekOf(sundayStr)!==base.week) return null;
  const dayDate = weekDates[base.day];
  if(!dayDate) return null;
  const dateStr = toYMD(dayDate);
  if((cache.suppressedBases||[]).includes(dateStr)) return null;
  return dateStr;
}

// ═══════════════════════════════════════
//  OT ENGINE
//  Input: array of {id, locationId, date, start, end, isBase?}
//  Output: totalHrs, totalPay, totalOt, breakdown[]
//  OT = hours past the weekly threshold (resets each week)
// ═══════════════════════════════════════
function computeWeekPay(shifts){
  const thresh=getSettings().otThreshold;
  let regRunning=0, totalPay=0;
  const sorted=[...shifts].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  const breakdown=sorted.map(s=>{
    const loc=getLocById(s.locationId);
    const rate=loc?loc.rate:0;
    const rawHrs=shiftHours(s.start,s.end);
    // Approved call-offs reduce worked hours (unpaid)
    const callOffHrs=leaveCache.loaded
      ? leaveCache.requests
          .filter(r=>r.type_name==='call_off'&&r.status==='approved'&&r.date&&String(r.date).slice(0,10)===s.date)
          .reduce((sum,r)=>sum+parseFloat(r.hours_requested||0),0)
      : 0;
    const hrs=Math.max(0,rawHrs-callOffHrs);
    const regHrs=Math.max(0,Math.min(hrs,thresh-regRunning));
    const otHrs=hrs-regHrs;
    const pay=regHrs*rate+otHrs*rate*1.5+(s.pullBonus||0);
    regRunning+=regHrs;
    totalPay+=pay;
    return {...s,hrs,rawHrs,callOffHrs,regHrs,otHrs,pay,rate};
  });
  const totalHrs=breakdown.reduce((a,b)=>a+b.hrs,0);
  const totalOt =breakdown.reduce((a,b)=>a+b.otHrs,0);
  return {totalHrs,totalPay,totalOt,breakdown};
}

// ═══════════════════════════════════════
//  CONFLICT CHECKER
//  Returns error string or null
// ═══════════════════════════════════════
function toMins(t){ const parsed=parseTimeString(t); return parsed?parsed.total:0; }
function toMinsEnd(start,end){ let s=toMins(start),e=toMins(end); if(e<=s) e+=1440; return e; }

function dateToDay(dateStr){
  return Math.round(new Date(dateStr+'T00:00:00').getTime()/86400000);
}
function shiftToAbsRange(date,start,end){
  const base=dateToDay(date)*1440;
  const s=toMins(start);
  let e=toMins(end);
  if(e<=s) e+=1440;
  return {startMins:base+s, endMins:base+e};
}

// Checks whether adding newShift would create a block of >18 consecutive hours
// (shifts within 60 min of each other are treated as part of the same block).
// Includes both logged shifts and base schedule shifts.
function checkConsecutiveChain(newShift, skipId=null){
  const GAP=60, MAX=MAX_DAY_HOURS*60;
  const newRange=shiftToAbsRange(newShift.date,newShift.start,newShift.end);

  // Resolve base schedule entries to actual dates within ±2 days of the new shift
  const baseRanges=[];
  for(let offset=-2;offset<=2;offset++){
    const d=new Date(newShift.date+'T12:00:00');
    d.setDate(d.getDate()+offset);
    const dateStr=toYMD(d);
    if(!dateStr) continue;
    const wkDates=weekDatesForDate(dateStr);
    getBase()
      .filter(b=>baseToDate(b,wkDates)===dateStr)
      .forEach(b=>baseRanges.push(shiftToAbsRange(dateStr,b.start,b.end)));
  }

  const allRanges=[
    ...getShifts().filter(s=>s.id!==skipId).map(s=>shiftToAbsRange(s.date,s.start,s.end)),
    ...baseRanges,
    newRange
  ];
  const visited=new Set([newRange]);
  const queue=[newRange];
  let minStart=newRange.startMins, maxEnd=newRange.endMins;
  while(queue.length){
    const curr=queue.shift();
    for(const other of allRanges){
      if(visited.has(other)) continue;
      const g1=other.startMins-curr.endMins;
      const g2=curr.startMins-other.endMins;
      if((g1>=0&&g1<GAP)||(g2>=0&&g2<GAP)){
        visited.add(other);
        queue.push(other);
        minStart=Math.min(minStart,other.startMins);
        maxEnd=Math.max(maxEnd,other.endMins);
      }
    }
  }
  const span=maxEnd-minStart;
  if(span>MAX){
    const h=Math.floor(span/60), m=span%60;
    const label=m>0?`${h}h ${m}m`:`${h}h`;
    return `These shifts total ${label} consecutive (max 18h; shifts within 1h of each other count as one block).`;
  }
  return null;
}

function checkConflicts(newShift, skipId=null){
  const {date,start,end}=newShift;
  const hrs=shiftHours(start,end);

  // 1. Single shift too long (>18 h; exactly 18 is allowed)
  if(hrs>MAX_DAY_HOURS)
    return `This shift is ${hrs.toFixed(1)} consecutive hours. Shifts over ${MAX_DAY_HOURS}h are not allowed.`;

  // 2. Collect all other shifts on this date
  const loggedSameDay=getShifts().filter(s=>s.date===date&&s.id!==skipId);
  const wkDates=weekDatesForDate(date);
  const baseSameDay=getBase()
    .filter(b=>baseToDate(b,wkDates)===date)
    .map(b=>({...b,isBase:true,name:getLocById(b.locationId)?.name||'base shift'}));

  const existing=[
    ...loggedSameDay.map(s=>({start:s.start,end:s.end,name:getLocById(s.locationId)?.name||'shift',isBase:false})),
    ...baseSameDay.map(b=>({start:b.start,end:b.end,name:b.name,isBase:true}))
  ];

  // 3. Time overlap
  const ns=toMins(start), ne=toMinsEnd(start,end);
  for(const ex of existing){
    const es=toMins(ex.start), ee=toMinsEnd(ex.start,ex.end);
    if(ns<ee&&ne>es)
      return `Overlap with your ${ex.isBase?'base ':''}shift at ${fmtTime(ex.start)}–${fmtTime(ex.end)} (${ex.name}).`;
  }

  // 4. Back-to-back consecutive hours across shifts (≤1h gap = same block, max 18h)
  return checkConsecutiveChain(newShift, skipId);
}

// ═══════════════════════════════════════
//  NAV
// ═══════════════════════════════════════
let weekOffset=0;
let payPeriodOffset=0;
function changeWeek(dir){ weekOffset+=dir; renderDash(); }
function changePayPeriod(dir){ payPeriodOffset+=dir; renderDash(); }

function switchScreen(name,el){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  el.classList.add('active');
  updateNavIndicator();
  if(name==='dash')     renderDash();
  if(name==='log')      { renderAllShifts(); loadOpenShifts(); }
  if(name==='calendar') {
    if(activeLeaveSubtab === 'cal') renderCalendar();
    else loadLeaveData();
  }
  if(name==='history')  renderHistory();
  if(name==='settings'){ renderSettings(); loadNotifStatus(); }
}
function openSheet(id){ document.getElementById(id).classList.add('open'); }
function closeSheet(id){ document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.sheet-overlay').forEach(o=>{
  o.addEventListener('click',e=>{ if(e.target===o) o.classList.remove('open'); });
});

// ═══════════════════════════════════════
//  LOCATIONS
// ═══════════════════════════════════════
function openAddLocation(id=null){
  document.getElementById('edit-loc-id').value=id||'';
  document.getElementById('loc-name').value='';
  document.getElementById('loc-rate').value='';
  document.getElementById('delete-loc-btn').style.display='none';
  document.getElementById('sheet-loc-title').textContent=id?'Edit Location':'Add Location';
  document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
  document.querySelector('.color-swatch').classList.add('selected');
  if(id){
    const loc=getLocById(id);
    if(loc){
      document.getElementById('loc-name').value=loc.name;
      document.getElementById('loc-rate').value=loc.rate;
      document.querySelectorAll('.color-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.c===loc.color));
      document.getElementById('delete-loc-btn').style.display='block';
    }
  }
  openSheet('sheet-location');
}
function pickColor(el){
  document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
  el.classList.add('selected');
}
async function saveLocation(){
  const name=document.getElementById('loc-name').value.trim();
  const rate=parseFloat(document.getElementById('loc-rate').value);
  const color=document.querySelector('.color-swatch.selected')?.dataset.c||'#5b8fff';
  if(!name){ showToast('Enter a location name',true); return; }
  if(isNaN(rate)||rate<0){ showToast('Enter a valid pay rate',true); return; }
  const editId=document.getElementById('edit-loc-id').value;
  const res = await apiFetch(
    editId ? `/api/locations/${editId}` : '/api/locations',
    { method: editId?'PUT':'POST', body:{name,rate,color} }
  );
  if(!res?.ok){ showToast(res?.error||'Failed to save',true); return; }
  // Update cache
  if(editId){ const i=cache.locations.findIndex(l=>l.id===editId); if(i>=0) cache.locations[i]=normalizeLocation(res.location); }
  else cache.locations.push(normalizeLocation(res.location));
  closeSheet('sheet-location'); renderSettings(); showToast('Location saved');
}
async function deleteLocation(){
  const id=document.getElementById('edit-loc-id').value;
  const res=await apiFetch(`/api/locations/${id}`,{method:'DELETE'});
  if(!res?.ok){ showToast('Failed to delete',true); return; }
  cache.locations=cache.locations.filter(l=>l.id!==id);
  closeSheet('sheet-location'); renderSettings(); showToast('Location removed');
}

// ═══════════════════════════════════════
//  SHIFT FORM
// ═══════════════════════════════════════
function openAddShift(id=null){
  if(id){
    const s=getShifts().find(x=>x.id===id);
    if(s?.locked){ showToast(`Awarded by ${s.awardedBy||'Admin'} — contact your admin to make changes`,false); return; }
  }
  const locs=getLocations();
  if(!locs.length){ showToast('Add a location first in Settings',true); switchScreen('settings',document.querySelector('[data-screen="settings"]')); return; }
  document.getElementById('edit-shift-id').value=id||'';
  document.getElementById('sheet-shift-title').textContent=id?'Edit Shift':'Log Shift';
  document.getElementById('delete-shift-btn').style.display=id?'block':'none';
  document.getElementById('shift-calc').style.display='none';
  document.getElementById('conflict-msg').style.display='none';
  document.getElementById('save-shift-btn').disabled=false;
  document.getElementById('save-shift-btn').style.opacity='1';

  const sel=document.getElementById('shift-location');
  sel.innerHTML=locs.map(l=>`<option value="${l.id}">${l.name} — $${l.rate}/hr</option>`).join('');

  if(id){
    const s=getShifts().find(x=>x.id===id);
    if(s){ sel.value=s.locationId; document.getElementById('shift-date').value=s.date; document.getElementById('shift-start').value=s.start; document.getElementById('shift-end').value=s.end; document.getElementById('shift-notes').value=s.notes||''; }
  } else {
    const assigned=getAssignedLocation();
    if(assigned) sel.value=assigned.id;
    document.getElementById('shift-date').value=toYMD(new Date());
    document.getElementById('shift-start').value='07:00';
    document.getElementById('shift-end').value='15:00';
    document.getElementById('shift-notes').value='';
  }
  updateCalc(); openSheet('sheet-shift');
}

function updateCalc(){
  const start=document.getElementById('shift-start').value;
  const end  =document.getElementById('shift-end').value;
  const date =document.getElementById('shift-date').value;
  const locId=document.getElementById('shift-location').value;
  const loc  =getLocById(locId);
  const editId=document.getElementById('edit-shift-id').value;
  const conflEl=document.getElementById('conflict-msg');
  const saveBtn=document.getElementById('save-shift-btn');

  // Conflict check
  if(start&&end&&date){
    const err=checkConflicts({date,start,end,locationId:locId},editId||null);
    if(err){
      conflEl.textContent='⛔  '+err; conflEl.style.display='block';
      saveBtn.disabled=true; saveBtn.style.opacity='.45';
    } else {
      conflEl.style.display='none'; saveBtn.disabled=false; saveBtn.style.opacity='1';
    }
  }
  if(!start||!end||!loc) return;

  // OT preview: insert this shift into the full week and let the OT engine sort chronologically
  const hrs=shiftHours(start,end);
  const wkDates=weekDatesForDate(date||toYMD(new Date()));
  const wkYMDs=wkDates.map(toYMD);
  const PREVIEW_ID='__preview__';
  const otherLogged=getShifts().filter(s=>wkYMDs.includes(s.date)&&s.id!==(editId||PREVIEW_ID));
  const baseShifts=getBase()
    .map(b=>({...b,date:baseToDate(b,wkDates)}))
    .filter(b=>b.date&&wkYMDs.includes(b.date));
  const previewShift={id:PREVIEW_ID,locationId:locId,date,start,end};
  const {breakdown}=computeWeekPay([...otherLogged,...baseShifts,previewShift]);
  const entry=breakdown.find(s=>s.id===PREVIEW_ID);
  const regHrs=entry?entry.regHrs:0;
  const otHrs =entry?entry.otHrs :0;
  const pay   =entry?entry.pay   :0;

  document.getElementById('shift-calc').style.display='block';
  document.getElementById('calc-dur').textContent=hrs.toFixed(1)+' hrs';
  document.getElementById('calc-rate').textContent='$'+loc.rate+'/hr';
  const otRow=document.getElementById('calc-ot-row');
  if(otHrs>0){ otRow.style.display='flex'; document.getElementById('calc-ot-hrs').textContent=otHrs.toFixed(1)+' hrs @ 1.5×'; }
  else { otRow.style.display='none'; }
  document.getElementById('calc-pay').textContent=formatPay(pay)+(otHrs>0?' (incl. OT)':'');
}

async function saveShift(){
  const locationId=document.getElementById('shift-location').value;
  const date=document.getElementById('shift-date').value;
  const start=document.getElementById('shift-start').value;
  const end=document.getElementById('shift-end').value;
  const notes=document.getElementById('shift-notes').value.trim();
  const editId=document.getElementById('edit-shift-id').value;
  if(!locationId||!date||!start||!end){ showToast('Fill in all required fields',true); return; }
  const err=checkConflicts({date,start,end,locationId},editId||null);
  if(err){ showToast(err,true); return; }
  const res=await apiFetch(
    editId?`/api/shifts/${editId}`:'/api/shifts',
    { method:editId?'PUT':'POST', body:{location_id:locationId,date,start_time:start,end_time:end,notes} }
  );
  if(!res?.ok){ showToast(res?.error||'Failed to save shift',true); return; }
  const norm=normalizeShift(res.shift);
  if(editId){ const i=cache.shifts.findIndex(s=>s.id===editId); if(i>=0) cache.shifts[i]=norm; }
  else { cache.shifts.push(norm); fireConfetti(); }
  closeSheet('sheet-shift'); renderDash(); renderAllShifts();
  if(document.getElementById('screen-calendar').classList.contains('active')) renderCalendar();
  showToast('Shift saved ✓');
}

async function deleteShift(){
  const id=document.getElementById('edit-shift-id').value;
  const s=getShifts().find(x=>x.id===id);
  if(s?.locked){ showToast(`Awarded shift — contact your admin to remove it`,false); return; }
  const res=await apiFetch(`/api/shifts/${id}`,{method:'DELETE'});
  if(!res?.ok){ showToast(res?.error||'Failed to delete',true); return; }
  cache.shifts=cache.shifts.filter(s=>s.id!==id);
  closeSheet('sheet-shift'); renderDash(); renderAllShifts();
  if(document.getElementById('screen-calendar').classList.contains('active')) renderCalendar();
  showToast('Shift deleted');
}

// ═══════════════════════════════════════
//  BASE SCHEDULE
// ═══════════════════════════════════════
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function openAddBase(id=null){
  const locs=getLocations();
  if(!locs.length){ showToast('Add a location first',true); return; }
  document.getElementById('edit-base-id').value=id||'';
  document.getElementById('sheet-base-title').textContent=id?'Edit Base Shift':'Add Base Shift';
  document.getElementById('delete-base-btn').style.display=id?'block':'none';
  const sel=document.getElementById('base-location');
  sel.innerHTML=locs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  if(id){
    const b=getBase().find(x=>x.id===id);
    if(b){ document.getElementById('base-week').value=b.week; document.getElementById('base-day').value=b.day; sel.value=b.locationId; document.getElementById('base-start').value=b.start; document.getElementById('base-end').value=b.end; }
  } else {
    document.getElementById('base-week').value='1';
    document.getElementById('base-day').value='1';
    document.getElementById('base-start').value='07:00';
    document.getElementById('base-end').value='15:00';
  }
  openSheet('sheet-base');
}

async function saveBase(){
  const week=parseInt(document.getElementById('base-week').value);
  const day=parseInt(document.getElementById('base-day').value);
  const locationId=document.getElementById('base-location').value;
  const start=document.getElementById('base-start').value;
  const end=document.getElementById('base-end').value;
  if(!locationId||!start||!end){ showToast('Fill in all fields',true); return; }
  const editId=document.getElementById('edit-base-id').value;
  const res=await apiFetch(
    editId?`/api/schedule/${editId}`:'/api/schedule',
    { method:editId?'PUT':'POST', body:{week,day_of_week:day,location_id:locationId,start_time:start,end_time:end} }
  );
  if(!res?.ok){ showToast(res?.error||'Failed to save',true); return; }
  const norm=normalizeBase(res.entry);
  if(editId){ const i=cache.base.findIndex(b=>b.id===editId); if(i>=0) cache.base[i]=norm; }
  else cache.base.push(norm);
  closeSheet('sheet-base'); renderSchedule(); renderDash(); showToast('Base shift saved');
}

async function deleteBase(){
  const id=document.getElementById('edit-base-id').value;
  const res=await apiFetch(`/api/schedule/${id}`,{method:'DELETE'});
  if(!res?.ok){ showToast('Failed to delete',true); return; }
  cache.base=cache.base.filter(b=>b.id!==id);
  closeSheet('sheet-base'); renderSchedule(); renderDash(); showToast('Base shift removed');
}

// ═══════════════════════════════════════
//  RENDER: DASHBOARD
// ═══════════════════════════════════════
function renderDash(){
  const settings=getSettings();
  const thresh=settings.otThreshold;
  const wkDates=getWeekDates(weekOffset);
  const wkYMDs=wkDates.map(toYMD);

  // Week label
  const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  document.getElementById('week-label').textContent=`${fmt(wkDates[0])}–${fmt(wkDates[6])}`;

  // Logged shifts this week
  const logged=getShifts().filter(s=>wkYMDs.includes(s.date));

  // Base shifts this week
  const baseThisWeek=getBase()
    .map(b=>({...b,date:baseToDate(b,wkDates),isBase:true}))
    .filter(b=>b.date!==null);

  const allShifts=[...baseThisWeek,...logged.map(s=>({...s,isBase:false}))];
  const {totalHrs,totalPay,totalOt,breakdown}=computeWeekPay(allShifts);

  countUp(document.getElementById('stat-hours'), totalHrs, 600, 'float1');
  countUp(document.getElementById('stat-pay'),   totalPay, 700, 'currency');
  countUp(document.getElementById('stat-ot'),    totalOt,  600, 'float1');
  countUp(document.getElementById('stat-shifts'),allShifts.length, 400, 'int');

  const pct=Math.min(100,(totalHrs/thresh)*100);
  const bar=document.getElementById('prog-hrs');
  bar.style.width=pct+'%';
  bar.className='prog-bar'+(totalOt>0?' over':totalHrs>=thresh*.8?' warn':'');

  // ── Pay period ──
  const {start:ppS,end:ppE}=getPayPeriod(payPeriodOffset);
  const ppYMDs=[];
  for(let d=new Date(ppS);d<=ppE;d.setDate(d.getDate()+1)) ppYMDs.push(toYMD(new Date(d)));
  const ppW1=ppYMDs.slice(0,7), ppW2=ppYMDs.slice(7,14);

  function ppWeekShifts(ymdSet){
    // Need the week dates for this set so we can resolve base shifts
    const wkD=ymdSet.map(y=>new Date(y+'T12:00:00'));
    const ppLogged=getShifts().filter(s=>ymdSet.includes(s.date));
    const ppBase=getBase()
      .map(b=>({...b,date:baseToDate(b,wkD),isBase:true}))
      .filter(b=>b.date&&ymdSet.includes(b.date));
    return computeWeekPay([...ppLogged,...ppBase]);
  }
  const r1=ppWeekShifts(ppW1), r2=ppWeekShifts(ppW2);
  const ppTotal=r1.totalPay+r2.totalPay;
  const ppHrs  =r1.totalHrs+r2.totalHrs;
  const ppOt   =r1.totalOt +r2.totalOt;

  countUp(document.getElementById('pp-pay'), ppTotal, 800, 'currency');
  document.getElementById('pp-hrs').textContent   =ppHrs.toFixed(1)+' hrs total';
  document.getElementById('pp-ot-label').textContent=ppOt>0?`${ppOt.toFixed(1)} hrs OT`:'';
  document.getElementById('pp-dates').textContent =fmt(ppS)+' – '+fmt(ppE);
  document.getElementById('pp-nav-label').textContent = payPeriodOffset===0 ? 'Current' : (payPeriodOffset<0 ? `${Math.abs(payPeriodOffset)} back` : `+${payPeriodOffset}`);
  document.getElementById('prog-pp').style.width  =Math.min(100,(ppHrs/(thresh*2))*100)+'%';

  // ── Hours by location ──
  const locHrs={};
  allShifts.forEach(s=>{ locHrs[s.locationId]=(locHrs[s.locationId]||0)+shiftHours(s.start,s.end); });
  const locBars=document.getElementById('loc-bars');
  if(!Object.keys(locHrs).length){
    locBars.innerHTML='<div class="empty-state" style="padding:12px;font-size:12px">No shifts this week</div>';
  } else {
    const maxH=Math.max(...Object.values(locHrs));
    locBars.innerHTML=Object.entries(locHrs).map(([lid,hrs])=>{
      const loc=getLocById(lid); if(!loc) return '';
      return `<div class="hr-bar-row">
        <div class="hr-bar-loc" style="color:${loc.color}">${loc.name}</div>
        <div class="hr-bar-bg"><div class="hr-bar-fill" style="width:${(hrs/maxH)*100}%;background:${loc.color}"></div></div>
        <div class="hr-bar-val">${hrs.toFixed(1)}h</div>
      </div>`;
    }).join('');
  }

  // ── Shift list ──
  // Build a lookup from shift id → breakdown entry
  const bdMap={};
  breakdown.forEach(b=>{ bdMap[b.id+(b.isBase?'_b':'')]=b; });

  const sorted=[...allShifts].sort((a,b2)=>a.date.localeCompare(b2.date)||a.start.localeCompare(b2.start));
  const listEl=document.getElementById('shift-list-dash');
  if(!sorted.length){
    listEl.innerHTML='<div class="empty-state"><div class="icon">🗓</div>No shifts this week.<br>Tap ＋ to log one.</div>';
    return;
  }
  const myId=getUser()?.id;
  const dashSwapDateMap={};
  swapsData.filter(sw=>sw.status==='accepted').forEach(sw=>{
    const myDate=sw.initiator_id===myId?(sw.target_date||'').slice(0,10):(sw.initiator_date||'').slice(0,10);
    dashSwapDateMap[myDate]=sw.id;
  });
  listEl.innerHTML=sorted.map(s=>{
    const key=s.id+(s.isBase?'_b':'');
    return shiftItemHTML(s,bdMap[key],(!s.isBase&&dashSwapDateMap[s.date])||null);
  }).join('');
}

// ═══════════════════════════════════════
//  RENDER: ALL SHIFTS
// ═══════════════════════════════════════
function renderAllShifts(){
  renderShiftActionInbox();
  const shifts=getShifts();
  const el=document.getElementById('shift-list-all');
  if(!shifts.length){ el.innerHTML='<div class="empty-state"><div class="icon">📋</div>No shifts yet.<br>Tap ＋ to add your first.</div>'; return; }

  // Group by week (Sun as key, descending)
  const sorted=[...shifts].sort((a,b)=>b.date.localeCompare(a.date)||b.start.localeCompare(a.start));
  const groups=new Map();
  sorted.forEach(s=>{
    const wkD=weekDatesForDate(s.date);
    const key=toYMD(wkD[0]);
    if(!groups.has(key)) groups.set(key,{wkD,shifts:[]});
    groups.get(key).shifts.push(s);
  });

  const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const today=toYMD(new Date());

  // Current week key — open by default, past weeks collapsed
  const currentWkKey=toYMD(weekDatesForDate(today)[0]);

  const groupsHtml=[...groups.entries()].map(([key,{wkD,shifts:wkShifts}])=>{
    const wkY=wkD.map(toYMD);
    const allWkShifts=[
      ...getShifts().filter(x=>wkY.includes(x.date)),
      ...getBase().map(b=>({...b,date:baseToDate(b,wkD),isBase:true})).filter(b=>b.date&&wkY.includes(b.date))
    ];
    const {breakdown}=computeWeekPay(allWkShifts);
    const totHrs=wkShifts.reduce((t,s)=>t+shiftHours(s.start,s.end),0);
    const totPay=wkShifts.reduce((t,s)=>{
      const bd=breakdown.find(b=>b.id===s.id&&!b.isBase);
      return t+(bd?bd.pay:shiftHours(s.start,s.end)*(getLocById(s.locationId)?.rate||0));
    },0);

    const isCurrentWk=key===currentWkKey;
    const weekLabel=`${fmt(wkD[0])} – ${fmt(wkD[6])}`;
    const myId=getUser()?.id;
    const acceptedSwapDateMap={};
    swapsData.filter(sw=>sw.status==='accepted').forEach(sw=>{
      const myDate=sw.initiator_id===myId?(sw.target_date||'').slice(0,10):(sw.initiator_date||'').slice(0,10);
      acceptedSwapDateMap[myDate]=sw.id;
    });
    const shiftsHtml=wkShifts.map(s=>{
      const bd=breakdown.find(b=>b.id===s.id&&!b.isBase);
      return shiftItemHTML({...s,isBase:false},bd,acceptedSwapDateMap[s.date]||null);
    }).join('');

    return `<div class="wk-group" id="wkg-${key}">
      <div class="wk-group-hd${isCurrentWk?' open':''}" onclick="toggleWeek('${key}')">
        <svg class="wk-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 4 10 8 6 12"/></svg>
        <span class="wk-label">${weekLabel}</span>
        <span class="wk-meta">${wkShifts.length} shift${wkShifts.length!==1?'s':''} · ${totHrs.toFixed(1)}h · ${formatPay(totPay)}</span>
      </div>
      <div class="wk-shifts-card${isCurrentWk?'':' collapsed'}">${shiftsHtml}</div>
    </div>`;
  }).join('');

  el.innerHTML = groupsHtml + (!cache.allShiftsLoaded
    ? `<div style="text-align:center;padding:18px 0 6px">
        <button class="btn" style="font-size:13px;color:var(--muted);background:none;border:1px solid var(--border);border-radius:10px;padding:8px 20px;cursor:pointer" onclick="loadAllShiftHistory()">Load older history</button>
       </div>`
    : '');
}

function toggleWeek(key){
  const hd=document.querySelector(`#wkg-${key} .wk-group-hd`);
  const body=document.querySelector(`#wkg-${key} .wk-shifts-card`);
  if(!hd||!body) return;
  const isOpen=hd.classList.contains('open');
  hd.classList.toggle('open',!isOpen);
  body.classList.toggle('collapsed',isOpen);
}

// ═══════════════════════════════════════
//  SHIFT ITEM HTML
// ═══════════════════════════════════════
function getShiftsForDateRange(startDate, days){
  const out=[];
  for(let i=0;i<days;i++){
    const d=new Date(startDate);
    d.setDate(startDate.getDate()+i);
    out.push(...getShiftsForDate(toYMD(d)));
  }
  return out.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
}

function renderShiftActionInbox(){
  const box=document.getElementById('shift-action-inbox');
  if(!box) return;
  const myId=getUser()?.id;
  const now=new Date();
  const fmtD=d=>{ const x=new Date(d+'T12:00:00'); return x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };
  const items=[];

  swapsData.filter(s=>s.status==='pending').slice(0,4).forEach(s=>{
    const iAmInitiator=s.initiator_id===myId;
    const title=iAmInitiator?`Waiting on ${s.target_name}`:`Swap request from ${s.initiator_name}`;
    const detail=iAmInitiator
      ?`${fmtD((s.initiator_date||'').slice(0,10))} for ${fmtD((s.target_date||'').slice(0,10))}`
      :`${s.initiator_location_name} for ${s.target_location_name} on ${fmtD((s.target_date||'').slice(0,10))}`;
    const actions=iAmInitiator
      ?`<button class="btn btn-ghost btn-sm" onclick="cancelSwap('${s.id}')">Cancel</button>`
      :`<button class="btn btn-primary btn-sm" onclick="respondSwap('${s.id}','accepted')">Accept</button><button class="btn btn-ghost btn-sm" onclick="respondSwap('${s.id}','rejected')">Decline</button>`;
    items.push(`<div class="inbox-item">
      <div class="inbox-icon swap">SW</div>
      <div class="inbox-main"><div class="inbox-title">${title}</div><div class="inbox-detail">${detail}</div></div>
      <div class="inbox-actions">${actions}</div>
    </div>`);
  });

  openShiftsData.filter(s=>!s.my_response).slice(0,4).forEach(s=>{
    const dl=new Date(s.deadline);
    const hours=Math.max(0,Math.round((dl-now)/3600000));
    const deadline=hours<1?'Due soon':hours<24?`${hours}h left`:dl.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    items.push(`<div class="inbox-item">
      <div class="inbox-icon open">OS</div>
      <div class="inbox-main"><div class="inbox-title">${s.location_name}</div><div class="inbox-detail">${(s.date||'').slice(0,10)} · ${s.start_time.slice(0,5)}-${s.end_time.slice(0,5)} · ${deadline}</div></div>
      <div class="inbox-actions"><button class="btn btn-primary btn-sm" onclick="respondOpenShift('${s.id}','claimed')">Claim</button><button class="btn btn-ghost btn-sm" onclick="respondOpenShift('${s.id}','rejected')">Decline</button></div>
    </div>`);
  });

  getShiftsForDateRange(now, 2)
    .filter(s=>!getLeaveForDate(s.date).length)
    .slice(0,3)
    .forEach(s=>{
      const start=new Date(`${s.date}T${s.start}:00`).getTime();
      if(start<now.getTime() || start>now.getTime()+172800000) return;
      const loc=getLocById(s.locationId);
      items.push(`<div class="inbox-item">
        <div class="inbox-icon soon">UP</div>
        <div class="inbox-main"><div class="inbox-title">Upcoming shift</div><div class="inbox-detail">${fmtD(s.date)} · ${loc?.name||'Unknown'} · ${fmtTime(s.start)}-${fmtTime(s.end)}</div></div>
        <div class="inbox-actions"><button class="btn btn-ghost btn-sm" onclick="openDaySheet('${s.date}')">View</button></div>
      </div>`);
    });

  if(!items.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='';
  box.innerHTML=`<div class="section-hd"><h2>Action Inbox</h2></div><div class="action-inbox-card">${items.join('')}</div>`;
}

function shiftItemHTML(s,bd,swapId=null){
  const loc  =getLocById(s.locationId);
  const color=loc?.color||'#888';
  const name =loc?.name||'Unknown';
  const rate =loc?.rate||0;
  const rawHrs=shiftHours(s.start,s.end);
  // bd.hrs already accounts for call-off deduction via computeWeekPay
  const effectiveHrs=bd?bd.hrs:rawHrs;
  const pay  =bd?bd.pay:effectiveHrs*rate;
  const otHrs=bd?bd.otHrs:0;
  const d    =new Date(s.date+'T12:00:00');
  const ds   =d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});

  // Determine shift state: done / active / upcoming
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const yestD = new Date(now); yestD.setDate(yestD.getDate() - 1);
  const yesterdayLocal = `${yestD.getFullYear()}-${String(yestD.getMonth()+1).padStart(2,'0')}-${String(yestD.getDate()).padStart(2,'0')}`;
  const nowMins = now.getHours()*60 + now.getMinutes();
  const stP = parseTimeString(s.start), enP = parseTimeString(s.end);
  let shiftState = 'upcoming';
  if(s.date === yesterdayLocal && stP && enP && enP.total < stP.total){
    // Overnight shift that started yesterday — check if we're still in the post-midnight window
    if(nowMins < enP.total) shiftState = 'active';
    else                    shiftState = 'done';
  } else if(s.date < todayLocal){
    shiftState = 'done';
  } else if(s.date === todayLocal && stP && enP){
    let enM = enP.total; if(enM <= stP.total) enM += 1440;
    if(nowMins >= enM)            shiftState = 'done';
    else if(nowMins >= stP.total) shiftState = 'active';
  }

  // Approved leave for this date
  const leaves=getLeaveForDate(s.date);
  const callOffLeave=leaves.find(r=>r.type_name==='call_off');
  const ptoLeave    =leaves.find(r=>r.type_name==='pto');
  const sickLeave   =leaves.find(r=>r.type_name==='sick_time');

  // Leave note row — show time range if partial, otherwise just hours
  function leaveRange(r){
    const h=parseFloat(r.hours_requested).toFixed(1);
    return r.start_time&&r.end_time
      ?`${fmtTime(String(r.start_time).slice(0,5))}–${fmtTime(String(r.end_time).slice(0,5))} (${h}h)`
      :`${h}h`;
  }
  let leaveNote='';
  if(callOffLeave){
    leaveNote=`<div class="ot-note" style="color:#f87171">✗ Call Off · ${leaveRange(callOffLeave)} unpaid</div>`;
  } else if(ptoLeave){
    leaveNote=`<div class="ot-note" style="color:#60a5fa">🌴 PTO · ${leaveRange(ptoLeave)}</div>`;
  } else if(sickLeave){
    leaveNote=`<div class="ot-note" style="color:#a78bfa">🤒 Sick · ${leaveRange(sickLeave)}</div>`;
  }

  // Hours display: "3.0/8.0 hrs" for partial call-off, "0.0 hrs" for full
  const hrsDisplay=callOffLeave
    ?`${effectiveHrs.toFixed(1)}/${rawHrs.toFixed(1)} hrs`
    :`${effectiveHrs.toFixed(1)} hrs`;

  let badge='';
  if(shiftState==='active')            badge='<span class="badge live">● LIVE</span>';
  else if(swapId)                      badge='<span class="badge swap">⇄ SWAPPED</span>';
  else if(callOffLeave)                badge='<span class="badge" style="background:rgba(248,113,113,.15);color:#f87171;border-color:rgba(248,113,113,.3)">CALL OFF</span>';
  else if(ptoLeave)                    badge='<span class="badge" style="background:rgba(96,165,250,.15);color:#60a5fa;border-color:rgba(96,165,250,.3)">PTO</span>';
  else if(sickLeave)                   badge='<span class="badge" style="background:rgba(167,139,250,.15);color:#a78bfa;border-color:rgba(167,139,250,.3)">SICK</span>';
  else if(s.isPulled)                  badge='<span class="badge" style="background:rgba(255,140,0,.15);color:#ff8c00;border-color:rgba(255,140,0,.3)">PULL</span>';
  else if(s.isBase)                    badge='<span class="badge base">BASE</span>';
  else if(effectiveHrs>0&&otHrs>=effectiveHrs) badge='<span class="badge ot">OT</span>';
  else if(otHrs>0)                     badge='<span class="badge mix">REG+OT</span>';
  else                                 badge='<span class="badge reg">REG</span>';

  const otNote=otHrs>0
    ?`<div class="ot-note">${(effectiveHrs-otHrs).toFixed(1)}h reg · ${otHrs.toFixed(1)}h OT @ 1.5×</div>`:'';
  const pullNote=s.isPulled
    ?`<div class="ot-note" style="color:#ff8c00">Pulled${s.pulledFromLocationName?` from ${s.pulledFromLocationName}`:''}${s.pullBonus>0?` · +$${s.pullBonus.toFixed(0)} pull bonus`:''}</div>`
    :'';

  const click=s.isBase?`showToast('Base shifts are set by your administrator',false)`:`openAddShift('${s.id}')`;
  const payStr=formatPay(pay);
  const schedLabel=s.isBase?` <span style="font-size:10px;opacity:.6">(schedule)</span>`:'';
  const awardedTag=s.locked&&s.awardedBy?`<div class="notes-chip" style="color:var(--accent)">Awarded by ${s.awardedBy}</div>`:'';
  const adminNotesChip=s.adminNotes?`<div class="notes-chip">${s.adminNotes.slice(0,40)}${s.adminNotes.length>40?'…':''}</div>`:'';

  const itemClass=`shift-item${s.isBase?' base-item':''}${shiftState==='done'?' done':''}${shiftState==='active'?' active-shift':''}`;

  const cancelSwapBtn = swapId
    ? `<button class="cancel-swap-btn" onclick="event.stopPropagation();cancelAcceptedSwap('${swapId}')">Cancel swap</button>`
    : '';

  return `<div class="${itemClass}" onclick="${click}">
    <div class="shift-dot${s.isBase?' sq':''}" style="background:${color}"></div>
    <div class="shift-info">
      <div class="name">${name}${schedLabel}</div>
      <div class="sub">${ds} · ${fmtTime(s.start)}–${fmtTime(s.end)}</div>
      ${leaveNote}
      ${otNote}
      ${pullNote}
      ${awardedTag}
      ${s.notes?`<div class="notes-chip">${s.notes.slice(0,40)}${s.notes.length>40?'…':''}</div>`:''}
      ${adminNotesChip}
      ${cancelSwapBtn}
    </div>
    <div class="shift-right">
      <div class="pay">${payStr}</div>
      <div class="hrs">${hrsDisplay}</div>
      ${badge}
    </div>
  </div>`;
}

// ═══════════════════════════════════════
//  RENDER: SCHEDULE
// ═══════════════════════════════════════
function renderSchedule(){
  [1,2].forEach(wk=>{
    const wkShifts=getBase().filter(b=>b.week===wk).sort((a,b)=>a.day-b.day||a.start.localeCompare(b.start));
    const el=document.getElementById(`base-week${wk}`);
    if(!wkShifts.length){ el.innerHTML=`<div class="empty-state" style="padding:20px;font-size:12px">No shifts for week ${wk}</div>`; return; }
    el.innerHTML=wkShifts.map(b=>{
      const loc=getLocById(b.locationId);
      const locName=loc?.name||'—';
      return `<div class="shift-item base-item">
        <div class="shift-dot sq" style="background:${loc?.color||'#888'}"></div>
        <div class="shift-info">
          <div class="name">${DAYS[b.day]}</div>
          <div class="sub">${locName} · ${fmtTime(b.start)}–${fmtTime(b.end)}</div>
        </div>
        <div class="shift-right">
          <div class="hrs">${shiftHours(b.start,b.end).toFixed(1)} hrs</div>
          <span class="badge base">BASE</span>
        </div>
      </div>`;
    }).join('');
  });
}

// ═══════════════════════════════════════
//  RENDER: SETTINGS
// ═══════════════════════════════════════
function renderSettings(){
  renderSettingsProfile();
  renderSettingsAvailability();
  const locs=getLocations();
  const el=document.getElementById('location-list');
  const label=document.getElementById('locations-summary-label');
  if(label) label.textContent=locs.length?`Locations (${locs.length})`:'Locations';
  if(!locs.length){ el.innerHTML='<div class="empty-state" style="padding:20px;font-size:12px">No locations yet</div>'; return; }
  el.innerHTML=locs.map(l=>`
    <div class="shift-item" style="flex-direction:column;align-items:stretch;gap:0;padding:0">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px">
        <div class="shift-dot" style="background:${l.color};flex-shrink:0"></div>
        <div class="shift-info" style="flex:1;min-width:0">
          <div class="name">${l.name}</div>
          <div class="sub">${l.regionName?l.regionName+' · ':''}<span style="color:var(--green)">$${l.rate.toFixed(2)}/hr</span></div>
        </div>
        ${l.address?`<button data-addr="${l.address.replace(/"/g,'&quot;')}" onclick="event.stopPropagation();openMapAddress(this.dataset.addr)" title="Get directions to ${l.name}" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:rgba(91,143,255,.12);border:1px solid rgba(91,143,255,.25);color:var(--accent);flex-shrink:0;cursor:pointer;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></button>`:''}
        ${l.phone?`<a href="tel:${l.phone.replace(/"/g,'&quot;')}" onclick="event.stopPropagation()" title="Call ${l.name}" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:rgba(46,204,138,.12);border:1px solid rgba(46,204,138,.25);color:var(--green);flex-shrink:0;cursor:pointer;text-decoration:none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.26h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.83 5.83l1.77-1.77a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7a2 2 0 0 1 1.72 2.02z"/></svg></a>`:''}
      </div>
      ${l.specialistName?`<div style="display:flex;align-items:center;gap:6px;padding:6px 14px 10px 38px;font-size:11px;font-family:var(--mono);color:var(--muted)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;flex-shrink:0"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Specialist: <span style="color:var(--text);font-weight:600">${l.specialistName}</span></div>`:''}
    </div>`).join('');
}

function renderSettingsProfile(){
  const el=document.getElementById('settings-profile-card');
  if(!el) return;
  const user=getUser()||{};
  const loc=getAssignedLocation();
  const name=user.name||user.email?.split('@')[0]||'Employee';
  const hire=user.hire_date
    ? new Date(String(user.hire_date).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
    : 'Not set';
  el.innerHTML=`
    <div class="settings-profile-head">
      <div class="settings-profile-avatar">${name.split(' ').slice(0,2).map(n=>n[0]).join('').toUpperCase().slice(0,2)}</div>
      <div>
        <div class="settings-profile-name">${name}</div>
        <div class="settings-profile-email">${user.email||''}</div>
      </div>
    </div>
    <div class="settings-profile-grid">
      <div><span>Position</span><b>${user.position||'Not assigned'}</b></div>
      <div><span>Assigned house</span><b>${loc?.name||user.location_name||'Not assigned'}</b></div>
      <div><span>Hire date</span><b>${hire}</b></div>
      <div><span>Role</span><b>${user.role==='admin'?'Admin':user.role==='specialist'?'Specialist':'Employee'}</b></div>
    </div>`;
}

function renderSettingsAvailability(){
  const el=document.getElementById('settings-unavail-list');
  if(!el) return;
  const today=toYMD(new Date());
  const entries=[...cache.unavailability]
    .filter(u=>u.endDate>=today)
    .sort((a,b)=>a.startDate.localeCompare(b.startDate)||(a.startTime||'').localeCompare(b.startTime||''));
  if(!entries.length){
    el.innerHTML='<div class="empty-state" style="padding:16px;font-size:12px">No unavailable time set</div>';
    return;
  }
  const fmt=s=>new Date(s+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
  el.innerHTML=entries.map(u=>{
    const dateText=u.startDate===u.endDate ? fmt(u.startDate) : `${fmt(u.startDate)}-${fmt(u.endDate)}`;
    const timeText=u.startTime ? `${fmtTime(u.startTime)}-${fmtTime(u.endTime)}` : 'All day';
    return `<div class="settings-unavail-row">
      <div class="settings-unavail-mark"></div>
      <div class="settings-unavail-main">
        <div>${dateText}</div>
        <span>${timeText}${u.note?' · '+u.note:''}</span>
      </div>
      <button onclick="deleteUnavail('${u.id}')" class="settings-unavail-remove">Remove</button>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
//  MAP HELPER — lets the OS pick the app
// ═══════════════════════════════════════
function openMapAddress(address){
  const q = encodeURIComponent(address);
  const ua = navigator.userAgent;
  const url = /iPad|iPhone|iPod/.test(ua)
    ? `maps://?q=${q}`                                          // iOS: opens default maps app
    : /Android/.test(ua)
    ? `geo:0,0?q=${q}`                                          // Android: native app picker
    : `https://www.google.com/maps/search/?api=1&query=${q}`;  // Desktop
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════
function showToast(msg,isErr=false,duration=2800){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=isErr?'err':'';
  t.onclick=null;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>t.classList.remove('show','err'),duration);
}
function confirmClearData(){
  if(confirm('This will sign you out. Your data stays safe in the cloud.\n\nContinue?')){
    doLogout();
  }
}

// ═══════════════════════════════════════
//  PHASE 2: CALENDAR
// ═══════════════════════════════════════
let calView = 'month'; // 'month' | 'week'
let calOffset = 0;     // months offset for month view, weeks for week view
let daySheetDate = ''; // currently open day sheet date
let calSelectedDate = toYMD(new Date());

function setCalView(v){
  calView = v;
  calOffset = 0;
  document.getElementById('btn-month').classList.toggle('active', v==='month');
  document.getElementById('btn-week').classList.toggle('active',  v==='week');
  renderCalendar();
}
function calNav(dir){ calOffset += dir; renderCalendar(); }

// Get all shifts (logged + base) for a given YYYY-MM-DD
function getShiftsForDate(dateStr){
  const logged = getShifts().filter(s=>s.date===dateStr).map(s=>({...s,isBase:false}));
  const wkD = weekDatesForDate(dateStr);
  const base = getBase()
    .filter(b=>baseToDate(b,wkD)===dateStr)
    .map(b=>({...b,date:dateStr,isBase:true}));
  return [...base,...logged].sort((a,b)=>a.start.localeCompare(b.start));
}

function renderCalendar(){
  if(calView==='month') renderCalMonth();
  else                  renderCalWeek();
  renderCalDayPreview(calSelectedDate);
}

function renderCalMonth(){
  document.getElementById('cal-month-view').style.display='block';
  document.getElementById('cal-week-view').style.display='none';

  const today = new Date(); today.setHours(0,0,0,0);
  const ref   = new Date(today.getFullYear(), today.getMonth()+calOffset, 1);
  document.getElementById('cal-title').textContent =
    ref.toLocaleDateString('en-US',{month:'long',year:'numeric'});

  // Build grid: pad to start on Sunday
  const firstDay = ref.getDay(); // 0=Sun
  const daysInMonth = new Date(ref.getFullYear(), ref.getMonth()+1, 0).getDate();
  const cells = [];

  // Prev month padding
  for(let i=0;i<firstDay;i++){
    const d=new Date(ref.getFullYear(), ref.getMonth(), -firstDay+i+1);
    cells.push({date:d, otherMonth:true});
  }
  // This month
  for(let i=1;i<=daysInMonth;i++){
    cells.push({date:new Date(ref.getFullYear(),ref.getMonth(),i), otherMonth:false});
  }
  // Next month padding to complete last row
  while(cells.length%7!==0){
    const last=cells[cells.length-1].date;
    const d=new Date(last); d.setDate(d.getDate()+1);
    cells.push({date:d, otherMonth:true});
  }

  const grid = document.getElementById('cal-month-grid');
  grid.innerHTML = cells.map(({date,otherMonth})=>{
    const ymd = toYMD(date);
    const isToday = toYMD(date)===toYMD(today);
    const isSelected = ymd===calSelectedDate;
    const shifts = getShiftsForDate(ymd);
    const unavail = getUnavailForDate(ymd);
    const leaves  = getLeaveForDate(ymd);
    const leaveCls = leaves.length
      ? (leaves[0].type_name==='pto' ? ' leave-pto' : leaves[0].type_name==='sick_time' ? ' leave-sick' : ' leave-calloff')
      : '';
    const dots = shifts.slice(0,4).map(s=>{
      const loc=getLocById(s.locationId);
      return `<div class="cal-dot${s.isBase?' sq':''}" style="background:${loc?.color||'#888'}"></div>`;
    }).join('');
    const firstColor = shifts.length ? (getLocById(shifts[0].locationId)?.color||null) : null;
    const cellStyle = firstColor ? ` style="--cc:${firstColor}"` : '';
    return `<div class="cal-cell${otherMonth?' other-month':''}${isToday?' today':''}${isSelected?' selected':''}${shifts.length?' has-shift':''}${unavail.length?' unavail':''}${leaveCls}"${cellStyle} onclick="selectCalendarDay('${ymd}')">
      <div class="cal-dn">${date.getDate()}</div>
      ${unavail.length?'<div class="unavail-stripe"></div>':''}
      ${dots?`<div class="cal-dots">${dots}</div>`:''}
    </div>`;
  }).join('');
}

function renderCalWeek(){
  document.getElementById('cal-month-view').style.display='none';
  document.getElementById('cal-week-view').style.display='block';

  const today = new Date(); today.setHours(0,0,0,0);
  const wkDates = getWeekDates(calOffset);
  const fmt = d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  document.getElementById('cal-title').textContent =
    `${fmt(wkDates[0])} – ${fmt(wkDates[6])}`;

  const DAY_SHORT=['Su','Mo','Tu','We','Th','Fr','Sa'];
  const grid = document.getElementById('cal-week-grid');
  grid.innerHTML = wkDates.map((d,i)=>{
    const ymd = toYMD(d);
    const isToday = ymd===toYMD(today);
    const shifts = getShiftsForDate(ymd);
    const pillsHTML = shifts.map(s=>{
      const loc=getLocById(s.locationId);
      return `<div class="cal-shift-pill" onclick="event.stopPropagation();openDaySheet('${ymd}')">
        <div class="cal-shift-pill"><div class="pill-dot${s.isBase?' sq':''}" style="background:${loc?.color||'#888'}"></div>
        <span class="pill-name">${loc?.name||'—'}${s.isBase?' (base)':''}</span>
        <span class="pill-time">${fmtTime(s.start)}</span></div>
      </div>`;
    }).join('');
    const addBtn = `<div class="cal-add-pill" onclick="event.stopPropagation();openAddShiftForDateStr('${ymd}')">+ add</div>`;
    return `<div class="cal-week-row${isToday?' today':''}${ymd===calSelectedDate?' selected':''}" onclick="selectCalendarDay('${ymd}')">
      <div class="cal-week-day-label${isToday?' today':''}">
        <div class="wd">${DAY_SHORT[i]}</div>
        <div class="dn">${d.getDate()}</div>
      </div>
      <div class="cal-week-shifts">
        ${shifts.length?pillsHTML:`<div class="cal-week-empty">—</div>`}
        ${addBtn}
      </div>
    </div>`;
  }).join('');
}

function selectCalendarDay(dateStr){
  calSelectedDate = dateStr;
  renderCalendar();
}

function renderCalDayPreview(dateStr){
  const el=document.getElementById('cal-day-preview');
  if(!el || !dateStr) return;
  const d=new Date(dateStr+'T12:00:00');
  const title=d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  const shifts=getShiftsForDate(dateStr);
  const unavails=getUnavailForDate(dateStr);
  const leaves=getLeaveForDate(dateStr);
  const rows=[];
  shifts.slice(0,3).forEach(s=>{
    const loc=getLocById(s.locationId);
    rows.push(`<div class="cal-preview-row">
      <span class="preview-mark${s.isBase?' sq':''}" style="background:${loc?.color||'#888'}"></span>
      <span>${loc?.name||'Unknown'}${s.isBase?' · base':''}</span>
      <b>${fmtTime(s.start)}-${fmtTime(s.end)}</b>
    </div>`);
  });
  leaves.forEach(r=>{
    rows.push(`<div class="cal-preview-row leave"><span class="preview-mark leave"></span><span>${r.type_label||r.type_name}</span><b>${parseFloat(r.hours_requested||0).toFixed(1)}h</b></div>`);
  });
  unavails.forEach(u=>{
    rows.push(`<div class="cal-preview-row muted"><span class="preview-mark unavailable"></span><span>Unavailable</span><b>${u.startTime?`${fmtTime(u.startTime)}-${fmtTime(u.endTime)}`:'All day'}</b></div>`);
  });
  el.innerHTML=`<div class="cal-preview-hd">
      <div><div class="cal-preview-title">${title}</div><div class="cal-preview-meta">${rows.length?`${rows.length} item${rows.length!==1?'s':''}`:'No shifts or requests'}</div></div>
      <button class="btn btn-ghost btn-sm" onclick="openDaySheet('${dateStr}')">Open</button>
    </div>
    ${rows.length?`<div class="cal-preview-list">${rows.join('')}</div>`:'<div class="cal-preview-empty">Tap Open to log a shift, mark unavailable, or request leave.</div>'}`;
}

// ── Day sheet ──
function openDaySheet(dateStr){
  calSelectedDate = dateStr;
  daySheetDate = dateStr;
  const d = new Date(dateStr+'T12:00:00');
  const title = d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  document.getElementById('day-sheet-title').textContent = title;

  const shifts = getShiftsForDate(dateStr);
  const listEl = document.getElementById('day-shift-list');
  const unavails = getUnavailForDate(dateStr);

  // Show unavailability entries at top
  const unavailHTML = unavails.map(u=>`
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="width:10px;height:10px;border-radius:2px;background:var(--muted);flex-shrink:0;opacity:.6"></div>
      <div style="flex:1">
        <div style="font-size:13px;color:var(--muted)">Unavailable${u.startTime?` · ${fmtTime(u.startTime)}–${fmtTime(u.endTime)}`:' · All day'}</div>
        ${u.note?`<div style="font-size:11px;color:var(--dim);font-family:var(--mono);margin-top:2px">${u.note}</div>`:''}
      </div>
      <button onclick="deleteUnavail('${u.id}')" style="background:none;border:none;color:var(--dim);font-size:16px;cursor:pointer;padding:4px 6px;line-height:1" title="Remove">✕</button>
    </div>`).join('');

  if(!shifts.length){
    listEl.innerHTML=(unavailHTML||'<div style="text-align:center;padding:16px 0;color:var(--muted);font-family:var(--mono);font-size:12px">No shifts on this day</div>');
    document.getElementById('day-summary').style.display='none';
  } else {
    // Compute OT in weekly context
    const wkD = weekDatesForDate(dateStr);
    const wkY = wkD.map(toYMD);
    const allWk = [
      ...getShifts().filter(s=>wkY.includes(s.date)),
      ...getBase().map(b=>({...b,date:baseToDate(b,wkD),isBase:true})).filter(b=>b.date&&wkY.includes(b.date))
    ];
    const {breakdown} = computeWeekPay(allWk);
    const bdMap = {}; breakdown.forEach(b=>{ bdMap[b.id+(b.isBase?'_b':'')]=b; });

    listEl.innerHTML = unavailHTML + shifts.map(s=>{
      const key = s.id+(s.isBase?'_b':'');
      return shiftItemHTML(s, bdMap[key]);
    }).join('');

    // Summary — use effective hours/pay from breakdown (call-offs already deducted)
    const dayShifts = shifts;
    const dayHrs = dayShifts.reduce((a,s)=>{
      const key=s.id+(s.isBase?'_b':'');
      const bd=bdMap[key];
      return a+(bd?bd.hrs:shiftHours(s.start,s.end));
    },0);
    const dayPay = dayShifts.reduce((a,s)=>{
      const key=s.id+(s.isBase?'_b':'');
      const bd=bdMap[key];
      return a+(bd?bd.pay:0);
    },0);
    document.getElementById('day-summary').style.display='block';
    document.getElementById('day-total-hrs').textContent=dayHrs.toFixed(1)+' hrs';
    document.getElementById('day-total-pay').textContent=formatPay(dayPay);
  }
  openSheet('sheet-day');
}

function openAddShiftForDay(){
  closeSheet('sheet-day');
  setTimeout(()=>openAddShiftForDateStr(daySheetDate), 200);
}

function openAddShiftForDateStr(dateStr){
  const locs=getLocations();
  if(!locs.length){ showToast('Add a location first in Settings',true); return; }
  document.getElementById('edit-shift-id').value='';
  document.getElementById('sheet-shift-title').textContent='Log Shift';
  document.getElementById('delete-shift-btn').style.display='none';
  document.getElementById('shift-calc').style.display='none';
  document.getElementById('conflict-msg').style.display='none';
  document.getElementById('save-shift-btn').disabled=false;
  document.getElementById('save-shift-btn').style.opacity='1';
  const sel=document.getElementById('shift-location');
  sel.innerHTML=locs.map(l=>`<option value="${l.id}">${l.name} — $${l.rate}/hr</option>`).join('');
  const assigned=getAssignedLocation();
  if(assigned) sel.value=assigned.id;
  document.getElementById('shift-date').value=dateStr;
  document.getElementById('shift-start').value='07:00';
  document.getElementById('shift-end').value='15:00';
  document.getElementById('shift-notes').value='';
  updateCalc();
  openSheet('sheet-shift');
}

// ═══════════════════════════════════════
//  PHASE 2: PAY HISTORY
// ═══════════════════════════════════════
async function renderHistory(){
  const el = document.getElementById('history-list');
  if(!cache.allShiftsLoaded){
    el.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px">Loading full pay history...</div>';
    const loaded = await loadAllShiftHistory({ render:false });
    if(!loaded){
      el.innerHTML = '<div class="empty-state" style="padding:16px;font-size:12px">Could not load pay history.</div>';
      return;
    }
    renderAllShifts();
    renderDash();
  }

  const { ppAnchor } = getSettings();
  const anchor = new Date(ppAnchor+'T00:00:00');
  const today  = new Date(); today.setHours(0,0,0,0);
  const diffDays = Math.round((today-anchor)/86400000);
  const currentN = diffDays<0 ? Math.ceil(diffDays/14) : Math.floor(diffDays/14);

  // Show current period + 11 past ones
  const cards = [];
  for(let offset=0; offset>=-11; offset--){
    const n = currentN+offset;
    const start = new Date(anchor); start.setDate(anchor.getDate()+n*14);
    const end   = new Date(start);  end.setDate(start.getDate()+13);

    const ppYMDs=[];
    for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) ppYMDs.push(toYMD(new Date(d)));
    const ppW1=ppYMDs.slice(0,7), ppW2=ppYMDs.slice(7,14);

    function ppWkShifts(ymdSet){
      const wkD=ymdSet.map(y=>new Date(y+'T12:00:00'));
      return computeWeekPay([
        ...getShifts().filter(s=>ymdSet.includes(s.date)),
        ...getBase().map(b=>({...b,date:baseToDate(b,wkD),isBase:true})).filter(b=>b.date&&ymdSet.includes(b.date))
      ]);
    }
    const r1=ppWkShifts(ppW1), r2=ppWkShifts(ppW2);
    const total=r1.totalPay+r2.totalPay;
    const hrs  =r1.totalHrs+r2.totalHrs;
    const ot   =r1.totalOt +r2.totalOt;

    const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const isCurrent=offset===0;
    const isFuture=start>today;
    const capturedOffset=offset;

    cards.push(`<div class="hist-card${isCurrent?' current':''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="flex:1;min-width:0">
          <div class="hist-period">${fmt(start)} – ${fmt(end)}${isCurrent?' · <span style="color:var(--accent)">current</span>':''}</div>
          <div class="hist-pay" style="color:${isFuture?'var(--muted)':'var(--text)'}">${formatPay(total)}</div>
          <div class="hist-meta">
            <div class="hist-chip"><span>${hrs.toFixed(1)}h</span> total</div>
            ${ot>0?`<div class="hist-chip ot"><span>${ot.toFixed(1)}h</span> OT</div>`:''}
            <div class="hist-chip"><span>${r1.totalHrs.toFixed(1)}h</span> wk1 · <span>${r2.totalHrs.toFixed(1)}h</span> wk2</div>
          </div>
        </div>
        ${!isFuture?`<button class="btn btn-ghost btn-sm" style="flex-shrink:0;margin-top:2px" onclick="downloadPayPDF(${capturedOffset})">↓ PDF</button>`:''}
      </div>
    </div>`);
  }
  el.innerHTML = cards.join('');
}

// ═══════════════════════════════════════
//  NOTIFICATIONS — Web Push
// ═══════════════════════════════════════

function urlBase64ToUint8Array(b64){
  const padding='='.repeat((4-b64.length%4)%4);
  const base64=(b64+padding).replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from([...window.atob(base64)].map(c=>c.charCodeAt(0)));
}

async function loadNotifStatus(){
  const toggle=document.getElementById('notif-toggle');
  const timingRow=document.getElementById('notif-timing-row');
  const statusEl=document.getElementById('notif-status');
  if(!toggle) return;

  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    statusEl.textContent='Not supported on this browser.';
    toggle.disabled=true;
    return;
  }
  const res=await apiFetch('/api/notifications/status');
  if(res?.ok && res.subscribed){
    toggle.checked=true;
    timingRow.style.display='block';
    document.getElementById('notif-minutes').value=String(res.notify_minutes||60);
    statusEl.textContent='✓ Active on this device';
    statusEl.style.color='var(--green)';
  } else {
    toggle.checked=false;
    timingRow.style.display='none';
    statusEl.textContent='Off';
    statusEl.style.color='var(--dim)';
  }
}

async function toggleNotifications(){
  const on=document.getElementById('notif-toggle').checked;
  const timingRow=document.getElementById('notif-timing-row');
  const statusEl=document.getElementById('notif-status');

  if(!on){
    await apiFetch('/api/notifications/unsubscribe',{method:'DELETE'});
    timingRow.style.display='none';
    statusEl.textContent='Off';
    statusEl.style.color='var(--dim)';
    showToast('Notifications disabled');
    return;
  }

  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    showToast('Push notifications not supported on this browser',true);
    document.getElementById('notif-toggle').checked=false;
    return;
  }

  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){
      document.getElementById('notif-toggle').checked=false;
      statusEl.textContent='Permission denied — enable in browser settings';
      statusEl.style.color='var(--red)';
      showToast('Permission denied',true);
      return;
    }
    const keyRes=await apiFetch('/api/notifications/vapid-public-key');
    if(!keyRes?.key){ throw new Error('Could not fetch VAPID key'); }
    const reg=await navigator.serviceWorker.register('/shift-track/sw.js');
    await navigator.serviceWorker.ready;
    const existing=await reg.pushManager.getSubscription();
    if(existing) await existing.unsubscribe();
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(keyRes.key)
    });
    const minutes=parseInt(document.getElementById('notif-minutes').value)||60;
    const j=sub.toJSON();
    const res=await apiFetch('/api/notifications/subscribe',{
      method:'POST',
      body:{endpoint:j.endpoint,keys:j.keys,notify_minutes:minutes,tz_offset:new Date().getTimezoneOffset()}
    });
    if(!res?.ok){ throw new Error(res?.error||'Subscribe failed'); }
    timingRow.style.display='block';
    statusEl.textContent='✓ Active on this device';
    statusEl.style.color='var(--green)';
    showToast('Shift reminders enabled ✓');
    apiFetch('/api/notifications/send-upcoming',{method:'POST'});
  } catch(e){
    console.error('Push error:',e);
    document.getElementById('notif-toggle').checked=false;
    statusEl.textContent='Could not enable — try again';
    statusEl.style.color='var(--red)';
    showToast('Failed to enable notifications',true);
  }
}

async function saveNotifMinutes(){
  const minutes=parseInt(document.getElementById('notif-minutes').value)||60;
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(sub){
      const j=sub.toJSON();
      await apiFetch('/api/notifications/subscribe',{
        method:'POST',
        body:{endpoint:j.endpoint,keys:j.keys,notify_minutes:minutes,tz_offset:new Date().getTimezoneOffset()}
      });
      showToast('Reminder timing updated ✓');
    }
  } catch(e){ showToast('Could not update timing',true); }
}

// Trigger reminder check 3 seconds after every login
const _origEnterApp=enterApp;
enterApp=function(user){
  _origEnterApp(user);
  setTimeout(()=>apiFetch('/api/notifications/send-upcoming',{method:'POST'}),3000);
};

// ═══════════════════════════════════════
//  PAY PERIOD PDF (browser print → Save as PDF)
// ═══════════════════════════════════════
async function downloadPayPDF(offset){
  if(!cache.allShiftsLoaded){
    const loaded = await loadAllShiftHistory({ render:false });
    if(!loaded) return;
    renderHistory();
  }

  const { ppAnchor } = getSettings();
  const anchor = new Date(ppAnchor+'T00:00:00');
  const today  = new Date(); today.setHours(0,0,0,0);
  const diffDays = Math.round((today-anchor)/86400000);
  const currentN = diffDays<0 ? Math.ceil(diffDays/14) : Math.floor(diffDays/14);
  const n = currentN+offset;
  const start = new Date(anchor); start.setDate(anchor.getDate()+n*14);
  const end   = new Date(start);  end.setDate(start.getDate()+13);

  const ppYMDs=[];
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) ppYMDs.push(toYMD(new Date(d)));
  const ppW1=ppYMDs.slice(0,7), ppW2=ppYMDs.slice(7,14);

  function weekBreakdown(ymdSet){
    const wkD=ymdSet.map(y=>new Date(y+'T12:00:00'));
    const logged=getShifts().filter(s=>ymdSet.includes(s.date));
    const base=getBase().map(b=>({...b,date:baseToDate(b,wkD),isBase:true})).filter(b=>b.date&&ymdSet.includes(b.date));
    const all=[...base,...logged].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
    const { otThreshold:thresh } = getSettings();
    let regRun=0, rows=[], totPay=0, totHrs=0, totOt=0;
    for(const s of all){
      const loc=getLocById(s.locationId);
      const rate=loc?loc.rate:0;
      const h=shiftHours(s.start,s.end);
      const reg=Math.max(0,Math.min(h,thresh-regRun)), otH=h-reg;
      const p=reg*rate+otH*rate*1.5+(s.pullBonus||0);
      regRun+=reg; totPay+=p; totHrs+=h; totOt+=otH;
      rows.push({...s,h,otH,p,loc});
    }
    return {rows,totPay,totHrs,totOt};
  }

  const w1=weekBreakdown(ppW1), w2=weekBreakdown(ppW2);
  const allRows=[...w1.rows,...w2.rows];
  const totPay=w1.totPay+w2.totPay, totHrs=w1.totHrs+w2.totHrs, totOt=w1.totOt+w2.totOt;
  const pullBonusTotal=allRows.reduce((sum,s)=>sum+(s.pullBonus||0),0);
  const shiftOnlyPay=totPay-pullBonusTotal;
  const fmt=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const user=getUser();

  document.getElementById('pdf-dates').textContent=`${fmt(start)} – ${fmt(end)}`;
  document.getElementById('pdf-employee').innerHTML=`<strong>${user?.name||user?.email||''}</strong>${user?.email&&user?.name?' &nbsp;·&nbsp; '+user.email:''}`;

  document.getElementById('pdf-tbody').innerHTML=allRows.map(s=>{
    const d=new Date(s.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const pullTag=s.isPulled?` <strong style="font-size:9px;background:#fff3e0;color:#c07000;border-radius:2px;padding:0 3px">PULL</strong>`:'';
    const locCell=s.isPulled&&s.pulledFromLocationName
      ?`<span style="text-decoration:line-through;opacity:.5">${s.pulledFromLocationName}</span> → ${s.loc?.name||'—'}`
      :(s.loc?.name||'—');
    return `<tr>
      <td>${d}${pullTag}</td>
      <td>${locCell}</td>
      <td>${s.start}</td>
      <td>${s.end}</td>
      <td>${s.h.toFixed(1)}h${s.otH>0?` (${s.otH.toFixed(1)}h OT)`:''}</td>
      <td style="text-align:right">${formatPay(s.p)}${s.pullBonus>0?`<br><span style="font-size:10px;color:#c07000">incl. +$${s.pullBonus.toFixed(0)} pull</span>`:''}</td>
    </tr>`;
  }).join('');

  document.getElementById('pdf-tfoot').innerHTML=pullBonusTotal>0?`
    <tr class="pdf-total">
      <td colspan="4"><strong>Shift Subtotal</strong></td>
      <td><strong>${totHrs.toFixed(1)}h${totOt>0?' ('+totOt.toFixed(1)+'h OT)':''}</strong></td>
      <td style="text-align:right"><strong>${formatPay(shiftOnlyPay)}</strong></td>
    </tr>
    <tr><td colspan="5">Pull Bonus</td><td style="text-align:right;color:#c07000">+${formatPay(pullBonusTotal)}</td></tr>
    <tr class="pdf-total">
      <td colspan="4"><strong>Total</strong></td>
      <td></td>
      <td style="text-align:right"><strong>${formatPay(totPay)}</strong></td>
    </tr>`:`
    <tr class="pdf-total">
      <td colspan="4"><strong>Total</strong></td>
      <td><strong>${totHrs.toFixed(1)}h${totOt>0?' ('+totOt.toFixed(1)+'h OT)':''}</strong></td>
      <td style="text-align:right"><strong>${formatPay(totPay)}</strong></td>
    </tr>`;

  window.print();
}

// ═══════════════════════════════════════
//  UNAVAILABILITY
// ═══════════════════════════════════════
function openMarkUnavail(){
  document.getElementById('unavail-start').value = daySheetDate;
  document.getElementById('unavail-end').value   = daySheetDate;
  document.getElementById('unavail-allday').checked = true;
  document.getElementById('unavail-time-row').style.display = 'none';
  document.getElementById('unavail-note').value = '';
  closeSheet('sheet-day');
  setTimeout(()=>openSheet('sheet-unavail'), 200);
}

function openAvailabilityFromSettings(){
  const today=toYMD(new Date());
  document.getElementById('unavail-start').value = today;
  document.getElementById('unavail-end').value   = today;
  document.getElementById('unavail-allday').checked = true;
  document.getElementById('unavail-time-row').style.display = 'none';
  document.getElementById('unavail-start-time').value = '09:00';
  document.getElementById('unavail-end-time').value = '17:00';
  document.getElementById('unavail-note').value = '';
  openSheet('sheet-unavail');
}

function toggleUnavailAllDay(){
  const allDay = document.getElementById('unavail-allday').checked;
  document.getElementById('unavail-time-row').style.display = allDay ? 'none' : 'block';
}

async function saveUnavail(){
  const startDate = document.getElementById('unavail-start').value;
  const endDate   = document.getElementById('unavail-end').value;
  const allDay    = document.getElementById('unavail-allday').checked;
  const startTime = allDay ? null : document.getElementById('unavail-start-time').value;
  const endTime   = allDay ? null : document.getElementById('unavail-end-time').value;
  const note      = document.getElementById('unavail-note').value.trim();
  if(!startDate||!endDate){ showToast('Select dates',true); return; }
  if(endDate<startDate){ showToast('End date must be on or after start date',true); return; }
  const res = await apiFetch('/api/unavailability',{method:'POST',body:{start_date:startDate,end_date:endDate,start_time:startTime,end_time:endTime,note}});
  if(!res?.ok){ showToast(res?.error||'Failed to save',true); return; }
  cache.unavailability.push(normalizeUnavail(res.entry));
  closeSheet('sheet-unavail');
  renderCalendar();
  renderSettings();
  showToast('Marked unavailable ✓');
}

async function deleteUnavail(id){
  const res = await apiFetch(`/api/unavailability/${id}`,{method:'DELETE'});
  if(!res?.ok){ showToast('Failed to remove',true); return; }
  cache.unavailability = cache.unavailability.filter(u=>u.id!==id);
  renderCalendar();
  renderSettings();
  if(daySheetDate && document.getElementById('screen-calendar')?.classList.contains('active')) openDaySheet(daySheetDate);
  showToast('Removed ✓');
}

// ═══════════════════════════════════════
//  NOTIFICATION HISTORY
// ═══════════════════════════════════════
let notifHistory = [];

function relativeTime(isoStr){
  const now  = Date.now();
  const then = new Date(isoStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if(diff < 60)   return 'just now';
  if(diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if(diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if(diff < 86400*7) return `${Math.floor(diff/86400)}d ago`;
  return new Date(isoStr).toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

async function loadNotifHistory(){
  const res = await apiFetch('/api/notifications/history');
  if(!res?.ok) return;
  notifHistory = res.notifications || [];
  updateBellBadge();
}

function getLastSeenTs(){
  return localStorage.getItem('st_notif_last_seen') || '1970-01-01T00:00:00Z';
}

function updateBellBadge(){
  const lastSeen  = getLastSeenTs();
  const unread    = notifHistory.filter(n => n.sent_at > lastSeen).length;
  const badge     = document.getElementById('notif-badge');
  if(!badge) return;
  if(unread > 0){
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

function openNotifHistory(){
  // Mark all as read
  localStorage.setItem('st_notif_last_seen', new Date().toISOString());
  updateBellBadge();
  renderNotifHistory();
  openSheet('sheet-notif');
}

function renderNotifHistory(){
  const lastSeen  = getLastSeenTs();
  const el        = document.getElementById('notif-list');
  const clearBtn  = document.getElementById('notif-clear-all-btn');

  if(!notifHistory.length){
    el.innerHTML = '<div class="empty-state"><div class="icon" style="font-size:28px">🔔</div>No notifications yet.</div>';
    if(clearBtn) clearBtn.style.display = 'none';
    return;
  }

  if(clearBtn) clearBtn.style.display = '';

  el.innerHTML = notifHistory.map(n => {
    const isUnread   = n.sent_at > lastSeen;
    const isReminder = n.title === 'Shift Reminder';
    const iconClass  = isReminder ? 'reminder' : 'broadcast';
    const iconEmoji  = isReminder ? '⏰' : '📢';
    return `<div class="notif-item${isUnread?' unread':''}" id="notif-item-${n.id}">
      <div class="notif-icon ${iconClass}">${iconEmoji}</div>
      <div class="notif-body-wrap">
        <div class="notif-title">${n.title}</div>
        <div class="notif-body">${n.body}</div>
        <div class="notif-time">${relativeTime(n.sent_at)}</div>
      </div>
      <div onclick="clearOneNotif('${n.id}')" style="flex-shrink:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:var(--dim);font-size:13px;cursor:pointer;margin-left:4px" title="Dismiss">✕</div>
    </div>`;
  }).join('');
}

async function clearOneNotif(id){
  await apiFetch(`/api/notifications/history/${id}`, { method: 'DELETE' });
  notifHistory = notifHistory.filter(n => String(n.id) !== String(id));
  updateBellBadge();
  renderNotifHistory();
}

async function clearAllNotifs(){
  await apiFetch('/api/notifications/history', { method: 'DELETE' });
  notifHistory = [];
  updateBellBadge();
  renderNotifHistory();
}

// Load notif history after login + after send-upcoming fires
const _origEnterAppNotif = enterApp;
enterApp = function(user){
  _origEnterAppNotif(user);
  setTimeout(loadNotifHistory, 3500); // after send-upcoming settles
  setTimeout(loadOpenShifts, 1000);
};

// ═══════════════════════════════════════
//  OPEN SHIFTS
// ═══════════════════════════════════════
let openShiftsData = [];
let swapsData      = [];
let _swapUsers     = [];

async function loadOpenShifts(){
  const res = await apiFetch('/api/open-shifts');
  if(!res?.ok) return;
  openShiftsData = res.shifts || [];
  renderOpenShifts();
}

let _openShiftDeadlineTimers = [];

function renderOpenShifts(){
  // Clear any previously scheduled deadline timers
  _openShiftDeadlineTimers.forEach(t => clearTimeout(t));
  _openShiftDeadlineTimers = [];

  const section = document.getElementById('open-shifts-section');
  const list    = document.getElementById('open-shifts-list');
  if(!openShiftsData.length){ section.style.display='none'; renderShiftActionInbox(); return; }
  section.style.display = '';

  list.innerHTML = openShiftsData.map(s => {
    const c   = s.location_color || '#888';
    const dl  = new Date(s.deadline);
    const now = new Date();
    const minsLeft = Math.round((dl - now) / 60000);

    // For house shifts where the user is waiting: auto-refresh when the deadline arrives
    if(s.target_type === 'house' && s.my_response === 'claimed' && dl > now){
      const msUntil = dl - now;
      _openShiftDeadlineTimers.push(setTimeout(() => loadOpenShifts(), msUntil + 3000));
    }
    let dlStr;
    if(minsLeft < 0) dlStr = 'Deadline passed';
    else if(minsLeft < 60) dlStr = `Respond within ${minsLeft}m`;
    else if(minsLeft < 1440) dlStr = `Respond within ${Math.round(minsLeft/60)}h`;
    else dlStr = `Deadline: ${dl.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true})}`;

    const isHouse    = s.target_type === 'house';
    const responded  = s.my_response;
    const hasClaimed = responded === 'claimed';
    const hasRejected= responded === 'rejected';

    let actionsHtml;
    if(hasClaimed && isHouse){
      actionsHtml = `<div class="os-badge" style="background:rgba(91,143,255,.12);color:var(--accent)">Waiting — seniority assigned at deadline</div>`;
    } else if(hasClaimed){
      actionsHtml = `<div class="os-badge" style="background:rgba(46,204,138,.12);color:var(--green)">✓ Claimed</div>`;
    } else if(hasRejected){
      actionsHtml = `<div class="os-badge" style="background:var(--bg3);color:var(--dim)">Declined</div>`;
    } else {
      actionsHtml = `
        <button class="btn btn-primary btn-sm" onclick="respondOpenShift('${s.id}','claimed')">Claim</button>
        <button class="btn btn-ghost btn-sm" onclick="respondOpenShift('${s.id}','rejected')">Decline</button>`;
    }

    return `<div class="os-card">
      <div class="os-card-hd">
        <div style="width:10px;height:10px;border-radius:2px;background:${c};flex-shrink:0"></div>
        <div class="os-loc">${s.location_name}</div>
        <div class="os-time">${(s.date||'').slice(0,10)} · ${s.start_time.slice(0,5)}–${s.end_time.slice(0,5)}</div>
        ${isHouse?`<span class="os-badge" style="background:rgba(245,166,35,.1);color:var(--orange)">Seniority</span>`:'<span class="os-badge" style="background:rgba(91,143,255,.1);color:var(--accent)">First come</span>'}
      </div>
      <div class="os-deadline">${dlStr}</div>
      ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-bottom:8px">${s.notes}</div>`:''}
      <div class="os-actions">${actionsHtml}</div>
    </div>`;
  }).join('');
  renderShiftActionInbox();
}

async function respondOpenShift(id, response){
  const res = await apiFetch(`/api/open-shifts/${id}/respond`, { method:'POST', body:{ response } });
  if(!res?.ok){ showToast(res?.error || 'Failed to respond', true); return; }
  if(response === 'claimed' && res.assigned){
    showToast('Shift claimed and added to your schedule ✓');
    // Refresh shifts so My Shifts / calendar / dash update immediately
    const shiftsRes = await apiFetch('/api/shifts');
    if(shiftsRes?.ok){ cache.shifts = shiftsRes.shifts.map(normalizeShift); }
    renderAllShifts();
    renderDash();
    renderCalendar();
  } else if(response === 'claimed' && !res.assigned){
    showToast('Response recorded — assigned at deadline by seniority');
  } else {
    showToast('Shift declined');
  }
  await loadOpenShifts();
}

// ═══════════════════════════════════════
//  SHIFT SWAPS
// ═══════════════════════════════════════

async function loadSwaps(){
  const res = await apiFetch('/api/shift-swaps');
  if(!res?.ok) return;
  swapsData = res.swaps || [];
  renderSwaps();
}

function renderSwaps(){
  const section = document.getElementById('swap-requests-section');
  const list    = document.getElementById('swap-requests-list');
  const myId    = getUser()?.id;

  const active = swapsData.filter(s => s.status === 'pending');
  if(!active.length){ section.style.display = 'none'; renderShiftActionInbox(); return; }
  section.style.display = '';

  const fmtD = d => { const x=new Date(d+'T12:00:00'); return x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };

  list.innerHTML = active.map(s => {
    const iAmInitiator = s.initiator_id === myId;
    const iDate = (s.initiator_date||'').slice(0,10);
    const tDate = (s.target_date||'').slice(0,10);
    const iColor = s.initiator_location_color || '#888';
    const tColor = s.target_location_color    || '#888';

    let actionsHtml;
    if(iAmInitiator){
      actionsHtml = `
        <span class="badge" style="background:rgba(91,143,255,.1);color:var(--accent);border:1px solid rgba(91,143,255,.3)">Awaiting ${s.target_name}</span>
        <button class="btn btn-ghost btn-sm" onclick="cancelSwap('${s.id}')">Cancel</button>`;
    } else {
      actionsHtml = `
        <button class="btn btn-primary btn-sm" onclick="respondSwap('${s.id}','accepted')">Accept</button>
        <button class="btn btn-ghost btn-sm"   onclick="respondSwap('${s.id}','rejected')">Decline</button>`;
    }

    return `<div class="os-card">
      <div class="os-card-hd">
        <div style="width:10px;height:10px;border-radius:2px;background:${iColor};flex-shrink:0"></div>
        <div class="os-loc">${s.initiator_name}</div>
        <span class="os-badge" style="background:rgba(91,143,255,.1);color:var(--accent)">Swap</span>
      </div>
      <div style="font-size:12px;color:var(--muted);font-family:var(--mono);margin:6px 0 4px;line-height:1.6">
        <span style="color:var(--text)">${s.initiator_name}</span> · <span style="color:${iColor}">${s.initiator_location_name}</span> · ${fmtD(iDate)}<br>
        <span style="color:var(--dim)">↕</span><br>
        <span style="color:var(--text)">${s.target_name}</span> · <span style="color:${tColor}">${s.target_location_name}</span> · ${fmtD(tDate)}
      </div>
      <div class="os-actions">${actionsHtml}</div>
    </div>`;
  }).join('');
  renderShiftActionInbox();
}

async function cancelAcceptedSwap(id){
  if(!confirm('Cancel this swap? Both schedules will be restored to their original shifts.')) return;
  const res = await apiFetch(`/api/shift-swaps/${id}/cancel`, { method:'PATCH' });
  if(!res?.ok){ showToast(res?.error || 'Failed to cancel swap', true); return; }
  showToast('Swap cancelled — schedules restored ✓');
  const shiftsRes = await apiFetch('/api/shifts');
  if(shiftsRes?.ok){
    cache.shifts          = shiftsRes.shifts.map(normalizeShift);
    cache.suppressedBases = shiftsRes.suppressed_bases || [];
  }
  renderAllShifts(); renderDash(); renderCalendar();
  await loadSwaps();
}

async function respondSwap(id, response){
  const res = await apiFetch(`/api/shift-swaps/${id}/respond`, { method:'PATCH', body:{ response } });
  if(!res?.ok){ showToast(res?.error || 'Failed to respond', true); return; }
  if(response === 'accepted'){
    fireConfetti();
    showToast('Swap accepted — schedules updated ✓');
    // Reload shifts so the swapped shift appears immediately
    const shiftsRes = await apiFetch('/api/shifts');
    if(shiftsRes?.ok){
      cache.shifts         = shiftsRes.shifts.map(normalizeShift);
      cache.suppressedBases= shiftsRes.suppressed_bases || [];
    }
    renderAllShifts();
    renderDash();
    renderCalendar();
  } else {
    showToast('Swap declined');
  }
  await loadSwaps();
}

async function cancelSwap(id){
  const res = await apiFetch(`/api/shift-swaps/${id}`, { method:'DELETE' });
  if(!res?.ok){ showToast(res?.error || 'Failed to cancel', true); return; }
  showToast('Swap request cancelled');
  await loadSwaps();
}

// ─── Propose swap sheet ───────────────────────────────────────────────────────

async function openSwapPropose(){
  const myShiftSel = document.getElementById('swap-my-shift');
  const fmtD = d => { const x=new Date(d+'T12:00:00'); return x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };

  // Build list of swappable shifts: concrete (non-locked) + base schedule for next 4 weeks
  const entries = [];
  const seenDates = new Set();

  // Concrete logged shifts (skip locked/awarded)
  getShifts().filter(s => !s.locked).forEach(s => {
    seenDates.add(s.date);
    const loc = getLocById(s.locationId);
    entries.push({ date: s.date, label: `${fmtD(s.date)} · ${loc?.name||'?'} · ${fmtTime(s.start)}–${fmtTime(s.end)}` });
  });

  // Base schedule — resolve for current week + next 3 weeks
  const today = new Date();
  for(let w = 0; w < 4; w++){
    const refDate = new Date(today);
    refDate.setDate(today.getDate() + w * 7);
    const weekDates = weekDatesForDate(toYMD(refDate));
    getBase().forEach(b => {
      const date = baseToDate(b, weekDates);
      if(!date || seenDates.has(date)) return; // already have a concrete shift or suppressed
      seenDates.add(date);
      const loc = getLocById(b.locationId);
      entries.push({ date, label: `${fmtD(date)} · ${loc?.name||'?'} · ${fmtTime(b.start)}–${fmtTime(b.end)} (schedule)` });
    });
  }

  entries.sort((a,b) => b.date.localeCompare(a.date));

  if(!entries.length){
    showToast('You have no shifts available to swap', true);
    return;
  }

  myShiftSel.innerHTML = entries.map(e =>
    `<option value="${e.date}" data-date="${e.date}">${e.label}</option>`
  ).join('');

  // Populate employees dropdown
  const targetSel = document.getElementById('swap-target-user');
  if(!_swapUsers.length){
    const r = await apiFetch('/api/shift-swaps/users');
    _swapUsers = r?.users || [];
  }
  if(!_swapUsers.length){
    showToast('No other employees found', true);
    return;
  }
  targetSel.innerHTML = _swapUsers.map(u => `<option value="${u.id}">${u.name}</option>`).join('');

  // Reset
  document.getElementById('swap-their-date').value = '';
  document.getElementById('swap-week-hint').style.display = 'none';

  // Validation hint on date change
  const updateHint = () => {
    const myDate    = myShiftSel.selectedOptions[0]?.dataset?.date;
    const theirDate = document.getElementById('swap-their-date').value;
    const hint      = document.getElementById('swap-week-hint');
    if(!myDate || !theirDate){ hint.style.display='none'; return; }
    const sunOf = d => { const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()-x.getDay()); return x.toISOString().slice(0,10); };
    hint.style.display = sunOf(myDate) !== sunOf(theirDate) ? '' : 'none';
  };
  myShiftSel.onchange   = updateHint;
  document.getElementById('swap-their-date').onchange = updateHint;

  openSheet('sheet-swap');
}

async function submitSwap(){
  const myShiftSel  = document.getElementById('swap-my-shift');
  const myDate      = myShiftSel.selectedOptions[0]?.dataset?.date;
  const targetUserId= document.getElementById('swap-target-user').value;
  const theirDate   = document.getElementById('swap-their-date').value;

  if(!myDate || !targetUserId || !theirDate){
    showToast('Please fill in all fields', true); return;
  }

  const sunOf = d => { const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()-x.getDay()); return x.toISOString().slice(0,10); };
  if(sunOf(myDate) !== sunOf(theirDate)){
    showToast('Both shifts must be in the same calendar week', true); return;
  }

  const res = await apiFetch('/api/shift-swaps', {
    method:'POST',
    body:{ my_date: myDate, target_user_id: targetUserId, their_date: theirDate }
  });
  if(!res?.ok){ showToast(res?.error || 'Failed to send swap request', true); return; }

  closeSheet('sheet-swap');
  showToast('Swap request sent ✓');
  await loadSwaps();
}

// ═══════════════════════════════════════
//  UI UPGRADES
// ═══════════════════════════════════════

// ─── Count-up animation ───
function countUp(el, target, dur=650, fmt='float1') {
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
    else if (fmt === 'int')    el.textContent = Math.round(val);
    else                       el.textContent = val.toFixed(1);
    if (t < 1) requestAnimationFrame(tick);
    else {
      if (fmt === 'currency') el.textContent = '$' + target.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      else if (fmt === 'int') el.textContent = Math.round(target);
      else el.textContent = target.toFixed(1);
    }
  }
  requestAnimationFrame(tick);
}

// ─── Live earnings ticker ───
let _tickerInterval = null;
function updateLiveTicker() {
  const card = document.getElementById('live-ticker-card');
  if (!card || !cache.loaded) return;
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const yesterdayStr = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`;
  const nowMins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  // Regular active check: shift started today and is currently in progress (handles overnight spans before midnight too)
  function isActive(s) {
    const st = parseTimeString(s.start), en = parseTimeString(s.end);
    if (!st || !en) return false;
    let em = en.total; if (em <= st.total) em += 1440;
    return nowMins >= st.total && nowMins < em;
  }
  // Overnight check: shift started yesterday and wraps past midnight — we're in the post-midnight portion
  function isOvernightCarryover(s) {
    const st = parseTimeString(s.start), en = parseTimeString(s.end);
    if (!st || !en) return false;
    if (en.total >= st.total) return false; // not an overnight shift
    return nowMins < en.total; // currently in the post-midnight window
  }
  const activeLogged = getShifts().filter(s =>
    (s.date === todayStr && isActive(s)) ||
    (s.date === yesterdayStr && isOvernightCarryover(s))
  );
  const wkD = weekDatesForDate(todayStr);
  const wkDYest = weekDatesForDate(yesterdayStr);
  const activeBase = [
    ...getBase().map(b => ({ ...b, date: baseToDate(b, wkD) })).filter(b => b.date === todayStr && isActive(b)),
    ...getBase().map(b => ({ ...b, date: baseToDate(b, wkDYest) })).filter(b => b.date === yesterdayStr && isOvernightCarryover(b)),
  ];
  const all = [...activeLogged, ...activeBase];
  if (!all.length) { card.style.display = 'none'; return; }

  // Compute elapsed hours correctly for overnight shifts that carry into today
  function elapsedHoursForActive(active) {
    const st = parseTimeString(active.start);
    if (!st) return 0;
    if (active.date === yesterdayStr && nowMins < st.total) {
      // Post-midnight portion of an overnight shift: time since midnight + time from start to midnight
      return (1440 - st.total + nowMins) / 60;
    }
    return Math.max(0, nowMins - st.total) / 60;
  }

  // Build week shift list for OT calculation, rooted at the active shift's own date
  // (not today's date — an overnight shift crossing a week boundary must use its own week)
  function weekShiftsForDate(dateStr) {
    const wk = weekDatesForDate(dateStr);
    const wkYMDs = wk.map(d => toYMD(d));
    return [
      ...getShifts().filter(s => wkYMDs.includes(s.date)),
      ...getBase().map(b => ({ ...b, date: baseToDate(b, wk), isBase: true })).filter(b => b.date !== null),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  }

  const thresh = getSettings().otThreshold;

  let earned = 0;
  for (const active of all) {
    const rate = getLocById(active.locationId)?.rate || 0;
    const elapsedHrs = elapsedHoursForActive(active);

    // Sum reg hours from all shifts that started strictly before this active shift
    let regBefore = 0;
    for (const s of weekShiftsForDate(active.date)) {
      if (s.date > active.date || (s.date === active.date && s.start >= active.start)) continue;
      regBefore = Math.min(thresh, regBefore + shiftHours(s.start, s.end));
    }

    const regRemaining = Math.max(0, thresh - regBefore);
    const regElapsed = Math.min(elapsedHrs, regRemaining);
    const otElapsed  = Math.max(0, elapsedHrs - regElapsed);
    earned += regElapsed * rate + otElapsed * rate * 1.5;
  }

  const otActive = all.some(s => {
    const rate = getLocById(s.locationId)?.rate || 0;
    if (!rate) return false;
    const elapsedHrs = elapsedHoursForActive(s);
    let regBefore = 0;
    for (const w of weekShiftsForDate(s.date)) {
      if (w.date > s.date || (w.date === s.date && w.start >= s.start)) continue;
      regBefore = Math.min(thresh, regBefore + shiftHours(w.start, w.end));
    }
    return elapsedHrs > Math.max(0, thresh - regBefore);
  });

  const sub = all.map(s => { const loc = getLocById(s.locationId); return `${loc?.name||'?'} · ${fmtTime(s.start)} – ${fmtTime(s.end)}`; }).join(' / ')
    + (otActive ? ' · OT rate active' : '');
  card.style.display = 'block';
  document.getElementById('ticker-amount').textContent = '$' + earned.toFixed(2);
  document.getElementById('ticker-sub').textContent = sub;
}
function startLiveTicker() {
  if (_tickerInterval) clearInterval(_tickerInterval);
  updateLiveTicker();
  _tickerInterval = setInterval(updateLiveTicker, 1000);
}

// ─── Confetti ───
function fireConfetti() {
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
function addRipple(e) {
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
function initRipples() {
  document.querySelectorAll('.btn, .nav-item').forEach(el => {
    el.classList.add('ripple-host');
    el.addEventListener('click', addRipple);
  });
}

// ─── Sliding nav indicator ───
function updateNavIndicator() {
  const active = document.querySelector('#bottom-nav .nav-item.active');
  const ind = document.getElementById('nav-indicator');
  const nav = document.getElementById('bottom-nav');
  if (!active || !ind || !nav) return;
  const navRect = nav.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  ind.style.left = (rect.left - navRect.left) + 'px';
  ind.style.width = rect.width + 'px';
}

// ═══════════════════════════════════════
//  LEAVE / TIME OFF
// ═══════════════════════════════════════
const leaveCache = { balances: [], requests: [], loaded: false };

// ── Sub-tab switcher ─────────────────────────────────────────────────────────
let activeLeaveSubtab = 'cal';
function switchLeaveSubtab(tab) {
  activeLeaveSubtab = tab;
  document.getElementById('subtab-cal').classList.toggle('active', tab === 'cal');
  document.getElementById('subtab-timeoff').classList.toggle('active', tab === 'timeoff');
  document.getElementById('lp-cal').classList.toggle('active', tab === 'cal');
  document.getElementById('lp-timeoff').classList.toggle('active', tab === 'timeoff');
  // Show/hide calendar nav controls; update title
  document.getElementById('cal-controls').style.display = tab === 'cal' ? 'flex' : 'none';
  if (tab === 'timeoff') {
    document.getElementById('cal-title').textContent = 'Leave';
    loadLeaveData();
  } else {
    renderCalendar(); // restores proper month/week title
  }
}

// ── Load leave data from API ─────────────────────────────────────────────────
async function loadLeaveData() {
  const [balRes, reqRes] = await Promise.all([
    apiFetch('/api/leave/balances'),
    apiFetch('/api/leave/requests'),
  ]);
  if (balRes?.ok) leaveCache.balances  = balRes.balances;
  if (reqRes?.ok) leaveCache.requests  = reqRes.requests;
  leaveCache.loaded = true;
  renderLeaveTab();
  // Re-render dash + shift list so leave badges/call-off deductions appear immediately
  renderDash();
  renderAllShifts();
}

// ── Render leave dashboard ────────────────────────────────────────────────────
function renderLeaveTab() {
  renderLeaveBalances();
  renderLeaveRequests();
}

function renderLeaveBalances() {
  const wrap = document.getElementById('leave-balances-wrap');
  if (!wrap) return;
  const bals = leaveCache.balances.filter(b => b.type_name !== 'call_off');
  if (!bals.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px 0"><div style="font-size:12px">No balances found — contact your admin.</div></div>';
    return;
  }

  wrap.innerHTML = bals.map(b => {
    const avail   = parseFloat(b.available_hours) || 0;
    const accrued = parseFloat(b.accrued_hours)   || 0;
    const carryover = parseFloat(b.carried_over_hours) || 0;
    const used    = parseFloat(b.used_hours)       || 0;
    const total   = b.type_name === 'sick_time' ? 40 : (accrued + carryover);
    const pct     = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    const typeCls = b.type_name === 'pto' ? 'pto' : 'sick';

    let subText = '';
    if (b.type_name === 'pto') {
      subText = `${accrued.toFixed(2)} accrued`;
      if (carryover > 0) subText += ` · ${carryover.toFixed(2)} carried over`;
      subText += ` · ${used.toFixed(2)} used`;
    } else {
      subText = `${used.toFixed(2)} hrs used of 40 this anniversary year`;
    }

    return `<div class="balance-card ${typeCls}">
      <div class="bal-header">
        <div class="bal-type ${typeCls}">${b.type_label}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--muted)">${b.anniversary_year_start ? 'Since ' + b.anniversary_year_start.slice(0,10) : ''}</div>
      </div>
      <div class="bal-available ${typeCls}">${avail.toFixed(2)}</div>
      <div class="bal-sub">hrs available ${b.type_name === 'sick_time' ? '· Unused hrs paid out on anniversary' : ''}</div>
      <div style="font-size:10px;color:var(--dim);font-family:var(--mono);margin-top:3px">${subText}</div>
      <div class="bal-bar-wrap">
        <div class="bal-bar-fill ${typeCls}" style="width:${pct.toFixed(1)}%"></div>
      </div>
    </div>`;
  }).join('');
}

function renderLeaveRequests() {
  const listEl = document.getElementById('leave-requests-list');
  if (!listEl) return;
  const reqs = leaveCache.requests;
  if (!reqs.length) {
    listEl.innerHTML = '<div class="empty-state"><div class="icon" style="font-size:28px">🌴</div>No leave requests yet.</div>';
    return;
  }

  listEl.innerHTML = reqs.map(r => {
    const dateStr = r.date ? String(r.date).slice(0,10) : '—';
    const d = new Date(dateStr + 'T12:00:00');
    const fmtDate = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    const color = r.type_color || '#888';
    let extra = '';
    if (r.status === 'denied' && r.denial_reason)
      extra = `<div style="font-size:10px;color:var(--red);font-family:var(--mono);margin-top:3px">Reason: ${r.denial_reason}</div>`;
    if (r.status === 'approved' && r.type_name === 'call_off' && parseFloat(r.sick_hours_applied) > 0)
      extra = `<div style="font-size:10px;color:var(--green);font-family:var(--mono);margin-top:3px">${parseFloat(r.sick_hours_applied).toFixed(2)} hrs sick time applied</div>`;

    let cancelBtn = '';
    if (r.status === 'pending')
      cancelBtn = `<button onclick="cancelLeaveRequest('${r.id}')" style="margin-top:6px;font-size:10px;font-family:var(--mono);color:var(--red);background:rgba(255,95,109,.07);border:1px solid rgba(255,95,109,.25);border-radius:5px;padding:2px 9px;cursor:pointer">Cancel</button>`;

    const timeRange = r.start_time && r.end_time
      ? `<div style="font-size:10px;color:var(--dim);font-family:var(--mono);margin-top:2px">${fmtTime(String(r.start_time).slice(0,5))} – ${fmtTime(String(r.end_time).slice(0,5))}</div>`
      : '';
    return `<div class="leave-req-item">
      <div class="leave-req-dot" style="background:${color}"></div>
      <div class="leave-req-info">
        <div class="leave-req-type">${r.type_label}</div>
        <div class="leave-req-meta">${fmtDate}${r.notes ? ' · ' + r.notes : ''}</div>
        ${timeRange}
        ${extra}
        ${cancelBtn}
      </div>
      <div class="leave-req-right">
        <div class="leave-req-hrs">${parseFloat(r.hours_requested).toFixed(1)} hrs</div>
        <div class="leave-req-status ${r.status}">${r.status}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Get approved leave for a date (for calendar + shift badges) ───────────────
function getLeaveForDate(dateStr) {
  return leaveCache.requests.filter(r =>
    r.status === 'approved' && r.date && String(r.date).slice(0,10) === dateStr
  );
}

// ── Open leave request sheet ──────────────────────────────────────────────────
function openLeaveRequest(prefillDate = '') {
  // Reset form state first
  document.getElementById('lr-time-group').style.display = 'none';
  document.getElementById('lr-hrs-display').textContent = '—';
  document.getElementById('lr-hrs-display').style.color = 'var(--muted)';
  document.getElementById('lr-hours').value = '';
  document.getElementById('lr-notes').value = '';
  document.getElementById('leave-req-error').style.display = 'none';
  document.getElementById('lr-submit-btn').disabled = false;
  document.getElementById('lr-submit-btn').textContent = 'Submit Request';

  // Build shift selector from logged + base schedule (upcoming only)
  const sel = document.getElementById('lr-shift');
  const today = toYMD(new Date());
  const fmtD = d => { const x = new Date(d+'T12:00:00'); return x.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };
  const entries = [];
  const seenDates = new Set();

  // Logged shifts — future or today
  getShifts().filter(s => s.date >= today).forEach(s => {
    seenDates.add(s.date);
    const loc = getLocById(s.locationId);
    entries.push({ date: s.date, start: s.start, end: s.end, label: `${fmtD(s.date)} · ${loc?.name||'?'} · ${fmtTime(s.start)}–${fmtTime(s.end)}` });
  });

  // Base schedule — current week + next 5 weeks
  for (let w = 0; w < 6; w++) {
    const refDate = new Date();
    refDate.setDate(refDate.getDate() + w * 7);
    const weekDates = weekDatesForDate(toYMD(refDate));
    getBase().forEach(b => {
      const date = baseToDate(b, weekDates);
      if (!date || date < today || seenDates.has(date)) return;
      seenDates.add(date);
      const loc = getLocById(b.locationId);
      entries.push({ date, start: b.start, end: b.end, label: `${fmtD(date)} · ${loc?.name||'?'} · ${fmtTime(b.start)}–${fmtTime(b.end)} (schedule)` });
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  sel.innerHTML = '<option value="">— select a shift —</option>' +
    entries.map(e => `<option value="${e.date}" data-start="${e.start}" data-end="${e.end}">${e.label}</option>`).join('');

  // Pre-select if a date was passed (e.g. from day sheet)
  if (prefillDate) {
    const opt = [...sel.options].find(o => o.value === prefillDate);
    if (opt) { sel.value = prefillDate; onLeaveShiftSelect(); }
  }

  updateLeaveCalc();
  openSheet('sheet-leave-request');
}

function onLeaveShiftSelect() {
  const sel = document.getElementById('lr-shift');
  const opt = sel.options[sel.selectedIndex];
  const grp = document.getElementById('lr-time-group');

  if (!opt || !opt.value) {
    grp.style.display = 'none';
    document.getElementById('lr-hours').value = '';
    updateLeaveCalc();
    return;
  }

  const start = opt.dataset.start;
  const end   = opt.dataset.end;
  if (start && end) {
    document.getElementById('lr-from').value = start;
    document.getElementById('lr-to').value   = end;
    grp.style.display = 'block';
    onLeaveTimeChange(); // computes hours + calls updateLeaveCalc
  } else {
    grp.style.display = 'none';
    updateLeaveCalc();
  }
}

function onLeaveTimeChange() {
  const from  = document.getElementById('lr-from').value;
  const to    = document.getElementById('lr-to').value;
  const disp  = document.getElementById('lr-hrs-display');
  const hrsEl = document.getElementById('lr-hours');

  if (!from || !to) {
    disp.textContent = '—';
    disp.style.color = 'var(--muted)';
    hrsEl.value = '';
    updateLeaveCalc();
    return;
  }

  const hrs = shiftHours(from, to);
  if (hrs <= 0) {
    disp.textContent = 'End time must be after start time';
    disp.style.color = 'var(--red)';
    hrsEl.value = '';
    updateLeaveCalc();
    return;
  }

  disp.textContent = `${fmtTime(from)} – ${fmtTime(to)} · ${hrs.toFixed(1)} hrs`;
  disp.style.color = 'var(--muted)';
  hrsEl.value = hrs;
  updateLeaveCalc();
}

function openLeaveRequestForDay() {
  closeSheet('sheet-day');
  setTimeout(() => openLeaveRequest(daySheetDate), 200);
}

function updateLeaveCalc() {
  const type  = document.getElementById('lr-type').value;
  const hrs   = parseFloat(document.getElementById('lr-hours').value) || 0;
  const prev  = document.getElementById('lr-balance-preview');

  // Call-off: no balance to preview — admin decides sick time later
  if (type === 'call_off') { prev.style.display = 'none'; return; }

  const bal = leaveCache.balances.find(b => b.type_name === type);
  if (!bal || !hrs) { prev.style.display = 'none'; return; }

  const avail = parseFloat(bal.available_hours) || 0;
  const after  = avail - hrs;
  document.getElementById('lr-avail').textContent = avail.toFixed(2) + ' hrs';
  document.getElementById('lr-after').textContent = after.toFixed(2) + ' hrs';
  document.getElementById('lr-after').style.color = after < 0 ? 'var(--red)' : 'var(--green)';
  prev.style.display = 'block';
}

async function submitLeaveRequest() {
  const type  = document.getElementById('lr-type').value;
  const date  = document.getElementById('lr-shift').value;
  const hrs   = parseFloat(document.getElementById('lr-hours').value);
  const from  = document.getElementById('lr-from').value || null;
  const to    = document.getElementById('lr-to').value   || null;
  const notes = document.getElementById('lr-notes').value.trim();
  const errEl = document.getElementById('leave-req-error');
  const btn   = document.getElementById('lr-submit-btn');

  errEl.style.display = 'none';
  if (!date) { errEl.textContent = 'Please select a shift.'; errEl.style.display = 'block'; return; }
  if (!hrs || hrs <= 0) { errEl.textContent = 'Select a valid time range.'; errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const res = await apiFetch('/api/leave/requests', {
    method: 'POST',
    body: { leave_type_name: type, date, hours_requested: hrs, notes, start_time: from, end_time: to }
  });

  btn.disabled = false;
  btn.textContent = 'Submit Request';

  if (!res?.ok) {
    errEl.textContent = res?.error || 'Failed to submit request.';
    errEl.style.display = 'block';
    return;
  }

  closeSheet('sheet-leave-request');
  showToast('Leave request submitted ✓');
  await loadLeaveData();
  renderCalendar(); // refresh calendar leave indicators
}

async function cancelLeaveRequest(id) {
  const res = await apiFetch(`/api/leave/requests/${id}/cancel`, { method: 'PATCH' });
  if (!res?.ok) { showToast(res?.error || 'Failed to cancel', true); return; }
  showToast('Request cancelled');
  await loadLeaveData();
  renderCalendar();
}

// leave color indicators are baked directly into renderCalMonth below.

// leave data is loaded lazily when the Time Off subtab is opened,
// and pre-warmed in the background after login via enterApp().

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════
// Data is loaded in enterApp() → loadAllData() after login.
