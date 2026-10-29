const Component=({item})=>{
const f=useCurrentFrame();const p=item.props;
const rootStyle={position:"relative",width:"100%",height:"100%",overflow:"visible",fontFamily:p.font};
const out=interpolate(f,[46,53],[1,0],{extrapolateLeft:"clamp",extrapolateRight:"clamp"});
const chars=Array.from(p.text);let cursor=34;
const letters=chars.map((c,i)=>{const big=i>=p.emphasis&&i<p.emphasis+p.count;const size=big?112:72;const x=cursor;cursor+=big?119:77;return {c,i,big,size,x};});
const enter=interpolate(f,[0,3,7,11],[0.42,1.12,0.97,1],{extrapolateRight:"clamp"});
const fracture=p.crack?interpolate(f,[10,13,19],[0,13,7],{extrapolateLeft:"clamp",extrapolateRight:"clamp"}):0;
return <div style={rootStyle}><div style={{position:"absolute",left:0,top:5,width:750,height:220,opacity:out,transform:"rotate("+p.tilt+"deg)",transformOrigin:"50% 60%"}}>
{letters.map(l=>{const k=Math.max(0,f-l.i);const sc=interpolate(k,[0,3,8],[0.3,l.big?1.22:1.1,1],{extrapolateRight:"clamp"});const y=l.big?36:75;const common={position:"absolute",left:l.x,top:y,width:l.size+16,height:l.size*1.25,fontSize:l.size,lineHeight:1.08,whiteSpace:"nowrap",color:l.big?p.accent:p.color,WebkitTextStroke:"2px "+p.ink,textShadow:"4px 5px 0 "+p.ink,opacity:Math.min(1,k/2),transformOrigin:"50% 65%"};
return <div key={l.i}>
{[0,1].map(j=><div key={j} style={{...common,color:p.accent,opacity:Math.max(0,1-k/6)*(0.16-j*0.05),transform:"translate("+(20+j*17)+"px,"+(-10-j*8)+"px) scale("+sc+")",filter:"blur(3px)"}}>{l.c}</div>)}
{l.big&&p.crack?<div><div style={{...common,clipPath:"polygon(0 0,100% 0,100% 43%,68% 48%,51% 39%,34% 57%,0 50%)",transform:"translate("+(-fracture)+"px,"+(-fracture*.5)+"px) rotate("+(-fracture*.35)+"deg) scale("+sc+")"}}>{l.c}</div><div style={{...common,clipPath:"polygon(0 50%,34% 57%,51% 39%,68% 48%,100% 43%,100% 100%,0 100%)",transform:"translate("+fracture+"px,"+(fracture*.55)+"px) rotate("+(fracture*.3)+"deg) scale("+sc+")"}}>{l.c}</div></div>:<div style={{...common,transform:"scale("+sc+")"}}>{l.c}</div>}
</div>;})}
<div style={{position:"absolute",left:34,top:174,height:5,width:Math.min(630,cursor-40),background:p.accent,opacity:.9,transform:"scaleX("+Math.min(1,f/10)+")",transformOrigin:"left"}}/>
{[0,1,2,3,4,5].map(i=>{const active=p.crack?f-11:f;const a=i*Math.PI/3;const visible=active>=0?Math.max(0,1-active/13):0;return <div key={i} style={{position:"absolute",left:355+Math.cos(a)*(245+Math.max(0,active)*6),top:105+Math.sin(a)*(72+Math.max(0,active)*4),width:18,height:5,background:p.accent,opacity:visible,transform:"rotate("+(i*60)+"deg)"}}/>})}
</div></div>;};