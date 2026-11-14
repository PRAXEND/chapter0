"""Remove verified fixed-gain narration for a second, unchanged BGM presence test.

This is evidence-only: never alters the export, normalizes the residual, or
replaces original-mix loudness/alignment checks. Unknown/dynamic mixes fail closed.
"""
import math
from pathlib import Path
import statistics

from review_audio_alignment import RATE, decode, envelope, match_window, tempo_filters, correlation
from studio import file_hash


def narration_sources(evidence, root):
    references = {}
    for row in evidence['voice_files']:
        file = Path(row['path']).resolve(strict=True)
        if not file.is_relative_to(root) or file_hash(file)!=row['sha256'] or row['assetId'] in references:
            raise ValueError('旁白原件身份或哈希无效')
        references[row['assetId']] = {'path':file,'sha256':row['sha256']}
    return references


def independent_music_source(source, left, right, evidence, root, fps, directory):
    """Different asset IDs/encodings do not make a narration copy into BGM."""
    from delivery_requirements import track_assets
    if not evidence.get('voice_files'):
        return
    track_assets(evidence, 'narration_tracks')
    timeline=evidence['timeline']['timeline'];wanted=set(evidence['narration_tracks'])
    ids={t['id'] for t in timeline['tracks'] if wanted.intersection((t['id'],t.get('alias')))}
    references=narration_sources(evidence,root)
    for index,clip in enumerate(timeline['entries']):
        if clip.get('kind')!='item' or clip.get('trackId') not in ids or clip.get('itemType') not in ('audio','video'):
            continue
        a,b=(clip['timelineRange'][k]/fps for k in ('fromFrame','toFrame'))
        overlap_start,overlap_end=max(a,left),min(b,right)
        if overlap_end<=overlap_start:
            continue
        first,last=(clip['sourceRange'][k]/1e6 for k in ('start','end'))
        voice=max(decode(references[clip['asset']['id']]['path'],directory/f'independence-{index}.raw',
                         ','.join([f'atrim=start={first}:end={last}','asetpts=PTS-STARTPTS',*tempo_filters((last-first)/(b-a))])),
                  key=lambda channel:sum(v*v for v in channel))
        overlap=round((overlap_end-overlap_start)*RATE)
        env=[envelope(source)];size=min(RATE//4,overlap//2);matches=[]
        if size<1:
            continue
        # Find audible probes inside the overlap: leading/trailing silence is
        # common in TTS and must not skip the independence check altogether.
        audible=[]
        for offset in sorted({*range(0,overlap-size+1,size),overlap-size}):
            start=round((overlap_start-a)*RATE)+offset
            ref=voice[start:start+size]
            if len(ref)==size and sum(v*v for v in ref)/size>=1e-8:
                audible.append(offset)
        probes=sorted({audible[0],audible[-1]}) if audible else []
        for offset in probes:
            time=overlap_start+offset/RATE
            start=round((time-a)*RATE);ref=voice[start:start+size]
            match=match_window(ref,[source],env,round((time-left)*RATE),max_shift=.1)
            if match['correlation']>=.95 and (not matches or offset>=matches[-1]+size):
                matches.append(offset)
        if len(matches)>=2:
            raise ValueError('配乐源与实际旁白波形高度相关，不能证明独立配乐存在')


def subtract_narration(mix, clips, fps, references, directory):
    residual = [list(channel) for channel in mix]
    envs = [envelope(channel) for channel in mix]
    fitted, excluded, occupied = [], [], []
    for index, clip in enumerate(clips):
        first, last = (clip['sourceRange'][k] / 1e6 for k in ('start', 'end'))
        left, right = (clip['timelineRange'][k] / fps for k in ('fromFrame', 'toFrame'))
        if not 0 <= first < last or not 0 <= left < right or any(a < right and b > left for a, b in occupied):
            raise ValueError('旁白重叠或区间无效，不能消除混音中的已知旁白')
        occupied.append((left, right))
        ref = references[clip['asset']['id']]
        source = max(decode(ref['path'], directory / f'voice-{index}.raw', ','.join([
            f'atrim=start={first}:end={last}', 'asetpts=PTS-STARTPTS', *tempo_filters((last-first)/(right-left))])),
            key=lambda channel: sum(v*v for v in channel))
        usable = min(len(source), round((right-left)*RATE))
        if abs(len(source)/RATE-(right-left)) > .1+1/fps or usable < RATE:
            raise ValueError('旁白参考不足以独立验证固定增益')
        size = RATE//4
        starts = sorted({round((usable-size)*f) for f in (.1, .5, .9)})
        probes = []
        for offset in starts:
            reference = source[offset:offset+size]
            if sum(v*v for v in reference)/size < 1e-8:
                raise ValueError('旁白拟合窗口缺少可验证的语音')
            match = match_window(reference, mix, envs, round(left*RATE)+offset, max_shift=.1)
            if match['correlation'] < .9 or match['ambiguous'] or abs(match['offset_ms']) > 100:
                raise ValueError('未独立确认旁白波形，不能使用消除路径')
            probes.append(match)
        offsets = [round(p['offset_ms']*RATE/1000) for p in probes]
        if max(offsets)-min(offsets) > 2:
            raise ValueError('旁白偏移不一致，不能使用固定增益消除')
        lag = round(statistics.median(offsets)); position = round(left*RATE)+lag
        if position < 0 or position+usable > min(map(len, mix)):
            raise ValueError('旁白源与最终混音边界不一致')
        gains = []
        for channel_index, channel in enumerate(mix):
            measured = []
            for start in starts:
                ref_window = source[start:start+size]
                actual = channel[position+start:position+start+size]
                measured.append(sum(a*b for a,b in zip(ref_window,actual))/sum(a*a for a in ref_window))
            gain = statistics.median(measured)
            if gain < 0 or max(measured)-min(measured) > max(.03, abs(gain)*.15):
                raise ValueError('旁白存在未知增益变化，不能使用固定增益消除')
            gains.append(gain)
            for i in range(usable):
                residual[channel_index][position+i] -= gain*source[i]
        excluded.extend(((position+s)/RATE-.1, (position+s+size)/RATE+.1) for s in starts)
        fitted.append({'asset_id':clip['asset']['id'],'sha256':ref['sha256'],'from':left,'to':right,
                       'offset_ms':lag*1000/RATE,'gains':gains,'minimum_voice_correlation':min(p['correlation'] for p in probes)})
    if not fitted:
        raise ValueError('缺少可消除的实际旁白')
    return residual, excluded, fitted


def verified_residual(mix, evidence, root, fps, directory):
    from delivery_requirements import track_assets
    track_assets(evidence, 'narration_tracks')
    timeline = evidence['timeline']['timeline']
    wanted = set(evidence['narration_tracks'])
    ids = {t['id'] for t in timeline['tracks'] if wanted.intersection((t['id'], t.get('alias')))}
    clips = [c for c in timeline['entries'] if c.get('kind')=='item' and c.get('trackId') in ids and c.get('itemType') in ('audio','video')]
    references = narration_sources(evidence, root)
    return subtract_narration(mix, clips, fps, references, directory)
