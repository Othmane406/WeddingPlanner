/* ============ UOAF Data Layer — IndexedDB (Dexie) + Cloud Sync ============ */
const APP_ID = 'wedding-planner-pro';
const APP_VERSION = '1.1.0';
const BACKUP_FORMAT_VERSION = '1.0';

// ---- Supabase config ----
const SUPABASE_URL = 'https://gbxnqgqvmlmwevfltfca.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdieG5xZ3F2bWxtd2V2Zmx0ZmNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MjE1NTEsImV4cCI6MjEwMjA5NzU1MX0.-P2lyFStX3hMlx5HT43eQ-5xS_soEP6wMCYsf601Nb4';
const SUPABASE_TABLE = 'wedding_sync';

function uid(prefix){ return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function nowISO(){ return new Date().toISOString(); }

const CHECKLIST_CATEGORIES = ['Venue','Photography','Videography','Catering','Flowers','Music','Transportation','Decor','Invitations','Attire','Legal Documents','Beauty','Honeymoon','Custom'];
const VENDOR_CATEGORIES = ['Venue','Photography','Videography','Catering','Florist','Music/DJ','Transportation','Decor','Officiant','Cake','Attire','Beauty','Stationery','Rentals','Other'];
const BUDGET_CATEGORIES = ['Venue','Catering','Photography','Videography','Attire','Flowers & Decor','Music & Entertainment','Stationery','Transportation','Beauty','Favors & Gifts','Rings','Honeymoon','Legal & Admin','Miscellaneous'];

function defaultData(){
  return {
    schemaVersion: 2,
    wedding: {
      id:'wedding_primary', partner1:'', partner2:'', date:'', ceremonyLocation:'', receptionLocation:'',
      theme:'', colorPalette:'', style:'', guestTarget:150, budgetTarget:30000, vision:'', notes:'',
      createdAt: nowISO()
    },
    guests: [], vendors: [], budgetItems: [], tasks: [], seatingTables: [], documents: [],
    registryItems: [], inspirationItems: [],
    honeymoon: { destination:'', budget:0, flights:'', hotels:'', activities:'', packingList:[], travelDocs:'', timeline:'', expenses:[] },
    settings: {
      theme:'system', accent:'rose', textScale:1, reducedMotion:false, highContrast:false,
      lastBackupAt:null, savedViews:[], activityLog:[],
      sync: { linked:false, email:'', syncKey:'', lastPushAt:null, lastPullAt:null, status:'offline' }
    }
  };
}

function migrateData(raw){
  const d = defaultData();
  if(!raw || typeof raw!=='object') return d;
  const merged = Object.assign({}, d, raw);
  merged.wedding = Object.assign({}, d.wedding, raw.wedding||{});
  merged.honeymoon = Object.assign({}, d.honeymoon, raw.honeymoon||{});
  merged.settings = Object.assign({}, d.settings, raw.settings||{});
  merged.settings.sync = Object.assign({}, d.settings.sync, (raw.settings&&raw.settings.sync)||{});
  ['guests','vendors','budgetItems','tasks','seatingTables','documents','registryItems','inspirationItems'].forEach(k=>{
    merged[k] = Array.isArray(raw[k]) ? raw[k] : [];
  });
  merged.schemaVersion = d.schemaVersion;
  return merged;
}

// ---- Dexie database: a single key/value table mirrors the old localStorage
// shape 1:1, so the rest of the app (which reads Store.data synchronously)
// doesn't need a full async rewrite. IndexedDB writes happen in the
// background after each mutation. ----
const db = new Dexie('WeddingPlannerProDB');
db.version(1).stores({ kv: 'key' });

const Store = {
  data: null,
  listeners: [],

  async load(){
    this.data = defaultData();
    try{
      const row = await db.kv.get('appData');
      if(row && row.value) this.data = migrateData(row.value);
      else {
        // one-time migration from the old localStorage version, if present
        const legacy = localStorage.getItem('uoaf.weddingPlannerPro.data');
        if(legacy){
          this.data = migrateData(JSON.parse(legacy));
          await db.kv.put({ key:'appData', value:this.data });
          localStorage.removeItem('uoaf.weddingPlannerPro.data');
        }
      }
    }catch(e){
      console.error('IndexedDB load failed, starting fresh', e);
    }
    return this.data;
  },

  persist(){
    // Synchronous-feeling API kept for the rest of the app: write-through
    // cache. UI re-renders immediately off the in-memory object; the
    // IndexedDB write and cloud push happen right after, async.
    db.kv.put({ key:'appData', value: this.data }).catch(e=>{
      console.error('IndexedDB write failed', e);
      Toast.show('Could not save locally — device storage may be full.', 'danger');
    });
    this.emit();
    Sync.schedulePush();
    return true;
  },
  emit(){ this.listeners.forEach(fn=>{ try{ fn(this.data); }catch(e){ console.error(e); } }); },
  subscribe(fn){ this.listeners.push(fn); },
  log(action){
    this.data.settings.activityLog.unshift({ id:uid('log'), action, at: nowISO() });
    if(this.data.settings.activityLog.length>200) this.data.settings.activityLog.length = 200;
  },
  add(collection, item){
    item.id = item.id || uid(collection.slice(0,-1));
    item.createdAt = nowISO(); item.updatedAt = nowISO();
    this.data[collection].push(item);
    this.log(`Added ${collection.slice(0,-1)}: ${item.name||item.title||item.description||item.id}`);
    this.persist();
    return item;
  },
  update(collection, id, patch){
    const arr = this.data[collection];
    const idx = arr.findIndex(x=>x.id===id);
    if(idx===-1) return null;
    arr[idx] = Object.assign({}, arr[idx], patch, { updatedAt: nowISO() });
    this.persist();
    return arr[idx];
  },
  remove(collection, id){
    const arr = this.data[collection];
    const idx = arr.findIndex(x=>x.id===id);
    if(idx===-1) return false;
    arr.splice(idx,1);
    this.persist();
    return true;
  },
  find(collection, id){ return this.data[collection].find(x=>x.id===id) || null; }
};
/* ============ Cloud Sync Engine ============ */
/* Shared-secret sync: email + access code are hashed client-side (SHA-256)
   into an unguessable sync_key. That key partitions a single JSONB row per
   couple in Supabase. Push = upsert the whole document. Pull = fetch the
   row and compare updated_at against our last-known value; if the cloud
   copy is newer, adopt it. Last-write-wins — see Settings > Sync for the
   plain-language explanation shown to users. */
const Sync = {
  pushTimer: null,
  pulling: false,
  pollTimer: null,

  async hashKey(email, code){
    const enc = new TextEncoder().encode('wpp-sync::' + email.trim().toLowerCase() + '::' + code);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
  },

  async link(email, code){
    const syncKey = await this.hashKey(email, code);
    Store.data.settings.sync = Object.assign({}, Store.data.settings.sync, {
      linked:true, email: email.trim().toLowerCase(), syncKey, status:'syncing'
    });
    Store.persist();
    // Immediately try to pull first (in case this device is joining data
    // that already exists in the cloud from a partner's device), then push.
    await this.pull({ silent:false });
    await this.push();
    this.startPolling();
  },

  unlink(){
    Store.data.settings.sync = Object.assign({}, Store.data.settings.sync, { linked:false, syncKey:'', status:'offline' });
    Store.persist();
    this.stopPolling();
  },

  headers(){
    return {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    };
  },

  schedulePush(){
    const sync = Store.data && Store.data.settings && Store.data.settings.sync;
    if(!sync || !sync.linked) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(()=>this.push(), 900);
  },

  async push(){
    const sync = Store.data.settings.sync;
    if(!sync.linked || !navigator.onLine) return;
    try{
      setSyncStatus('syncing');
      const payload = { sync_key: sync.syncKey, data: Store.data, app_version: APP_VERSION };
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=sync_key`, {
        method:'POST',
        headers: Object.assign({}, this.headers(), { 'Prefer':'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(payload)
      });
      if(!res.ok) throw new Error('Push failed: ' + res.status);
      Store.data.settings.sync.lastPushAt = nowISO();
      db.kv.put({ key:'appData', value: Store.data }).catch(()=>{});
      setSyncStatus('synced');
    }catch(e){
      console.error('Sync push error', e);
      setSyncStatus('error');
    }
  },

  async pull({ silent } = {}){
    const sync = Store.data.settings.sync;
    if(!sync.linked || !navigator.onLine || this.pulling) return;
    this.pulling = true;
    try{
      if(!silent) setSyncStatus('syncing');
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?sync_key=eq.${encodeURIComponent(sync.syncKey)}&select=data,updated_at`, {
        headers: this.headers()
      });
      if(!res.ok) throw new Error('Pull failed: ' + res.status);
      const rows = await res.json();
      if(rows && rows.length){
        const remote = rows[0];
        const remoteTime = new Date(remote.updated_at).getTime();
        const localTime = sync.lastPushAt ? new Date(sync.lastPushAt).getTime() : 0;
        // Only adopt the remote copy if it's newer than the last change we
        // pushed from this device — avoids clobbering local edits made
        // while offline with a stale cloud copy.
        if(remoteTime > localTime){
          const preservedSync = Store.data.settings.sync;
          Store.data = migrateData(remote.data);
          Store.data.settings.sync = Object.assign({}, preservedSync, { lastPullAt: nowISO(), status:'synced' });
          db.kv.put({ key:'appData', value: Store.data }).catch(()=>{});
          Store.emit();
          if(!silent) Toast.show('Synced latest changes from your partner.', 'success');
          if(typeof render==='function') render();
        }
      }
      Store.data.settings.sync.lastPullAt = nowISO();
      setSyncStatus('synced');
    }catch(e){
      console.error('Sync pull error', e);
      setSyncStatus('error');
    }finally{
      this.pulling = false;
    }
  },

  startPolling(){
    this.stopPolling();
    this.pollTimer = setInterval(()=>{ if(navigator.onLine) this.pull({silent:true}); }, 45000);
  },
  stopPolling(){ if(this.pollTimer) clearInterval(this.pollTimer); }
};

function setSyncStatus(status){
  if(!Store.data || !Store.data.settings || !Store.data.settings.sync) return;
  Store.data.settings.sync.status = status;
  const pill = document.getElementById('sync-status-pill');
  if(pill) renderSyncPill(pill);
}

window.addEventListener('online', ()=>{ if(Store.data && Store.data.settings.sync.linked) Sync.pull({silent:true}); });
window.addEventListener('offline', ()=>{ setSyncStatus('offline'); });
/* ============ Utilities & Shared UI Primitives ============ */
function el(tag, attrs, children){
  const node = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(k=>{
    if(k==='class') node.className = attrs[k];
    else if(k==='html') node.innerHTML = attrs[k];
    else if(k.startsWith('on') && typeof attrs[k]==='function') node.addEventListener(k.slice(2), attrs[k]);
    else if(attrs[k]!==false && attrs[k]!==null && attrs[k]!==undefined) node.setAttribute(k, attrs[k]);
  });
  (children||[]).forEach(c=>{ if(c) node.appendChild(typeof c==='string'?document.createTextNode(c):c); });
  return node;
}
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtMoney(n){ n = Number(n)||0; return '$' + n.toLocaleString('en-US',{maximumFractionDigits:0}); }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso+'T00:00:00'); if(isNaN(d)) return iso; return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function daysUntil(iso){ if(!iso) return null; const target=new Date(iso+'T00:00:00'); const now=new Date(); now.setHours(0,0,0,0); return Math.ceil((target-now)/86400000); }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

const Icons = {
  dashboard:'<path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z"/>',
  checklist:'<path d="M9 11l3 3L22 4M4 12l3 3L14 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 6h.01M3 12h.01M3 18h.01M7 6h14M7 12h14M7 18h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  timeline:'<circle cx="5" cy="6" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="18" r="2" fill="currentColor"/><path d="M5 8v2a2 2 0 0 0 2 2h3M12 14v2a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2" fill="none"/>',
  guests:'<circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 20c0-3.9 3.1-7 7-7s7 3.1 7 7" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="8" r="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16 20c.3-2.8 2.3-5 5-5.6" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  vendors:'<rect x="3" y="9" width="18" height="12" rx="1" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7 9V6a5 5 0 0 1 10 0v3" stroke="currentColor" stroke-width="2" fill="none"/>',
  budget:'<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 7v10M9.5 9.5c0-1.4 1.1-2.5 2.5-2.5s2.5.9 2.5 2.1c0 3-5 1.4-5 4.3 0 1.3 1.1 2.1 2.5 2.1s2.5-1 2.5-2.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  reports:'<path d="M6 2h9l5 5v15H6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M9 13h6M9 17h6M9 9h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  settings:'<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  plus:'<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  search:'<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  close:'<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  edit:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  menu:'<path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sun:'<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
  check:'<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  download:'<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 20h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  upload:'<path d="M12 20V8m0 0l-4 4m4-4l4 4M4 4h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  sparkle:'<path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4Z" fill="currentColor"/>',
  heart:'<path d="M12 20s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 5c-2.5 4.6-9.5 9-9.5 9Z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
};
function icon(name, size){ size=size||18; return `<svg class="nav-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${Icons[name]||''}</svg>`; }

/* Toast Notification component */
const Toast = {
  region: null,
  init(){ this.region = el('div',{class:'toast-region','aria-live':'polite','aria-atomic':'true'}); document.body.appendChild(this.region); },
  show(msg, type){
    const t = el('div',{class:'toast'+(type?(' '+type):'')},[msg]);
    this.region.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .2s'; setTimeout(()=>t.remove(),200); }, 3200);
  }
};

/* Modal component (focus-trapped) */
const Modal = {
  stack: [],
  open({title, body, footer, onClose, width}){
    const overlay = el('div',{class:'modal-overlay',role:'presentation'});
    const modal = el('div',{class:'modal',role:'dialog','aria-modal':'true','aria-label':title||'Dialog'});
    if(width) modal.style.maxWidth = width;
    const header = el('div',{class:'modal-header'},[
      el('h2',{},[title||'']),
      el('button',{class:'icon-btn','aria-label':'Close dialog', onclick:()=>this.close(overlay,onClose)},[])
    ]);
    header.querySelector('button').innerHTML = icon('close',16);
    modal.appendChild(header);
    const bodyEl = el('div',{class:'modal-body'});
    if(typeof body==='string') bodyEl.innerHTML = body; else if(body) bodyEl.appendChild(body);
    modal.appendChild(bodyEl);
    if(footer){ const f = el('div',{class:'modal-footer'}); (Array.isArray(footer)?footer:[footer]).forEach(b=>f.appendChild(b)); modal.appendChild(f); }
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', e=>{ if(e.target===overlay) this.close(overlay,onClose); });
    document.addEventListener('keydown', this._escHandler = e=>{ if(e.key==='Escape') this.close(overlay,onClose); });
    document.body.appendChild(overlay);
    this.stack.push(overlay);
    const focusable = modal.querySelector('input,select,textarea,button');
    if(focusable) setTimeout(()=>focusable.focus(),30);
    return { overlay, modal, bodyEl, close:()=>this.close(overlay,onClose) };
  },
  close(overlay,onClose){
    if(overlay && overlay.parentNode) overlay.remove();
    document.removeEventListener('keydown', this._escHandler);
    this.stack = this.stack.filter(o=>o!==overlay);
    if(onClose) onClose();
  }
};

function confirmDialog({title, message, confirmLabel, danger, onConfirm}){
  const footer = [
    el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn '+(danger?'btn-danger':'btn-primary'), onclick:()=>{ ref.close(); onConfirm(); }},[confirmLabel||'Confirm'])
  ];
  const ref = Modal.open({ title: title||'Are you sure?', body: `<p style="color:var(--odf-text-secondary);font-size:14.5px;">${message||''}</p>`, footer });
  return ref;
}

function emptyState({icon:iconName, title, message, actionLabel, onAction}){
  const wrap = el('div',{class:'empty-state'});
  wrap.innerHTML = `<div class="empty-icon">${icon(iconName||'sparkle',44)}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>`;
  if(actionLabel){
    const btn = el('button',{class:'btn btn-primary', onclick:onAction},[actionLabel]);
    wrap.appendChild(btn);
  }
  return wrap;
}

function formField({label, type, value, id, hint, options, required, placeholder, min, max, step}){
  const wrap = el('div',{class:'field'});
  const labelEl = el('label',{for:id},[label + (required?' *':'')]);
  wrap.appendChild(labelEl);
  let input;
  if(type==='select'){
    input = el('select',{id, name:id});
    (options||[]).forEach(o=>{
      const optVal = typeof o==='object'?o.value:o;
      const optLabel = typeof o==='object'?o.label:o;
      const opt = el('option',{value:optVal},[optLabel]);
      if(String(optVal)===String(value)) opt.setAttribute('selected','selected');
      input.appendChild(opt);
    });
  } else if(type==='textarea'){
    input = el('textarea',{id, name:id, placeholder:placeholder||''});
    input.value = value||'';
  } else {
    input = el('input',{ id, name:id, type:type||'text', placeholder:placeholder||'', value: value==null?'':value });
    if(min!=null) input.setAttribute('min',min);
    if(max!=null) input.setAttribute('max',max);
    if(step!=null) input.setAttribute('step',step);
  }
  wrap.appendChild(input);
  if(hint) wrap.appendChild(el('div',{class:'field-hint'},[hint]));
  return { wrap, input };
}
/* ============ Intelligence Engine ============ */
/* Transparent, locally-computed scores. Every score exposes its plain-language reason. */
const Intel = {
  planningCompletion(data){
    const tasks = data.tasks;
    if(!tasks.length) return { value:0, reason:'No tasks created yet.' };
    const done = tasks.filter(t=>t.status==='done').length;
    const value = Math.round((done/tasks.length)*100);
    return { value, reason:`${done} of ${tasks.length} tasks completed.` };
  },
  budgetHealth(data){
    const items = data.budgetItems;
    if(!items.length) return { value:100, reason:'No budget items tracked yet.' };
    const est = items.reduce((s,i)=>s+(Number(i.estimated)||0),0);
    const act = items.reduce((s,i)=>s+(Number(i.actual)||0),0);
    const target = Number(data.wedding.budgetTarget)||0;
    const spentRatio = target>0 ? act/target : 0;
    const varianceRatio = est>0 ? (act-est)/est : 0;
    let value = 100 - clamp(varianceRatio*100,0,60) - clamp((spentRatio-1)*100,0,40);
    value = Math.round(clamp(value,0,100));
    const reason = act>est ? `Actual spend is ${fmtMoney(act-est)} over estimates.` : `Spending is on or under estimate by ${fmtMoney(est-act)}.`;
    return { value, reason };
  },
  vendorReliability(data){
    const vendors = data.vendors;
    if(!vendors.length) return { value:0, reason:'No vendors added yet.' };
    const rated = vendors.filter(v=>v.rating);
    const avg = rated.length ? rated.reduce((s,v)=>s+Number(v.rating),0)/rated.length : 0;
    const signed = vendors.filter(v=>v.contractStatus==='signed').length;
    const value = Math.round(((avg/5)*60) + ((signed/vendors.length)*40));
    return { value, reason:`${signed} of ${vendors.length} contracts signed, avg rating ${avg.toFixed(1)}/5.` };
  },
  guestResponseRate(data){
    const guests = data.guests;
    if(!guests.length) return { value:0, reason:'No guests added yet.' };
    const responded = guests.filter(g=>g.rsvp==='yes'||g.rsvp==='no').length;
    const value = Math.round((responded/guests.length)*100);
    return { value, reason:`${responded} of ${guests.length} guests have responded.` };
  },
  taskRisk(data){
    const overdue = data.tasks.filter(t=>t.status!=='done' && t.dueDate && daysUntil(t.dueDate)<0).length;
    const dueSoon = data.tasks.filter(t=>t.status!=='done' && t.dueDate && daysUntil(t.dueDate)>=0 && daysUntil(t.dueDate)<=7).length;
    const value = overdue>0 ? 'high' : dueSoon>3 ? 'medium' : 'low';
    return { value, overdue, dueSoon, reason: overdue>0 ? `${overdue} task(s) overdue.` : dueSoon>0 ? `${dueSoon} task(s) due within a week.` : 'No urgent task pressure.' };
  },
  timelineRisk(data){
    const wDate = data.wedding.date;
    if(!wDate) return { value:'unknown', reason:'Set your wedding date to enable timeline risk detection.' };
    const remaining = daysUntil(wDate);
    const openHighPriority = data.tasks.filter(t=>t.status!=='done' && t.priority==='high').length;
    if(remaining!=null && remaining<30 && openHighPriority>0) return { value:'high', reason:`${openHighPriority} high-priority task(s) still open with under 30 days left.` };
    if(openHighPriority>3) return { value:'medium', reason:`${openHighPriority} high-priority tasks open.` };
    return { value:'low', reason:'Timeline currently on track.' };
  },
  budgetForecast(data){
    const items = data.budgetItems;
    const target = Number(data.wedding.budgetTarget)||0;
    const act = items.reduce((s,i)=>s+(Number(i.actual)||0),0);
    const est = items.reduce((s,i)=>s+(Number(i.estimated)||0),0);
    const projectedTotal = act + Math.max(0, est - items.filter(i=>i.actual).reduce((s,i)=>s+(Number(i.estimated)||0),0));
    const forecast = est>act ? est : act;
    return { value: forecast, overTarget: target>0 && forecast>target, target, reason: target>0 && forecast>target ? `Forecast ${fmtMoney(forecast)} exceeds target ${fmtMoney(target)}.` : `Forecast ${fmtMoney(forecast)} is within target.` };
  },
  vendorRecommendation(data, category){
    const vendors = data.vendors.filter(v=>!category || v.category===category);
    return vendors.map(v=>({ vendor:v, score: Math.round(((Number(v.rating)||0)/5)*70 + (v.contractStatus==='signed'?30:0)) }))
      .sort((a,b)=>b.score-a.score);
  },
  rsvpPrediction(data){
    const guests = data.guests;
    if(!guests.length) return { value:0, reason:'No guests to predict from.' };
    const responded = guests.filter(g=>g.rsvp==='yes'||g.rsvp==='no');
    const yesRate = responded.length ? responded.filter(g=>g.rsvp==='yes').length/responded.length : 0.75;
    const pending = guests.filter(g=>g.rsvp==='pending').length;
    const predicted = guests.filter(g=>g.rsvp==='yes').length + Math.round(pending*yesRate);
    return { value: predicted, reason:`Based on a ${Math.round(yesRate*100)}% historical yes-rate among responders.` };
  },
  weddingReadiness(data){
    const pc = this.planningCompletion(data).value;
    const bh = this.budgetHealth(data).value;
    const vr = this.vendorReliability(data).value;
    const gr = this.guestResponseRate(data).value;
    const value = Math.round(pc*0.4 + bh*0.25 + vr*0.2 + gr*0.15);
    return { value, breakdown:{planningCompletion:pc, budgetHealth:bh, vendorReliability:vr, guestResponseRate:gr} };
  },
  // ---- Algorithms ----
  criticalPath(data){
    const open = data.tasks.filter(t=>t.status!=='done' && t.dueDate);
    return open.sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate)).slice(0,8);
  },
  duplicateGuests(data){
    const seen = {}; const dupes = [];
    data.guests.forEach(g=>{
      const key = (g.name||'').trim().toLowerCase();
      if(!key) return;
      if(seen[key]) dupes.push([seen[key], g]); else seen[key]=g;
    });
    return dupes;
  },
  paymentReminders(data){
    return data.vendors.filter(v=>v.paymentDueDate && v.contractStatus!=='paid')
      .map(v=>({vendor:v, daysUntil: daysUntil(v.paymentDueDate)}))
      .filter(x=>x.daysUntil!=null && x.daysUntil<=30)
      .sort((a,b)=>a.daysUntil-b.daysUntil);
  },
  seatingConflicts(data){
    const conflicts = [];
    data.seatingTables.forEach(t=>{
      const assigned = data.guests.filter(g=>g.tableId===t.id);
      if(assigned.length > (Number(t.capacity)||0)){
        conflicts.push({ table:t, message:`${assigned.length} guests assigned to a ${t.capacity}-seat table.` });
      }
    });
    return conflicts;
  },
  taskPrioritization(data){
    const weights = {high:3, medium:2, low:1};
    return data.tasks.filter(t=>t.status!=='done').map(t=>{
      const urgency = t.dueDate ? clamp(30-Math.max(0,daysUntil(t.dueDate)),0,30) : 0;
      const score = (weights[t.priority]||1)*10 + urgency;
      return Object.assign({},t,{ _priorityScore:score });
    }).sort((a,b)=>b._priorityScore-a._priorityScore);
  }
};
/* ============ Router & App Shell ============ */
const NAV_ITEMS = [
  {id:'dashboard', label:'Dashboard', icon:'dashboard'},
  {id:'checklist', label:'Checklist', icon:'checklist'},
  {id:'timeline', label:'Timeline', icon:'timeline'},
  {id:'guests', label:'Guests', icon:'guests'},
  {id:'vendors', label:'Vendors', icon:'vendors'},
  {id:'budget', label:'Budget', icon:'budget'},
  {id:'reports', label:'Reports', icon:'reports'},
  {id:'settings', label:'Settings', icon:'settings'}
];
const BOTTOM_NAV_IDS = ['dashboard','checklist','guests','budget','settings'];

const Router = {
  current: 'dashboard',
  subtab: {},
  go(page, subtab){
    this.current = page;
    if(subtab) this.subtab[page] = subtab;
    location.hash = '#/' + page + (subtab ? '/' + subtab : '');
    render();
    window.scrollTo(0,0);
  },
  parseHash(){
    const h = location.hash.replace(/^#\/?/, '');
    const [page, sub] = h.split('/');
    if(page) this.current = page;
    if(sub) this.subtab[page] = sub;
  }
};
window.addEventListener('hashchange', ()=>{ Router.parseHash(); render(); });

function applyThemeSettings(){
  const s = Store.data.settings;
  const root = document.documentElement;
  let theme = s.theme;
  if(theme==='system'){ theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-contrast', s.highContrast ? 'high':'normal');
  root.setAttribute('data-motion', s.reducedMotion ? 'reduced':'normal');
  root.style.setProperty('--odf-text-scale', s.textScale || 1);
  const accents = { rose:['#B76E79','#A25B67','#F7E6E9'], sage:['#6E8E6D','#5B7A5A','#E7EFE6'], gold:['#B8863B','#9C6F2C','#F7EBD6'], slate:['#5C7080','#4A5C6A','#E6ECF0'], plum:['#8C6494','#734F7B','#F0E6F2'] };
  const a = accents[s.accent] || accents.rose;
  root.style.setProperty('--odf-accent', theme==='dark' ? lighten(a[0]) : a[0]);
  root.style.setProperty('--odf-accent-hover', a[1]);
  root.style.setProperty('--odf-accent-soft', theme==='dark' ? darken(a[2]) : a[2]);
}
function lighten(hex){ return hex; }
function darken(hex){ return '#2A2226'; }
window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener && window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ if(Store.data.settings.theme==='system'){ applyThemeSettings(); } });

function renderShell(){
  const app = document.getElementById('app');
  app.innerHTML = '';

  // Sidebar (desktop)
  const sidebar = el('div',{class:'sidebar'});
  sidebar.appendChild(el('div',{class:'sidebar-brand'},[
    el('div',{class:'brand-mark'},['Wedding Planner Pro']),
    el('div',{class:'brand-sub'},[countdownLabel()])
  ]));
  const nav = el('nav',{class:'sidebar-nav','aria-label':'Primary'});
  NAV_ITEMS.forEach(item=>{
    const btn = el('button',{class:'nav-item'+(Router.current===item.id?' active':''), onclick:()=>Router.go(item.id)});
    btn.innerHTML = icon(item.icon) + '<span>'+item.label+'</span>';
    nav.appendChild(btn);
  });
  sidebar.appendChild(nav);
  const footer = el('div',{class:'sidebar-footer'});
  const syncPill = el('div',{id:'sync-status-pill', style:'margin-bottom:8px;'});
  renderSyncPill(syncPill);
  footer.appendChild(syncPill);
  footer.appendChild((()=>{ const b = el('button',{class:'btn btn-secondary', style:'width:100%', onclick:()=>CommandPalette.open()},['⌘K  Quick search']); return b; })());
  sidebar.appendChild(footer);
  app.appendChild(sidebar);

  // Main column
  const mainCol = el('div',{class:'main-col'});
  const topbar = el('div',{class:'topbar'},[
    (()=>{ const b=el('button',{class:'icon-btn','aria-label':'Search', onclick:()=>CommandPalette.open()},[]); b.innerHTML=icon('search',18); return b; })(),
    el('div',{class:'brand-mark'},['Wedding Planner Pro']),
    (()=>{ const b=el('button',{class:'icon-btn','aria-label':'Settings', onclick:()=>Router.go('settings')},[]); b.innerHTML=icon('settings',18); return b; })()
  ]);
  mainCol.appendChild(topbar);

  const mainContent = el('div',{class:'main-content', id:'main-content'});
  mainCol.appendChild(mainContent);

  const bottomNav = el('div',{class:'bottom-nav'});
  const bnInner = el('div',{class:'bottom-nav-inner'});
  BOTTOM_NAV_IDS.forEach(id=>{
    const item = NAV_ITEMS.find(n=>n.id===id);
    const btn = el('button',{class:'bottom-nav-item'+(Router.current===id?' active':''), onclick:()=>Router.go(id)});
    btn.innerHTML = icon(item.icon,20) + '<span>'+item.label+'</span>';
    bnInner.appendChild(btn);
  });
  bottomNav.appendChild(bnInner);
  mainCol.appendChild(bottomNav);

  app.appendChild(mainCol);
  return mainContent;
}

function renderSyncPill(pill){
  const sync = Store.data.settings.sync;
  if(!sync.linked){
    pill.innerHTML = `<button class="btn btn-ghost btn-sm" style="width:100%; justify-content:flex-start; color:var(--odf-text-tertiary);" onclick="Router.go('settings','sync')">${icon('upload',14)} Not synced — set up</button>`;
    return;
  }
  const dotColor = sync.status==='synced' ? 'var(--odf-success)' : sync.status==='error' ? 'var(--odf-danger)' : sync.status==='syncing' ? 'var(--odf-warning)' : 'var(--odf-text-tertiary)';
  const label = sync.status==='synced' ? 'Synced' : sync.status==='syncing' ? 'Syncing…' : sync.status==='error' ? 'Sync error' : 'Offline';
  pill.innerHTML = `<button onclick="Router.go('settings','sync')" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:1px solid var(--odf-border);border-radius:var(--odf-radius-md);background:none;cursor:pointer;font-size:12.5px;color:var(--odf-text-secondary);">
    <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;"></span>${label}</button>`;
}

function countdownLabel(){
  const d = daysUntil(Store.data.wedding.date);
  if(d==null) return 'Set your wedding date';
  if(d<0) return 'Married! ' + Math.abs(d) + ' days ago';
  if(d===0) return 'Today is the day! 💍';
  return d + ' days to go';
}

const PAGE_RENDERERS = {}; // populated by module files: PAGE_RENDERERS.dashboard = fn(container)

function render(){
  applyThemeSettings();
  const container = renderShell();
  const fn = PAGE_RENDERERS[Router.current] || PAGE_RENDERERS.dashboard;
  fn(container);
}

/* Command Palette (Universal Search / Command Palette) */
const CommandPalette = {
  open(){
    const overlay = el('div',{class:'command-overlay'});
    const box = el('div',{class:'command-box'});
    const input = el('input',{class:'command-input', type:'text', placeholder:'Search guests, vendors, tasks, or jump to a page…', 'aria-label':'Command palette search'});
    const list = el('div',{class:'command-list'});
    box.appendChild(input); box.appendChild(list);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', e=>{ if(e.target===overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    const closeOnEsc = e=>{ if(e.key==='Escape'){ overlay.remove(); document.removeEventListener('keydown',closeOnEsc); } };
    document.addEventListener('keydown', closeOnEsc);
    setTimeout(()=>input.focus(),20);
    const doSearch = debounce(()=>{
      const q = input.value.trim().toLowerCase();
      list.innerHTML='';
      if(!q){ NAV_ITEMS.forEach(n=>list.appendChild(cmdItem(n.label,'Go to page',()=>{Router.go(n.id); overlay.remove();}))); return; }
      const results = [];
      Store.data.guests.forEach(g=>{ if((g.name||'').toLowerCase().includes(q)) results.push(cmdItem(g.name,'Guest',()=>{Router.go('guests'); overlay.remove();})); });
      Store.data.vendors.forEach(v=>{ if((v.company||'').toLowerCase().includes(q)) results.push(cmdItem(v.company,'Vendor',()=>{Router.go('vendors'); overlay.remove();})); });
      Store.data.tasks.forEach(t=>{ if((t.title||'').toLowerCase().includes(q)) results.push(cmdItem(t.title,'Task',()=>{Router.go('checklist'); overlay.remove();})); });
      NAV_ITEMS.forEach(n=>{ if(n.label.toLowerCase().includes(q)) results.push(cmdItem(n.label,'Page',()=>{Router.go(n.id); overlay.remove();})); });
      if(!results.length){ list.appendChild(el('div',{class:'command-item text-secondary'},['No matches found.'])); return; }
      results.slice(0,20).forEach(r=>list.appendChild(r));
    },120);
    input.addEventListener('input', doSearch);
    doSearch();
  }
};
function cmdItem(label, sub, onClick){
  const it = el('div',{class:'command-item', onclick:onClick, role:'button', tabindex:'0'});
  it.innerHTML = `<span>${esc(label)}</span><span class="text-tertiary">${esc(sub)}</span>`;
  return it;
}
document.addEventListener('keydown', e=>{
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); CommandPalette.open(); }
});
/* ============ Dashboard Module ============ */
PAGE_RENDERERS.dashboard = function(container){
  const sub = Router.subtab.dashboard || 'overview';
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Dashboard']), el('div',{class:'page-sub'},[countdownLabel()]) ]),
  ]));
  const tabs = el('div',{class:'subtabs'});
  [['overview','Overview'],['profile','Wedding Profile'],['inspiration','Inspiration Board']].forEach(([id,label])=>{
    tabs.appendChild(el('button',{class:'subtab'+(sub===id?' active':''), onclick:()=>Router.go('dashboard',id)},[label]));
  });
  container.appendChild(tabs);
  const body = el('div',{});
  container.appendChild(body);
  if(sub==='profile') renderWeddingProfile(body);
  else if(sub==='inspiration') renderInspirationBoard(body);
  else renderDashboardOverview(body);
};

function renderDashboardOverview(body){
  const data = Store.data;
  if(!data.wedding.date && data.guests.length===0 && data.tasks.length===0){
    body.appendChild(emptyState({
      icon:'sparkle', title:'Welcome to your wedding planning workspace',
      message:'Start by setting up your Wedding Profile with your date, venue, and vision — everything else builds from there.',
      actionLabel:'Set up Wedding Profile', onAction:()=>Router.go('dashboard','profile')
    }));
    return;
  }
  const readiness = Intel.weddingReadiness(data);
  const pc = Intel.planningCompletion(data);
  const bh = Intel.budgetHealth(data);
  const grr = Intel.guestResponseRate(data);
  const tr = Intel.taskRisk(data);

  const kpis = el('div',{class:'grid grid-4', style:'margin-bottom:24px;'});
  kpis.appendChild(kpiCard('Wedding Readiness', readiness.value+'%', 'Composite score across planning, budget, vendors & guests'));
  kpis.appendChild(kpiCard('Days Until Wedding', data.wedding.date ? Math.max(0,daysUntil(data.wedding.date)) : '—', data.wedding.date ? fmtDate(data.wedding.date) : 'No date set'));
  kpis.appendChild(kpiCard('Budget Remaining', fmtMoney((Number(data.wedding.budgetTarget)||0) - data.budgetItems.reduce((s,i)=>s+(Number(i.actual)||0),0)), 'of '+fmtMoney(data.wedding.budgetTarget)+' target'));
  kpis.appendChild(kpiCard('Confirmed Guests', data.guests.filter(g=>g.rsvp==='yes').length+' / '+data.guests.length, grr.reason));
  body.appendChild(kpis);

  const grid2 = el('div',{class:'grid grid-2', style:'margin-bottom:24px; align-items:start;'});

  // Planning progress card
  const progCard = el('div',{class:'card'});
  progCard.appendChild(el('div',{class:'card-title'},['Planning Progress']));
  progCard.innerHTML += `<div class="flex-between" style="margin-bottom:6px;"><span class="text-secondary" style="font-size:13px;">${pc.reason}</span><strong>${pc.value}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${pc.value}%"></div></div>`;
  const catRows = el('div',{style:'margin-top:16px; display:flex; flex-direction:column; gap:10px;'});
  CHECKLIST_CATEGORIES.slice(0,6).forEach(cat=>{
    const catTasks = data.tasks.filter(t=>t.category===cat);
    if(!catTasks.length) return;
    const done = catTasks.filter(t=>t.status==='done').length;
    const pct = Math.round((done/catTasks.length)*100);
    const row = el('div',{});
    row.innerHTML = `<div class="flex-between" style="font-size:13px;margin-bottom:4px;"><span>${cat}</span><span class="text-tertiary">${done}/${catTasks.length}</span></div><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
    catRows.appendChild(row);
  });
  progCard.appendChild(catRows);
  grid2.appendChild(progCard);

  // Budget health card
  const budCard = el('div',{class:'card'});
  budCard.appendChild(el('div',{class:'card-title'},['Budget Health']));
  const badgeClass = bh.value>=70?'badge-success':bh.value>=40?'badge-warning':'badge-danger';
  budCard.innerHTML += `<div class="flex-between" style="margin-bottom:10px;"><span class="badge ${badgeClass}">${bh.value}/100</span><span class="text-secondary" style="font-size:13px;">${bh.reason}</span></div>`;
  const est = data.budgetItems.reduce((s,i)=>s+(Number(i.estimated)||0),0);
  const act = data.budgetItems.reduce((s,i)=>s+(Number(i.actual)||0),0);
  budCard.innerHTML += `<div style="display:flex; gap:20px; margin-top:8px;">
    <div><div class="text-tertiary" style="font-size:12px;">Estimated</div><div style="font-weight:700;font-size:17px;">${fmtMoney(est)}</div></div>
    <div><div class="text-tertiary" style="font-size:12px;">Actual</div><div style="font-weight:700;font-size:17px;">${fmtMoney(act)}</div></div>
    <div><div class="text-tertiary" style="font-size:12px;">Target</div><div style="font-weight:700;font-size:17px;">${fmtMoney(data.wedding.budgetTarget)}</div></div>
  </div>`;
  grid2.appendChild(budCard);
  body.appendChild(grid2);

  const grid3 = el('div',{class:'grid grid-2', style:'align-items:start;'});

  // Upcoming deadlines
  const deadlinesCard = el('div',{class:'card'});
  deadlinesCard.appendChild(el('div',{class:'card-title'},['Upcoming Deadlines & Critical Path']));
  const crit = Intel.criticalPath(data);
  if(!crit.length){ deadlinesCard.appendChild(el('p',{class:'text-secondary',style:'font-size:13.5px;'},['Nothing due soon — you\'re clear for now.'])); }
  else {
    const list = el('div',{style:'display:flex;flex-direction:column;gap:10px;'});
    crit.forEach(t=>{
      const d = daysUntil(t.dueDate);
      const overdue = d<0;
      const row = el('div',{class:'flex-between'});
      row.innerHTML = `<div><div style="font-weight:600;font-size:14px;">${esc(t.title)}</div><div class="text-tertiary" style="font-size:12.5px;">${esc(t.category||'General')}</div></div><span class="badge ${overdue?'badge-danger':'badge-neutral'}">${overdue?Math.abs(d)+'d overdue':d+'d left'}</span>`;
      list.appendChild(row);
    });
    deadlinesCard.appendChild(list);
  }
  grid3.appendChild(deadlinesCard);

  // Payments & priorities
  const rightCard = el('div',{class:'card'});
  rightCard.appendChild(el('div',{class:'card-title'},["Upcoming Payments"]));
  const payments = Intel.paymentReminders(data);
  if(!payments.length){ rightCard.appendChild(el('p',{class:'text-secondary',style:'font-size:13.5px;'},['No vendor payments due in the next 30 days.'])); }
  else {
    const list = el('div',{style:'display:flex;flex-direction:column;gap:10px;'});
    payments.forEach(p=>{
      const row = el('div',{class:'flex-between'});
      row.innerHTML = `<div><div style="font-weight:600;font-size:14px;">${esc(p.vendor.company)}</div><div class="text-tertiary" style="font-size:12.5px;">${esc(p.vendor.category||'')}</div></div><span class="badge badge-warning">${p.daysUntil}d</span>`;
      list.appendChild(row);
    });
    rightCard.appendChild(list);
  }
  grid3.appendChild(rightCard);
  body.appendChild(grid3);
}

function kpiCard(label, value, sub){
  const c = el('div',{class:'kpi-card'});
  c.innerHTML = `<div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(String(value))}</div><div class="kpi-sub">${esc(sub||'')}</div>`;
  return c;
}

function renderWeddingProfile(body){
  const w = Store.data.wedding;
  const card = el('div',{class:'card'});
  card.appendChild(el('div',{class:'card-title'},['Wedding Profile']));
  const form = el('form',{});
  const grid = el('div',{class:'form-grid'});
  const fields = [
    {key:'partner1', label:'Partner 1 Name', type:'text'},
    {key:'partner2', label:'Partner 2 Name', type:'text'},
    {key:'date', label:'Wedding Date', type:'date'},
    {key:'guestTarget', label:'Guest Target', type:'number'},
    {key:'ceremonyLocation', label:'Ceremony Location', type:'text'},
    {key:'receptionLocation', label:'Reception Location', type:'text'},
    {key:'theme', label:'Theme', type:'text'},
    {key:'colorPalette', label:'Color Palette', type:'text'},
    {key:'style', label:'Style', type:'text'},
    {key:'budgetTarget', label:'Budget Target ($)', type:'number'},
  ];
  const inputs = {};
  fields.forEach(f=>{
    const {wrap,input} = formField({label:f.label, type:f.type, value:w[f.key], id:'wp_'+f.key});
    inputs[f.key] = input;
    grid.appendChild(wrap);
  });
  form.appendChild(grid);
  const {wrap:visionWrap, input:visionInput} = formField({label:'Wedding Vision', type:'textarea', value:w.vision, id:'wp_vision', hint:'Describe the feeling and style you want your wedding to have.'});
  form.appendChild(visionWrap);
  const {wrap:notesWrap, input:notesInput} = formField({label:'Important Notes', type:'textarea', value:w.notes, id:'wp_notes'});
  form.appendChild(notesWrap);
  const saveBtn = el('button',{type:'submit', class:'btn btn-primary'},['Save Profile']);
  form.appendChild(saveBtn);
  form.addEventListener('submit', e=>{
    e.preventDefault();
    const patch = {};
    fields.forEach(f=> patch[f.key] = f.type==='number' ? Number(inputs[f.key].value)||0 : inputs[f.key].value);
    patch.vision = visionInput.value; patch.notes = notesInput.value;
    Store.data.wedding = Object.assign({}, w, patch);
    Store.log('Updated wedding profile');
    Store.persist();
    Toast.show('Wedding profile saved.', 'success');
    render();
  });
  card.appendChild(form);
  body.appendChild(card);
}

function renderInspirationBoard(body){
  const items = Store.data.inspirationItems;
  body.appendChild(el('div',{class:'page-actions', style:'margin-bottom:16px;'},[
    (()=>{ const b=el('button',{class:'btn btn-primary', onclick:openInspirationForm},[]); b.innerHTML = icon('plus',16)+' Add Inspiration'; return b; })()
  ]));
  if(!items.length){
    body.appendChild(emptyState({icon:'sparkle', title:'No inspiration saved yet', message:'Save mood board notes, color palettes, and links to dress, decor, flower, cake, and venue ideas.', actionLabel:'Add Inspiration', onAction:openInspirationForm}));
    return;
  }
  const grid = el('div',{class:'grid grid-3'});
  items.forEach(it=>{
    const c = el('div',{class:'card'});
    c.innerHTML = `<div class="flex-between" style="margin-bottom:8px;"><span class="badge badge-info">${esc(it.category)}</span></div><div style="font-weight:600;margin-bottom:4px;">${esc(it.title)}</div><div class="text-secondary" style="font-size:13.5px; margin-bottom:10px;">${esc(it.notes||'')}</div>${it.link?`<a href="${esc(it.link)}" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--odf-accent);">View link ↗</a>`:''}`;
    const actions = el('div',{class:'row-actions', style:'margin-top:10px;'});
    const editBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>openInspirationForm(it)},[]); editBtn.innerHTML=icon('edit',14);
    const delBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>confirmDialog({title:'Remove inspiration item?', message:'This will delete "'+it.title+'" permanently.', danger:true, confirmLabel:'Remove', onConfirm:()=>{ Store.remove('inspirationItems', it.id); Toast.show('Removed.'); render(); }})},[]); delBtn.innerHTML=icon('trash',14);
    actions.appendChild(editBtn); actions.appendChild(delBtn);
    c.appendChild(actions);
    grid.appendChild(c);
  });
  body.appendChild(grid);
}
function openInspirationForm(existing){
  const categories = ['Color Palette','Dress','Decor','Flowers','Cake','Venue','Other'];
  const {wrap:w1,input:title} = formField({label:'Title', id:'ins_title', required:true, value:existing?existing.title:''});
  const {wrap:w2,input:category} = formField({label:'Category', id:'ins_cat', type:'select', options:categories, value:existing?existing.category:categories[0]});
  const {wrap:w3,input:link} = formField({label:'Link (optional)', id:'ins_link', type:'url', value:existing?existing.link:''});
  const {wrap:w4,input:notes} = formField({label:'Notes', id:'ins_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{}); [w1,w2,w3,w4].forEach(w=>body.appendChild(w));
  const footer = [
    el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!title.value.trim()){ Toast.show('Title is required.','danger'); return; }
      const payload = { title:title.value.trim(), category:category.value, link:link.value.trim(), notes:notes.value.trim() };
      if(existing) Store.update('inspirationItems', existing.id, payload); else Store.add('inspirationItems', payload);
      Toast.show('Saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Inspiration'])
  ];
  const ref = Modal.open({title: existing?'Edit Inspiration':'Add Inspiration', body, footer});
}
/* ============ Master Checklist Module ============ */
let checklistFilter = { category:'all', status:'all', search:'' };

PAGE_RENDERERS.checklist = function(container){
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Master Checklist']), el('div',{class:'page-sub'},['Track every task from engagement to event day.']) ]),
    el('div',{class:'page-actions'},[ (()=>{ const b=el('button',{class:'btn btn-primary', onclick:()=>openTaskForm()},[]); b.innerHTML=icon('plus',16)+' Add Task'; return b; })() ])
  ]));

  const tasks = Store.data.tasks;
  if(!tasks.length){
    container.appendChild(emptyState({icon:'checklist', title:'No tasks yet', message:'Build your planning checklist across venue, photography, catering, and every other category.', actionLabel:'Add Your First Task', onAction:()=>openTaskForm()}));
    return;
  }

  const filterBar = el('div',{style:'display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;'});
  const catSelect = el('select',{'aria-label':'Filter by category'});
  ['all',...CHECKLIST_CATEGORIES].forEach(c=>catSelect.appendChild(el('option',{value:c},[c==='all'?'All Categories':c])));
  catSelect.value = checklistFilter.category;
  catSelect.addEventListener('change', ()=>{ checklistFilter.category=catSelect.value; render(); });
  const statusSelect = el('select',{'aria-label':'Filter by status'});
  [['all','All Statuses'],['todo','To Do'],['in_progress','In Progress'],['done','Done']].forEach(([v,l])=>statusSelect.appendChild(el('option',{value:v},[l])));
  statusSelect.value = checklistFilter.status;
  statusSelect.addEventListener('change', ()=>{ checklistFilter.status=statusSelect.value; render(); });
  const searchInput = el('input',{type:'text', placeholder:'Search tasks…', 'aria-label':'Search tasks', value:checklistFilter.search, style:'max-width:220px;'});
  searchInput.addEventListener('input', debounce(()=>{ checklistFilter.search=searchInput.value; renderTaskList(container.querySelector('#task-list-region')); },200));
  filterBar.appendChild(catSelect); filterBar.appendChild(statusSelect); filterBar.appendChild(searchInput);
  container.appendChild(filterBar);

  const listRegion = el('div',{id:'task-list-region'});
  container.appendChild(listRegion);
  renderTaskList(listRegion);
};

function renderTaskList(region){
  region.innerHTML = '';
  let tasks = Store.data.tasks.slice();
  if(checklistFilter.category!=='all') tasks = tasks.filter(t=>t.category===checklistFilter.category);
  if(checklistFilter.status!=='all') tasks = tasks.filter(t=>t.status===checklistFilter.status);
  if(checklistFilter.search) tasks = tasks.filter(t=>(t.title||'').toLowerCase().includes(checklistFilter.search.toLowerCase()));
  tasks.sort((a,b)=>{
    if(a.status==='done' && b.status!=='done') return 1;
    if(b.status==='done' && a.status!=='done') return -1;
    if(a.dueDate && b.dueDate) return new Date(a.dueDate)-new Date(b.dueDate);
    return a.dueDate ? -1 : b.dueDate ? 1 : 0;
  });
  if(!tasks.length){ region.appendChild(el('p',{class:'text-secondary'},['No tasks match your filters.'])); return; }

  const wrap = el('div',{class:'table-wrap'});
  const table = el('table',{});
  table.innerHTML = `<thead><tr><th></th><th>Task</th><th>Category</th><th>Priority</th><th>Due Date</th><th>Status</th><th></th></tr></thead>`;
  const tbody = el('tbody',{});
  tasks.forEach(t=>{
    const tr = el('tr',{});
    const d = t.dueDate ? daysUntil(t.dueDate) : null;
    const overdue = d!=null && d<0 && t.status!=='done';
    const cb = el('input',{type:'checkbox','aria-label':'Mark complete'});
    cb.checked = t.status==='done';
    cb.addEventListener('change', ()=>{ Store.update('tasks', t.id, {status: cb.checked?'done':'todo'}); Toast.show(cb.checked?'Task completed.':'Task reopened.'); render(); });
    const tdCb = el('td',{}); tdCb.appendChild(cb); tr.appendChild(tdCb);
    tr.appendChild(el('td',{},[ el('div',{style:t.status==='done'?'text-decoration:line-through;color:var(--odf-text-tertiary);':'font-weight:600;'},[t.title]) ]));
    tr.appendChild(el('td',{},[t.category||'—']));
    const priBadge = {high:'badge-danger', medium:'badge-warning', low:'badge-neutral'}[t.priority] || 'badge-neutral';
    tr.innerHTML += `<td><span class="badge ${priBadge}">${t.priority||'low'}</span></td>`;
    tr.innerHTML += `<td>${t.dueDate ? fmtDate(t.dueDate) + (overdue?' <span class="badge badge-danger">overdue</span>':'') : '—'}</td>`;
    const statusBadge = {todo:'badge-neutral', in_progress:'badge-info', done:'badge-success'}[t.status] || 'badge-neutral';
    tr.innerHTML += `<td><span class="badge ${statusBadge}">${(t.status||'todo').replace('_',' ')}</span></td>`;
    const actionsTd = el('td',{});
    const actions = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-icon', 'aria-label':'Edit task', onclick:()=>openTaskForm(t)},[]); editBtn.innerHTML=icon('edit',15);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon', 'aria-label':'Delete task', onclick:()=>confirmDialog({title:'Delete task?', message:`Delete "${t.title}" permanently?`, danger:true, confirmLabel:'Delete', onConfirm:()=>{ Store.remove('tasks', t.id); Toast.show('Task deleted.'); render(); }})},[]); delBtn.innerHTML=icon('trash',15);
    actions.appendChild(editBtn); actions.appendChild(delBtn);
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  region.appendChild(wrap);
}

function openTaskForm(existing){
  const {wrap:w1,input:title} = formField({label:'Task Title', id:'tk_title', required:true, value:existing?existing.title:''});
  const {wrap:w2,input:category} = formField({label:'Category', id:'tk_cat', type:'select', options:CHECKLIST_CATEGORIES, value:existing?existing.category:CHECKLIST_CATEGORIES[0]});
  const {wrap:w3,input:priority} = formField({label:'Priority', id:'tk_pri', type:'select', options:['low','medium','high'], value:existing?existing.priority:'medium'});
  const {wrap:w4,input:dueDate} = formField({label:'Due Date', id:'tk_due', type:'date', value:existing?existing.dueDate:''});
  const {wrap:w5,input:owner} = formField({label:'Owner', id:'tk_owner', value:existing?existing.owner:''});
  const {wrap:w6,input:notes} = formField({label:'Notes', id:'tk_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{});
  const grid = el('div',{class:'form-grid'}); grid.appendChild(w2); grid.appendChild(w3); grid.appendChild(w4); grid.appendChild(w5);
  body.appendChild(w1); body.appendChild(grid); body.appendChild(w6);
  const footer = [
    el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!title.value.trim()){ Toast.show('Task title is required.','danger'); return; }
      const payload = { title:title.value.trim(), category:category.value, priority:priority.value, dueDate:dueDate.value, owner:owner.value.trim(), notes:notes.value.trim(), status: existing?existing.status:'todo' };
      if(existing) Store.update('tasks', existing.id, payload); else Store.add('tasks', payload);
      Toast.show('Task saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Task'])
  ];
  const ref = Modal.open({title: existing?'Edit Task':'Add Task', body, footer});
}
/* ============ Timeline Planner + Honeymoon Module ============ */
PAGE_RENDERERS.timeline = function(container){
  const sub = Router.subtab.timeline || 'planner';
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Timeline']), el('div',{class:'page-sub'},['Milestones, weekly tasks, and your honeymoon plan.']) ])
  ]));
  const tabs = el('div',{class:'subtabs'});
  [['planner','Planning Timeline'],['honeymoon','Honeymoon Planner']].forEach(([id,label])=>{
    tabs.appendChild(el('button',{class:'subtab'+(sub===id?' active':''), onclick:()=>Router.go('timeline',id)},[label]));
  });
  container.appendChild(tabs);
  const body = el('div',{}); container.appendChild(body);
  if(sub==='honeymoon') renderHoneymoonPlanner(body); else renderTimelinePlanner(body);
};

function renderTimelinePlanner(body){
  const data = Store.data;
  if(!data.tasks.length){
    body.appendChild(emptyState({icon:'timeline', title:'No timeline items yet', message:'Add tasks with due dates in the Checklist to see them plotted here by month.', actionLabel:'Go to Checklist', onAction:()=>Router.go('checklist')}));
    return;
  }
  const withDates = data.tasks.filter(t=>t.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  const byMonth = {};
  withDates.forEach(t=>{
    const key = t.dueDate.slice(0,7);
    byMonth[key] = byMonth[key]||[];
    byMonth[key].push(t);
  });

  const conflictCard = timelineRiskCard(data);
  body.appendChild(conflictCard);

  Object.keys(byMonth).sort().forEach(month=>{
    const [y,m] = month.split('-');
    const label = new Date(Number(y),Number(m)-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
    const section = el('div',{style:'margin-bottom:24px;'});
    section.appendChild(el('h3',{style:'font-size:16px;margin-bottom:10px;color:var(--odf-text-secondary);'},[label]));
    const list = el('div',{style:'display:flex;flex-direction:column;gap:8px;'});
    byMonth[month].forEach(t=>{
      const row = el('div',{class:'card', style:'padding:12px 16px; display:flex; align-items:center; gap:14px;'});
      const dot = el('div',{style:`width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${t.status==='done'?'var(--odf-success)':t.priority==='high'?'var(--odf-danger)':'var(--odf-accent)'}`});
      row.appendChild(dot);
      const info = el('div',{style:'flex:1;'});
      info.innerHTML = `<div style="font-weight:600;font-size:14px;${t.status==='done'?'text-decoration:line-through;color:var(--odf-text-tertiary);':''}">${esc(t.title)}</div><div class="text-tertiary" style="font-size:12.5px;">${esc(t.category||'')}</div>`;
      row.appendChild(info);
      row.innerHTML += `<span class="text-secondary" style="font-size:13px;">${fmtDate(t.dueDate)}</span>`;
      list.appendChild(row);
    });
    section.appendChild(list);
    body.appendChild(section);
  });
}

function timelineRiskCard(data){
  const risk = Intel.timelineRisk(data);
  const colorMap = {high:'badge-danger', medium:'badge-warning', low:'badge-success', unknown:'badge-neutral'};
  const card = el('div',{class:'card', style:'margin-bottom:24px;'});
  card.innerHTML = `<div class="flex-between"><div class="card-title" style="margin-bottom:0;">Timeline Risk</div><span class="badge ${colorMap[risk.value]}">${risk.value}</span></div><p class="text-secondary" style="font-size:13.5px; margin-top:8px;">${esc(risk.reason)}</p>`;
  return card;
}

function renderHoneymoonPlanner(body){
  const hm = Store.data.honeymoon;
  const card = el('div',{class:'card'});
  card.appendChild(el('div',{class:'card-title'},['Honeymoon Details']));
  const form = el('form',{});
  const grid = el('div',{class:'form-grid'});
  const {wrap:w1,input:dest} = formField({label:'Destination', id:'hm_dest', value:hm.destination});
  const {wrap:w2,input:budget} = formField({label:'Budget ($)', id:'hm_budget', type:'number', value:hm.budget});
  const {wrap:w3,input:flights} = formField({label:'Flights', id:'hm_flights', value:hm.flights});
  const {wrap:w4,input:hotels} = formField({label:'Hotels', id:'hm_hotels', value:hm.hotels});
  [w1,w2,w3,w4].forEach(w=>grid.appendChild(w));
  form.appendChild(grid);
  const {wrap:w5,input:activities} = formField({label:'Planned Activities', id:'hm_act', type:'textarea', value:hm.activities});
  const {wrap:w6,input:travelDocs} = formField({label:'Travel Documents Needed', id:'hm_docs', type:'textarea', value:hm.travelDocs});
  const {wrap:w7,input:timelineField} = formField({label:'Honeymoon Timeline', id:'hm_timeline', type:'textarea', value:hm.timeline, hint:'e.g. departure/return dates, day-by-day plan.'});
  form.appendChild(w5); form.appendChild(w6); form.appendChild(w7);
  form.appendChild(el('button',{type:'submit', class:'btn btn-primary'},['Save Honeymoon Plan']));
  form.addEventListener('submit', e=>{
    e.preventDefault();
    Store.data.honeymoon = Object.assign({}, hm, { destination:dest.value, budget:Number(budget.value)||0, flights:flights.value, hotels:hotels.value, activities:activities.value, travelDocs:travelDocs.value, timeline:timelineField.value });
    Store.log('Updated honeymoon plan');
    Store.persist(); Toast.show('Honeymoon plan saved.','success'); render();
  });
  card.appendChild(form);
  body.appendChild(card);

  // Packing list
  const packCard = el('div',{class:'card', style:'margin-top:20px;'});
  packCard.appendChild(el('div',{class:'flex-between'},[ el('div',{class:'card-title', style:'margin-bottom:0;'},['Packing List']), (()=>{ const b=el('button',{class:'btn btn-secondary btn-sm', onclick:addPackingItem},[]); b.innerHTML=icon('plus',14)+' Add Item'; return b; })() ]));
  const list = el('div',{style:'margin-top:12px; display:flex; flex-direction:column; gap:6px;'});
  if(!hm.packingList || !hm.packingList.length){ list.appendChild(el('p',{class:'text-secondary', style:'font-size:13.5px;'},['No packing items yet.'])); }
  else hm.packingList.forEach((item,idx)=>{
    const row = el('div',{class:'flex-between', style:'padding:6px 0;'});
    const left = el('div',{class:'flex gap-2'});
    const cb = el('input',{type:'checkbox'}); cb.checked = !!item.packed;
    cb.addEventListener('change', ()=>{ hm.packingList[idx].packed = cb.checked; Store.persist(); });
    left.appendChild(cb);
    left.appendChild(el('span',{style:item.packed?'text-decoration:line-through;color:var(--odf-text-tertiary);':''},[item.name]));
    row.appendChild(left);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon btn-sm', onclick:()=>{ hm.packingList.splice(idx,1); Store.persist(); render(); }},[]); delBtn.innerHTML=icon('trash',13);
    row.appendChild(delBtn);
    list.appendChild(row);
  });
  packCard.appendChild(list);
  body.appendChild(packCard);
}
function addPackingItem(){
  const {wrap,input} = formField({label:'Item name', id:'pack_item', required:true});
  const footer=[ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{ if(!input.value.trim()) return; Store.data.honeymoon.packingList = Store.data.honeymoon.packingList||[]; Store.data.honeymoon.packingList.push({name:input.value.trim(), packed:false}); Store.persist(); ref.close(); render(); }},['Add']) ];
  const ref = Modal.open({title:'Add Packing Item', body:wrap, footer});
}
/* ============ Guest Manager + Seating + Registry Module ============ */
let guestFilter = { rsvp:'all', search:'' };

PAGE_RENDERERS.guests = function(container){
  const sub = Router.subtab.guests || 'list';
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Guests']), el('div',{class:'page-sub'},['Manage invitations, RSVPs, seating, and the gift registry.']) ]),
  ]));
  const tabs = el('div',{class:'subtabs'});
  [['list','Guest List'],['seating','Seating Chart'],['registry','Gift Registry']].forEach(([id,label])=>{
    tabs.appendChild(el('button',{class:'subtab'+(sub===id?' active':''), onclick:()=>Router.go('guests',id)},[label]));
  });
  container.appendChild(tabs);
  const body = el('div',{}); container.appendChild(body);
  if(sub==='seating') renderSeatingPlanner(body);
  else if(sub==='registry') renderGiftRegistry(body);
  else renderGuestList(body);
};

function renderGuestList(body){
  const data = Store.data;
  const actions = el('div',{style:'display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; justify-content:space-between;'});
  const addBtn = el('button',{class:'btn btn-primary', onclick:()=>openGuestForm()},[]); addBtn.innerHTML=icon('plus',16)+' Add Guest';
  actions.appendChild(addBtn);
  body.appendChild(actions);

  if(!data.guests.length){
    body.appendChild(emptyState({icon:'guests', title:'No guests added yet', message:'Build your guest list and track invitations, RSVPs, meals, and dietary needs.', actionLabel:'Add Your First Guest', onAction:()=>openGuestForm()}));
    return;
  }

  const dupes = Intel.duplicateGuests(data);
  if(dupes.length){
    const warn = el('div',{class:'card', style:'margin-bottom:16px; border-color:var(--odf-warning);'});
    warn.innerHTML = `<div class="flex-between"><strong style="font-size:14px;">Possible duplicate guests detected</strong><span class="badge badge-warning">${dupes.length}</span></div><p class="text-secondary" style="font-size:13px;margin-top:6px;">${dupes.map(d=>esc(d[0].name)).join(', ')}</p>`;
    body.appendChild(warn);
  }

  const filterBar = el('div',{style:'display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap;'});
  const rsvpSelect = el('select',{'aria-label':'Filter by RSVP'});
  [['all','All RSVPs'],['yes','Confirmed'],['no','Declined'],['pending','Pending']].forEach(([v,l])=>rsvpSelect.appendChild(el('option',{value:v},[l])));
  rsvpSelect.value = guestFilter.rsvp;
  rsvpSelect.addEventListener('change', ()=>{ guestFilter.rsvp=rsvpSelect.value; renderGuestTable(region); });
  const searchInput = el('input',{type:'text', placeholder:'Search guests…', style:'max-width:220px;', value:guestFilter.search});
  searchInput.addEventListener('input', debounce(()=>{ guestFilter.search=searchInput.value; renderGuestTable(region); },200));
  filterBar.appendChild(rsvpSelect); filterBar.appendChild(searchInput);
  body.appendChild(filterBar);

  const summary = el('div',{class:'grid grid-4', style:'margin-bottom:18px;'});
  summary.appendChild(kpiCard('Total Guests', data.guests.length, 'Target: '+(data.wedding.guestTarget||'—')));
  summary.appendChild(kpiCard('Confirmed', data.guests.filter(g=>g.rsvp==='yes').length, ''));
  summary.appendChild(kpiCard('Declined', data.guests.filter(g=>g.rsvp==='no').length, ''));
  summary.appendChild(kpiCard('Pending', data.guests.filter(g=>g.rsvp==='pending').length, ''));
  body.appendChild(summary);

  const region = el('div',{});
  body.appendChild(region);
  renderGuestTable(region);
}

function renderGuestTable(region){
  region.innerHTML = '';
  let guests = Store.data.guests.slice();
  if(guestFilter.rsvp!=='all') guests = guests.filter(g=>g.rsvp===guestFilter.rsvp);
  if(guestFilter.search) guests = guests.filter(g=>(g.name||'').toLowerCase().includes(guestFilter.search.toLowerCase()));
  if(!guests.length){ region.appendChild(el('p',{class:'text-secondary'},['No guests match your filters.'])); return; }
  const wrap = el('div',{class:'table-wrap'});
  const table = el('table',{});
  table.innerHTML = `<thead><tr><th>Name</th><th>Relationship</th><th>RSVP</th><th>Meal</th><th>Table</th><th>Plus One</th><th></th></tr></thead>`;
  const tbody = el('tbody',{});
  guests.forEach(g=>{
    const tr = el('tr',{});
    const rsvpBadge = {yes:'badge-success', no:'badge-danger', pending:'badge-neutral'}[g.rsvp] || 'badge-neutral';
    const tableObj = Store.data.seatingTables.find(t=>t.id===g.tableId);
    tr.innerHTML = `<td><strong>${esc(g.name)}</strong>${g.dietaryRestrictions?`<div class="text-tertiary" style="font-size:12px;">${esc(g.dietaryRestrictions)}</div>`:''}</td>
      <td>${esc(g.relationship||'—')}</td>
      <td><span class="badge ${rsvpBadge}">${g.rsvp||'pending'}</span></td>
      <td>${esc(g.mealPreference||'—')}</td>
      <td>${tableObj?esc(tableObj.name):'—'}</td>
      <td>${g.plusOne?'Yes':'No'}</td>`;
    const actionsTd = el('td',{});
    const actionsWrap = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>openGuestForm(g)},[]); editBtn.innerHTML=icon('edit',15);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>confirmDialog({title:'Remove guest?', message:`Remove "${g.name}" from the guest list?`, danger:true, confirmLabel:'Remove', onConfirm:()=>{ Store.remove('guests', g.id); Toast.show('Guest removed.'); render(); }})},[]); delBtn.innerHTML=icon('trash',15);
    actionsWrap.appendChild(editBtn); actionsWrap.appendChild(delBtn);
    actionsTd.appendChild(actionsWrap);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); region.appendChild(wrap);
}

function openGuestForm(existing){
  const tableOptions = [{value:'',label:'Unassigned'}].concat(Store.data.seatingTables.map(t=>({value:t.id,label:t.name})));
  const {wrap:w1,input:name} = formField({label:'Guest Name', id:'g_name', required:true, value:existing?existing.name:''});
  const {wrap:w2,input:relationship} = formField({label:'Relationship', id:'g_rel', value:existing?existing.relationship:''});
  const {wrap:w3,input:rsvp} = formField({label:'RSVP Status', id:'g_rsvp', type:'select', options:[['pending','Pending'],['yes','Confirmed'],['no','Declined']].map(o=>({value:o[0],label:o[1]})), value:existing?existing.rsvp:'pending'});
  const {wrap:w4,input:plusOne} = formField({label:'Plus One', id:'g_plus', type:'select', options:[{value:'',label:'No'},{value:'yes',label:'Yes'}], value:existing&&existing.plusOne?'yes':''});
  const {wrap:w5,input:meal} = formField({label:'Meal Preference', id:'g_meal', value:existing?existing.mealPreference:''});
  const {wrap:w6,input:diet} = formField({label:'Dietary Restrictions', id:'g_diet', value:existing?existing.dietaryRestrictions:''});
  const {wrap:w7,input:table} = formField({label:'Table Assignment', id:'g_table', type:'select', options:tableOptions, value:existing?existing.tableId:''});
  const {wrap:w8,input:gift} = formField({label:'Gift Status', id:'g_gift', type:'select', options:[{value:'none',label:'None received'},{value:'received',label:'Received'},{value:'thanked',label:'Thank-you sent'}], value:existing?existing.giftStatus:'none'});
  const {wrap:w9,input:contact} = formField({label:'Contact (email/phone)', id:'g_contact', value:existing?existing.contact:''});
  const {wrap:w10,input:notes} = formField({label:'Special Notes', id:'g_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{});
  body.appendChild(w1);
  const grid = el('div',{class:'form-grid'}); [w2,w3,w4,w5,w6,w7,w8,w9].forEach(w=>grid.appendChild(w));
  body.appendChild(grid); body.appendChild(w10);
  const footer = [
    el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!name.value.trim()){ Toast.show('Guest name is required.','danger'); return; }
      const payload = { name:name.value.trim(), relationship:relationship.value, rsvp:rsvp.value, plusOne: plusOne.value==='yes', mealPreference:meal.value, dietaryRestrictions:diet.value, tableId:table.value||null, giftStatus:gift.value, contact:contact.value, notes:notes.value };
      if(existing) Store.update('guests', existing.id, payload); else Store.add('guests', payload);
      Toast.show('Guest saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Guest'])
  ];
  const ref = Modal.open({title: existing?'Edit Guest':'Add Guest', body, footer, width:'640px'});
}

/* ---------- Seating Planner ---------- */
function renderSeatingPlanner(body){
  const data = Store.data;
  const actions = el('div',{style:'display:flex; gap:10px; margin-bottom:16px;'});
  const addBtn = el('button',{class:'btn btn-primary', onclick:()=>openTableForm()},[]); addBtn.innerHTML=icon('plus',16)+' Add Table';
  actions.appendChild(addBtn);
  body.appendChild(actions);

  if(!data.seatingTables.length){
    body.appendChild(emptyState({icon:'guests', title:'No tables yet', message:'Add tables, set their capacity, then assign guests from the Guest List tab.', actionLabel:'Add a Table', onAction:()=>openTableForm()}));
    return;
  }
  const conflicts = Intel.seatingConflicts(data);
  if(conflicts.length){
    const warn = el('div',{class:'card', style:'margin-bottom:16px; border-color:var(--odf-danger);'});
    warn.innerHTML = `<strong style="font-size:14px;color:var(--odf-danger);">Seating conflicts detected</strong>` + conflicts.map(c=>`<p class="text-secondary" style="font-size:13px;margin-top:6px;">${esc(c.table.name)}: ${esc(c.message)}</p>`).join('');
    body.appendChild(warn);
  }
  const grid = el('div',{class:'grid grid-3'});
  data.seatingTables.forEach(t=>{
    const assigned = data.guests.filter(g=>g.tableId===t.id);
    const over = assigned.length > (Number(t.capacity)||0);
    const c = el('div',{class:'card'});
    c.innerHTML = `<div class="flex-between" style="margin-bottom:8px;"><strong>${esc(t.name)}</strong><span class="badge ${over?'badge-danger':'badge-neutral'}">${assigned.length}/${t.capacity}</span></div>`;
    if(t.notes) c.innerHTML += `<div class="text-tertiary" style="font-size:12.5px; margin-bottom:8px;">${esc(t.notes)}</div>`;
    const list = el('div',{style:'display:flex;flex-direction:column;gap:4px;margin-bottom:10px;'});
    if(!assigned.length) list.appendChild(el('div',{class:'text-tertiary', style:'font-size:13px;'},['No guests assigned.']));
    assigned.forEach(g=>list.appendChild(el('div',{style:'font-size:13.5px;'},[g.name])));
    c.appendChild(list);
    const actionsRow = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>openTableForm(t)},[]); editBtn.innerHTML=icon('edit',14);
    const delBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>confirmDialog({title:'Delete table?', message:`Delete "${t.name}"? Assigned guests will become unassigned.`, danger:true, confirmLabel:'Delete', onConfirm:()=>{ data.guests.forEach(g=>{ if(g.tableId===t.id) g.tableId=null; }); Store.remove('seatingTables', t.id); Toast.show('Table deleted.'); render(); }})},[]); delBtn.innerHTML=icon('trash',14);
    actionsRow.appendChild(editBtn); actionsRow.appendChild(delBtn);
    c.appendChild(actionsRow);
    grid.appendChild(c);
  });
  body.appendChild(grid);
}
function openTableForm(existing){
  const {wrap:w1,input:name} = formField({label:'Table Name', id:'st_name', required:true, value:existing?existing.name:''});
  const {wrap:w2,input:capacity} = formField({label:'Capacity', id:'st_cap', type:'number', value:existing?existing.capacity:8});
  const {wrap:w3,input:notes} = formField({label:'Notes (VIP, family grouping, conflicts)', id:'st_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{}); [w1,w2,w3].forEach(w=>body.appendChild(w));
  const footer = [ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!name.value.trim()){ Toast.show('Table name required.','danger'); return; }
      const payload = { name:name.value.trim(), capacity:Number(capacity.value)||8, notes:notes.value };
      if(existing) Store.update('seatingTables', existing.id, payload); else Store.add('seatingTables', payload);
      Toast.show('Table saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Table']) ];
  const ref = Modal.open({title: existing?'Edit Table':'Add Table', body, footer});
}

/* ---------- Gift Registry ---------- */
function renderGiftRegistry(body){
  const items = Store.data.registryItems;
  const actions = el('div',{style:'display:flex; gap:10px; margin-bottom:16px;'});
  const addBtn = el('button',{class:'btn btn-primary', onclick:()=>openRegistryForm()},[]); addBtn.innerHTML=icon('plus',16)+' Add Item';
  actions.appendChild(addBtn);
  body.appendChild(actions);
  if(!items.length){
    body.appendChild(emptyState({icon:'heart', title:'No registry items yet', message:'Track gift registry items, prices, and purchase status across every store.', actionLabel:'Add an Item', onAction:()=>openRegistryForm()}));
    return;
  }
  const wrap = el('div',{class:'table-wrap'});
  const table = el('table',{});
  table.innerHTML = `<thead><tr><th>Item</th><th>Store</th><th>Price</th><th>Priority</th><th>Status</th><th></th></tr></thead>`;
  const tbody = el('tbody',{});
  items.forEach(it=>{
    const tr = el('tr',{});
    const statusBadge = it.purchased ? 'badge-success' : 'badge-neutral';
    tr.innerHTML = `<td><strong>${esc(it.name)}</strong>${it.notes?`<div class="text-tertiary" style="font-size:12px;">${esc(it.notes)}</div>`:''}</td><td>${esc(it.store||'—')}</td><td>${fmtMoney(it.price)}</td><td><span class="badge badge-neutral">${esc(it.priority||'nice-to-have')}</span></td><td><span class="badge ${statusBadge}">${it.purchased?'Purchased':'Available'}</span></td>`;
    const actionsTd = el('td',{});
    const actionsWrap = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>openRegistryForm(it)},[]); editBtn.innerHTML=icon('edit',15);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>confirmDialog({title:'Remove item?', message:`Remove "${it.name}"?`, danger:true, confirmLabel:'Remove', onConfirm:()=>{ Store.remove('registryItems', it.id); Toast.show('Removed.'); render(); }})},[]); delBtn.innerHTML=icon('trash',15);
    actionsWrap.appendChild(editBtn); actionsWrap.appendChild(delBtn);
    actionsTd.appendChild(actionsWrap); tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
}
function openRegistryForm(existing){
  const {wrap:w1,input:name} = formField({label:'Item Name', id:'r_name', required:true, value:existing?existing.name:''});
  const {wrap:w2,input:store} = formField({label:'Store', id:'r_store', value:existing?existing.store:''});
  const {wrap:w3,input:price} = formField({label:'Price ($)', id:'r_price', type:'number', value:existing?existing.price:''});
  const {wrap:w4,input:priority} = formField({label:'Priority', id:'r_pri', type:'select', options:['must-have','nice-to-have','optional'], value:existing?existing.priority:'nice-to-have'});
  const {wrap:w5,input:purchased} = formField({label:'Purchased', id:'r_purchased', type:'select', options:[{value:'',label:'No'},{value:'yes',label:'Yes'}], value:existing&&existing.purchased?'yes':''});
  const {wrap:w6,input:notes} = formField({label:'Notes', id:'r_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{}); const grid = el('div',{class:'form-grid'}); [w2,w3,w4,w5].forEach(w=>grid.appendChild(w));
  body.appendChild(w1); body.appendChild(grid); body.appendChild(w6);
  const footer = [ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!name.value.trim()){ Toast.show('Item name required.','danger'); return; }
      const payload = { name:name.value.trim(), store:store.value, price:Number(price.value)||0, priority:priority.value, purchased: purchased.value==='yes', notes:notes.value };
      if(existing) Store.update('registryItems', existing.id, payload); else Store.add('registryItems', payload);
      Toast.show('Saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Item']) ];
  const ref = Modal.open({title: existing?'Edit Item':'Add Registry Item', body, footer});
}
/* ============ Vendor Manager + Documents Module ============ */
let vendorFilter = { category:'all', search:'' };

PAGE_RENDERERS.vendors = function(container){
  const sub = Router.subtab.vendors || 'list';
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Vendors']), el('div',{class:'page-sub'},['Contracts, payments, communication, and vendor documents.']) ]),
  ]));
  const tabs = el('div',{class:'subtabs'});
  [['list','Vendor Directory'],['documents','Documents']].forEach(([id,label])=>{
    tabs.appendChild(el('button',{class:'subtab'+(sub===id?' active':''), onclick:()=>Router.go('vendors',id)},[label]));
  });
  container.appendChild(tabs);
  const body = el('div',{}); container.appendChild(body);
  if(sub==='documents') renderDocuments(body); else renderVendorList(body);
};

function renderVendorList(body){
  const data = Store.data;
  const actions = el('div',{style:'display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; justify-content:space-between;'});
  const addBtn = el('button',{class:'btn btn-primary', onclick:()=>openVendorForm()},[]); addBtn.innerHTML=icon('plus',16)+' Add Vendor';
  actions.appendChild(addBtn);
  body.appendChild(actions);
  if(!data.vendors.length){
    body.appendChild(emptyState({icon:'vendors', title:'No vendors yet', message:'Track every vendor — contracts, payment schedules, ratings, and communication in one place.', actionLabel:'Add Your First Vendor', onAction:()=>openVendorForm()}));
    return;
  }
  const filterBar = el('div',{style:'display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap;'});
  const catSelect = el('select',{'aria-label':'Filter by category'});
  ['all',...VENDOR_CATEGORIES].forEach(c=>catSelect.appendChild(el('option',{value:c},[c==='all'?'All Categories':c])));
  catSelect.value = vendorFilter.category;
  catSelect.addEventListener('change', ()=>{ vendorFilter.category=catSelect.value; renderVendorTable(region); });
  const searchInput = el('input',{type:'text', placeholder:'Search vendors…', style:'max-width:220px;', value:vendorFilter.search});
  searchInput.addEventListener('input', debounce(()=>{ vendorFilter.search=searchInput.value; renderVendorTable(region); },200));
  filterBar.appendChild(catSelect); filterBar.appendChild(searchInput);
  body.appendChild(filterBar);
  const region = el('div',{}); body.appendChild(region);
  renderVendorTable(region);
}

function renderVendorTable(region){
  region.innerHTML = '';
  let vendors = Store.data.vendors.slice();
  if(vendorFilter.category!=='all') vendors = vendors.filter(v=>v.category===vendorFilter.category);
  if(vendorFilter.search) vendors = vendors.filter(v=>(v.company||'').toLowerCase().includes(vendorFilter.search.toLowerCase()));
  if(!vendors.length){ region.appendChild(el('p',{class:'text-secondary'},['No vendors match your filters.'])); return; }
  const grid = el('div',{class:'grid grid-3'});
  vendors.forEach(v=>{
    const c = el('div',{class:'card'});
    const statusBadge = {signed:'badge-success', pending:'badge-warning', none:'badge-neutral'}[v.contractStatus] || 'badge-neutral';
    const stars = '★'.repeat(Number(v.rating)||0) + '☆'.repeat(5-(Number(v.rating)||0));
    c.innerHTML = `<div class="flex-between" style="margin-bottom:6px;"><strong>${esc(v.company)}</strong><span class="badge ${statusBadge}">${esc(v.contractStatus||'none')}</span></div>
      <div class="text-secondary" style="font-size:13px;margin-bottom:8px;">${esc(v.category||'')}</div>
      <div style="color:var(--odf-warning); font-size:13px; margin-bottom:8px;">${stars}</div>
      <div class="text-tertiary" style="font-size:12.5px; display:flex; flex-direction:column; gap:2px;">
        ${v.contact?`<span>${esc(v.contact)}</span>`:''} ${v.email?`<span>${esc(v.email)}</span>`:''} ${v.phone?`<span>${esc(v.phone)}</span>`:''}
      </div>`;
    if(v.paymentDueDate) c.innerHTML += `<div style="margin-top:8px;font-size:12.5px;" class="text-secondary">Next payment: ${fmtDate(v.paymentDueDate)}</div>`;
    const actionsRow = el('div',{class:'row-actions', style:'margin-top:10px;'});
    const editBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>openVendorForm(v)},[]); editBtn.innerHTML=icon('edit',14);
    const delBtn = el('button',{class:'btn btn-ghost btn-sm', onclick:()=>confirmDialog({title:'Delete vendor?', message:`Delete "${v.company}" permanently?`, danger:true, confirmLabel:'Delete', onConfirm:()=>{ Store.remove('vendors', v.id); Toast.show('Vendor deleted.'); render(); }})},[]); delBtn.innerHTML=icon('trash',14);
    actionsRow.appendChild(editBtn); actionsRow.appendChild(delBtn);
    c.appendChild(actionsRow);
    grid.appendChild(c);
  });
  region.appendChild(grid);
}

function openVendorForm(existing){
  const {wrap:w1,input:company} = formField({label:'Company Name', id:'v_company', required:true, value:existing?existing.company:''});
  const {wrap:w2,input:category} = formField({label:'Category', id:'v_cat', type:'select', options:VENDOR_CATEGORIES, value:existing?existing.category:VENDOR_CATEGORIES[0]});
  const {wrap:w3,input:contact} = formField({label:'Contact Name', id:'v_contact', value:existing?existing.contact:''});
  const {wrap:w4,input:email} = formField({label:'Email', id:'v_email', type:'email', value:existing?existing.email:''});
  const {wrap:w5,input:phone} = formField({label:'Phone', id:'v_phone', type:'tel', value:existing?existing.phone:''});
  const {wrap:w6,input:website} = formField({label:'Website', id:'v_web', type:'url', value:existing?existing.website:''});
  const {wrap:w7,input:contractStatus} = formField({label:'Contract Status', id:'v_status', type:'select', options:[{value:'none',label:'Not started'},{value:'pending',label:'Pending'},{value:'signed',label:'Signed'},{value:'paid',label:'Paid in full'}], value:existing?existing.contractStatus:'none'});
  const {wrap:w8,input:paymentDueDate} = formField({label:'Next Payment Due', id:'v_pay', type:'date', value:existing?existing.paymentDueDate:''});
  const {wrap:w9,input:rating} = formField({label:'Rating (1-5)', id:'v_rating', type:'number', min:0, max:5, value:existing?existing.rating:''});
  const {wrap:w10,input:notes} = formField({label:'Notes / Communication History', id:'v_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{}); body.appendChild(w1);
  const grid = el('div',{class:'form-grid'}); [w2,w3,w4,w5,w6,w7,w8,w9].forEach(w=>grid.appendChild(w));
  body.appendChild(grid); body.appendChild(w10);
  const footer = [ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!company.value.trim()){ Toast.show('Company name required.','danger'); return; }
      const payload = { company:company.value.trim(), category:category.value, contact:contact.value, email:email.value, phone:phone.value, website:website.value, contractStatus:contractStatus.value, paymentDueDate:paymentDueDate.value, rating:Number(rating.value)||0, notes:notes.value };
      if(existing) Store.update('vendors', existing.id, payload); else Store.add('vendors', payload);
      Toast.show('Vendor saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Vendor']) ];
  const ref = Modal.open({title: existing?'Edit Vendor':'Add Vendor', body, footer, width:'640px'});
}

/* ---------- Documents ---------- */
const DOC_CATEGORIES = ['Contract','Invoice','Guest List','Menu','Venue Layout','Vendor Proposal','Permit','Receipt','Other'];
function renderDocuments(body){
  const docs = Store.data.documents;
  const actions = el('div',{style:'display:flex; gap:10px; margin-bottom:16px;'});
  const addBtn = el('button',{class:'btn btn-primary', onclick:()=>openDocumentForm()},[]); addBtn.innerHTML=icon('plus',16)+' Add Document Reference';
  actions.appendChild(addBtn);
  body.appendChild(actions);
  if(!docs.length){
    body.appendChild(emptyState({icon:'reports', title:'No documents tracked yet', message:'Log references to contracts, invoices, permits, and other important wedding documents — with links to the vendor or guest they relate to.', actionLabel:'Add a Document', onAction:()=>openDocumentForm()}));
    return;
  }
  const wrap = el('div',{class:'table-wrap'});
  const table = el('table',{});
  table.innerHTML = `<thead><tr><th>Title</th><th>Category</th><th>Related Vendor</th><th>Notes</th><th></th></tr></thead>`;
  const tbody = el('tbody',{});
  docs.forEach(d=>{
    const vendor = Store.data.vendors.find(v=>v.id===d.vendorId);
    const tr = el('tr',{});
    tr.innerHTML = `<td><strong>${esc(d.title)}</strong></td><td><span class="badge badge-neutral">${esc(d.category)}</span></td><td>${vendor?esc(vendor.company):'—'}</td><td class="text-secondary" style="font-size:13px;">${esc(d.notes||'')}</td>`;
    const actionsTd = el('td',{}); const actionsWrap = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>openDocumentForm(d)},[]); editBtn.innerHTML=icon('edit',15);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>confirmDialog({title:'Remove document?', message:`Remove "${d.title}"?`, danger:true, confirmLabel:'Remove', onConfirm:()=>{ Store.remove('documents', d.id); Toast.show('Removed.'); render(); }})},[]); delBtn.innerHTML=icon('trash',15);
    actionsWrap.appendChild(editBtn); actionsWrap.appendChild(delBtn); actionsTd.appendChild(actionsWrap); tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
}
function openDocumentForm(existing){
  const vendorOptions = [{value:'',label:'None'}].concat(Store.data.vendors.map(v=>({value:v.id,label:v.company})));
  const {wrap:w1,input:title} = formField({label:'Document Title', id:'d_title', required:true, value:existing?existing.title:''});
  const {wrap:w2,input:category} = formField({label:'Category', id:'d_cat', type:'select', options:DOC_CATEGORIES, value:existing?existing.category:DOC_CATEGORIES[0]});
  const {wrap:w3,input:vendorId} = formField({label:'Related Vendor', id:'d_vendor', type:'select', options:vendorOptions, value:existing?existing.vendorId:''});
  const {wrap:w4,input:notes} = formField({label:'Notes', id:'d_notes', type:'textarea', value:existing?existing.notes:'', hint:'Since this app stores no attached files, note where the physical/digital file lives.'});
  const body = el('div',{}); [w1,w2,w3,w4].forEach(w=>body.appendChild(w));
  const footer = [ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!title.value.trim()){ Toast.show('Title required.','danger'); return; }
      const payload = { title:title.value.trim(), category:category.value, vendorId:vendorId.value||null, notes:notes.value };
      if(existing) Store.update('documents', existing.id, payload); else Store.add('documents', payload);
      Toast.show('Saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Document']) ];
  const ref = Modal.open({title: existing?'Edit Document':'Add Document Reference', body, footer});
}
/* ============ Budget Manager Module ============ */
PAGE_RENDERERS.budget = function(container){
  container.innerHTML = '';
  const data = Store.data;
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Budget Manager']), el('div',{class:'page-sub'},['Estimates, actuals, deposits, and your overall budget health.']) ]),
    el('div',{class:'page-actions'},[ (()=>{ const b=el('button',{class:'btn btn-primary', onclick:()=>openBudgetForm()},[]); b.innerHTML=icon('plus',16)+' Add Budget Item'; return b; })() ])
  ]));

  if(!data.budgetItems.length){
    container.appendChild(emptyState({icon:'budget', title:'No budget items yet', message:'Break your wedding budget into categories and track estimated vs. actual costs, deposits, and final payments.', actionLabel:'Add Your First Budget Item', onAction:()=>openBudgetForm()}));
    return;
  }

  const items = data.budgetItems;
  const est = items.reduce((s,i)=>s+(Number(i.estimated)||0),0);
  const act = items.reduce((s,i)=>s+(Number(i.actual)||0),0);
  const target = Number(data.wedding.budgetTarget)||0;
  const bh = Intel.budgetHealth(data);
  const forecast = Intel.budgetForecast(data);

  const kpis = el('div',{class:'grid grid-4', style:'margin-bottom:24px;'});
  kpis.appendChild(kpiCard('Budget Target', fmtMoney(target), ''));
  kpis.appendChild(kpiCard('Estimated Total', fmtMoney(est), ''));
  kpis.appendChild(kpiCard('Actual Spent', fmtMoney(act), target?Math.round((act/target)*100)+'% of target':''));
  kpis.appendChild(kpiCard('Remaining', fmtMoney(target-act), target-act<0?'Over budget':'On track'));
  container.appendChild(kpis);

  const healthCard = el('div',{class:'card', style:'margin-bottom:24px;'});
  healthCard.innerHTML = `<div class="flex-between"><div class="card-title" style="margin-bottom:0;">Budget Health Score</div><span class="badge ${bh.value>=70?'badge-success':bh.value>=40?'badge-warning':'badge-danger'}">${bh.value}/100</span></div><p class="text-secondary" style="font-size:13.5px; margin-top:8px;">${esc(bh.reason)}</p>${forecast.overTarget?`<p style="color:var(--odf-danger); font-size:13px; margin-top:6px;">Forecast: ${esc(forecast.reason)}</p>`:''}`;
  container.appendChild(healthCard);

  // Category breakdown chart (simple bar)
  const catCard = el('div',{class:'card', style:'margin-bottom:24px;'});
  catCard.appendChild(el('div',{class:'card-title'},['Spending by Category']));
  const byCat = {};
  items.forEach(i=>{ byCat[i.category] = byCat[i.category]||{est:0,act:0}; byCat[i.category].est += Number(i.estimated)||0; byCat[i.category].act += Number(i.actual)||0; });
  const maxVal = Math.max(1, ...Object.values(byCat).map(v=>Math.max(v.est,v.act)));
  const chart = el('div',{style:'display:flex;flex-direction:column;gap:12px;'});
  Object.keys(byCat).forEach(cat=>{
    const {est:ce, act:ca} = byCat[cat];
    const row = el('div',{});
    row.innerHTML = `<div class="flex-between" style="font-size:13px;margin-bottom:4px;"><span>${esc(cat)}</span><span class="text-tertiary">${fmtMoney(ca)} / ${fmtMoney(ce)}</span></div>
      <div class="progress-track"><div class="progress-fill ${ca>ce?'danger':'success'}" style="width:${clamp((ca/maxVal)*100,0,100)}%"></div></div>`;
    chart.appendChild(row);
  });
  catCard.appendChild(chart);
  container.appendChild(catCard);

  const wrap = el('div',{class:'table-wrap'});
  const table = el('table',{});
  table.innerHTML = `<thead><tr><th>Item</th><th>Category</th><th>Estimated</th><th>Actual</th><th>Variance</th><th>Payment Status</th><th></th></tr></thead>`;
  const tbody = el('tbody',{});
  items.forEach(i=>{
    const variance = (Number(i.actual)||0) - (Number(i.estimated)||0);
    const tr = el('tr',{});
    tr.innerHTML = `<td><strong>${esc(i.name)}</strong></td><td>${esc(i.category)}</td><td>${fmtMoney(i.estimated)}</td><td>${fmtMoney(i.actual)}</td>
      <td class="${variance>0?'text-danger':'text-success'}">${variance>0?'+':''}${fmtMoney(variance)}</td>
      <td><span class="badge ${i.paymentStatus==='paid'?'badge-success':i.paymentStatus==='deposit'?'badge-warning':'badge-neutral'}">${esc(i.paymentStatus||'unpaid')}</span></td>`;
    const actionsTd = el('td',{}); const actionsWrap = el('div',{class:'row-actions'});
    const editBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>openBudgetForm(i)},[]); editBtn.innerHTML=icon('edit',15);
    const delBtn = el('button',{class:'btn btn-ghost btn-icon', onclick:()=>confirmDialog({title:'Delete budget item?', message:`Delete "${i.name}"?`, danger:true, confirmLabel:'Delete', onConfirm:()=>{ Store.remove('budgetItems', i.id); Toast.show('Deleted.'); render(); }})},[]); delBtn.innerHTML=icon('trash',15);
    actionsWrap.appendChild(editBtn); actionsWrap.appendChild(delBtn); actionsTd.appendChild(actionsWrap); tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); container.appendChild(wrap);
};

function openBudgetForm(existing){
  const {wrap:w1,input:name} = formField({label:'Item Name', id:'b_name', required:true, value:existing?existing.name:''});
  const {wrap:w2,input:category} = formField({label:'Category', id:'b_cat', type:'select', options:BUDGET_CATEGORIES, value:existing?existing.category:BUDGET_CATEGORIES[0]});
  const {wrap:w3,input:estimated} = formField({label:'Estimated Cost ($)', id:'b_est', type:'number', value:existing?existing.estimated:''});
  const {wrap:w4,input:actual} = formField({label:'Actual Cost ($)', id:'b_act', type:'number', value:existing?existing.actual:''});
  const {wrap:w5,input:paymentStatus} = formField({label:'Payment Status', id:'b_status', type:'select', options:[{value:'unpaid',label:'Unpaid'},{value:'deposit',label:'Deposit paid'},{value:'paid',label:'Paid in full'}], value:existing?existing.paymentStatus:'unpaid'});
  const {wrap:w6,input:notes} = formField({label:'Notes', id:'b_notes', type:'textarea', value:existing?existing.notes:''});
  const body = el('div',{}); body.appendChild(w1);
  const grid = el('div',{class:'form-grid'}); [w2,w3,w4,w5].forEach(w=>grid.appendChild(w));
  body.appendChild(grid); body.appendChild(w6);
  const footer = [ el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Cancel']),
    el('button',{class:'btn btn-primary', onclick:()=>{
      if(!name.value.trim()){ Toast.show('Item name required.','danger'); return; }
      const payload = { name:name.value.trim(), category:category.value, estimated:Number(estimated.value)||0, actual:Number(actual.value)||0, paymentStatus:paymentStatus.value, notes:notes.value };
      if(existing) Store.update('budgetItems', existing.id, payload); else Store.add('budgetItems', payload);
      Toast.show('Budget item saved.','success'); ref.close(); render();
    }},[existing?'Save Changes':'Add Budget Item']) ];
  const ref = Modal.open({title: existing?'Edit Budget Item':'Add Budget Item', body, footer});
}
/* ============ Reports Module (Report Builder) ============ */
const REPORT_TYPES = [
  {id:'overview', label:'Wedding Overview'},
  {id:'budget', label:'Budget Report'},
  {id:'vendors', label:'Vendor Directory'},
  {id:'guests', label:'Guest Directory'},
  {id:'rsvp', label:'RSVP Summary'},
  {id:'tasks', label:'Task Progress'},
  {id:'timeline', label:'Timeline Report'},
  {id:'payments', label:'Payment Calendar'},
  {id:'schedule', label:'Wedding Day Schedule'},
  {id:'seating', label:'Printable Seating Chart'},
  {id:'vendorbook', label:'Vendor Contact Book'}
];

PAGE_RENDERERS.reports = function(container){
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Reports']), el('div',{class:'page-sub'},['Generate printable, shareable reports from your live planning data.']) ])
  ]));
  const grid = el('div',{class:'grid grid-3'});
  REPORT_TYPES.forEach(r=>{
    const c = el('div',{class:'card'});
    c.innerHTML = `<div class="card-title">${r.label}</div><p class="text-secondary" style="font-size:13px; margin-bottom:14px;">${reportDescription(r.id)}</p>`;
    const btn = el('button',{class:'btn btn-secondary btn-sm', onclick:()=>openReportPreview(r.id, r.label)},['View Report']);
    c.appendChild(btn);
    grid.appendChild(c);
  });
  container.appendChild(grid);
};

function reportDescription(id){
  return {
    overview:'High-level snapshot of your entire wedding plan.',
    budget:'Full budget breakdown by category with variance.',
    vendors:'Every vendor with contract and payment status.',
    guests:'Complete guest list with RSVP and meal detail.',
    rsvp:'RSVP totals, response rate, and prediction.',
    tasks:'Checklist progress by category.',
    timeline:'Upcoming milestones in date order.',
    payments:'Upcoming vendor payments by due date.',
    schedule:'Wedding-day run-of-show, built from timeline tasks.',
    seating:'Table-by-table seating assignments.',
    vendorbook:'Quick-reference contact sheet for every vendor.'
  }[id] || '';
}

function openReportPreview(reportId, title){
  const content = buildReportHTML(reportId);
  const bodyEl = el('div',{});
  bodyEl.innerHTML = `<div id="report-print-area" style="font-size:13.5px;">${content}</div>`;
  const footer = [
    el('button',{class:'btn btn-secondary', onclick:()=>ref.close()},['Close']),
    el('button',{class:'btn btn-primary', onclick:()=>printReport(title, content)},['Print / Save as PDF'])
  ];
  const ref = Modal.open({title, body:bodyEl, footer, width:'700px'});
}

function printReport(title, content){
  const w = window.open('', '_blank');
  if(!w){ Toast.show('Please allow popups to print reports.', 'danger'); return; }
  w.document.write(`<html><head><title>${esc(title)} — Wedding Planner Pro</title><style>
    body{font-family:Georgia,serif;color:#2B2420;padding:32px;max-width:800px;margin:0 auto;}
    h1{font-size:22px;border-bottom:2px solid #B76E79;padding-bottom:10px;}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;}
    th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;}
    th{text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:#666;}
    .rpt-section{margin-top:20px;}
  </style></head><body><h1>${esc(title)}</h1>${content}</body></html>`);
  w.document.close();
  setTimeout(()=>w.print(), 300);
}

function buildReportHTML(id){
  const data = Store.data;
  switch(id){
    case 'overview': {
      const readiness = Intel.weddingReadiness(data);
      return `<p><strong>${esc(data.wedding.partner1||'Partner 1')} &amp; ${esc(data.wedding.partner2||'Partner 2')}</strong><br>${fmtDate(data.wedding.date)} · ${esc(data.wedding.ceremonyLocation||'Location TBD')}</p>
      <p>Wedding Readiness: <strong>${readiness.value}%</strong></p>
      <table><tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Guests</td><td>${data.guests.length} (${data.guests.filter(g=>g.rsvp==='yes').length} confirmed)</td></tr>
      <tr><td>Vendors</td><td>${data.vendors.length}</td></tr>
      <tr><td>Tasks</td><td>${data.tasks.filter(t=>t.status==='done').length}/${data.tasks.length} complete</td></tr>
      <tr><td>Budget</td><td>${fmtMoney(data.budgetItems.reduce((s,i)=>s+(Number(i.actual)||0),0))} of ${fmtMoney(data.wedding.budgetTarget)}</td></tr>
      </table>`;
    }
    case 'budget': {
      const rows = data.budgetItems.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.category)}</td><td>${fmtMoney(i.estimated)}</td><td>${fmtMoney(i.actual)}</td><td>${esc(i.paymentStatus)}</td></tr>`).join('');
      return `<table><tr><th>Item</th><th>Category</th><th>Estimated</th><th>Actual</th><th>Status</th></tr>${rows||'<tr><td colspan="5">No budget items yet.</td></tr>'}</table>`;
    }
    case 'vendors': {
      const rows = data.vendors.map(v=>`<tr><td>${esc(v.company)}</td><td>${esc(v.category)}</td><td>${esc(v.contact||'')}</td><td>${esc(v.contractStatus)}</td></tr>`).join('');
      return `<table><tr><th>Company</th><th>Category</th><th>Contact</th><th>Status</th></tr>${rows||'<tr><td colspan="4">No vendors yet.</td></tr>'}</table>`;
    }
    case 'guests': {
      const rows = data.guests.map(g=>`<tr><td>${esc(g.name)}</td><td>${esc(g.relationship||'')}</td><td>${esc(g.rsvp)}</td><td>${esc(g.mealPreference||'')}</td></tr>`).join('');
      return `<table><tr><th>Name</th><th>Relationship</th><th>RSVP</th><th>Meal</th></tr>${rows||'<tr><td colspan="4">No guests yet.</td></tr>'}</table>`;
    }
    case 'rsvp': {
      const yes = data.guests.filter(g=>g.rsvp==='yes').length, no = data.guests.filter(g=>g.rsvp==='no').length, pending = data.guests.filter(g=>g.rsvp==='pending').length;
      const pred = Intel.rsvpPrediction(data);
      return `<table><tr><th>Status</th><th>Count</th></tr><tr><td>Confirmed</td><td>${yes}</td></tr><tr><td>Declined</td><td>${no}</td></tr><tr><td>Pending</td><td>${pending}</td></tr></table><p style="margin-top:12px;">Predicted final headcount: <strong>${pred.value}</strong> — ${esc(pred.reason)}</p>`;
    }
    case 'tasks': {
      const rows = CHECKLIST_CATEGORIES.map(cat=>{
        const ct = data.tasks.filter(t=>t.category===cat);
        if(!ct.length) return '';
        const done = ct.filter(t=>t.status==='done').length;
        return `<tr><td>${cat}</td><td>${done}/${ct.length}</td></tr>`;
      }).join('');
      return `<table><tr><th>Category</th><th>Completed</th></tr>${rows||'<tr><td colspan="2">No tasks yet.</td></tr>'}</table>`;
    }
    case 'timeline': {
      const rows = data.tasks.filter(t=>t.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate)).map(t=>`<tr><td>${fmtDate(t.dueDate)}</td><td>${esc(t.title)}</td><td>${esc(t.category||'')}</td></tr>`).join('');
      return `<table><tr><th>Date</th><th>Task</th><th>Category</th></tr>${rows||'<tr><td colspan="3">No dated tasks yet.</td></tr>'}</table>`;
    }
    case 'payments': {
      const rows = data.vendors.filter(v=>v.paymentDueDate).sort((a,b)=>new Date(a.paymentDueDate)-new Date(b.paymentDueDate)).map(v=>`<tr><td>${fmtDate(v.paymentDueDate)}</td><td>${esc(v.company)}</td><td>${esc(v.contractStatus)}</td></tr>`).join('');
      return `<table><tr><th>Due Date</th><th>Vendor</th><th>Status</th></tr>${rows||'<tr><td colspan="3">No payments scheduled.</td></tr>'}</table>`;
    }
    case 'schedule': {
      const wDate = data.wedding.date;
      const dayTasks = data.tasks.filter(t=>t.dueDate===wDate);
      const rows = dayTasks.map(t=>`<tr><td>${esc(t.title)}</td><td>${esc(t.category||'')}</td></tr>`).join('');
      return `<p>${fmtDate(wDate)} — ${esc(data.wedding.ceremonyLocation||'')}</p><table><tr><th>Item</th><th>Category</th></tr>${rows||'<tr><td colspan="2">No wedding-day tasks scheduled yet — add tasks due on your wedding date in the Checklist.</td></tr>'}</table>`;
    }
    case 'seating': {
      const sections = data.seatingTables.map(t=>{
        const guests = data.guests.filter(g=>g.tableId===t.id).map(g=>`<li>${esc(g.name)}</li>`).join('');
        return `<div class="rpt-section"><strong>${esc(t.name)}</strong> (${t.capacity} seats)<ul>${guests||'<li>No guests assigned</li>'}</ul></div>`;
      }).join('');
      return sections || '<p>No seating tables yet.</p>';
    }
    case 'vendorbook': {
      const rows = data.vendors.map(v=>`<tr><td>${esc(v.company)}</td><td>${esc(v.category)}</td><td>${esc(v.phone||'')}</td><td>${esc(v.email||'')}</td></tr>`).join('');
      return `<table><tr><th>Company</th><th>Category</th><th>Phone</th><th>Email</th></tr>${rows||'<tr><td colspan="4">No vendors yet.</td></tr>'}</table>`;
    }
    default: return '<p>Report not available.</p>';
  }
}
/* ============ Settings Module ============ */
PAGE_RENDERERS.settings = function(container){
  const sub = Router.subtab.settings || 'appearance';
  container.innerHTML = '';
  container.appendChild(el('div',{class:'page-header'},[
    el('div',{},[ el('h1',{},['Settings']), el('div',{class:'page-sub'},['Appearance, data, backup, and accessibility.']) ])
  ]));
  const tabs = el('div',{class:'subtabs'});
  [['appearance','Appearance'],['sync','Sync'],['data','Data'],['backup','Backup & Restore'],['accessibility','Accessibility'],['about','About']].forEach(([id,label])=>{
    tabs.appendChild(el('button',{class:'subtab'+(sub===id?' active':''), onclick:()=>Router.go('settings',id)},[label]));
  });
  container.appendChild(tabs);
  const body = el('div',{}); container.appendChild(body);
  if(sub==='sync') renderSyncSettings(body);
  else if(sub==='data') renderDataManagement(body);
  else if(sub==='backup') renderBackupManager(body);
  else if(sub==='accessibility') renderAccessibilitySettings(body);
  else if(sub==='about') renderAboutPage(body);
  else renderAppearanceSettings(body);
};

/* ---------- Cloud Sync (auto, shared access code) ---------- */
function renderSyncSettings(body){
  const sync = Store.data.settings.sync;
  const card = el('div',{class:'card', style:'max-width:560px; margin-bottom:20px;'});
  card.appendChild(el('div',{class:'card-title'},['Sync Across Devices']));
  card.innerHTML += `<p class="text-secondary" style="font-size:13.5px; margin-bottom:16px;">
    Link this device with an email and access code to automatically keep your wedding plan in sync
    across every device that uses the same email and code — no manual backup/restore needed.
    Anyone who has both the email and the code can see and edit this data, so share the code the
    way you'd share a password: privately, with only the people planning this wedding with you.
  </p>`;

  if(sync.linked){
    card.innerHTML += `<div class="flex-between" style="margin-bottom:14px;">
      <div>
        <div style="font-weight:600;font-size:14px;">Linked as ${esc(sync.email)}</div>
        <div class="text-tertiary" style="font-size:12.5px;">Last synced: ${sync.lastPullAt ? new Date(sync.lastPullAt).toLocaleString() : 'not yet'}</div>
      </div>
      <span class="badge ${sync.status==='synced'?'badge-success':sync.status==='error'?'badge-danger':'badge-neutral'}">${esc(sync.status||'offline')}</span>
    </div>`;
    const btnRow = el('div',{style:'display:flex; gap:10px;'});
    const syncNowBtn = el('button',{class:'btn btn-secondary', onclick:async ()=>{ await Sync.pull({silent:false}); await Sync.push(); Toast.show('Sync check complete.'); render(); }},['Sync Now']);
    const unlinkBtn = el('button',{class:'btn btn-ghost', onclick:()=>confirmDialog({title:'Unlink this device?', message:'This device will stop auto-syncing. Your data stays on this device either way — you can re-link anytime with the same email and code.', confirmLabel:'Unlink', onConfirm:()=>{ Sync.unlink(); Toast.show('Device unlinked.'); render(); }})},['Unlink Device']);
    btnRow.appendChild(syncNowBtn); btnRow.appendChild(unlinkBtn);
    card.appendChild(btnRow);
  } else {
    const form = el('form',{});
    const {wrap:w1,input:email} = formField({label:'Email', id:'sync_email', type:'email', required:true, hint:'Used only to derive your private sync key — never sent anywhere on its own.'});
    const {wrap:w2,input:code} = formField({label:'Access Code', id:'sync_code', type:'text', required:true, hint:'Make this up yourself — anything memorable both partners will use. Treat it like a password.'});
    form.appendChild(w1); form.appendChild(w2);
    const submitBtn = el('button',{type:'submit', class:'btn btn-primary'},['Link This Device']);
    form.appendChild(submitBtn);
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      if(!email.value.trim() || !code.value.trim()){ Toast.show('Email and access code are both required.','danger'); return; }
      submitBtn.disabled = true; submitBtn.textContent = 'Linking…';
      try{
        await Sync.link(email.value.trim(), code.value.trim());
        Toast.show('Device linked. Syncing…', 'success');
        render();
      }catch(err){
        console.error(err);
        Toast.show('Could not link — check your connection and try again.', 'danger');
        submitBtn.disabled = false; submitBtn.textContent = 'Link This Device';
      }
    });
    card.appendChild(form);
  }
  body.appendChild(card);

  const howCard = el('div',{class:'card', style:'max-width:560px;'});
  howCard.innerHTML = `<div class="card-title">How this works</div>
    <p class="text-secondary" style="font-size:13px; line-height:1.7;">
    Every change you make saves locally first, then syncs to your private cloud record within a
    couple of seconds whenever you're online. When you open the app, or reconnect after being
    offline, it checks the cloud for anything newer and pulls it in automatically. If you and a
    partner both edit the same field while offline at the same time, the most recent save wins.
    </p>`;
  body.appendChild(howCard);
}

/* ---------- Theme Manager + Accent Color Picker ---------- */
function renderAppearanceSettings(body){
  const s = Store.data.settings;
  const card = el('div',{class:'card', style:'max-width:560px;'});
  card.appendChild(el('div',{class:'card-title'},['Theme']));
  const themeRow = el('div',{style:'display:flex; gap:10px; margin-bottom:24px;'});
  [['light','Light','sun'],['dark','Dark','moon'],['system','System','settings']].forEach(([val,label,ic])=>{
    const chip = el('button',{class:'chip'+(s.theme===val?' active':''), onclick:()=>{ s.theme=val; Store.persist(); render(); }});
    chip.innerHTML = icon(ic,14)+' '+label;
    themeRow.appendChild(chip);
  });
  card.appendChild(themeRow);

  card.appendChild(el('div',{class:'card-title'},['Accent Color']));
  const swatches = el('div',{style:'display:flex; gap:10px;'});
  [['rose','Rose'],['sage','Sage'],['gold','Gold'],['slate','Slate'],['plum','Plum']].forEach(([val,label])=>{
    const colors = {rose:'#B76E79', sage:'#6E8E6D', gold:'#B8863B', slate:'#5C7080', plum:'#8C6494'};
    const sw = el('button',{'aria-label':label, class:'', onclick:()=>{ s.accent=val; Store.persist(); render(); },
      style:`width:32px;height:32px;border-radius:50%;background:${colors[val]};border:2px solid ${s.accent===val?'var(--odf-text)':'transparent'};cursor:pointer;`});
    swatches.appendChild(sw);
  });
  card.appendChild(swatches);
  body.appendChild(card);
}

/* ---------- Data Management ---------- */
function renderDataManagement(body){
  const data = Store.data;
  const raw = localStorage.getItem(STORAGE_KEY) || '';
  const sizeKb = (new Blob([raw]).size / 1024).toFixed(1);
  const card = el('div',{class:'card', style:'max-width:640px;'});
  card.appendChild(el('div',{class:'card-title'},['Local Storage Usage']));
  card.innerHTML += `<p class="text-secondary" style="font-size:13.5px;">All Wedding Planner Pro data lives only in this browser, on this device — approximately <strong>${sizeKb} KB</strong> currently used.</p>`;
  const categories = [
    ['Guests', data.guests.length], ['Vendors', data.vendors.length], ['Budget Items', data.budgetItems.length],
    ['Tasks', data.tasks.length], ['Seating Tables', data.seatingTables.length], ['Documents', data.documents.length],
    ['Registry Items', data.registryItems.length], ['Inspiration Items', data.inspirationItems.length]
  ];
  const list = el('div',{style:'margin:16px 0; display:flex; flex-direction:column; gap:8px;'});
  categories.forEach(([label,count])=>{
    list.appendChild(el('div',{class:'flex-between', style:'font-size:14px;'},[
      (()=>{const s=document.createElement('span'); s.textContent=label; return s;})(),
      (()=>{const s=document.createElement('span'); s.className='text-tertiary'; s.textContent=count; return s;})()
    ]));
  });
  card.appendChild(list);
  card.appendChild(el('p',{class:'text-secondary', style:'font-size:13px; margin-bottom:14px;'},['Back up your data before clearing anything — clearing is permanent and cannot be undone from within the app.']));
  const clearBtn = el('button',{class:'btn btn-danger', onclick:()=>{
    confirmDialog({ title:'Clear All Data?', message:'This permanently deletes every guest, vendor, task, and budget item stored in this browser. This cannot be undone. Consider creating a backup first.', danger:true, confirmLabel:'Clear Everything', onConfirm:()=>{
      Store.data = defaultData(); Store.persist(); Toast.show('All data cleared.'); Router.go('dashboard'); render();
    }});
  }},['Clear All Data']);
  card.appendChild(clearBtn);
  body.appendChild(card);
}

/* ---------- Backup Manager & Restore Wizard (MANDATORY) ---------- */
function renderBackupManager(body){
  const s = Store.data.settings;
  const card = el('div',{class:'card', style:'max-width:640px; margin-bottom:20px;'});
  card.appendChild(el('div',{class:'card-title'},['Save My Data']));
  card.innerHTML += `<p class="text-secondary" style="font-size:13.5px; margin-bottom:6px;">Creates a single backup file containing your entire wedding plan — guests, vendors, budget, tasks, and settings. This file is yours: save it to your own device, cloud drive, or USB stick. Wedding Planner Pro never transmits this file anywhere.</p>`;
  card.innerHTML += `<p style="font-size:13px; margin-bottom:16px;"><strong>Last backup:</strong> ${s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString() : 'No backup created yet.'}</p>`;
  const saveBtn = el('button',{class:'btn btn-primary', onclick:createBackup},[]); saveBtn.innerHTML = icon('download',16)+' Save My Data';
  card.appendChild(saveBtn);
  body.appendChild(card);

  const restoreCard = el('div',{class:'card', style:'max-width:640px;'});
  restoreCard.appendChild(el('div',{class:'card-title'},['Restore My Data']));
  restoreCard.innerHTML += `<p class="text-secondary" style="font-size:13.5px; margin-bottom:16px;">Select a backup file created with Save My Data to restore your wedding plan on this device. Restoring replaces the data currently in this browser.</p>`;
  const fileInput = el('input',{type:'file', accept:'.uofabackup,application/json', style:'display:none;'});
  fileInput.addEventListener('change', e=>{ if(e.target.files[0]) handleRestoreFile(e.target.files[0]); e.target.value=''; });
  const restoreBtn = el('button',{class:'btn btn-secondary', onclick:()=>fileInput.click()},[]); restoreBtn.innerHTML = icon('upload',16)+' Restore My Data';
  restoreCard.appendChild(restoreBtn); restoreCard.appendChild(fileInput);
  body.appendChild(restoreCard);
}

function createBackup(){
  const payload = {
    format: 'UOAF-BACKUP', formatVersion: BACKUP_FORMAT_VERSION,
    application: APP_ID, applicationVersion: APP_VERSION,
    exportedAt: nowISO(),
    manifest: {
      guests: Store.data.guests.length, vendors: Store.data.vendors.length, tasks: Store.data.tasks.length,
      budgetItems: Store.data.budgetItems.length
    },
    data: Store.data
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `wedding-planner-pro-backup-${todayISO()}.uofabackup`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  Store.data.settings.lastBackupAt = nowISO();
  Store.log('Created a backup');
  Store.persist();
  Toast.show('Backup created and downloaded.', 'success');
  render();
}

function handleRestoreFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try{ parsed = JSON.parse(reader.result); }
    catch(e){ Toast.show('This file isn\'t a valid backup — it could not be read.', 'danger'); return; }
    if(parsed.format !== 'UOAF-BACKUP' || parsed.application !== APP_ID || !parsed.data){
      Toast.show('This backup file doesn\'t match Wedding Planner Pro — restore cancelled.', 'danger');
      return;
    }
    confirmDialog({
      title:'Restore Backup?',
      message:`This backup was created ${new Date(parsed.exportedAt).toLocaleString()} and contains ${parsed.manifest?.guests||0} guests, ${parsed.manifest?.vendors||0} vendors, and ${parsed.manifest?.tasks||0} tasks. Restoring will replace all current data on this device. This cannot be undone.`,
      danger:true, confirmLabel:'Restore Backup',
      onConfirm:()=>{
        try{
          // safety backup of current state before overwrite
          const safety = JSON.stringify(Store.data);
          sessionStorage.setItem('uoaf.wpp.preRestoreSafety', safety);
          Store.data = migrateData(parsed.data);
          Store.persist();
          Toast.show('Backup restored successfully.', 'success');
          Router.go('dashboard'); render();
        }catch(e){
          console.error(e);
          Toast.show('Restore failed — your existing data was not changed.', 'danger');
        }
      }
    });
  };
  reader.onerror = () => Toast.show('Could not read that file.', 'danger');
  reader.readAsText(file);
}

/* ---------- Accessibility Settings ---------- */
function renderAccessibilitySettings(body){
  const s = Store.data.settings;
  const card = el('div',{class:'card', style:'max-width:560px;'});
  card.appendChild(el('div',{class:'card-title'},['Accessibility']));
  const rows = el('div',{});
  rows.appendChild(toggleRow('Reduced Motion','Minimizes animations and transitions throughout the app.', s.reducedMotion, v=>{ s.reducedMotion=v; Store.persist(); render(); }));
  rows.appendChild(toggleRow('High Contrast','Strengthens borders and text contrast beyond the default.', s.highContrast, v=>{ s.highContrast=v; Store.persist(); render(); }));
  card.appendChild(rows);
  card.appendChild(el('div',{class:'card-title', style:'margin-top:20px;'},['Text Size']));
  const sizeRow = el('div',{style:'display:flex; gap:10px;'});
  [[0.9,'Small'],[1,'Default'],[1.15,'Large'],[1.3,'Larger']].forEach(([val,label])=>{
    const chip = el('button',{class:'chip'+(Math.abs(s.textScale-val)<0.01?' active':''), onclick:()=>{ s.textScale=val; Store.persist(); render(); }},[label]);
    sizeRow.appendChild(chip);
  });
  card.appendChild(sizeRow);
  body.appendChild(card);

  const kbCard = el('div',{class:'card', style:'max-width:560px; margin-top:20px;'});
  kbCard.appendChild(el('div',{class:'card-title'},['Keyboard Shortcuts']));
  kbCard.innerHTML += `<div style="font-size:13.5px; display:flex; flex-direction:column; gap:8px;">
    <div class="flex-between"><span>Open quick search</span><code>Ctrl/⌘ + K</code></div>
    <div class="flex-between"><span>Close dialog</span><code>Esc</code></div>
  </div>`;
  body.appendChild(kbCard);
}
function toggleRow(label, sub, value, onChange){
  const row = el('div',{class:'toggle-row'});
  const left = el('div',{},[ el('div',{class:'toggle-row-label'},[label]), el('div',{class:'toggle-row-sub'},[sub]) ]);
  const t = el('button',{class:'toggle'+(value?' on':''), role:'switch', 'aria-checked':String(!!value), 'aria-label':label});
  t.addEventListener('click', ()=>{ const nv=!t.classList.contains('on'); t.classList.toggle('on'); t.setAttribute('aria-checked',String(nv)); onChange(nv); });
  row.appendChild(left); row.appendChild(t);
  return row;
}

/* ---------- About Page ---------- */
function renderAboutPage(body){
  const card = el('div',{class:'card', style:'max-width:560px;'});
  card.innerHTML = `<div class="card-title">About Wedding Planner Pro</div>
  <p class="text-secondary" style="font-size:13.5px; line-height:1.7;">
  Version ${APP_VERSION} · Built on the Universal Offline Application Framework (UOAF).<br><br>
  Wedding Planner Pro runs entirely on this device. There is no account, no subscription, and no server —
  every piece of data you enter is stored only in this browser's local storage, and the only way it leaves
  this device is if you choose to create a backup file yourself.<br><br>
  No analytics, trackers, or advertising are included in this application.
  </p>`;
  body.appendChild(card);
}
/* ============ Boot ============ */
(async function boot(){
  Toast.init();
  await Store.load();
  Router.parseHash();
  applyThemeSettings();
  render();

  if(Store.data.settings.sync.linked){
    Sync.startPolling();
    Sync.pull({ silent:true });
  }

  function updateOnlineState(){
    const existing = document.getElementById('offline-pill');
    if(navigator.onLine){ if(existing) existing.remove(); return; }
    if(existing) return;
    const pill = document.createElement('div');
    pill.id = 'offline-pill';
    pill.textContent = 'Offline — your data is stored on this device.';
    pill.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:var(--odf-text);color:var(--odf-bg);font-size:12px;padding:6px 14px;border-radius:999px;z-index:300;opacity:.9;';
    document.body.appendChild(pill);
    setTimeout(()=>{ if(pill.parentNode) pill.style.opacity='0'; setTimeout(()=>pill.remove(), 400); }, 4000);
  }
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);
  updateOnlineState();

  // Register the real service worker + manifest (served as their own files
  // by GitHub Pages) rather than blob URLs — this makes the app genuinely
  // installable on Android/desktop Chrome and Add-to-Home-Screen on iOS.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./service-worker.js').catch(err=>{
      console.warn('Service worker registration failed', err);
    });
  }
})();
