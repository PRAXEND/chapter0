const Component = ({item}) => {
 const f=useCurrentFrame(); const {durationInFrames}=useVideoConfig(); const p=item.props;
 const en=interpolate(f,[0,10],[0,1],{extrapolateRight:"clamp"});
 const out=interpolate(f,[durationInFrames-10,durationInFrames-1],[1,0],{extrapolateLeft:"clamp",extrapolateRight:"clamp"});
 const y=interpolate(f,[0,7,13],[28,-3,0],{extrapolateRight:"clamp"});
 const rootStyle={position:"absolute",inset:0,display:"flex",flexDirection:"column",justifyContent:"center",fontFamily:p.font,opacity:en*out,color:p.white,padding:"12px 24px",backgroundColor:p.transparentBackground?"transparent":"rgba(6,15,24,.82)",overflow:"hidden"};
 const labelStyle={fontSize:24,fontWeight:600,letterSpacing:5,color:p.cyan,marginBottom:10};
 const titleStyle={fontSize:p.size,fontWeight:900,lineHeight:1.16,transform:"translateY("+y+"px)",textShadow:"0 3px 12px rgba(0,0,0,.65)"};
 const lineStyle={height:5,width:interpolate(f,[0,15],[0,390],{extrapolateRight:"clamp"}),backgroundColor:p.cyan,marginTop:17};
 return <div style={rootStyle}><div style={labelStyle}>{p.label}</div><div style={titleStyle}>{p.title}</div><div style={lineStyle}/></div>;
};