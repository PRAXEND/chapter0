// Build-time allowlist. The first six indices were shipped in saved v1 projects.
const groups = [
  ['technical-explainer', ['impact-title','source-label','process-rail','staggered-explanation','fragment-title','comparison-guide']],
  ['hot-news', ['hot-impact-lines','hot-fact-scan','hot-orbit-mechanism','hot-reaction-text','hot-surface-projection','hot-source-label','hot-directional-word']],
];
export const motionSources = groups.flatMap(([folder, ids]) => ids.map((id, i) => ({
  id, folder, file:'mg-'+String(i+1).padStart(2,'0')+'.jsx', styleId:'henry-'+folder, styleVersion:8,
})));
