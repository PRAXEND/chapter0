// Generated from the shipped Henry JSX sources by scripts/compile-motion-jsx.mjs.
import {h, interpolate} from './motion-dom.mjs';
export const sourceHashes = [
  "5f08b3efe04acbc14fd76b97d4c17b9ec4bc1ed0a7581ebd5b730d6a7d5de923",
  "338f1d162838f1e25da7fb63c6a7e1ddc13721f730c29b1b238f2b2c7db59464",
  "d9bf21bf56b856f73b4ec50f91f84002fb1c21605cbbc8ef446d956d783ad358",
  "c74dbc0b45f89e9e2529af3b62bbabc3d181def4b94d7d54d5a62f26ddf873d4",
  "f4cb2e1d4e571ead21908cba08a3f0250ab137cc221776b0ad09ba694655f8f1",
  "d4057478523edc61e6f5b9203b51c6444765c409fcd763b66e66f1484e4834b3",
  "a1a5158c263f5cf457a1d06a39308be1d540e33920aac08424352d6d893549dd",
  "36d51a454daa15ea23b42318452f16d4caee4d9fd1dcd5c845d376afd0a36d6f",
  "ce2924bbc9f355ce3e0bd03c1b58e44ac7bec50733177b92fb327b88ed126c5f",
  "52ba0e81e38189bc2172103a031e41642c1abda934c2e99e0ce0d781ee25214b",
  "d7dcc5b50078eb7918783850af14825a6e950ea9ea9a37ab5ac4a89dd5faf5d1",
  "d90f980c2fcbd068358d2b361db9ea63a8b318920ed7ec27257e96b84b716950",
  "053d913f4a8827806d89bbb3d36e6ebb0c5a2ef572d96402b767e3e4c52c6dca"
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

function component7(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => {
        const f = useCurrentFrame();
        const p = item.props;
        const rootStyle = { position: "relative", width: "100%", height: "100%", overflow: "visible" };
        const op = interpolate(f, [0, 2, 7, 17], [0, 1, .7, 0], { extrapolateRight: "clamp" });
        const d = interpolate(f, [0, 17], [0, 52], { extrapolateRight: "clamp" });
        return h("div", { style: rootStyle },
            [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const a = i * Math.PI / 4; return h("div", { key: i, style: { position: "absolute", left: 210 + Math.cos(a) * (95 + d), top: 140 + Math.sin(a) * (55 + d * .6), width: 40 + (i % 2) * 20, height: i % 2 ? 3 : 5, backgroundColor: p.accent, opacity: op, transform: "rotate(" + (i * 45) + "deg)", boxShadow: "0 0 8px " + p.accent } }); }),
            [0, 1, 2].map(i => h("div", { key: i, style: { position: "absolute", left: 80 - d * 2, top: 115 + i * 16, width: 75, height: 3, backgroundColor: p.color, filter: "blur(2px)", opacity: op * .8, transform: "rotate(-8deg)" } })));
    };
    return Component({ item });
}

function component8(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const frame = useCurrentFrame(); const p = item.props; const fade = interpolate(frame, [0, 6, 182, 189], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const reveal = interpolate(frame, [0, 13], [0, 100], { extrapolateRight: "clamp" }); const scan = interpolate(frame, [0, 18], [-30, 720], { extrapolateRight: "clamp" }); const rootStyle = { position: "absolute", inset: 0, backgroundColor: "transparent", opacity: fade, overflow: "hidden", padding: 16, display: "flex", flexDirection: "column", gap: 12 }; const titleStyle = { fontFamily: p.font, fontSize: 88, lineHeight: 1.05, color: p.accent, textShadow: "0 2px 9px #111", clipPath: "inset(0 " + (100 - reveal) + "% 0 0)" }; const sub = { fontFamily: p.font, fontSize: 38, color: p.color, lineHeight: 1.15, textShadow: "0 2px 9px #111", opacity: Math.min(1, Math.max(0, (frame - 10) / 8)) }; const light = { position: "absolute", left: scan, top: 0, height: 180, width: 5, backgroundColor: p.accent, boxShadow: "0 0 18px " + p.accent, opacity: frame < 18 ? 0.65 : 0, transform: "rotate(13deg)" }; return h("div", { style: rootStyle },
        h("div", { style: titleStyle }, p.title),
        h("div", { style: sub }, p.subtitle),
        h("div", { style: light })); };
    return Component({ item });
}

function component9(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => {
        const f = useCurrentFrame();
        const p = item.props;
        const rootStyle = { position: "relative", width: "100%", height: "100%", fontFamily: p.font, overflow: "visible" };
        const stage = f < 65 ? 0 : f < 161 ? 1 : 2;
        const sf = stage === 0 ? f : stage === 1 ? f - 65 : f - 161;
        const en = interpolate(sf, [0, 5, 10], [0.6, 1.06, 1], { extrapolateRight: "clamp" });
        const out = interpolate(f, [216, 229], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const chars = p.orbit.split("·");
        const line = stage === 0 ? p.titleA : stage === 1 ? p.titleB : p.titleC;
        const sub = stage === 0 ? p.subA : stage === 1 ? p.subB : p.subC;
        const nodes = [p.actionA, p.actionB, p.actionC];
        const phase = Math.max(0, Math.min(2, Math.floor((f - 65) / 22)));
        return h("div", { style: rootStyle },
            h("div", { style: { position: "absolute", left: 280, top: 10, color: p.accent, fontSize: 30, letterSpacing: 4, textShadow: "2px 2px 4px " + p.ink, opacity: out } }, p.kicker),
            h("div", { style: { position: "absolute", left: 275, top: 60, color: p.color, fontSize: stage === 2 ? 90 : 110, lineHeight: 1.1, whiteSpace: "nowrap", WebkitTextStroke: "2px " + p.ink, textShadow: "5px 6px 0 " + p.ink, transform: "translateX(" + (1 - en) * 120 + "px) scale(" + en + ")", transformOrigin: "left", opacity: out } }, line),
            stage === 0 && chars.map((ch, i) => { const a = i / chars.length * Math.PI * 2 + f * .035; const z = Math.sin(a); return h("div", { key: i, style: { position: "absolute", left: 580 + Math.cos(a) * 250 - 70, top: 275 + z * 100 - 35, width: 140, textAlign: "center", fontSize: 62, whiteSpace: "nowrap", color: p.accent, WebkitTextStroke: "1px " + p.ink, textShadow: "0 0 12px " + p.ink, opacity: out * (.4 + .6 * (z + 1) / 2), transform: "perspective(600px) rotateY(" + (-Math.cos(a) * 55) + "deg) scale(" + (0.75 + (z + 1) * .18) + ")", backfaceVisibility: "hidden" } }, ch); }),
            h("div", { style: { position: "absolute", left: stage === 0 ? 410 : 315, top: 245, color: p.color, fontSize: stage === 0 ? 84 : 68, whiteSpace: "nowrap", textShadow: "3px 4px 0 " + p.ink, WebkitTextStroke: "1px " + p.ink, opacity: out, transform: "translateY(" + ((1 - en) * 50) + "px)" } }, sub),
            stage > 0 && nodes.map((t, i) => {
                const x = 300 + i * 190;
                const active = stage === 2 || i <= phase;
                return h("div", { key: i, style: { position: "absolute", left: x, top: 360, opacity: out * (active ? 1 : .2) } },
                    h("div", { style: { fontSize: 54, color: active ? p.accent : p.color, textShadow: "2px 3px 4px " + p.ink, transform: "scale(" + (stage === 1 && i === phase ? 1 + .04 * Math.sin(f * .3) : 1) + ")" } }, t),
                    h("div", { style: { position: "absolute", left: 0, top: 76, width: 145, height: 4, backgroundColor: p.accent } }));
            }),
            stage > 0 && [0, 1, 2, 3].map(i => { const travel = ((f * 8 + i * 95) % 560); return h("div", { key: i, style: { position: "absolute", left: 300 + travel, top: 437, width: 16, height: 5, borderRadius: 5, backgroundColor: p.color, boxShadow: "0 0 16px " + p.accent, opacity: out * (1 - i * .14) } }); }),
            h("div", { style: { position: "absolute", left: 280, top: 500, color: p.color, fontSize: 25, textShadow: "2px 2px 4px " + p.ink, opacity: out * .9 } }, p.note));
    };
    return Component({ item });
}

function component10(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => {
        const f = useCurrentFrame();
        const p = item.props;
        const rootStyle = { position: "relative", width: "100%", height: "100%", overflow: "visible", fontFamily: p.font };
        const out = interpolate(f, [46, 53], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const chars = Array.from(p.text);
        let cursor = 34;
        const letters = chars.map((c, i) => { const big = i >= p.emphasis && i < p.emphasis + p.count; const size = big ? 112 : 72; const x = cursor; cursor += big ? 119 : 77; return { c, i, big, size, x }; });
        const enter = interpolate(f, [0, 3, 7, 11], [0.42, 1.12, 0.97, 1], { extrapolateRight: "clamp" });
        const fracture = p.crack ? interpolate(f, [10, 13, 19], [0, 13, 7], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
        return h("div", { style: rootStyle },
            h("div", { style: { position: "absolute", left: 0, top: 5, width: 750, height: 220, opacity: out, transform: "rotate(" + p.tilt + "deg)", transformOrigin: "50% 60%" } },
                letters.map(l => {
                    const k = Math.max(0, f - l.i);
                    const sc = interpolate(k, [0, 3, 8], [0.3, l.big ? 1.22 : 1.1, 1], { extrapolateRight: "clamp" });
                    const y = l.big ? 36 : 75;
                    const common = { position: "absolute", left: l.x, top: y, width: l.size + 16, height: l.size * 1.25, fontSize: l.size, lineHeight: 1.08, whiteSpace: "nowrap", color: l.big ? p.accent : p.color, WebkitTextStroke: "2px " + p.ink, textShadow: "4px 5px 0 " + p.ink, opacity: Math.min(1, k / 2), transformOrigin: "50% 65%" };
                    return h("div", { key: l.i },
                        [0, 1].map(j => h("div", { key: j, style: { ...common, color: p.accent, opacity: Math.max(0, 1 - k / 6) * (0.16 - j * 0.05), transform: "translate(" + (20 + j * 17) + "px," + (-10 - j * 8) + "px) scale(" + sc + ")", filter: "blur(3px)" } }, l.c)),
                        l.big && p.crack ? h("div", null,
                            h("div", { style: { ...common, clipPath: "polygon(0 0,100% 0,100% 43%,68% 48%,51% 39%,34% 57%,0 50%)", transform: "translate(" + (-fracture) + "px," + (-fracture * .5) + "px) rotate(" + (-fracture * .35) + "deg) scale(" + sc + ")" } }, l.c),
                            h("div", { style: { ...common, clipPath: "polygon(0 50%,34% 57%,51% 39%,68% 48%,100% 43%,100% 100%,0 100%)", transform: "translate(" + fracture + "px," + (fracture * .55) + "px) rotate(" + (fracture * .3) + "deg) scale(" + sc + ")" } }, l.c)) : h("div", { style: { ...common, transform: "scale(" + sc + ")" } }, l.c));
                }),
                h("div", { style: { position: "absolute", left: 34, top: 174, height: 5, width: Math.min(630, cursor - 40), background: p.accent, opacity: .9, transform: "scaleX(" + Math.min(1, f / 10) + ")", transformOrigin: "left" } }),
                [0, 1, 2, 3, 4, 5].map(i => { const active = p.crack ? f - 11 : f; const a = i * Math.PI / 3; const visible = active >= 0 ? Math.max(0, 1 - active / 13) : 0; return h("div", { key: i, style: { position: "absolute", left: 355 + Math.cos(a) * (245 + Math.max(0, active) * 6), top: 105 + Math.sin(a) * (72 + Math.max(0, active) * 4), width: 18, height: 5, background: p.accent, opacity: visible, transform: "rotate(" + (i * 60) + "deg)" } }); })));
    };
    return Component({ item });
}

function component11(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => {
        const f = useCurrentFrame();
        const p = item.props;
        const rootStyle = { position: "relative", width: "100%", height: "100%", overflow: "visible", fontFamily: p.font };
        const opacity = interpolate(f, [0, 8, 70, 84], [0, 1, 1, 0], { extrapolateRight: "clamp" });
        const reveal = interpolate(f, [0, 14], [100, 0], { extrapolateRight: "clamp" });
        return h("div", { style: rootStyle },
            h("div", { style: { position: "absolute", left: 0, top: 0, width: 500, height: 150, transformOrigin: "0px 0px", transform: "matrix3d(0.7373534072900159,-0.31244849445324885,0,-0.00008161648177496038,0.7664377531255503,0.31958971649938367,0,-0.0000017608733932030288,0,0,1,0,15,185,0,1)", opacity, clipPath: "inset(0 " + reveal + "% 0 0)" } },
                h("div", { style: { position: "absolute", left: 12, top: 0, fontSize: 116, lineHeight: 1.1, letterSpacing: 4, color: p.color, WebkitTextStroke: "1px " + p.ink, textShadow: "0 0 5px " + p.glow, whiteSpace: "nowrap" } }, p.text),
                h("div", { style: { position: "absolute", left: 16, top: 133, width: 465, height: 4, background: p.color, opacity: .5 } }),
                h("div", { style: { position: "absolute", left: interpolate(f, [0, 18], [0, 490], { extrapolateRight: "clamp" }), top: 7, width: 7, height: 124, background: p.glow, boxShadow: "0 0 14px " + p.glow, opacity: f < 18 ? .55 : 0 } })));
    };
    return Component({ item });
}

function component12(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const p = item.props; const rootStyle = { position: "absolute", inset: 0, backgroundColor: "transparent", display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end", padding: 6 }; const t = { fontFamily: p.font, fontSize: 25, color: p.color, textShadow: "0 2px 6px #000", lineHeight: 1.2 }; const dot = { width: 7, height: 7, backgroundColor: p.accent, borderRadius: 9 }; return h("div", { style: rootStyle },
        h("div", { style: dot }),
        h("div", { style: t }, p.text)); };
    return Component({ item });
}

function component13(item, frame, duration) {
    const useCurrentFrame = () => frame;
    const useVideoConfig = () => ({ fps: 30, durationInFrames: duration });
    const Component = ({ item }) => { const frame = useCurrentFrame(); const { durationInFrames } = useVideoConfig(); const p = item.props; const enter = interpolate(frame, [0, 5, 9], [0, 1.06, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const opacity = interpolate(frame, [0, 3, durationInFrames - 6, durationInFrames - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); const slide = interpolate(frame, [0, 7], [65, 0], { extrapolateRight: "clamp" }); const blur = interpolate(frame, [0, 7], [9, 0], { extrapolateRight: "clamp" }); const rootStyle = { position: "absolute", inset: 0, backgroundColor: "transparent", display: "flex", alignItems: "center", padding: "12px 22px", opacity }; const textStyle = { fontFamily: p.font, fontSize: 78, lineHeight: 1.15, color: p.color, textShadow: "0 3px 10px #000", WebkitTextStroke: "1px #111", transform: "translateX(" + slide + "px) scale(" + enter + ")", transformOrigin: "left center", filter: "blur(" + blur + "px)", whiteSpace: "nowrap" }; const barStyle = { position: "absolute", left: 22, bottom: 10, width: 88, height: 6, backgroundColor: p.accent, transform: "scaleX(" + Math.min(1, enter) + ")", transformOrigin: "left center", boxShadow: "0 0 12px " + p.accent }; return h("div", { style: rootStyle },
        h("div", { style: barStyle }),
        h("div", { style: textStyle }, p.text)); };
    return Component({ item });
}
export const components = [component1, component2, component3, component4, component5, component6, component7, component8, component9, component10, component11, component12, component13];
