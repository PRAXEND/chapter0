const Component=({item})=>{
const f=useCurrentFrame();const p=item.props;
const rootStyle={position:"relative",width:"100%",height:"100%",overflow:"visible",fontFamily:p.font};
const opacity=interpolate(f,[0,8,70,84],[0,1,1,0],{extrapolateRight:"clamp"});
const reveal=interpolate(f,[0,14],[100,0],{extrapolateRight:"clamp"});
return <div style={rootStyle}><div style={{position:"absolute",left:0,top:0,width:500,height:150,transformOrigin:"0px 0px",transform:"matrix3d(0.ref-b2b6ff686f81,-0.ref-74f189ce92ea,0,-0.ref-ce7501cfe360,0.ref-98eacaffbe0f,0.ref-2e7cceb1cec4,0,-0.ref-2deb3b5c548f,0,0,1,0,15,185,0,1)",opacity,clipPath:"inset(0 "+reveal+"% 0 0)"}}>
<div style={{position:"absolute",left:12,top:0,fontSize:116,lineHeight:1.1,letterSpacing:4,color:p.color,WebkitTextStroke:"1px "+p.ink,textShadow:"0 0 5px "+p.glow,whiteSpace:"nowrap"}}>{p.text}</div>
<div style={{position:"absolute",left:16,top:133,width:465,height:4,background:p.color,opacity:.5}}/>
<div style={{position:"absolute",left:interpolate(f,[0,18],[0,490],{extrapolateRight:"clamp"}),top:7,width:7,height:124,background:p.glow,boxShadow:"0 0 14px "+p.glow,opacity:f<18?.55:0}}/>
</div></div>;};