"""Synthesize from a local, registered sample. The parent supplies filesystem paths only."""
import json
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model = load_model(request["model"])
    reference, rate = sf.read(request["reference"], dtype="float32")
    if rate != 24000 or reference.ndim != 1:
        raise ValueError("参考音频需为 24 kHz 单声道")
    blocks = []
    for result in model.generate(
        text=request["text"], ref_audio=mx.array(reference), ref_text=request["referenceText"],
        lang_code=request.get("language", "Chinese"), verbose=False,
    ):
        sample = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        if sample.size:
            blocks.append(sample)
    if not blocks:
        raise ValueError("模型没有生成语音")
    sf.write(request["output"], np.concatenate(blocks), model.sample_rate, subtype="PCM_16")
    print(json.dumps({"peakModelBytes": mx.get_peak_memory()}), flush=True)


if __name__ == "__main__":
    main()
