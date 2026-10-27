const Component=({item})=>{
 const f=useCurrentFrame();const p=item.props;const rootStyle={position:"relative",width:"100%",height:"100%",fontFamily:p.font,overflow:"visible"};
 const stage=f<65?0:f<161?1:2;const sf=stage===0?f:stage===1?f-65:f-161;
 const en=interpolate(sf,[0,5,10],[0.6,1.06,1],{extrapolateRight:"clamp"});const out=interpolate(f,[216,229],[1,0],{extrapolateLeft:"clamp",extrapolateRight:"clamp"});
 const chars=p.orbit.split("·");const line=stage===0?p.titleA:stage===1?p.titleB:p.titleC;
 const sub=stage===0?p.subA:stage===1?p.subB:p.subC;
 const nodes=[p.actionA,p.actionB,p.actionC];
 const phase=Math.max(0,Math.min(2,Math.floor((f-65)/22)));
 return <div style={rootStyle}>
 <div style={{position:"absolute",left:280,top:10,color:p.accent,fontSize:30,letterSpacing:4,textShadow:"2px 2px 4px "+p.ink,opacity:out}}>{p.kicker}</div>
 <div style={{position:"absolute",left:275,top:60,color:p.color,fontSize:stage===2?90:110,lineHeight:1.1,whiteSpace:"nowrap",WebkitTextStroke:"2px "+p.ink,textShadow:"5px 6px 0 "+p.ink,transform:"translateX("+(1-en)*120+"px) scale("+en+")",transformOrigin:"left",opacity:out}}>{line}</div>
 {stage===0&&chars.map((ch,i)=>{const a=i/chars.length*Math.PI*2+f*.035;const z=Math.sin(a);return <div key={i} style={{position:"absolute",left:580+Math.cos(a)*250-70,top:275+z*100-35,width:140,textAlign:"center",fontSize:62,whiteSpace:"nowrap",color:p.accent,WebkitTextStroke:"1px "+p.ink,textShadow:"0 0 12px "+p.ink,opacity:out*(.4+.6*(z+1)/2),transform:"perspective(600px) rotateY("+(-Math.cos(a)*55)+"deg) scale("+(0.75+(z+1)*.18)+")",backfaceVisibility:"hidden"}}>{ch}</div>})}
 <div style={{position:"absolute",left:stage===0?410:315,top:245,color:p.color,fontSize:stage===0?84:68,whiteSpace:"nowrap",textShadow:"3px 4px 0 "+p.ink,WebkitTextStroke:"1px "+p.ink,opacity:out,transform:"translateY("+((1-en)*50)+"px)"}}>{sub}</div>
 {stage>0&&nodes.map((t,i)=>{const x=300+i*190;const active=stage===2||i<=phase;return <div key={i} style={{position:"absolute",left:x,top:360,opacity:out*(active?1:.2)}}>
 <div style={{fontSize:54,color:active?p.accent:p.color,textShadow:"2px 3px 4px "+p.ink,transform:"scale("+(stage===1&&i===phase?1+.04*Math.sin(f*.3):1)+")"}}>{t}</div>
 <div style={{position:"absolute",left:0,top:76,width:145,height:4,backgroundColor:p.accent}}/>
 </div>})}
 {stage>0&&[0,1,2,3].map(i=>{const travel=((f*8+i*95)%560);return <div key={i} style={{position:"absolute",left:300+travel,top:437,width:16,height:5,borderRadius:5,backgroundColor:p.color,boxShadow:"0 0 16px "+p.accent,opacity:out*(1-i*.14)}}/>})}
 <div style={{position:"absolute",left:280,top:500,color:p.color,fontSize:25,textShadow:"2px 2px 4px "+p.ink,opacity:out*.9}}>{p.note}</div>
 </div>;};