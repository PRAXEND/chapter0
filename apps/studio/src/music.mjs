import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {fault} from './project.mjs';

export function createMusic(store,fetcher=fetch){
  let apiKey=process.env.ELEVENLABS_API_KEY||'';
  const busy=new Set();
  return {
    connected:()=>Boolean(apiKey),
    connect(value){apiKey=String(value||'').trim();return {connected:Boolean(apiKey)};},
    async compose(id,{requestId,prompt,seconds}){
      if(!apiKey)throw fault('请先连接云配乐账号。');
      if(!/^[a-zA-Z0-9-]{8,80}$/.test(requestId||'')||!Number.isInteger(seconds)||seconds<3||seconds>600||!String(prompt||'').trim())throw fault('请输入曲风和 3 至 600 秒的时长。');
      const p=store.get(id);const receipts=p.musicReceipts||[];
      const prior=receipts.find(r=>r.id===requestId);
      if(prior){if(prior.assetId)return p.assets.find(a=>a.id===prior.assetId);throw fault('已记录过该请求，请在服务商账单确认结果。',409);}
      if(busy.has(id)||receipts.some(r=>r.status==='unknown'||r.status==='sent'))throw fault('此项目有待核实的云端请求，请先核对回执。',409);
      if(!p.settings.cloudEnabled||seconds+receipts.filter(r=>r.status!=='rejected').reduce((s,r)=>s+r.seconds,0)>p.settings.cloudBudget)throw fault('生成时长超出本项目启用的云预算。',409);
      busy.add(id);
      function update(changes){const current=store.get(id).musicReceipts||[];store.setMeta(id,{musicReceipts:current.map(r=>r.id===requestId?{...r,...changes}:r)});}
      store.setMeta(id,{musicReceipts:[...receipts,{id:requestId,provider:'ElevenLabs Music',seconds,status:'sent',at:new Date().toISOString()}]});
      const file=path.join(store.paths(id).cache,randomUUID()+'.mp3');
      try{
        const response=await fetcher('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128',{method:'POST',headers:{'xi-api-key':apiKey,'Content-Type':'application/json'},body:JSON.stringify({prompt:String(prompt).slice(0,4000),music_length_ms:seconds*1000,force_instrumental:true}),signal:AbortSignal.timeout(600000)});
        if(!response.ok){const known=[400,401,403,422,429].includes(response.status);update({status:known?'rejected':'unknown'});throw fault('云作曲服务返回 '+response.status+'。',502);}
        await pipeline(Readable.fromWeb(response.body),createWriteStream(file,{mode:0o600}));
        const a=await store.addAsset(id,file,{name:'原创配乐.mp3',kind:'generated-music',provider:'ElevenLabs Music',requestId,receipt:response.headers.get('request-id')||null});
        update({status:'done',assetId:a.id});return a;
      }catch(e){if(store.get(id).musicReceipts.find(r=>r.id===requestId)?.status==='sent')update({status:'unknown'});throw e;}
      finally{busy.delete(id);await unlink(file).catch(()=>{});}
    },
    reconcile(id,{requestId,charged}){
      if(typeof charged!=='boolean'||busy.has(id))throw fault('请先核实服务商回执。');
      const list=store.get(id).musicReceipts||[];
      if(!list.some(r=>r.id===requestId&&['unknown','sent'].includes(r.status)))throw fault('没有待核实的请求。');
      return store.setMeta(id,{musicReceipts:list.map(r=>r.id===requestId?{...r,status:charged?'charged':'rejected',resolvedAt:new Date().toISOString()}:r)});
    }
  };
}
