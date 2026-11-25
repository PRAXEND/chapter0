import { audioSelection, styleAudioPolicy } from './style-audio.mjs';
import { voiceLibrary } from './voices.mjs';
import { fileHash } from './media.mjs';

const equalName = (a,b) => a && b && a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
const snapshot = p => JSON.stringify([p.style,p.settings,p.timeline.clips]);

function requestedAudio(project,message) {
  const patch={};
  for(const [text,latest] of [[project.brief,false],[message,true]]) {
    const unquoted=String(text||'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|\x22[^\x22]*\x22/gu,' ');
    const clauses=unquoted.split(/[，,。；;!?！？\n]/u);
    const local=/(?:开场|开头|片头|片尾|结尾|首段|末段|前奏|第[一二三四五六七八九十百\d]+(?:段|句|镜)|[这该本上下一两]一?(?:句|段|镜头)|[前后末]\s*[一二三四五六七八九十\d]+(?:秒|帧)|\d+(?:[.:]\d+)?\s*[-–—至到]\s*\d+\s*(?:秒|帧)|opening|ending|this (?:line|shot|segment))/i;
    const scoped=clauses.some(c=>local.test(c));
    for(const clause of clauses){
      const whole=/(?:全片|整片|全程|从头到尾|整(?:个|条|部)视频|本期|本片|这次|throughout|entire (?:video|film))/i.test(clause);
      if((local.test(clause) || scoped&&!whole) || /(?:如果|假如|是否|可以考虑|参考片|示例|if |whether )/i.test(clause))continue;
      if(latest||audioSelection(project,'music')!=='user'){
        if(/(?:不要|不用|无需|不要加|不需要|不使用|去掉|去除|取消|关闭|不放|不加)(?:任何)?(?:背景)?(?:配乐|音乐)|(?:no |without )(?:background )?music/i.test(clause))
          Object.assign(patch,{musicSelection:'user',musicMode:'none',musicEnabled:false});
      }
      if((latest||audioSelection(project,'voice')!=='user') && !/(?:不要|不用|不使用|无须|别用|避免|不想|参考片)/.test(clause)){
        if(/(?:确认采用|就用|确认使用|选用|明确使用)(?:本机|本地|这个|这一|刚才的|刚试听的|预置|中文|男声|声音|音色|\s|Qwen)*(?:Dylan|迪兰)/i.test(clause) ||
          (project.settings.voiceMode==='preset' && /(?:确认采用|确认使用)(?:刚才|当前|这个|刚试听)(?:的)?(?:预置)?(?:中文)?(?:男声|声音|音色)/.test(clause)))
          Object.assign(patch,{voiceSelection:'user',voiceMode:'preset',presetVoice:'dylan'});
        else if(/(?:保留|只用|沿用)(?:这段|人物|采访|现场|视频)?(?:同期声|原声)/.test(clause))
          Object.assign(patch,{voiceSelection:'user',voiceMode:'original'});
        else if(/(?:请用|请使用|使用|选用|就用|改用|换用|指定)(?:本机|苹果|macOS)?系统(?:中文)?(?:配音|声音|女声|男声|音色)/i.test(clause))
          Object.assign(patch,{voiceSelection:'user',voiceMode:'system'});
        else if(/(?:请用|请使用|使用|选用|就用|改用|换用|用)(?:我|本次|已经|已)?(?:导入|上传)(?:的)?(?:录音|旁白)/.test(clause)){
          const sources=project.assets.filter(a=>a.kind==='audio'&&(!a.source?.role||a.source.role==='recording')&&!a.source?.audition&&!a.source?.sourceVoice);
          const id=project.settings.narrationAssetId||(sources.length===1?sources[0].id:null);
          Object.assign(patch,{voiceSelection:'user',voiceMode:'import',narrationAssetId:id});
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(patch).filter(([k,v])=>project.settings[k]!==v));
}

export async function resolveProductionAudio(deps, project, {signal,message,voiceOnly=false}={}) {
  if (!project.style?.id || !deps.styleLibrary) return project;
  const spec=await deps.styleLibrary.get(project.style.id,project.style.version);
  const policy=styleAudioPolicy(spec);
  if (!policy) {
    if (project.styleAudio) { await deps.store.setMeta(project.id,{styleAudio:null}); return deps.store.get(project.id); }
    return project;
  }
  const requested=requestedAudio(project,message);
  let p=Object.keys(requested).length?await deps.store.configure(project.id,project.revision,{settings:requested}):project;
  const id=p.id, voiceIntent=audioSelection(p,'voice'), musicIntent=audioSelection(p,'music');
  const voices=deps.voices || (deps.store.root ? voiceLibrary(deps.store) : null);
  let voice=null,music=null;
  if(policy.voice){
    const preferred=policy.voice.preferredName;
    let selected=p.settings.voiceMode,confirmed=p.settings.voiceLibraryId;
    let known=[],ambiguity=false;
    if(voices && preferred && voiceIntent==='style' && selected!=='import' && selected!=='original') {
      known=(await voices.list()).filter(v=>equalName(v.name,preferred));
      const match=known.find(v=>v.id===confirmed) || (known.length===1?known[0]:null);
      ambiguity=known.length>1 && !match;
      if(match && (!p.settings.voiceConsent || selected!=='clone' || confirmed!==match.id)) {
        signal?.throwIfAborted();
        p=await voices.use(id,match.id,p.revision,{selection:'style'});
      }
      selected=p.settings.voiceMode;confirmed=p.settings.voiceLibraryId;
    }
    const reference=p.assets.find(a=>a.id===p.settings.voiceReferenceAssetId);
    const linked=selected==='clone'&&p.settings.voiceConsent===true&&reference?.sha256;
    const matched=!policy.voice.preset && linked && (preferred ? known.some(v=>v.id===confirmed) : Boolean(confirmed));
    if(voiceIntent==='style' && !matched && !['import','original'].includes(selected) && !(selected==='preset' && p.settings.presetVoice==='dylan')) {
      p=await deps.store.configure(id,p.revision,{settings:{voiceSelection:'style',voiceMode:'preset',presetVoice:'dylan'}});
      selected=p.settings.voiceMode;
    }
    const status=voiceIntent==='user'?'user-selected':voiceIntent!=='preview'&&(matched||policy.voice.preset&&selected==='preset'&&p.settings.presetVoice===policy.voice.preset)?'matched':'preview-only';
    voice={status,selection:voiceIntent,preferredName:preferred,speed:policy.voice.speed,mode:selected,preset:selected==='preset'?(p.settings.presetVoice||'dylan'):null,
      voiceId:linked?(p.settings.voiceId||confirmed||reference.id):null,referenceHash:selected==='clone'?(linked||null):null,
      reason:status==='preview-only'?(ambiguity?'同名音色有多个，请在个人音色库指定本期使用的一个。':
        '尚未绑定本期确认的声音。当前声音供试听，选用或登记已授权的中文音色后可重新配音。'):null};
  }
  if(policy.music && !voiceOnly){
    const m=policy.music,chosen=p.assets.find(a=>a.id===p.settings.musicAssetId && a.kind==='audio');
    const mode=p.settings.musicEnabled===false?'none':p.settings.musicMode || (p.mode==='interview'?'none':'library');
    let asset=chosen,matched=false,carried=false;
    if(mode==='library' && musicIntent==='style' && m.url && deps.styleLibrary.getMusicResource) {
      const file=await deps.styleLibrary.getMusicResource(p.style.id,p.style.version,m);
      signal?.throwIfAborted();
      if(file?.available && file.verified) {
        if(snapshot(await deps.store.get(id))!==snapshot(p)) throw Error('选择风格配乐时工程已改变。请基于当前版本重试。');
        const credit=m.title+' — '+m.author+'（节选并调整音量）';
        const next=await deps.store.addAsset(id,file.path,{kind:'style-music',role:'music',name:m.title,title:m.title,credit,
          author:m.author,license:m.license,licenseUrl:m.licenseUrl,url:m.url,styleResourceHash:file.sha256});
        if(next.sha256!==file.sha256) throw Error('风格配乐导入时文件已改变，请重新核对资料包。');
        const latest=await deps.store.get(id);
        if(snapshot(latest)!==snapshot(p)) throw Error('选择风格配乐时工程已改变。请基于当前版本重试。');
        asset=next; matched=true;p=latest;
      }
    }
    if(!asset && mode==='library' && musicIntent==='style') {
      const prior=p.styleAudio?.music;
      const registered=p.assets.find(a=>a.id===prior?.assetId && a.sha256===prior.sha256 && prior.url===m.url &&
        prior.license===m.license && prior.licenseUrl===m.licenseUrl && prior.credit);
      const alternative=registered || p.assets.find(a=>a.kind==='audio' && a.source?.role==='music' &&
        a.source?.bedStyle===m.bedStyle && (a.source.license || a.source.rights));
      if(alternative && await fileHash(alternative.path).catch(()=>null)===alternative.sha256) {
        asset=alternative; carried=Boolean(registered);
      }
    }
    music={status:musicIntent==='user'?'user-selected':matched?'matched':asset?'alternative':'missing',selection:musicIntent,mode,
      title:matched||carried?m.title:(asset?.name||null),preferredTitle:m.title,assetId:asset?.id||null,sha256:asset?.sha256||null,
      ducking:false,targetDifferenceLU:m.targetDifferenceLU,bedStyle:m.bedStyle,
      sourceStart:matched||carried?m.sourceStart:0,sourceEnd:matched||carried?m.sourceEnd:null,
      ...(matched||carried?{credit:m.title+' — '+m.author+'（节选并调整音量）',url:m.url,license:m.license,licenseUrl:m.licenseUrl}:{}),
      reason:!matched&&musicIntent!=='user'&&m.title?'本机未核验所选风格的原配乐；可用获授权的同类纯音乐。':null};
  }
  const current=await deps.store.get(id);
  if(snapshot(current)!==snapshot(p))throw Error('准备风格声音时工程设置已改变。请重试。');
  if(voiceOnly && current.styleAudio?.styleId===spec.id && current.styleAudio.styleVersion===spec.version)music=current.styleAudio.music;
  const receipt={styleId:spec.id,styleVersion:spec.version,voice,music};
  // Preserve measured mix fields when resuming the same source and settings.
  const prev=current.styleAudio?.music;
  if(music?.assetId && prev?.assetId===music.assetId && prev?.sha256===music.sha256 && prev?.mode===music.mode) {
    for(const key of ['gain','sourceLUFS','voiceLUFS','measuredSourceSeconds','mixMethod']) if(prev[key]!=null)music[key]=prev[key];
  }
  if(JSON.stringify(receipt)!==JSON.stringify(current.styleAudio))await deps.store.setMeta(id,{styleAudio:receipt});
  return deps.store.get(id);
}
