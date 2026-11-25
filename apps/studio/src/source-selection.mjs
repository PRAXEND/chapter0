import {randomUUID} from 'node:crypto';
import {searchSources,importSource} from './sources.mjs';
export function sourceSelection(store,{search=searchSources,acquire=importSource}={}) {
  const lists=new Map();
  return {
    async find(p,query) {
      if(p.settings.sourceScope==='project')throw Error('本工程仅使用已有素材。');
      if(!String(query||'').trim())throw Error('请输入素材关键词。');
      const rows=await search(query,{kind:'video'});
      const candidates=rows.map(row=>({key:randomUUID(),row}));
      if(lists.size>=32)lists.delete(lists.keys().next().value);
      lists.set(p.id,candidates);
      return candidates.map(({key,row:r})=>({key,title:r.title,url:r.url,credit:r.credit,license:r.license,date:r.date,eventDate:r.eventDate||'',hasWindow:!!r.youtubeId}));
    },
    async pick(p,requests) {
      if(p.settings.sourceScope==='project')throw Error('本工程仅使用已有素材。');
      if(!Array.isArray(requests)||!requests.length||requests.length>12)throw Error('请选择本次搜索中的素材。');
      const choices=requests.map(r=>{
        const match=lists.get(p.id)?.find(c=>c.key===r.key);
        if(!match)throw Error('候选已更新，请重新搜索。');
        return {row:match.row,window:r.window,authorized:r.authorized===true};
      });
      const assets=[];
      for(const {row,window,authorized} of choices){
        const current=await store.get(p.id);
        if(current.settings.sourceScope==='project')throw Error('工程已切换为仅使用本地素材。');
        assets.push((await acquire(store,p.id,{...row,...(authorized&&{userAuthorized:true})},{window})).id);
      }
      return assets;
    }
  };
}
