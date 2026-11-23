// Generated from the six shipped Henry JSX components by scripts/compile-motion-jsx.mjs.
import {h, interpolate} from './motion-dom.mjs';
export const sourceHashes = [
  "5f08b3efe04acbc14fd76b97d4c17b9ec4bc1ed0a7581ebd5b730d6a7d5de923",
  "338f1d162838f1e25da7fb63c6a7e1ddc13721f730c29b1b238f2b2c7db59464",
  "d9bf21bf56b856f73b4ec50f91f84002fb1c21605cbbc8ef446d956d783ad358",
  "c74dbc0b45f89e9e2529af3b62bbabc3d181def4b94d7d54d5a62f26ddf873d4",
  "f4cb2e1d4e571ead21908cba08a3f0250ab137cc221776b0ad09ba694655f8f1",
  "d4057478523edc61e6f5b9203b51c6444765c409fcd763b66e66f1484e4834b3"
];
function component1(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => {
        const f = useCurrentFrame();
        const { durationInFrames } = useVideoConfig();
        const p = item.props;
        const en = interpolate(f, [0, 10], [0, 1], { extrapolateRight: "clamp" });
        const out = interpolate(f, [durationInFrames - 10, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const y = interpolate(f, [0, 7, 13], [28, -3, 0], { extrapolateRight: "clamp" });
        const rootStyle = { position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", fontFamily: p.font, opacity: en * out, color: p.white, padding: "12px 24px", backgroundColor: p.transparentBackground ? "transparent" : "rgba(6,15,24,.82)", overflow: "hidden" };
        const labelStyle = { fontSize: 24, fontWeight: 600, letterSpacing: 5, color: p.cyan, marginBottom: 10 };
        const titleStyle = { fontSize: p.size, fontWeight: 900, lineHeight: 1.16, transform: "translateY(" + y + "px)", textShadow: "0 3px 12px rgba(0,0,0,.65)" };
        const lineStyle = { height: 5, width: interpolate(f, [0, 15], [0, 390], { extrapolateRight: "clamp" }), backgroundColor: p.cyan, marginTop: 17 };
        return h("div", { style: rootStyle },
            h("div", { style: labelStyle }, p.label),
            h("div", { style: titleStyle }, p.title),
            h("div", { style: lineStyle }));
    };
    return Component({ item });
}

function component2(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const f = useCurrentFrame(); const p = item.props; const hardware = (f >= 1302 && f < 1398) || (f >= 1572 && f < 1650) || (f >= 1773 && f < 1884) || (f >= 2439 && f < 2559); const label = hardware ? p.hardware : p.lab; const rootStyle = { position: "absolute", inset: 0, display: "flex", justifyContent: "flex-end", alignItems: "center", fontFamily: p.font, fontSize: 22, color: p.white, textShadow: "0 1px 5px #000", opacity: .82 }; return h("div", { style: rootStyle }, label); };
    return Component({ item });
}

function component3(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const f = useCurrentFrame(); const { durationInFrames } = useVideoConfig(); const p = item.props; const rootStyle = { position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 18, fontFamily: p.font, opacity: interpolate(f, [0, 8, durationInFrames - 9, durationInFrames - 1], [0, 1, 1, 0], { extrapolateRight: "clamp" }) }; const labels = [p.a, p.b, p.c]; const starts = [0, p.second, p.third]; return h("div", { style: rootStyle }, labels.map((label, i) => { const active = f >= starts[i]; const rise = interpolate(f, [starts[i], starts[i] + 9], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const st = { height: 104, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, border: "2px solid " + (active ? p.cyan : "rgba(255,255,255,.35)"), backgroundColor: p.transparentBackground ? "rgba(5,16,25,.7)" : "#071622", color: active ? p.white : "rgba(255,255,255,.55)", fontSize: 38, fontWeight: 800, transform: "translateY(" + rise + "px)", boxShadow: active ? "0 0 16px rgba(72,225,209,.12)" : "none" }; return h("div", { key: i, style: st }, label); })); };
    return Component({ item });
}

function component4(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const f = useCurrentFrame(); const { durationInFrames } = useVideoConfig(); const p = item.props; const alpha = interpolate(f, [0, 7, durationInFrames - 8, durationInFrames - 1], [0, 1, 1, 0], { extrapolateRight: "clamp" }); const rootStyle = { position: "absolute", inset: 0, fontFamily: p.font, color: p.white, opacity: alpha, display: "flex", flexDirection: "column", gap: 14, padding: 18, backgroundColor: p.transparentBackground ? "transparent" : "rgba(7,15,24,.84)" }; const text = [p.a, p.b, p.c]; return h("div", { style: rootStyle }, text.map((s, i) => { const progress = interpolate(f, [i * 18, i * 18 + 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const rowStyle = { display: "flex", alignItems: "center", gap: 16, transform: "translateX(" + ((1 - progress) * -32) + "px)", opacity: progress }; const dotStyle = { height: 11, width: 11, borderRadius: 6, backgroundColor: p.cyan, boxShadow: "0 0 12px rgba(72,225,209,.4)" }; const labelStyle = { fontSize: 46, fontWeight: 800, textShadow: "0 2px 8px #000" }; return h("div", { key: i, style: rowStyle },
        h("div", { style: dotStyle }),
        h("div", { style: labelStyle }, s)); })); };
    return Component({ item });
}

function component5(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const f = useCurrentFrame(); const { durationInFrames } = useVideoConfig(); const p = item.props; const out = interpolate(f, [durationInFrames - 10, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const rootStyle = { position: "absolute", inset: 0, fontFamily: p.font, fontSize: 64, fontWeight: 900, color: p.white, opacity: out, overflow: "hidden", textShadow: "0 3px 10px #000" }; const whole = { position: "absolute", left: 0, top: 18, width: 760, whiteSpace: "nowrap" }; const line = { position: "absolute", left: 0, bottom: 12, height: 5, width: 240, backgroundColor: p.cyan }; const settled = f >= 22; return h("div", { style: rootStyle },
        settled ? h("div", { style: whole }, p.title) : Array.from({ length: 12 }, (_, i) => { const shift = interpolate(f, [i * .9, 15 + i * .4], [i % 2 === 0 ? 80 : -80, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const slice = { position: "absolute", left: i * 64, top: 0, width: 64, height: 130, overflow: "hidden" }; const inner = { ...whole, left: -i * 64, transform: "translateY(" + shift + "px)" }; return h("div", { key: i, style: slice },
            h("div", { style: inner }, p.title)); }),
        h("div", { style: line })); };
    return Component({ item });
}

function component6(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const p = item.props; const rootStyle = { position: "absolute", inset: 0, fontFamily: p.font, color: p.white }; const left = { position: "absolute", left: 72, top: 0, fontSize: 32, fontWeight: 800, padding: "9px 18px", backgroundColor: "rgba(6,18,28,.8)", borderLeft: "4px solid " + p.cyan }; const right = { ...left, left: 1032 }; const divider = { position: "absolute", left: 958, top: 0, height: 680, width: 4, backgroundColor: p.cyan }; return h("div", { style: rootStyle },
        h("div", { style: left }, p.left),
        h("div", { style: right }, p.right),
        h("div", { style: divider })); };
    return Component({ item });
}
export const components = [component1, component2, component3, component4, component5, component6];
