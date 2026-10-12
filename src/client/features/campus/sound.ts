import type { AudioCore } from '../../sound/core';

// ---- The card reader ----------------------------------------------------------------------------

/** A card on a reader, right where you stand: two bright beeps going up when it opens, one low buzz when it won't. */
export function cardReader(a: AudioCore, ok: boolean) {
  a.unlock();
  const ctx = a.ctx;
  if (!ctx) return;
  a.count(`cardReader.${ok ? 'ok' : 'no'}`);
  const out = a.panner({ x: a.listener.x, y: a.listener.y, z: a.listener.z }, 1.2, 1);
  out.connect(a.ambience);
  const t0 = ctx.currentTime + 0.02;
  const tone = (f: number, at: number, len: number, type: OscillatorType, loud: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(loud, at + 0.01);
    g.gain.setValueAtTime(loud, at + len - 0.03);
    g.gain.linearRampToValueAtTime(0, at + len);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + len + 0.02);
  };
  if (ok) {
    tone(1568, t0, 0.09, 'sine', 0.22);
    tone(2093, t0 + 0.12, 0.14, 'sine', 0.22);
  } else tone(196, t0, 0.45, 'square', 0.08);
}
