#!/usr/bin/env python3
"""Build editable ChatCut payloads for the accepted portrait presentation.

This produces tool arguments, not a rendered video or a project mutation.
Pass each asset's inline code to the live ChatCut tool; keep returned IDs.
"""
import argparse
import json
import math
from pathlib import Path
from production_plan import layout, validate_placement


BACKGROUND = """const Component = ({item}) => { const p=item.props; const frame=useCurrentFrame(); const cfg=useVideoConfig(); const time=frame/cfg.fps*p.speed; const scale=cfg.width/1080; const rootStyle={position:'absolute',inset:0,overflow:'hidden',backgroundColor:p.transparentBackground?'transparent':p.bgColor}; const hash=(n)=>{ const v=Math.sin(n*127.1+311.7)*43758.5453; return v-Math.floor(v); }; const count=Math.round(p.lineCount/6); const rows=Math.ceil(count/4); const fieldHeight=cfg.height/scale+440; const groups=Array.from({length:6},(_,g)=>{ const paths=Array.from({length:count},(_,i)=>{ const seed=g*211+i*17+1; const col=i%4; const row=Math.floor(i/4); let x=-190+col*380+hash(seed)*270; let y=-210+row*(fieldHeight/rows)+hash(seed+1)*330; let angle=hash(seed+2)*Math.PI*2; let d='M '+x+' '+y; for(let j=0;j<5;j++){ angle+=(hash(seed+j*11+3)-0.5)*1.8; const length=130+hash(seed+j*7+5)*230; x+=Math.cos(angle)*length; y+=Math.sin(angle)*length; d+=' L '+x+' '+y; } return <path key={seed} d={d} fill='none' stroke={p.lineColor} strokeWidth='1.4' strokeLinecap='round' strokeLinejoin='round'/>; }); const dx=Math.sin(time*(0.11+g*0.017)+g*2.1)*36+Math.sin(time*0.043+g)*15; const dy=Math.cos(time*(0.09+g*0.013)+g*1.3)*28; const rotation=Math.sin(time*0.035+g)*2.4; const groupStyle={position:'absolute',left:-220,top:-220,width:1520,height:fieldHeight,opacity:p.strength*(0.64+g*0.065),transform:'translate('+dx+'px,'+dy+'px) rotate('+rotation+'deg)',transformOrigin:'50% 50%'}; const viewBox='-220 -220 1520 '+fieldHeight; return <div key={g} style={groupStyle}><svg width='1520' height={fieldHeight} viewBox={viewBox}>{paths}</svg></div>; }); const scaledStyle={position:'absolute',left:0,top:0,width:1080,height:cfg.height/scale,transform:'scale('+scale+')',transformOrigin:'0 0'}; return <div style={rootStyle}><div style={scaledStyle}>{groups}</div></div>; }"""

TITLE = """const Component = ({item}) => { const p=item.props; const rootStyle={position:'absolute',inset:0,display:'flex',flexDirection:'column',justifyContent:'flex-end',paddingBottom:p.fontSize*7.8/92,boxSizing:'border-box',alignItems:'center',gap:p.lineGap,fontFamily:p.fontFamily,fontSize:p.fontSize,fontWeight:900,lineHeight:1.1,color:p.color,backgroundColor:'transparent'}; const start=p.title.replace(/\\n/g,'').indexOf(p.emphasis); let offset=0; const rows=p.title.split('\\n').map((line,i)=>{ const a=Math.max(0,start-offset); const b=Math.min(line.length,start+p.emphasis.length-offset); offset+=line.length; const active=b>a; const markedStyle={color:p.emphasisColor}; const rowStyle={whiteSpace:'nowrap',flexShrink:0}; return <div key={i} style={rowStyle}>{active?<React.Fragment>{line.slice(0,a)}<span style={markedStyle}>{line.slice(a,b)}</span>{line.slice(b)}</React.Fragment>:line}</div>; }); return <div style={rootStyle}>{rows}</div>; }"""

ENDING = """const Component = ({item}) => { const p=item.props; const frame=useCurrentFrame(); const progress=Math.min(1,Math.max(0,frame/p.fadeFrames)); const alpha=progress*progress*(3-2*progress); const rootStyle={position:'absolute',inset:0,backgroundColor:p.color,opacity:alpha}; return <div style={rootStyle}/>; }"""


def prop(key, value, kind, label):
    return dict(key=key, defaultValue=value, type=kind, label=label)


def build(settings, frames, title, emphasis):
    policy = layout(settings)
    if policy['mode'] != 'portrait-centered':
        raise ValueError('Portrait recipe requires height > width')
    fps = settings['fps']
    if type(frames) is not int or frames <= math.ceil(1.8*fps):
        raise ValueError('Timeline must include content before the 1.8-second ending')
    placement = dict(composition='Centered contain footage; stable glyph top',
                     **{k:policy[k] for k in ('titleBox','mediaBox','captionBox','captionStyle','fit','titleStyle')},
                     titleText=title, titleEmphasis=emphasis, emphasisBoxes=[])
    if not settings.get('captions'):placement.update(captionBox=None,captionStyle=None)
    validate_placement(placement,settings,title.replace('\n',''),title_emphasis=emphasis)
    w,h=settings['width'],settings['height'];s=w/1080
    fade=round(policy['ending']['fadeSeconds']*fps);hold=round(policy['ending']['blackHoldSeconds']*fps)
    black=frames-hold;start=black-fade
    assets=[dict(name='竖版底纹｜全幅灰色线网',width=w,height=h,durationInFrames=frames,code=BACKGROUND,
        properties=[prop('bgColor',policy['background'],'color','底色'),prop('lineColor','#9CA5AD','color','线条颜色'),prop('strength',.12,'number','线条强度'),prop('speed',1,'number','运动速度'),prop('lineCount',120,'number','线条数量'),prop('transparentBackground',False,'boolean','透明底色')]),
        dict(name='竖版标题｜白黄重点',width=972*s,height=222*s,durationInFrames=frames,code=TITLE,
        properties=[prop('title',title,'text','标题'),prop('emphasis',emphasis,'text','黄色重点'),prop('fontFamily','Noto Sans SC','font','字体'),prop('fontSize',92*s,'number','字号'),prop('lineGap',4*s,'number','行间距'),prop('color','#FFFFFF','color','正文颜色'),prop('emphasisColor','#F0FF00','color','重点颜色')]),
        dict(name='竖版结尾｜全层渐隐到黑',width=w,height=h,durationInFrames=fade+hold,code=ENDING,
        properties=[prop('fadeFrames',fade,'number','渐隐帧数'),prop('color','#000000','color','收尾颜色')])]
    return dict(recipe='customer-portrait-v3',layout=policy,shotLayout=placement,assets=assets,
        placements=[dict(role='background',assetIndex=0,fromFrame=0,durationInFrames=frames,left=0,top=0,width=w,height=h,layer='bottom'),
                    dict(role='title',assetIndex=1,fromFrame=0,durationInFrames=frames,left=54*s,top=h/2-538*s,width=972*s,height=222*s,layer='above-footage'),
                    dict(role='ending',assetIndex=2,fromFrame=start,durationInFrames=fade+hold,left=0,top=0,width=w,height=h,layer='above-all-including-captions')],
        captionLayouts={str(lines):dict(left=54*s,top=h/2+321*s,width=972*s,height=height) for lines,height in [(1,68*s),(2,135*s)]},
        endingTimeline=dict(fadeStartFrame=start,blackStartFrame=black,endFrame=frames,musicEndFrame=black,musicFadeOutSeconds=1.4),
        instructions=['Use actual returned asset IDs and current tool schema. No static raster substitute for the animated background.',
                      'Confirm Noto Sans SC with search_fonts before creating the title; never silently substitute.',
                      'Reserve ending inside requested duration. Continue real footage through fade; never freeze or loop a source to pad.',
                      'Native caption renderer centers vertically: use the one/two-line heights at the SAME top. Inspect visible glyph tops.',
                      'Inspect composed beginning, middle, end, one/two-line captions and native-rate fade before submitting the candidate.'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',required=True);parser.add_argument('--width',type=int,required=True);parser.add_argument('--height',type=int,required=True)
    parser.add_argument('--fps',type=int,required=True);parser.add_argument('--frames',type=int,required=True);parser.add_argument('--captions',choices=['on','off'],default='on')
    args=parser.parse_args();plan=json.loads(Path(args.plan).read_text())
    p=plan['productionPlan'];title=plan['shots'][0]['layout']['titleText']
    print(json.dumps(build(dict(width=args.width,height=args.height,fps=args.fps,captions=args.captions=='on'),args.frames,title,p['titleEmphasis']),ensure_ascii=False))


if __name__=='__main__':main()
