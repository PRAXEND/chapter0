// Official NASA media, pinned to the exact downloads used for the human screenings.
export const footage={
  launch:['Artemis I Launch 2022 CU tracking from Press Site_compressed','d55e43036de3fabadfcf1da87d9eba42cfd52b02d80cfff2ba97c89866c8debd'],
  flare:['GSFC_20160426_SDO_m12224_SolarFlare','f8a3fa685185ca5ac3b457dce86d9ee416a6b0b8c5a65d2554b7c1f735fc5ebe'],
  splash:['KSC-20221211-VP-MWC01-001-ARTEMIS-SPLASHDOWN-3296595','df4964dfae903bcde875a85de3f96f98ac7e7e5210f3c14b52ff4ced90572b68'],
  lift:['KSC-20221104-MH-CSH01_0001-Artemis_I_Rollout_for_Launch_Reupload-3317651','d5164ca7ec9333e6a6ef296527606955e5e9474b26613029fe34799ae17dd860'],
  station:['jsc2020m000166_DM-2_Docking_200531','e028950cec61dcf9b81bd79dde32beada404ff99ffb430861506e6cfba039ffa'],
  interview:['iss061m2627771232_Live_Interviews_Jeanette_Epps_191004','31687e6e92252304aa01ccb5f3704b7c6b8b897ecb4612ad937dd8adff3ebe28']
};
export const captionHash='9730ceef50e4d1c23c4f84d7b5cd3623264a5570d914e26858947eec644fbd47';
export const styleSubjects={
 launch:{name:'夜间发射',start:35.5,anchor:40.5,frames:[36,40.5,44],subject:{x:.5,y:.75},narration:'看火箭下方，越来越强的亮光，照亮了旁边的发射塔。',description:'选取 NASA 发射场夜间特写的 35.5–45.5 秒，三帧分别为 36.0、40.5、44.0 秒，反应字在 40.5 秒出现。事实边界：箭体下方逐渐增亮并照亮塔架，此段没有看到火箭离开发射台。'},
 flare:{name:'太阳边缘',start:20,anchor:23.5,frames:[20,23.5,28],subject:{x:.8,y:.5},narration:'从太阳的全景切到局部，留意右侧边缘的亮区。',description:'选取 NASA 太阳观测的 20.0–30.0 秒，三帧分别为 20.0、23.5、28.0 秒，反应字在 23.5 秒出现。事实边界：镜头切近太阳边缘亮区，不能说耀斑在这一帧首次出现。'},
 splash:{name:'返回舱触海',start:94.8,anchor:99,frames:[95,99,103],subject:{x:.5,y:.8},narration:'看降落伞下面的返回舱，它在海面上溅起一小片水花。',description:'选取 NASA 返回舱海面降落的 94.8–104.8 秒，三帧分别为 95.0、99.0、103.0 秒，反应字在 99.0 秒出现。事实边界：舱体触水时能见小片水花，舱体上方还有降落伞。'}
};
export function stylePrompt(subject,styleId) {
  const treatment=styleId==='henry-hot-news'?'热点资讯的“动作出现、短反应字、结果证据”':'技术科普的“提出可见问题、局部分步揭示、回到实拍验证”';
  return '你是短片剪辑师。图从左到右是同一选定原片的前、中、后三帧。这一段采用'+treatment+'模板。依据可见内容独立撰写一套编辑决定。'+subject.description+'固定旁白：'+subject.narration+'仅输出 JSON 对象，字段为 text（13字以内）、followup（25字以内）和 continuity（用一句话说明怎样衔接到结果）。';
}
