import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as dates from '../public/material-dates.js';
import {readFile} from 'node:fs/promises';
const full=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const code=full.slice(0,full.indexOf("$('#project-topic').addEventListener")).replace(/^import .*;\n/gm,'');
function harness(){
 const elements=new Map(),button={disabled:false};
 const doc={querySelector:s=>{if(!elements.has(s))elements.set(s,{value:'',textContent:'',classList:{add(){},remove(){}},querySelector(){return null;}});return elements.get(s);},querySelectorAll:()=>[button]};
 const context=vm.createContext({...dates,document:doc,setTimeout:()=>1,clearTimeout(){},URL,console});vm.runInContext(code,context);return {context,elements,button,run:s=>vm.runInContext(s,context)};
}
test('collection locks immediately during save, suppresses repeat clicks and surfaces request failure',async()=>{
 const h=harness();let finish;h.context.saveBarrier=new Promise(r=>finish=r);
 h.run("state={project:{}};saveSettings=()=>saveBarrier;render=()=>{busy=!!activeId||submitting};refresh=async()=>{};schedulePoll=()=>{};calls=0;api=async()=>{calls++;throw new Error('精确采集失败原因')};");
 const first=h.run("start('collect',{sourceId:'one'})");assert.equal(h.button.disabled,true);
 await h.run("start('collect',{sourceId:'one'})");assert.equal(h.run('calls'),0);
 finish();await first;assert.equal(h.run('calls'),1);assert.equal(h.run('busy'),false);assert.equal(h.elements.get('#error-banner').textContent,'精确采集失败原因');assert.equal(h.elements.get('#toast').textContent,'精确采集失败原因');
});
test('source card exposes its own failure and retry while uncollected cache stays out of library',()=>{
 const h=harness();h.run("state={project:{jobs:[{action:'collect',sourceId:'a',status:'failed',error:'规格未通过'}]},library:{entries:[],candidates:[{id:'hidden',title:'不展示的仓库目录'}]}};selected=new Set();");
 const html=h.run("sourceCard({id:'a',title:'素材A',kind:'video',status:'candidate'})");assert.match(html,/规格未通过/);assert.match(html,/重试采集/);
 const lib=h.run('renderLibrary()');assert.match(lib,/已下载素材/);assert.doesNotMatch(lib,/不展示的仓库目录|repository-sync/);
});
test('event exposes evidence and every video, with official evidence first and images kept separate',()=>{
 const h=harness();h.run(`state={project:{jobs:[],sources:[{id:'x',title:'社交视频',kind:'video',sourceType:'x_repository',url:'https://x.com/a'},{id:'o',title:'官网公告',kind:'article',sourceType:'official',url:'https://example.com/news'},{id:'y',title:'演示视频',kind:'video',sourceType:'youtube',url:'https://youtube.com/a'},{id:'i',title:'公告配图',kind:'image',sourceType:'x_repository'}]},library:{entries:[]}};`);
 const html=h.run("sourceEventCard({source_ids:['x','o','y','i'],title:'事件',reason:'推荐',decision:'top5',rank:1})");
 assert.ok(html.indexOf('官网公告')<html.indexOf('社交视频'));
 assert.match(html,/视频素材来源 · 2/);assert.match(html,/图片／音频素材来源 · 1/);
 assert.match(html,/data-collect="x"/);assert.match(html,/data-collect="y"/);
 assert.doesNotMatch(html,/同一内容的其他来源|原始来源/);
 const imageOnly=h.run("sourceEventCard({source_ids:['o','i'],title:'图片事件'})");
 assert.match(imageOnly,/尚未找到视频素材/);assert.doesNotMatch(imageOnly,/视频素材来源 · 1/);
});
