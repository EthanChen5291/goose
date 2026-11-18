"""
Skeleton — where notes *can* go, a property of the audio alone.

One decode, one beat grid (aligned to the downbeat), and for every sixteenth
of every beat a set of band confirmations (kick, snare, hats, vocal, full),
the metric weight of the position, and an accent value that combines them
into MUST / SHOULD / MAY / NO.  Per-bar energy and vocal presence feed the
vibe matcher and the duet detector.

The skeleton is deterministic for a given file and is cached by the chart
layer, so every teacher's word list is fitted onto the same bones.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

MUST, SHOULD, MAY, NO = 3, 2, 1, 0
CLASS_NAMES = {3: "MUST", 2: "SHOULD", 1: "MAY", 0: "NO"}

# The layers a chart can follow.  "lead" is the harmonic band above ~280 Hz (a voice, a guitar,
# a synth line), "bass" the harmonic band under it, the rest are the drum kit.  Keyboard
# Warrior's charts, read from the reels, follow whichever of these carries the phrase.
LAYERS = ("lead", "bass", "kick", "snare", "hat")

# metric weight by (beat in bar, sixteenth in beat)
_BEAT_W = {0: 1.0, 1: 0.75, 2: 0.9, 3: 0.75}
_SUB_W = {0: 1.0, 1: 0.3, 2: 0.5, 3: 0.3}


@dataclass
class Point:
    t: float            # seconds
    bar: int
    beat: int           # 0..3 in bar
    sub: int            # 0..3 sixteenth in beat
    kick: float
    snare: float
    hat: float
    vocal: float
    full: float
    weight: float       # metric weight 0..1
    accent: float       # combined accent 0..1
    cls: int            # MUST / SHOULD / MAY / NO
    attack: str         # "kick" | "snare" | "vocal" | "hat" | "full"
    peak: bool = True   # a local onset maximum: the sixteenth before and after are quieter
    t_hit: float = -1.0 # when the hit actually lands (the full-mix onset within ±35 ms), −1 = on the grid
    t_vocal: float = -1.0   # the vocal / lead onset nearest this point (±45 ms), −1 = none
    melodic: bool = False   # the bar is carried by a tune: slots follow the vocal band, not the drums
    bass: float = 0.0       # harmonic onset below ~280 Hz: a bass line, a pad's root
    peaks: int = -1         # bitmask over LAYERS of "a local maximum in that band"; −1 = use ``peak``

    def layer(self, name: str) -> float:
        """This point's onset strength in one layer (see LAYERS)."""
        return {"lead": self.vocal, "bass": self.bass, "kick": self.kick, "snare": self.snare, "hat": self.hat}[name]

    def layer_peak(self, name: str) -> bool:
        if self.peaks < 0:
            return self.peak
        return bool(self.peaks & (1 << LAYERS.index(name)))

    @property
    def conf(self) -> float:
        """How surely something hits here, 0..1.

        In a melodic bar the tune leads: a sung note outranks a drum hit of the same strength,
        so the letters land on the melody rather than on the kick under it.  Elsewhere the
        loudest band wins, hats and the full mix discounted.
        """
        if self.melodic:
            return min(1.0, max(1.15 * self.vocal, 0.7 * self.kick, 0.7 * self.snare, 0.6 * self.full, 0.4 * self.hat))
        return min(1.0, max(self.kick, self.snare, self.vocal, 0.8 * self.full, 0.6 * self.hat))

    @property
    def metric(self) -> int:
        """4 beat1 · 3 beat3 · 2 backbeat · 1 eighth · 0 sixteenth (the Highway's weight code)."""
        if self.sub == 0:
            return 4 if self.beat == 0 else (3 if self.beat == 2 else 2)
        return 1 if self.sub == 2 else 0


@dataclass
class Skeleton:
    bpm: float
    duration: float
    beat_times: list[float]
    points: list[Point]
    bar_energy: list[float]            # 0..1 per bar
    bar_vocal: list[float]             # 0..1 per bar
    bar_start: list[float]             # seconds per bar
    sustains: list[tuple[float, float]] = field(default_factory=list)   # (onset, duration) in the full mix
    # (onset, duration, band) — "low" is a bass / pad drone, "high" a lead or vocal held note.
    # These are what the Duo sections hold on: the band says which hand.
    band_sustains: list[tuple[float, float, str]] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    @property
    def n_bars(self) -> int:
        return len(self.bar_start)

    def points_in(self, t0: float, t1: float) -> list[Point]:
        return [p for p in self.points if t0 <= p.t < t1]


# ── slot selection: the loudest hits first, strong beats as the tie-break ─
# What you hear decides: a point's loudness relative to the loudest hit of its stretch
# carries most of the score, and the metric position (beat 1, beat 3, the backbeats)
# breaks ties, so a syncopated hit that stands out wins over a quiet beat.
METRIC_PRIO = {4: 0.9, 3: 0.7, 2: 0.5, 1: 0.2, 0: 0.0}
# In a melodic stretch the tune leads and the grid only breaks ties: Keyboard Warrior's charts
# (measured from the reels) put ~half their notes on lead/vocal onsets and only a fifth on a
# beat, where a grid-first pick lands 94 % on beats and misses the melody.
MELODIC_METRIC_SCALE = 0.35


def slot_score(p: Point, rel: float) -> float:
    if p.melodic:
        return 1.6 * rel + MELODIC_METRIC_SCALE * METRIC_PRIO[p.metric] + (0.3 if p.peak else 0.0) \
            + (0.35 if p.attack == "vocal" else 0.0)
    return 1.6 * rel + METRIC_PRIO[p.metric] + (0.2 if p.peak else 0.0)


def layer_score(p: Point, layer: str, rel: float) -> float:
    """Priority of a point as a note of one layer: loudness in that layer first, the grid as a
    tie-break (a tune may land anywhere; a drum part leans on the beat)."""
    grid = MELODIC_METRIC_SCALE if layer == "lead" else 0.7
    return 1.6 * rel + grid * METRIC_PRIO[p.metric] + (0.2 if p.layer_peak(layer) else 0.0)


def layer_eligible(p: Point, layer: str, finest: int, rel: float) -> bool:
    """Can a letter follow this layer here?  A real onset of the layer (a local maximum, loud
    enough in absolute terms and against the loudest of its stretch), on the tier's grid —
    except a lead note, which may fall between the grid lines when it clearly sounds."""
    if not p.layer_peak(layer):
        return False
    v = p.layer(layer)
    if v < 0.28 or rel < 0.35:
        return False
    if p.sub % finest != 0:
        return layer == "lead" and rel >= 0.5 and v >= 0.35
    if p.sub == 0:
        return True
    return rel >= (0.40 if p.sub == 2 else 0.50)


def select_layer_slots(pts: list[Point], layer: str, k: int, min_gap: float, finest: int,
                       taken: list[Point] | None = None) -> tuple[list[Point], list[Point]]:
    """The ``k`` strongest onsets of one layer in a stretch, never closer than ``min_gap`` to
    each other or to ``taken`` (slots already placed by another layer).  Returns (slots in time
    order, every eligible point)."""
    if not pts or k <= 0:
        return [], []
    vals = [p.layer(layer) for p in pts]
    top = max(vals)
    if top < 0.28:
        return [], []
    # loudness relative to the stretch's loudest onset — but one very loud hit (the envelopes are
    # normalised to their 95th percentile, so 1.0 is already a loud onset) must not silence the
    # ordinary notes around it
    top = min(top, 1.0)
    cand = [p for p, v in zip(pts, vals) if layer_eligible(p, layer, finest, v / top)]
    if not cand:
        return [], []
    order = sorted(cand, key=lambda p: (-layer_score(p, layer, p.layer(layer) / top), p.t))
    kept: list[Point] = []
    busy = list(taken or [])
    if layer != "lead":
        first = next((p for p in order if p.sub == 0), None)     # a drum part starts on a beat
        if first is not None and all(abs(first.t - q.t) >= min_gap for q in busy):
            kept.append(first)
    for p in order:
        if len(kept) >= k:
            break
        if p in kept:
            continue
        if all(abs(p.t - q.t) >= min_gap for q in kept) and all(abs(p.t - q.t) >= min_gap for q in busy):
            kept.append(p)
    kept.sort(key=lambda p: p.t)
    return kept, cand


def eligible(p: Point, finest: int, rel: float) -> bool:
    """Can a letter sit here?  ``rel`` is the point's confidence relative to the loudest in its stretch."""
    if p.melodic and p.attack == "vocal" and p.peak and rel >= 0.45 and p.vocal >= 0.30:
        return True                      # a sung / lead note: wherever it falls, even off the tier's grid
    if p.sub % finest != 0:
        return False
    if p.sub == 0:
        if p.conf < 0.08:
            return False
        return rel >= 0.35 or (p.beat in (0, 2) and rel >= 0.25)
    if not p.peak:                       # the tail of a hit, not a hit
        return False
    if p.sub == 2:                       # an "and": Hard and Demon take them more readily than Fair
        return rel >= (0.30 if finest == 1 else 0.45)
    return rel >= 0.50                   # a sixteenth


def select_slots(pts: list[Point], k: int, min_gap: float, finest: int) -> tuple[list[Point], list[Point]]:
    """The ``k`` strongest accents of a stretch, strong beats first, never closer than ``min_gap``.

    The first pick is always the strongest *on-beat* point (a word starts on a beat),
    the rest follow the priority score.  Returns (slots in time order, every eligible
    point of the stretch) so a fitter can extend by one when a word is a letter long.
    """
    if not pts or k <= 0:
        return [], []
    max_conf = max(p.conf for p in pts)
    if max_conf < 0.04:                  # silence
        return [], []
    cand = [p for p in pts if eligible(p, finest, p.conf / max_conf)]
    if not cand:
        return [], []
    order = sorted(cand, key=lambda p: (-slot_score(p, p.conf / max_conf), p.t))
    kept: list[Point] = []
    melodic = sum(1 for p in pts if p.melodic) * 2 > len(pts)
    # a word starts on a beat — unless the tune leads, when it starts where the tune does
    anchor = order[0] if melodic else next((p for p in order if p.sub == 0), None)
    if anchor is not None:
        kept.append(anchor)
    for p in order:
        if len(kept) >= k:
            break
        if p is anchor:
            continue
        if all(abs(p.t - q.t) >= min_gap for q in kept):
            kept.append(p)
    kept.sort(key=lambda p: p.t)
    return kept, cand


# ── audio features ────────────────────────────────────────────────────────
def _band_onsets(y: np.ndarray, sr: int, hop: int) -> dict[str, np.ndarray]:
    """Onset-strength envelopes per band, frame-aligned (hop samples)."""
    import librosa
    D = librosa.stft(y, n_fft=2048, hop_length=hop)
    H, P = librosa.decompose.hpss(D, margin=(1.0, 2.0))
    mel_p = librosa.feature.melspectrogram(S=np.abs(P) ** 2, sr=sr, n_mels=96, fmax=sr / 2)
    mel_h = librosa.feature.melspectrogram(S=np.abs(H) ** 2, sr=sr, n_mels=96, fmax=sr / 2)
    mel_f = librosa.feature.melspectrogram(S=np.abs(D) ** 2, sr=sr, n_mels=96, fmax=sr / 2)
    freqs = librosa.mel_frequencies(n_mels=96, fmax=sr / 2)

    def band(M, lo, hi):
        idx = np.where((freqs >= lo) & (freqs < hi))[0]
        if len(idx) == 0:
            idx = np.array([0])
        S = librosa.power_to_db(M[idx, :] + 1e-10)
        return librosa.onset.onset_strength(S=S, sr=sr, hop_length=hop)

    out = {
        "kick": band(mel_p, 20, 150),
        "snare": band(mel_p, 150, 2200),
        "hat": band(mel_p, 5000, sr / 2),
        "vocal": band(mel_h, 280, 4500),
        "bass": band(mel_h, 30, 280),
        "full": librosa.onset.onset_strength(S=librosa.power_to_db(mel_f + 1e-10), sr=sr, hop_length=hop),
    }
    # normalise each envelope to its 95th percentile
    for k, v in out.items():
        p95 = float(np.percentile(v, 95)) if len(v) else 1.0
        out[k] = np.clip(v / (p95 + 1e-9), 0.0, 1.5)
    return out


def _sample_env(env: np.ndarray, frame_times: np.ndarray, t: float, win: float = 0.035) -> float:
    lo = int(np.searchsorted(frame_times, t - win))
    hi = int(np.searchsorted(frame_times, t + win))
    if hi <= lo:
        hi = lo + 1
    seg = env[lo:hi]
    return float(seg.max()) if len(seg) else 0.0


def _sample_env_peak_t(env: np.ndarray, frame_times: np.ndarray, t: float, win: float = 0.035) -> tuple[float, float]:
    """(max, time of the max) of an envelope within ±win of t."""
    lo = int(np.searchsorted(frame_times, t - win))
    hi = int(np.searchsorted(frame_times, t + win))
    if hi <= lo:
        hi = lo + 1
    seg = env[lo:hi]
    if not len(seg):
        return 0.0, t
    i = int(np.argmax(seg))
    return float(seg[i]), float(frame_times[min(lo + i, len(frame_times) - 1)])


def hit_time(p: Point, layer: str | None = None) -> float:
    """Where a letter for this point should land: on the sung note when the note follows the
    lead (or the bar is melodic and no layer is given), else on the audible onset, else on the grid."""
    follows_lead = (layer == "lead") if layer is not None else p.melodic
    if follows_lead and p.t_vocal >= 0 and p.vocal >= 0.30:
        return p.t_vocal
    return p.t_hit if p.t_hit >= 0 else p.t


def _beat_grid(y: np.ndarray, sr: int, expected_bpm: int | None) -> tuple[float, list[float]]:
    """Tempo + downbeat-aligned beat times.

    The tempo octave is chosen so the tapping pulse lands in 84–170 BPM (closest to
    120 when two octaves qualify); only ×2 / ÷2 candidates are considered, never 3/2,
    because librosa cannot lock onto a non-octave prior and jumps to double time.
    """
    import librosa
    from analysis.audio_analysis import find_downbeat_offset
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    if expected_bpm:
        target = float(expected_bpm)
    else:
        tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr, start_bpm=120.0)
        raw = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
        cands = [raw * f for f in (0.25, 0.5, 1.0, 2.0, 4.0)]
        inside = [c for c in cands if 84.0 <= c <= 170.0]
        target = min(inside, key=lambda c: abs(c - 120.0)) if inside else min(cands, key=lambda c: abs(c - 120.0))
    _, frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, start_bpm=target, tightness=300)
    bt = librosa.frames_to_time(frames, sr=sr)
    if len(bt) > 1:
        bpm = float(60.0 / np.median(np.diff(bt)))
    else:
        bpm = target
    # if the tracker still doubled or halved the prior, fold it back by resampling the grid
    # (a 136 prior tracked at 199 on one reel: anything past a third off the prior is an octave slip)
    if len(bt) > 8 and bpm > target * 1.34:
        bt = bt[::2]
        bpm = float(60.0 / np.median(np.diff(bt)))
    elif len(bt) > 8 and bpm < target * 0.72:
        mid = (bt[:-1] + bt[1:]) * 0.5
        bt = np.sort(np.concatenate([bt, mid]))
        bpm = float(60.0 / np.median(np.diff(bt)))
    onset_times = librosa.frames_to_time(np.arange(len(onset_env)), sr=sr)
    off = find_downbeat_offset(bt, onset_env, onset_times)
    return bpm, bt[off:].tolist()


def _sustains(y: np.ndarray, sr: int, beat_dur: float) -> list[tuple[float, float]]:
    """(onset, snapped duration) where the amplitude stays flat after an onset (a held note)."""
    import librosa
    hop = max(1, int(sr * 0.025))
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
    rms_t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.frames_to_time(librosa.onset.onset_detect(y=y, sr=sr, onset_envelope=env, backtrack=True), sr=sr)
    out: list[tuple[float, float]] = []
    last_end = -1e9
    for ot in onsets:
        if ot < last_end + beat_dur:
            continue
        i0 = int(np.searchsorted(rms_t, ot))
        if i0 >= len(rms) - 4:
            continue
        ref = float(np.max(rms[i0:i0 + 3]))
        if ref < 1e-5:
            continue
        i_max = min(len(rms) - 1, int(np.searchsorted(rms_t, ot + 2.0)))
        end = i0
        for j in range(i0 + 1, i_max + 1):
            if rms[j] < ref * 0.6:
                break
            seg = rms[max(i0, j - 2):j + 1]
            if len(seg) >= 2 and float(np.std(seg)) / (ref + 1e-8) > 0.25:
                break
            end = j
        dur = rms_t[end] - ot
        if dur < 0.30:
            continue
        beats = max(0.5, round(dur / beat_dur * 2) / 2)
        out.append((float(ot), float(beats * beat_dur)))
        last_end = ot + beats * beat_dur
    return out


def _band_split(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """The mix as two signals: below ~220 Hz (bass, pads' roots) and above ~350 Hz (leads, vocals)."""
    import librosa
    D = librosa.stft(y, n_fft=2048, hop_length=512)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    lo = D.copy()
    lo[freqs > 220.0, :] = 0
    hi = D.copy()
    hi[freqs < 350.0, :] = 0
    return librosa.istft(lo, hop_length=512, length=len(y)), librosa.istft(hi, hop_length=512, length=len(y))


def _pitch_sustains(sig: np.ndarray, sr: int, beat_dur: float, min_beats: float = 1.5) -> list[tuple[float, float]]:
    """Held *pitches*: runs where the dominant chroma stays put while the band is sounding.

    A sung note or a pad chord varies in loudness (vibrato, a swell) and so slips past the
    RMS test, but its pitch class does not move.  Runs shorter than ``min_beats`` are ignored;
    a run may skip up to two frames of wobble.
    """
    import librosa
    hop = 512
    try:
        C = librosa.feature.chroma_cqt(y=sig, sr=sr, hop_length=hop)
    except Exception:
        return []
    if C.size == 0:
        return []
    rms = librosa.feature.rms(y=sig, frame_length=2048, hop_length=hop)[0]
    n = min(C.shape[1], len(rms))
    C, rms = C[:, :n], rms[:n]
    loud = rms >= 0.15 * (float(np.percentile(rms, 95)) + 1e-9)
    strength = C.max(axis=0) / (C.sum(axis=0) + 1e-9)          # how single-pitched the frame is
    dom = C.argmax(axis=0)
    ft = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=hop)
    out: list[tuple[float, float]] = []
    i = 0
    while i < n:
        if not (loud[i] and strength[i] >= 0.22):
            i += 1
            continue
        pc = dom[i]
        j = i + 1
        miss = 0
        while j < n:
            ok = loud[j] and dom[j] == pc and strength[j] >= 0.18
            if ok:
                miss = 0
            else:
                miss += 1
                if miss > 2:
                    break
            j += 1
        end = j - miss
        dur = ft[min(end, n - 1)] - ft[i]
        if dur >= min_beats * beat_dur:
            out.append((float(ft[i]), float(round(dur / (beat_dur * 0.5)) * beat_dur * 0.5)))
        i = max(end, i + 1)
    return out


def _band_sustains(y: np.ndarray, sr: int, beat_dur: float) -> list[tuple[float, float, str]]:
    """Sustains per band — held pitches and flat-loudness holds — merged in time order."""
    out: list[tuple[float, float, str]] = []
    try:
        y_lo, y_hi = _band_split(y, sr)
    except Exception:
        return out
    for band, sig in (("low", y_lo), ("high", y_hi)):
        if float(np.max(np.abs(sig))) < 1e-4:
            continue
        found = list(_pitch_sustains(sig, sr, beat_dur)) + list(_sustains(sig, sr, beat_dur))
        found.sort()
        merged: list[list[float]] = []
        for onset, dur in found:
            if merged and onset <= merged[-1][0] + merged[-1][1] + 0.5 * beat_dur:
                merged[-1][1] = max(merged[-1][1], onset + dur - merged[-1][0])
            else:
                merged.append([onset, dur])
        out.extend((float(o), float(d), band) for o, d in merged)
    out.sort(key=lambda x: x[0])
    return out


# ── build ─────────────────────────────────────────────────────────────────
def build_skeleton(song_path: str, expected_bpm: int | None = None, progress=None) -> Skeleton:
    import librosa
    y, sr = librosa.load(song_path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    if progress:
        progress("grid")
    bpm, beat_times = _beat_grid(y, sr, expected_bpm)
    if len(beat_times) < 8:
        raise ValueError("too few beats")
    hop = 256
    if progress:
        progress("bands")
    envs = _band_onsets(y, sr, hop)
    frame_times = librosa.frames_to_time(np.arange(len(envs["full"])), sr=sr, hop_length=hop)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    rms_p95 = float(np.percentile(rms, 95)) + 1e-9

    points: list[Point] = []
    bar_start: list[float] = []
    bar_energy: list[float] = []
    bar_vocal: list[float] = []
    n_beats = len(beat_times)
    rows = []
    for i in range(n_beats - 1):
        b0, b1 = beat_times[i], beat_times[i + 1]
        bar = i // 4
        beat = i % 4
        if beat == 0:
            bar_start.append(b0)
        for sub in range(4):
            t = b0 + (b1 - b0) * sub / 4
            k = _sample_env(envs["kick"], frame_times, t)
            s = _sample_env(envs["snare"], frame_times, t)
            h = _sample_env(envs["hat"], frame_times, t)
            v = _sample_env(envs["vocal"], frame_times, t)
            f = _sample_env(envs["full"], frame_times, t)
            bs = _sample_env(envs["bass"], frame_times, t)
            w = _BEAT_W[beat] * _SUB_W[sub]
            rows.append((float(t), bar, beat, sub, k, s, h, v, f, w, bs))
    confs = [min(1.0, max(k, s, v, 0.8 * f, 0.6 * h)) for (_t, _b, _bt, _su, k, s, h, v, f, _w, _bs) in rows]
    layer_vals = {"lead": [r[7] for r in rows], "bass": [r[10] for r in rows], "kick": [r[4] for r in rows],
                  "snare": [r[5] for r in rows], "hat": [r[6] for r in rows]}
    for i, (t, bar, beat, sub, k, s, h, v, f, w, bs) in enumerate(rows):
        conf = confs[i]
        f_max, t_peak = _sample_env_peak_t(envs["full"], frame_times, t)
        t_hit = t_peak if (conf >= 0.25 and f_max >= 0.15) else -1.0
        v_max, t_vpeak = _sample_env_peak_t(envs["vocal"], frame_times, t, win=0.045)
        t_vocal = t_vpeak if v_max >= 0.30 else -1.0
        prev_c = confs[i - 1] if i > 0 else 0.0
        next_c = confs[i + 1] if i + 1 < len(confs) else 0.0
        peak = conf >= max(prev_c, next_c) - 0.05
        accent = w * (conf ** 0.7)
        if sub != 0 and not peak:
            accent *= 0.4                # an off-beat must be an onset, not the ring of the beat before
        if accent >= 0.55 or (beat == 0 and sub == 0 and conf >= 0.25):
            cls = MUST
        elif accent >= 0.32:
            cls = SHOULD
        elif accent >= 0.14 and conf >= 0.2:
            cls = MAY
        else:
            cls = NO
        bands = {"kick": k, "snare": s, "vocal": v, "hat": 0.6 * h, "full": 0.8 * f}
        attack = max(bands, key=bands.get)
        mask = 0
        for li, name in enumerate(LAYERS):
            vals = layer_vals[name]
            prev_v = vals[i - 1] if i > 0 else 0.0
            next_v = vals[i + 1] if i + 1 < len(vals) else 0.0
            if vals[i] >= max(prev_v, next_v) - 0.05:
                mask |= 1 << li
        points.append(Point(t, bar, beat, sub, k, s, h, v, f, w, accent, cls, attack, peak, t_hit, t_vocal,
                            False, bs, mask))
    # bar energy / vocal presence
    n_bars = len(bar_start)
    for b in range(n_bars):
        t0 = bar_start[b]
        t1 = bar_start[b + 1] if b + 1 < n_bars else (beat_times[-1] if beat_times else duration)
        lo = int(np.searchsorted(frame_times, t0))
        hi = max(lo + 1, int(np.searchsorted(frame_times, t1)))
        e = float(np.mean(rms[lo:hi])) / rms_p95 if hi > lo else 0.0
        bar_energy.append(float(min(1.0, e)))
        pv = [p.vocal for p in points if p.bar == b]
        bar_vocal.append(float(np.mean(pv)) if pv else 0.0)
    # melodic bars: a tune is present relative to the song's own vocal level.  The class is
    # recomputed there because the melodic conf changes which points are accents.
    if bar_vocal:
        srt = sorted(bar_vocal)
        thresh = max(0.15, 0.7 * srt[int(len(srt) * 0.6)])
        melodic_bars = {b for b, v in enumerate(bar_vocal) if v >= thresh}
        for p in points:
            if p.bar in melodic_bars:
                p.melodic = True
                accent = p.weight * (p.conf ** 0.7)
                if p.sub != 0 and not p.peak:
                    accent *= 0.4
                p.accent = accent
                if accent >= 0.55 or (p.beat == 0 and p.sub == 0 and p.conf >= 0.25):
                    p.cls = MUST
                elif accent >= 0.32:
                    p.cls = SHOULD
                elif accent >= 0.14 and p.conf >= 0.2:
                    p.cls = MAY
                else:
                    p.cls = NO
    if progress:
        progress("sustains")
    sus = _sustains(y, sr, 60.0 / bpm)
    band_sus = _band_sustains(y, sr, 60.0 / bpm)
    sk = Skeleton(bpm=bpm, duration=duration, beat_times=beat_times, points=points,
                  bar_energy=bar_energy, bar_vocal=bar_vocal, bar_start=bar_start, sustains=sus,
                  band_sustains=band_sus, meta={"sr": sr, "hop": hop})
    return sk


def to_dict(sk: Skeleton) -> dict:
    return {
        "bpm": sk.bpm, "duration": sk.duration, "beat_times": sk.beat_times,
        "points": [[p.t, p.bar, p.beat, p.sub, p.kick, p.snare, p.hat, p.vocal, p.full, p.weight, p.accent, p.cls, p.attack, int(p.peak), round(p.t_hit, 4), round(p.t_vocal, 4), int(p.melodic), round(p.bass, 4), p.peaks] for p in sk.points],
        "bar_energy": sk.bar_energy, "bar_vocal": sk.bar_vocal, "bar_start": sk.bar_start,
        "sustains": sk.sustains, "band_sustains": sk.band_sustains, "meta": sk.meta,
    }


def from_dict(d: dict) -> Skeleton:
    pts = [Point(*row[:13], bool(row[13]) if len(row) > 13 else True, float(row[14]) if len(row) > 14 else -1.0,
                 float(row[15]) if len(row) > 15 else -1.0, bool(row[16]) if len(row) > 16 else False,
                 float(row[17]) if len(row) > 17 else 0.0, int(row[18]) if len(row) > 18 else -1)
           for row in d["points"]]
    return Skeleton(d["bpm"], d["duration"], d["beat_times"], pts, d["bar_energy"], d["bar_vocal"],
                    d["bar_start"], [tuple(s) for s in d.get("sustains", [])],
                    [(float(a), float(b), str(c)) for a, b, c in d.get("band_sustains", [])], d.get("meta", {}))
