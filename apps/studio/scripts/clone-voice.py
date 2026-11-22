"""Offline Qwen synthesis from an enrolled sample or a named publisher preset."""
import json
import re
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model


def samples(generation):
    blocks = []
    for result in generation:
        block = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        if block.size:
            blocks.append(block.copy())
    if not blocks:
        raise ValueError("模型没有生成语音")
    return np.concatenate(blocks)


def preset_segments(text):
    # Retain punctuation, prefer sentence boundaries, and bound the per-inference memory budget.
    text = re.sub(r"(?<![。！？.!?])(?:\r?\n)+", "。", text)
    parts = re.findall(r"[^。！？.!?\r\n]+[。！？.!?]*|[。！？.!?]+", text)
    current = ""
    for part in parts:
        if current and len(current) + len(part) > 140:
            yield current
            current = ""
        while len(part) > 140:
            cut = max(part.rfind(mark, 40, 140) for mark in "，、,；; ")
            cut = cut + 1 if cut >= 40 else 140
            yield part[:cut]
            part = part[cut:]
        current += part
    if current.strip():
        yield current


def preset_audio(model, request):
    sections = []
    # This deterministic preset takes no reference recording. Tune tempo and loudness on a separate render.
    for text in preset_segments(request["text"]):
        waveform = samples(model.generate_custom_voice(
            text=text, speaker=request["speaker"], language=request.get("language", "Chinese").lower(),
            temperature=0.72, top_k=45, max_tokens=min(2048, max(200, len(text) * 8 + 48)), verbose=False,
        ))
        win = model.sample_rate // 100
        levels = np.max(np.abs(np.pad(waveform, (0, (-len(waveform)) % win)).reshape(-1, win)), axis=1)
        active = np.flatnonzero(levels > max(0.0024, np.max(levels) * 0.005))
        if not active.size:
            raise ValueError("预置音色未产生可听语音")
        first = max(0, int(active[0] * win - 0.10 * model.sample_rate))
        last = min(len(waveform), int((active[-1] + 1) * win + 0.14 * model.sample_rate))
        sections.append(waveform[first:last])
    if not sections:
        raise ValueError("请提供可朗读的文字")
    return np.concatenate(sections)


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model = load_model(request["model"])
    if request.get("mode") == "preset":
        mx.random.seed(1907)
        pcm = preset_audio(model, request)
    else:
        reference, rate = sf.read(request["reference"], dtype="float32")
        if rate != 24000 or reference.ndim != 1:
            raise ValueError("参考音频需为 24 kHz 单声道")
        pcm = samples(model.generate(
            text=request["text"], ref_audio=mx.array(reference), ref_text=request["referenceText"],
            lang_code=request.get("language", "Chinese"), verbose=False,
        ))
    sf.write(request["output"], pcm, model.sample_rate, subtype="PCM_16")
    print(json.dumps({"peakModelBytes": mx.get_peak_memory()}), flush=True)


if __name__ == "__main__":
    main()
