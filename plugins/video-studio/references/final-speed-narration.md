# 可选：先固化旁白语速，再转录和剪辑

当风格要求明确语速（例如 henry-hot-news 的 1.2 倍）时，可把真实生成的旁白先转为最终速度 WAV，再导入 ChatCut。此路径解决不同变速引擎输出波形不同、严格关联难以复现的问题；不改变音色选择、波形相关度、同步容差或字幕验收标准。它不保证整个成片一次通过，也不能代替真实转录、最终混音检测与独立验收。

## 制作顺序

1. 使用本期用户选定音色生成真实旁白，保存完整生成记录和下载原件。下载文件放在当前 run 内，保留原 assetId、实际下载读回和 SHA-256。不要重复加上供应商已经应用的速度；先确定这次需要的额外倍率。
2. 调用辅助脚本，输出一个新文件和新收据；原件与已有文件都不会被覆盖：

   ```sh
   "$VIDEO_STUDIO_PYTHON" "$PLUGIN_ROOT/scripts/prepare_narration.py" \
     --source "$RUN/media/narration-original.mp3" \
     --source-asset-id "$ORIGINAL_ASSET_ID" --rate 1.2 \
     --output "$RUN/media/narration-final-speed.wav" \
     --receipt "$RUN/evidence/narration-speed.json"
   ```

   固定输出为 48 kHz PCM16 WAV，保留单/双声道。收据记录实际源字节、派生字节、PCM、倍率、滤镜和 FFmpeg 版本/二进制哈希。实测 PCM 帧数决定时长，不能直接用旧时长除以倍率替代。
3. 按当前 ChatCut asset-import 技能导入新 WAV，取得**真实的新 assetId**。读取新资产并等其转录就绪，再保存 `inspect_asset` 返回的完整 asset 与 transcript；按当前工具说明请求所有转录范围，不能只存 preview。实际导入/下载的资产文件字节必须与准备的 WAV 相同；若服务转码导致字节不同，保留为未验证，不改写收据使其通过。
4. 只从新资产的真实转录建立字幕和动画锚点；不能复制旧转录并除以 1.2。新音频在时间线上显式 `playbackRate=1`，源窗口与帧时长也必须表示单位速度。按实测静音剪接，不截词。普通增益和短淡入淡出仍由现有混音检查处理。
5. 导出前验证派生链、用户音色、全量词与字幕边界；最终导出后照常执行波形、响度、峰值、字幕和视觉验收。失败或证据不足仍保留候选与报告。

## 证据结构

`review-evidence.json` 增加下列可选字段。所有文件位于本 run 内，哈希为真实字节的 SHA-256。示例中的 ID 和哈希是字段说明，不是可提交的证据：

```json
{
  "voice_files": [
    {"assetId": "实际原始ID", "path": "run内原音频绝对路径", "sha256": "原件哈希"},
    {"assetId": "实际导入ID", "path": "run内派生WAV绝对路径", "sha256": "派生哈希"}
  ],
  "voice_derivations": [{
    "assetId": "实际导入ID",
    "receipt": {"path": "prepare_narration收据绝对路径", "sha256": "收据哈希"},
    "transcript": {"path": "新资产真实读回JSON绝对路径", "sha256": "读回哈希"}
  }],
  "voice_derivation_sources": [
    {"assetId": "实际原始ID", "data": [{"asset": "原始inspect_asset对象（含generationRecord）"}]}
  ],
  "voice_sources": [
    {"assetId": "实际导入ID", "data": [{"asset": "新资产inspect_asset对象"}, {"transcript": "该新资产的完整真实转录对象"}]}
  ]
}
```

转录读回文件保存实际工具结果解包后的 `{assetId,data:[{asset},{transcript}]}`；外层 assetId 使用真实请求的完整 UUID。Hosted `asset.id` 可能是去掉连字符后的前 10 位，保留原样；只允许它在完整时间线及本期所有来源/文件/派生身份中唯一对应该完整 UUID，不接受任意短前缀或碰撞。

Hosted 转录可能是 `columns:["startMs","endMs","text"]` 和 `ranges[].words` 三元数组。把 `voice_derivations.canonical_source(raw_row)` 返回的副本放进 `voice_sources`，保留原始读回文件；此转换仅把列名映射为内部 `segments` 字段，保留原词、时间、资产 ID 与范围元数据。验证先做同一无损规范化，再逐字段核对读回与当前证据，不能把其他完整资产 ID 的转录移植过来。`available`、`truncated=false` 不表示已请求全量内容；真实 `ranges[].range` 必须覆盖派生 PCM 全时长（仅允许 1ms 元数据舍入）。

这是原始工具读回的封装，不是自行生成词时间的接口。不要给导入资产补造 `generationRecord`；音色由派生链追溯原始生成记录。原始记录与派生当前转录分开，避免把未使用原件当成当前字幕来源。

支持多步派生，每条收据的 `source.assetId` 必须指向已有原始生成资产或另一条明确派生边；每步都重放验证 PCM。当前实际播放的每个派生资产都必须有自己的完整转录，未知源、循环、重复身份、错文件/错倍率、缺失转录或再次时间线变速均拒绝。原始源必须有真实可用生成记录和本期所选 provider/voiceId。

## 验证接口及调用位置

```python
result = voice_derivations.verify(evidence, run_directory, fps)
# result.status: checked / not_applicable；证据不足或不一致抛 ValueError。
# result.evidence_files: [{path, sha256}, ...]，包括原件、派生件、收据与转录读回。
# result.assets: 每个派生 assetId 对应 source_asset_id/root_asset_id/rate/PCM 哈希。
# result.root_sources: 实际已使用旁白对应的原始生成记录，供 voice_controls 比较。
delivery_requirements.check(data, evidence, cues, fps, selected_voice, root=run_directory)
```

`quality_probe` 在准备证据时调用 `verify`，把 `evidence_files` 合并到现有输入哈希和最终证据列表，并保留现有末次哈希一致性检查。失败应成为旁白证据错误，不能把空结果当通过。`quality_probe` 和 `web_bridge` 的 `delivery_requirements.check` 都传当前 run；省略 root 的旧直接生成路径不变，但派生路径会拒绝。控制一致性只可使用验证后返回的 `root_sources`；当前派生 `voice_sources` 仍用于真实词时间投影。无须改动 `review_audio_alignment` 的阈值、算法或接受标准。

这里仍信任实际工具的资产身份/生成记录与下载结果，与现有直接生成路径相同；本地哈希不能独立证明服务商身份，也不能鉴别伪造的工具日志。实现额外证明的是：已绑定源字节经过明确变速后，确实产生这些派生 PCM；它不会声称完成听审。

## 开发验证与限制

`test_voice_derivations.py` 使用真实 FFmpeg 音频变换和明确标注的合成工具/ASR 测试数据，覆盖来源身份、逐步 PCM 重放、全部证据绑定、错误源/输出/倍率、循环、再次变速、缺失/移植/截断转录及现有严格波形匹配。与 `test_delivery_requirements.py`、`test_audio_alignment.py` 一起运行。

真实旁白组件验证：已冻结的机器人试片原音频在独立临时目录复制后，以 1.2 倍转换并重放 PCM；另用新 WAV 在本地生成带轻音乐的诊断 AAC，按原波形阈值检查。该验证不导入 ChatCut、不生成派生 ASR、不改当前试片/验收状态；因此只能证明准备与波形组件，不是新的完整制片验收。具体哈希、结果与命令由任务交接记录保存，客户素材不入仓库。
