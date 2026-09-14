"""
Synthesise the game's sound effects.

    python3 web/tools/sfx_gen.py       # writes web/public/audio/sfx/*.wav

No sample pack was attached, so the sounds are made here: short, chiptune-ish,
in keeping with the pixel art — square waves, noise bursts, hard envelopes.
Each is a few kilobytes of 16-bit mono at 32 kHz.
"""
from __future__ import annotations

import os
import struct
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "public", "audio", "sfx")
SR = 32000
rng = np.random.default_rng(3)


def t(seconds: float) -> np.ndarray:
    return np.arange(int(SR * seconds)) / SR


def env(n: int, attack: float, decay: float, curve: float = 2.0) -> np.ndarray:
    a = max(1, int(attack * SR))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    d = np.linspace(1, 0, n - a) ** curve if n > a else np.zeros(0)
    e[a:] = d
    return e


def square(tt: np.ndarray, f, duty: float = 0.5) -> np.ndarray:
    ph = np.cumsum(np.broadcast_to(f, tt.shape) / SR) % 1.0
    return np.where(ph < duty, 1.0, -1.0)


def noise(n: int) -> np.ndarray:
    return rng.uniform(-1, 1, n)


def lowpass(x: np.ndarray, cutoff) -> np.ndarray:
    """One-pole lowpass; `cutoff` may be an array for a sweep."""
    c = np.broadcast_to(cutoff, x.shape)
    a = np.clip(2 * np.pi * c / SR, 0, 0.99)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def quantise(x: np.ndarray, steps: int = 16) -> np.ndarray:
    """Bit-crush a little: it is a pixel game."""
    return np.round(x * steps) / steps


def write(name: str, x: np.ndarray, gain: float = 0.8) -> None:
    x = np.clip(x * gain, -1, 1)
    data = (x * 32767).astype("<i2").tobytes()
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"{name}: {len(x) / SR * 1000:.0f} ms, {len(data) // 1024} KB")


def slap() -> np.ndarray:
    tt = t(0.09)
    thump = square(tt, np.linspace(160, 60, len(tt)), 0.5) * env(len(tt), 0.001, 0.08, 3)
    crack = lowpass(noise(len(tt)), np.linspace(6000, 900, len(tt))) * env(len(tt), 0.0005, 0.05, 4)
    return quantise(0.6 * thump + 0.9 * crack)


def slap2() -> np.ndarray:
    tt = t(0.08)
    thump = square(tt, np.linspace(220, 70, len(tt)), 0.3) * env(len(tt), 0.001, 0.07, 3)
    crack = lowpass(noise(len(tt)), np.linspace(8000, 1200, len(tt))) * env(len(tt), 0.0005, 0.04, 4)
    return quantise(0.5 * thump + 0.9 * crack)


def whip() -> np.ndarray:
    tt = t(0.16)
    swish = lowpass(noise(len(tt)), np.linspace(400, 9000, len(tt))) * env(len(tt), 0.05, 0.1, 1.5)
    n2 = int(SR * 0.03)
    crack = np.zeros(len(tt))
    crack[-n2:] = lowpass(noise(n2), 7000) * env(n2, 0.0005, 0.03, 5)
    return quantise(0.6 * swish + 1.0 * crack)


def peck() -> np.ndarray:
    tt = t(0.05)
    return quantise(square(tt, np.linspace(900, 500, len(tt)), 0.2) * env(len(tt), 0.001, 0.045, 3))


def honk() -> np.ndarray:
    tt = t(0.22)
    f = 330 + 18 * np.sin(2 * np.pi * 11 * tt)
    a = square(tt, f, 0.35) * 0.7 + square(tt, f * 1.5, 0.5) * 0.4
    return quantise(a * env(len(tt), 0.01, 0.2, 1.2))


def hurt() -> np.ndarray:
    tt = t(0.2)
    f = np.linspace(520, 160, len(tt))
    return quantise(square(tt, f, 0.5) * env(len(tt), 0.002, 0.19, 1.5) * 0.8)


def enemy_hit() -> np.ndarray:
    tt = t(0.07)
    click = lowpass(noise(len(tt)), np.linspace(9000, 2000, len(tt))) * env(len(tt), 0.0005, 0.06, 5)
    tone = square(tt, np.linspace(700, 300, len(tt)), 0.25) * env(len(tt), 0.001, 0.05, 3)
    return quantise(0.8 * click + 0.4 * tone)


def miss() -> np.ndarray:
    tt = t(0.14)
    return quantise(square(tt, np.linspace(120, 80, len(tt)), 0.5) * env(len(tt), 0.003, 0.13, 1.2) * 0.7)


def perfect() -> np.ndarray:
    out = []
    for f in (880, 1108, 1318):
        tt = t(0.04)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.038, 2))
    return quantise(np.concatenate(out) * 0.5)


def word() -> np.ndarray:
    out = []
    for f in (523, 659, 784, 1046):
        tt = t(0.05)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.045, 2))
    return quantise(np.concatenate(out) * 0.5)


def combo() -> np.ndarray:
    out = []
    for f in (784, 988, 1175, 1568, 1568):
        tt = t(0.055)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.05, 2))
    return quantise(np.concatenate(out) * 0.5)


def jump() -> np.ndarray:
    tt = t(0.12)
    return quantise(square(tt, np.linspace(300, 900, len(tt)), 0.5) * env(len(tt), 0.002, 0.11, 2) * 0.5)


def slide() -> np.ndarray:
    tt = t(0.18)
    return quantise(lowpass(noise(len(tt)), np.linspace(3000, 600, len(tt))) * env(len(tt), 0.01, 0.16, 1.5) * 0.8)


def ui_move() -> np.ndarray:
    tt = t(0.03)
    return quantise(square(tt, 1200, 0.5) * env(len(tt), 0.001, 0.028, 2) * 0.4)


def ui_click() -> np.ndarray:
    out = []
    for f in (900, 1350):
        tt = t(0.035)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.03, 2))
    return quantise(np.concatenate(out) * 0.45)


def pause() -> np.ndarray:
    out = []
    for f in (660, 440):
        tt = t(0.06)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.055, 2))
    return quantise(np.concatenate(out) * 0.45)


def win() -> np.ndarray:
    out = []
    for f, d in ((523, 0.09), (659, 0.09), (784, 0.09), (1046, 0.25)):
        tt = t(d)
        out.append((square(tt, f, 0.5) * 0.6 + square(tt, f * 2, 0.25) * 0.3) * env(len(tt), 0.002, d - 0.002, 1.5))
    return quantise(np.concatenate(out) * 0.5)


def lose() -> np.ndarray:
    out = []
    for f, d in ((392, 0.12), (349, 0.12), (311, 0.3)):
        tt = t(d)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.002, d - 0.002, 1.2))
    return quantise(np.concatenate(out) * 0.5)



def whoosh() -> np.ndarray:
    """a heavy thing leaving the hand"""
    tt = t(0.2)
    return quantise(lowpass(noise(len(tt)), np.linspace(300, 2500, len(tt))) * env(len(tt), 0.08, 0.1, 1.5) * 0.7)


def rock_break() -> np.ndarray:
    """the boulder landing and coming apart: a thud, then gravel"""
    tt = t(0.3)
    thud = square(tt, np.linspace(90, 40, len(tt)), 0.5) * env(len(tt), 0.002, 0.16, 3)
    gravel = lowpass(noise(len(tt)), np.linspace(5000, 1500, len(tt))) * env(len(tt), 0.01, 0.28, 2)
    clicks = np.zeros(len(tt))
    for at in (0.05, 0.09, 0.14, 0.2):
        i = int(at * SR)
        n = int(0.012 * SR)
        clicks[i:i + n] += lowpass(noise(n), 6000) * env(n, 0.0005, 0.011, 4)
    return quantise(0.9 * thud + 0.5 * gravel + 0.6 * clicks)


def uppercut() -> np.ndarray:
    """a deep punch with a rising ring after it"""
    tt = t(0.22)
    punch = square(tt, np.linspace(140, 50, len(tt)), 0.5) * env(len(tt), 0.001, 0.12, 3)
    ring = square(tt, np.linspace(400, 1400, len(tt)), 0.3) * env(len(tt), 0.03, 0.18, 2) * 0.4
    crack = lowpass(noise(len(tt)), 4000) * env(len(tt), 0.0005, 0.04, 5)
    return quantise(0.8 * punch + ring + 0.6 * crack)


def thud() -> np.ndarray:
    """feet hitting the ground after a jump"""
    tt = t(0.09)
    return quantise(square(tt, np.linspace(110, 55, len(tt)), 0.5) * env(len(tt), 0.001, 0.08, 3)
                    + 0.4 * lowpass(noise(len(tt)), 1500) * env(len(tt), 0.001, 0.05, 4)) * 0.7


def splat() -> np.ndarray:
    """the bellyflop"""
    tt = t(0.16)
    body = square(tt, np.linspace(200, 60, len(tt)), 0.6) * env(len(tt), 0.001, 0.1, 2)
    slap_ = lowpass(noise(len(tt)), np.linspace(3000, 500, len(tt))) * env(len(tt), 0.0005, 0.12, 3)
    return quantise(0.6 * body + 0.9 * slap_)


def windup() -> np.ndarray:
    """a rising tension while the goose loads a heavy move"""
    tt = t(0.4)
    f = np.linspace(180, 520, len(tt))
    return quantise(square(tt, f, 0.25) * env(len(tt), 0.3, 0.1, 1) * 0.35)


def megahonk() -> np.ndarray:
    tt = t(0.4)
    f = 220 + 25 * np.sin(2 * np.pi * 9 * tt)
    a = square(tt, f, 0.4) * 0.7 + square(tt, f * 1.5, 0.5) * 0.4 + square(tt, f * 0.5, 0.5) * 0.5
    return quantise(a * env(len(tt), 0.01, 0.38, 1.1))


def shift_tick() -> np.ndarray:
    """one tick of the countdown before the circles rearrange"""
    tt = t(0.05)
    return quantise(square(tt, 1500, 0.5) * env(len(tt), 0.001, 0.045, 2) * 0.45)


def shift_go() -> np.ndarray:
    """the circles rearrange: a two-note stamp"""
    out = []
    for f in (740, 1480):
        tt = t(0.06)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, 0.055, 2))
    return quantise(np.concatenate(out) * 0.5)


def boom() -> np.ndarray:
    """the drop: a low boom that fills the room for a moment"""
    tt = t(0.45)
    low = square(tt, np.linspace(70, 35, len(tt)), 0.5) * env(len(tt), 0.003, 0.4, 2)
    air = lowpass(noise(len(tt)), np.linspace(2500, 300, len(tt))) * env(len(tt), 0.002, 0.3, 2)
    return quantise(0.9 * low + 0.5 * air)


def whiff() -> np.ndarray:
    """a swing at nothing"""
    tt = t(0.14)
    return quantise(lowpass(noise(len(tt)), np.linspace(800, 4000, len(tt))) * env(len(tt), 0.04, 0.09, 1.5) * 0.5)



def bodyslam() -> np.ndarray:
    """the whole goose landing flat: a deep boom under a wide slap, then the ground settling"""
    tt = t(0.34)
    boom_ = square(tt, np.linspace(80, 30, len(tt)), 0.5) * env(len(tt), 0.002, 0.3, 2.5)
    slap_ = lowpass(noise(len(tt)), np.linspace(4000, 400, len(tt))) * env(len(tt), 0.0005, 0.1, 3)
    settle = lowpass(noise(len(tt)), 600) * env(len(tt), 0.05, 0.3, 1.5) * 0.4
    return quantise(0.9 * boom_ + 0.8 * slap_ + settle)


def dash() -> np.ndarray:
    """feet leaving the grass in a hurry: a short rising whoosh with a scuff"""
    tt = t(0.14)
    air = lowpass(noise(len(tt)), np.linspace(600, 5000, len(tt))) * env(len(tt), 0.03, 0.1, 1.5)
    scuff = lowpass(noise(len(tt)), 2000) * env(len(tt), 0.001, 0.03, 4)
    return quantise((0.6 * air + 0.5 * scuff) * 0.7)


def bat() -> np.ndarray:
    """a wing batting the rock out of the air: a hard knock and a ping"""
    tt = t(0.12)
    knock = square(tt, np.linspace(320, 120, len(tt)), 0.4) * env(len(tt), 0.001, 0.07, 4)
    ping = square(tt, 1900, 0.5) * env(len(tt), 0.001, 0.05, 3) * 0.3
    crack = lowpass(noise(len(tt)), 5000) * env(len(tt), 0.0005, 0.02, 5)
    return quantise(0.8 * knock + ping + 0.6 * crack)


def smash() -> np.ndarray:
    """the overhead smash landing: a crack, a boom, and a rising pillar of crackle after it"""
    tt = t(0.5)
    crack = lowpass(noise(len(tt)), 6000) * env(len(tt), 0.0005, 0.03, 5)
    boom_ = square(tt, np.linspace(120, 40, len(tt)), 0.5) * env(len(tt), 0.002, 0.22, 3)
    pillar = lowpass(noise(len(tt)), np.linspace(1500, 4500, len(tt))) * env(len(tt), 0.08, 0.4, 1.5) * 0.35
    sparks = np.zeros(len(tt))
    for at in (0.12, 0.17, 0.23, 0.3, 0.38):
        i = int(at * SR)
        n = int(0.01 * SR)
        sparks[i:i + n] += lowpass(noise(n), 7000) * env(n, 0.0005, 0.009, 4) * 0.5
    return quantise(0.7 * crack + 0.9 * boom_ + pillar + sparks)


def run_steps() -> np.ndarray:
    """a cartoon footstep patter — quick alternating hollow knocks, eight a second,
    a second and a half of it (the loader loops it)"""
    out = []
    for i in range(12):
        tt = t(0.125)
        f = 260 if i % 2 == 0 else 330
        knock = square(tt, np.linspace(f, f * 0.6, len(tt)), 0.3) * env(len(tt), 0.001, 0.06, 4)
        tap = lowpass(noise(len(tt)), 3000) * env(len(tt), 0.0005, 0.02, 5)
        out.append(0.7 * knock + 0.5 * tap)
    return quantise(np.concatenate(out) * 0.6)


def menace() -> np.ndarray:
    """ドドドド — a low drone with a pulse, under the pose"""
    tt = t(2.2)
    pulse = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * 6 * tt))
    a = square(tt, 55, 0.5) * 0.6 + square(tt, 82.5, 0.3) * 0.3 + lowpass(noise(len(tt)), 300) * 0.4
    return quantise(a * pulse * env(len(tt), 0.15, 2.0, 1.0) * 0.6, 12)


def glass() -> np.ndarray:
    """the shatter into the fight"""
    tt = t(0.5)
    crack = lowpass(noise(len(tt)), np.linspace(9000, 2500, len(tt))) * env(len(tt), 0.0005, 0.45, 2.5)
    shards = np.zeros(len(tt))
    for at in np.linspace(0.02, 0.4, 14):
        i = int(at * SR)
        n = int(0.02 * SR)
        f = 2400 + 1800 * rng.random()
        shards[i:i + n] += square(t(0.02), f, 0.5) * env(n, 0.0005, 0.018, 3) * 0.5
    return quantise(0.8 * crack + shards)


def slash() -> np.ndarray:
    """a claw slash: a rising swish with a bright tail"""
    tt = t(0.2)
    return quantise(lowpass(noise(len(tt)), np.linspace(1500, 9000, len(tt))) * env(len(tt), 0.02, 0.17, 1.4) * 0.8)


def kanji() -> np.ndarray:
    """a stamp landing: a short low thud with a click on top"""
    tt = t(0.12)
    thud = square(tt, np.linspace(120, 60, len(tt)), 0.5) * env(len(tt), 0.001, 0.1, 3)
    click = lowpass(noise(len(tt)), 6000) * env(len(tt), 0.0005, 0.02, 5)
    return quantise(0.8 * thud + 0.5 * click)


def flash_hit() -> np.ndarray:
    """the inverted frame: a white-noise crack and a sub drop"""
    tt = t(0.25)
    crack = noise(len(tt)) * env(len(tt), 0.0005, 0.05, 5)
    sub = square(tt, np.linspace(90, 30, len(tt)), 0.5) * env(len(tt), 0.002, 0.24, 2)
    return quantise(0.7 * crack + 0.9 * sub)


def crash_zoom() -> np.ndarray:
    """the camera slamming in: a fast downward zip"""
    tt = t(0.14)
    return quantise(square(tt, np.linspace(1800, 200, len(tt)), 0.4) * env(len(tt), 0.001, 0.13, 2) * 0.5)


def text_tick() -> np.ndarray:
    tt = t(0.02)
    return quantise(square(tt, 1900, 0.5) * env(len(tt), 0.0005, 0.018, 2) * 0.35)


def fight_card() -> np.ndarray:
    """FIGHT! — two hard hits and a rising sting"""
    out = []
    for f, d in ((196, 0.09), (196, 0.09)):
        tt = t(d)
        out.append(square(tt, f, 0.5) * env(len(tt), 0.001, d - 0.002, 2) * 0.8)
    tt = t(0.3)
    out.append((square(tt, np.linspace(392, 784, len(tt)), 0.5) * 0.6) * env(len(tt), 0.01, 0.28, 1.5))
    return quantise(np.concatenate(out) * 0.6)


def throw_far() -> np.ndarray:
    """a body sent across the field: a long falling whoosh"""
    tt = t(0.6)
    return quantise(lowpass(noise(len(tt)), np.linspace(4000, 300, len(tt))) * env(len(tt), 0.02, 0.55, 1.6) * 0.7)


def eye_glow() -> np.ndarray:
    """the eyes light up: a thin rising shimmer"""
    tt = t(0.5)
    a = square(tt, np.linspace(900, 2400, len(tt)), 0.2) * 0.4 + square(tt, np.linspace(1350, 3600, len(tt)), 0.1) * 0.2
    return quantise(a * env(len(tt), 0.1, 0.38, 1.3) * 0.5)


def down_card() -> np.ndarray:
    """DOWN! — a slam and a low ring"""
    tt = t(0.45)
    slam = square(tt, np.linspace(160, 45, len(tt)), 0.5) * env(len(tt), 0.001, 0.2, 2.5)
    ring = square(tt, 98, 0.5) * env(len(tt), 0.05, 0.4, 1.2) * 0.4
    return quantise(0.9 * slam + ring)


def flip() -> np.ndarray:
    """the beak flick that sends the enemy skyward: a snap and a fast rising whistle"""
    tt = t(0.32)
    snap = noise(len(tt)) * env(len(tt), 0.001, 0.03, 3)
    f = 500 + 1400 * (tt / 0.32) ** 1.6
    whistle = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(tt), 0.02, 0.3, 1.5) * 0.5
    return quantise(snap + whistle)


def lash() -> np.ndarray:
    """the tail lash coming down: a whip crack with a deep thud under it"""
    tt = t(0.36)
    crack = noise(len(tt)) * env(len(tt), 0.001, 0.05, 4)
    crack = lowpass(crack, 5000 - 4000 * tt / 0.36)
    thud = np.sin(2 * np.pi * np.cumsum(90 - 50 * tt / 0.36) / SR) * env(len(tt), 0.005, 0.3, 2) * 0.8
    return quantise(crack * 0.7 + thud)


def roll() -> np.ndarray:
    """the ball hitting the enemy into the wall: a rumble, a knock, and the wall ringing a little"""
    tt = t(0.4)
    rumble = lowpass(noise(len(tt)), 300) * env(len(tt), 0.01, 0.35, 1.5) * 1.6
    knock = np.sin(2 * np.pi * 140 * tt) * env(len(tt), 0.002, 0.12, 3) * 0.7
    ring = square(tt, 660, 0.3) * env(len(tt), 0.02, 0.25, 3) * 0.12
    return quantise(rumble + knock + ring)


def whip_boom() -> np.ndarray:
    """the hold released clean: the crack of the lash and a boom that fills the room"""
    tt = t(0.6)
    crack = noise(len(tt)) * env(len(tt), 0.001, 0.04, 4)
    boom = np.sin(2 * np.pi * np.cumsum(70 - 30 * tt / 0.6) / SR) * env(len(tt), 0.01, 0.55, 2)
    hiss = lowpass(noise(len(tt)), 1800) * env(len(tt), 0.02, 0.4, 2) * 0.35
    return quantise(crack * 0.6 + boom + hiss)


SOUNDS = {
    "slap": slap, "slap2": slap2, "whip": whip, "peck": peck, "honk": honk, "hurt": hurt,
    "enemy_hit": enemy_hit, "miss": miss, "perfect": perfect, "word": word, "combo": combo,
    "jump": jump, "slide": slide, "ui_move": ui_move, "ui_click": ui_click, "pause": pause,
    "win": win, "lose": lose,
    "whoosh": whoosh, "rock_break": rock_break, "uppercut": uppercut, "thud": thud, "splat": splat,
    "windup": windup, "megahonk": megahonk, "shift_tick": shift_tick, "shift_go": shift_go,
    "boom": boom, "whiff": whiff,
    "run_steps": run_steps, "menace": menace, "glass": glass, "slash": slash, "kanji": kanji,
    "flash_hit": flash_hit, "crash_zoom": crash_zoom, "text_tick": text_tick, "fight_card": fight_card,
    "throw_far": throw_far, "eye_glow": eye_glow, "down_card": down_card,
    "bodyslam": bodyslam, "dash": dash, "bat": bat, "smash": smash,
    "flip": flip, "lash": lash, "roll": roll, "whip_boom": whip_boom,
}


def main() -> None:
    for name, fn in SOUNDS.items():
        write(name, fn())


if __name__ == "__main__":
    main()
