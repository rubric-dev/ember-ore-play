// Keep the mobile preview's saves separate from still-open 0.2 tabs.
// No old database writes, deletion, upgrades, or save-content logging.
(function (global) {
 'use strict';
 const VERSION=21, FILES='FILE_DATA', META='EMBER_MIGRATION';
 function openExisting(name) {
  return new Promise((resolve,reject)=>{
   let absent=false,settled=false;
   const r=indexedDB.open(name);
   r.onupgradeneeded=()=>{absent=true;r.transaction.abort();};
   r.onsuccess=()=>{if(settled)r.result.close();else{settled=true;resolve(r.result);}};
   r.onerror=()=>{settled=true;absent?resolve(null):reject(r.error);};
   r.onblocked=()=>{settled=true;reject(new Error('기존 저장 공간을 열 수 없습니다. 다른 게임 탭을 닫고 다시 시도해 주세요.'));};
  });
 }
 function openTarget(name) {
  return new Promise((resolve,reject)=>{
   let settled=false;
   const r=indexedDB.open(name,VERSION);
   r.onupgradeneeded=()=>{
    const db=r.result;
    if(!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES).createIndex('timestamp','timestamp',{unique:false});
    if(!db.objectStoreNames.contains(META)) db.createObjectStore(META);
   };
   r.onsuccess=()=>{if(settled)r.result.close();else{settled=true;resolve(r.result);}};r.onerror=()=>{settled=true;reject(r.error);};
   r.onblocked=()=>{settled=true;reject(new Error('저장 공간 준비가 막혔습니다. 다른 게임 탭을 닫고 다시 시도해 주세요.'));};
  });
 }
 async function selectedOldEntries(name) {
  const db=await openExisting(name);
  if(!db) return [];
  try {
   if(!db.objectStoreNames.contains(FILES)) throw new Error('기존 저장 공간 형식을 확인할 수 없습니다.');
   // One readonly transaction keeps key selection and contents from the same snapshot.
   return await new Promise((resolve,reject)=>{
    const tx=db.transaction(FILES,'readonly'), store=tx.objectStore(FILES), entries=[];
    const r=store.getAllKeys();
    r.onsuccess=()=>{
     const keys=r.result;
     const saves=keys.filter(k=>typeof k==='string' && k.startsWith('/userfs/') && !k.includes('/../') && /\/forge-save-v[12]\.json$/.test(k));
     const parents=new Set(saves.map(k=>k.slice(0,k.lastIndexOf('/'))));
     if(parents.size>1){tx.abort();return;}
     const chosen=new Set(saves);
     for(const save of saves){let dir=save.slice(0,save.lastIndexOf('/'));while(dir.startsWith('/userfs')){if(keys.includes(dir))chosen.add(dir);dir=dir.slice(0,dir.lastIndexOf('/'));}}
     for(const key of chosen){const value=store.get(key);value.onsuccess=()=>entries.push([key,value.result]);}
    };
    tx.oncomplete=()=>resolve(entries);
    tx.onerror=tx.onabort=()=>reject(tx.error||new Error('기존 저장 경로가 모호해 자동 이동을 멈췄습니다.'));
   });
  } finally { db.close(); }
 }
 async function migrate(options={}) {
  const oldName=options.oldName||'/userfs', newName=options.newName||'/userfs-ember-ore-schema2';
  if(oldName===newName) throw new Error('저장 공간은 서로 달라야 합니다.');
  const target=await openTarget(newName);
  try {
   if(!target.objectStoreNames.contains(META)) throw new Error('새 저장 공간의 이관 기록을 확인할 수 없습니다.');
   const state=await new Promise((resolve,reject)=>{
    const tx=target.transaction([FILES,META],'readonly');let marker,hasSave=false;
    tx.objectStore(META).get('complete').onsuccess=e=>{marker=e.target.result;};
    tx.objectStore(FILES).getAllKeys().onsuccess=e=>{hasSave=e.target.result.some(k=>typeof k==='string' && /\/forge-save-v[12]\.json$/.test(k));};
    tx.oncomplete=()=>resolve({marker,hasSave});tx.onerror=tx.onabort=()=>reject(tx.error);
   });
   if(state.marker) return {status:'already_ready'};
   const entries=state.hasSave?[]:await selectedOldEntries(oldName);
   return await new Promise((resolve,reject)=>{
    const tx=target.transaction([FILES,META],'readwrite'), files=tx.objectStore(FILES), meta=tx.objectStore(META);
    let status='copied';
    const marker=meta.get('complete');
    marker.onsuccess=()=>{
     if(marker.result){status='already_ready';return;}
     const keys=files.getAllKeys();
     keys.onsuccess=()=>{
      // Never replace progress already written by a new runtime.
      const hasSave=keys.result.some(k=>typeof k==='string' && /\/forge-save-v[12]\.json$/.test(k));
      if(hasSave) status='kept_new_progress';
      else for(const [key,value] of entries) files.put(value,key);
      meta.put({version:1,complete:true},'complete');
     };
    };
    tx.oncomplete=()=>resolve({status});
    tx.onerror=tx.onabort=()=>reject(tx.error||new Error('저장 이동을 완료하지 못했습니다. 기존 저장은 유지됩니다.'));
   });
  } finally { target.close(); }
 }
 global.EmberStorage={migrate};
})(globalThis);
