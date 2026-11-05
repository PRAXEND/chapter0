"""Checks shared by pre-export and independent review of new workbench projects."""
from collections import Counter
import math
import re

from review_sync import compare_cards, normalized


def track_assets(evidence, field):
    timeline = evidence['timeline']['timeline']
    if timeline.get('totalEntries') != len(timeline['entries']):
        raise ValueError('需要完整的最终时间线')
    wanted = set(evidence.get(field) or [])
    tracks = [t for t in timeline['tracks'] if wanted.intersection((t['id'], t.get('alias')))]
    if not wanted or any(t.get('muted') for t in tracks) or wanted - {v for t in tracks for v in (t['id'], t.get('alias'))}:
        raise ValueError('缺少或静音的轨道：' + field)
    ids = {t['id'] for t in tracks}
    assets = {c['asset']['id'] for c in timeline['entries'] if c.get('kind') == 'item'
              and c.get('itemType') in ('audio', 'video') and c['trackId'] in ids}
    if not assets:
        raise ValueError('轨道缺少实际音频：' + field)
    return assets


def selected_voice(evidence, wanted):
    if not wanted or not wanted.get('selected_by_user') or not all(wanted.get(k) for k in ('provider', 'voiceId')):
        raise ValueError('缺少用户确认的本期音色身份')
    assets = track_assets(evidence, 'narration_tracks')
    records = {}
    for source in evidence['voice_sources']:
        ident = source['assetId']
        if ident in assets:
            if ident in records:
                raise ValueError('旁白素材身份重复：' + ident)
            asset = next((v['asset'] for v in source['data'] if 'asset' in v), {})
            if asset.get('id') != ident:
                raise ValueError('生成记录与旁白素材不匹配')
            params = (asset.get('generationRecord') or {}).get('params') or {}
            # Hosted inspect_asset can put the provider in its generation header only.
            header = re.match(r'^Generated: ([\w.-]+) voice\s*\|', asset.get('generation') or '')
            provider = params.get('provider') or (header.group(1) if header else None)
            if header and header.group(1) != provider:
                raise ValueError('旁白供应商记录不一致')
            records[ident] = {'provider': provider, 'voiceId': params.get('voiceId')}
    for ident in assets:
        if any(records.get(ident, {}).get(k) != wanted[k] for k in ('provider', 'voiceId')):
            raise ValueError('时间线旁白与所选音色不匹配或缺少实际生成记录：' + ident)


def native_caption_state(pages, timeline_id, project_id=None):
    """Normalize complete unfiltered read_captions v2 pages from a single revision."""
    if not isinstance(pages, list):
        pages = [pages]
    if not pages or not timeline_id:
        raise ValueError('缺少当前时间线的原生字幕读回')
    first = pages[0]
    revision = first.get('revision')
    cards = []
    seen = set()
    if not revision:
        raise ValueError('原生字幕缺少版本')
    tracks = [{'id': t['id'], 'visible': t.get('hidden') is False} for t in first['tracks']]
    track_ids = {t['id'] for t in tracks}
    for index, page in enumerate(pages):
        info = page['page']
        items = page['items']
        last = index == len(pages)-1
        if (page.get('topologyVersion') != 2 or page['timelineId'] != timeline_id
                or (project_id and page.get('projectId') != project_id)
                or page.get('revision') != revision or info['offset'] != len(cards)
                or info['returned'] != len(items) or page['hasMore'] != (not last)
                or page['tracks'] != first['tracks'] or page['settings'] != first['settings']):
            raise ValueError('字幕分页、工程、可见性或版本不一致')
        for item in items:
            cid, track_id, start, length = (item[k] for k in ('id', 'trackId', 'from', 'durationInFrames'))
            if cid in seen or track_id not in track_ids or start < 0 or length <= 0:
                raise ValueError('原生字幕卡标识或时序无效')
            seen.add(cid)
            body = item['data']
            lines = [line['text'] for line in body['lines']]
            if not lines or any(not isinstance(line,str) or not line.strip() for line in lines):
                raise ValueError('原生字幕缺少文本')
            cards.append({'id':cid, 'trackId':track_id, 'hidden':body.get('hidden') is not False,
                          'start_frame':start, 'end_frame':start+length, 'lines':lines})
        if info['total'] != first['page']['total'] or (not last and (not items or page['nextOffset'] != len(cards))):
            raise ValueError('原生字幕分页不完整')
    if len(cards) != first['page']['total']:
        raise ValueError('需要完整原生字幕卡')
    return {'timelineId':timeline_id,'enabled':first['settings'].get('enabled') is True,'tracks':tracks,'cards':cards}


def subtitles_text(cards, fps):
    def stamp(frame):
        minutes, ms = divmod(round(frame*1000/fps), 60000)
        hours, minutes = divmod(minutes, 60)
        seconds, ms = divmod(ms, 1000)
        return f'{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}'
    return '\n\n'.join(f"{i}\n{stamp(c['start_frame'])} --> {stamp(c['end_frame'])}\n" + '\n'.join(c['lines'])
                       for i, c in enumerate(cards, 1)) + '\n'


def visible_cards(evidence):
    state = (native_caption_state(evidence['caption_pages'], evidence.get('timeline_id'))
             if 'caption_pages' in evidence else evidence.get('caption_state') or {})
    if state.get('enabled') is not True:
        raise ValueError('全局字幕未启用或缺少读回证据')
    if state.get('timelineId') != evidence.get('timeline_id') or not state.get('timelineId'):
        raise ValueError('字幕与本次时间线不匹配')
    tracks = {t['id'] for t in state['tracks'] if t.get('visible') is True}
    cards = [c for c in state['cards'] if c['trackId'] in tracks and c.get('hidden') is False]
    if not cards:
        raise ValueError('缺少实际可见的同步字幕卡')
    return sorted(cards, key=lambda c: c['start_frame'])


def sample_captions(cues, fps, frames):
    if not cues:
        return []
    samples = []
    for i in sorted({0, len(cues)//2, len(cues)-1}):
        cue = cues[i]
        frame = min(frames-1, math.floor((cue['start']+cue['end'])*fps/2))
        samples.append({'frame': frame, 'text': ''.join(cue['lines'])})
    return samples


def check(data, evidence, cues, fps, voice=None):
    errors = {}
    settings, brief = data['settings'], data['brief']
    if brief.get('workbench_rules') != 2:
        return errors
    evidence = evidence or {}
    def validate(key, fn):
        try:
            fn()
        except (KeyError, ValueError, TypeError, AttributeError, IndexError) as exc:
            errors[key] = str(exc)
    if settings['narration']:
        validate('av_sync', lambda: selected_voice(evidence, voice or settings.get('voice')))
    if settings['captions']:
        def captions():
            if evidence.get('timeline_id') != data['project'].get('timelineId'):
                raise ValueError('字幕证据来自其他时间线')
            if not cues or not compare_cards(cues, visible_cards(evidence), fps)['matches']:
                raise ValueError('可见字幕卡与导出的 SRT 不匹配')
        validate('caption_flow', captions)
    def music():
        if not brief['generate_music']:
            timeline = evidence.get('timeline', {}).get('timeline', {})
            declared = set(evidence.get('music_tracks') or []) | set(data['project'].get('music_tracks') or [])
            ids = {t['id'] for t in timeline.get('tracks', []) if not t.get('muted')
                   and declared.intersection((t['id'], t.get('alias')))}
            if any(c.get('kind') == 'item' and c.get('trackId') in ids for c in timeline.get('entries', [])):
                raise ValueError('已选择不生成配乐，实际时间线上仍有活动配乐')
            return
        assets = track_assets(evidence, 'music_tracks')
        if settings['narration'] and assets & track_assets(evidence, 'narration_tracks'):
            raise ValueError('配乐与旁白不能指向同一个素材')
        refs = evidence.get('music_files') or []
        generated = {f['assetId'] for f in refs if f.get('generationTaskId') and f.get('sha256')}
        completed = set()
        for operation in data.get('operations', {}).values():
            result = operation.get('result') or {}
            arguments = (operation.get('input') or {}).get('arguments') or {}
            if (operation.get('status') == 'completed' and arguments.get('generationType') == 'instrumental'
                    and all(result.get(k) and result[k] == data['project'].get(k) for k in ('projectId', 'timelineId'))):
                completed.add((result.get('assetId'), result.get('jobId')))
        if (not assets.issubset(generated) or any((f['assetId'], f.get('generationTaskId')) not in completed
                                                  for f in refs if f['assetId'] in assets)):
            raise ValueError('配乐轨缺少本项目已生成的音乐素材和任务记录')
    validate('music_fit', music)
    return errors


def observed_captions_match(expected, observed):
    if not expected or not isinstance(observed, list):
        return False
    def key(sample):
        return sample['frame'], normalized(sample['text'])
    try:
        return Counter(map(key, expected)) == Counter(map(key, observed))
    except (KeyError, TypeError, AttributeError):
        return False
