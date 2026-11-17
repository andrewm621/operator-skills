"""Synthesized scratch soundtrack for the Northwind walkthrough, locked to cues.json.

Usage:  .venv/bin/python soundtrack.py [--transpose N] [--voice keys|pluck]
Reads cues.json (written by `node render.mjs cues`), writes walkthrough.wav at about -14 LUFS.
120 BPM, one beat = 0.5 s. Original synthesized music; swap for a licensed 120 BPM track if wanted.
"""
import json, os, re, subprocess, sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
args = sys.argv[1:]
TRANSPOSE = int(args[args.index("--transpose") + 1]) if "--transpose" in args else 0
VOICE = args[args.index("--voice") + 1] if "--voice" in args else "keys"   # warm brand: soft keys
TARGET_LUFS = -14.0
FFMPEG = "/opt/homebrew/bin/ffmpeg"

data = json.load(open(os.path.join(HERE, "cues.json")))
TOTAL = float(data["total"])
TM = data["timing"]
BEAT = 60.0 / data["bpm"]
N = int(TOTAL * SR)
rng = np.random.default_rng(7)

def bus(): return np.zeros((2, N))
music, drums, fx, send = bus(), bus(), bus(), bus()
kick_env = np.zeros(N)

def mtof(m): return 440.0 * 2 ** ((m + TRANSPOSE - 69) / 12)
def put(b, t, sig, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if i >= N or i + len(sig) <= 0: return
    j = min(N, i + len(sig)); s = sig[: j - i] * gain
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    b[0, i:j] += s * l * 1.414; b[1, i:j] += s * r * 1.414
def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, "low", fs=SR, output="sos"), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, "high", fs=SR, output="sos"), x)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], "band", fs=SR, output="sos"), x)

# ---------- voices ----------
def keys(m, d=1.6, vel=1.0):
    t = tt(d); f = mtof(m)
    s = sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t * (2.2 + k * 1.6)) for k, a in [(1, 1), (2, .45), (3, .18), (4, .08)])
    return s * np.minimum(1, t / 0.006) * vel * 0.35
def pluck(m, d=0.6, vel=1.0):
    t = tt(d); f = mtof(m)
    s = np.sign(np.sin(2 * np.pi * f * t)) * 0.3 + np.sin(2 * np.pi * f * t)
    return lp(s * np.exp(-t * 7), 3500) * vel * 0.25
def lead(m, d, vel=1.0): return keys(m, d, vel) if VOICE == "keys" else pluck(m, d, vel)
def pad(ms, d):
    t = tt(d); s = np.zeros_like(t)
    for m in ms:
        for det in (-0.08, 0.0, 0.07):
            f = mtof(m + det); s += np.sin(2 * np.pi * f * t + rng.random() * 6) + 0.3 * np.sin(4 * np.pi * f * t)
    env = np.minimum(1, t / 0.35) * np.minimum(1, (d - t) / 0.4)
    return lp(s, 1800) * env * 0.13
def kick(vel=1.0):
    t = tt(0.45); f = 48 + 90 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-t * 7.5) + 0.25 * np.exp(-t * 300) * rng.standard_normal(len(t))) * vel * 0.9
def snap(vel=1.0):
    t = tt(0.22); n = rng.standard_normal(len(t))
    return (bp(n, 1400, 6000) * np.exp(-t * 26) + 0.4 * np.sin(2 * np.pi * 210 * t) * np.exp(-t * 40)) * vel * 0.55
def shaker(vel=1.0):
    t = tt(0.07); return hp(rng.standard_normal(len(t)), 7000) * np.exp(-t * 70) * vel * 0.14
def bass(m, d):
    t = tt(d); f = mtof(m)
    s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return s * np.minimum(1, t / 0.01) * np.minimum(1, (d - t) / 0.05) * np.exp(-t * 1.2) * 0.42
def tick(f=3200, vel=1.0):
    t = tt(0.03); return (np.sin(2 * np.pi * f * t) * np.exp(-t * 260) + 0.3 * hp(rng.standard_normal(len(t)), 4000) * np.exp(-t * 400)) * vel * 0.16
def blip(m, vel=1.0):
    t = tt(0.16); return np.sin(2 * np.pi * mtof(m) * t) * np.exp(-t * 26) * np.minimum(1, t / 0.003) * vel * 0.22
def chime(m, vel=1.0):
    t = tt(1.6); f = mtof(m)
    s = sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t * dcy) for k, a, dcy in [(1, 1, 3), (2.76, .35, 6), (5.4, .15, 9)])
    return s * np.minimum(1, t / 0.002) * vel * 0.2
def sweep(d, up=True, vel=1.0):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros_like(n)
    seg = int(0.02 * SR)
    for i in range(0, len(n), seg):
        p = i / len(n); p = p if up else 1 - p
        fc = 400 + 6000 * p ** 2
        out[i:i + seg] = bp(n[max(0, i - seg):i + seg], fc * 0.7, min(fc * 1.4, 20000))[-len(n[i:i + seg]):]
    env = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 1.5 if not up else (t / d) ** 2
    return out * env * vel * 0.25
def impact(vel=1.0):
    t = tt(2.2); f = 38 + 50 * np.exp(-t * 12)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.5)
    crash = hp(rng.standard_normal(len(t)), 5000) * np.exp(-t * 2.2) * 0.35
    return (sub + crash) * vel * 0.8

# ---------- harmony (D major, transposable) ----------
D = 62
CH = {
    "Dmaj9": [50, 57, 61, 64, 66], "Bm9": [47, 54, 57, 61, 62], "Gmaj9": [43, 50, 54, 57, 62],
    "Em9": [40, 47, 50, 54, 55], "A6": [45, 52, 57, 61, 66], "D/F#": [42, 50, 54, 57, 62],
}
S = TM["stations"]; PB0, PB1 = TM["pullback"]; HL = TM["headline"]; END = TM["end"]
sections = [  # (start, end, chord, groove)
    (0, S[1], "Dmaj9", False), (S[1], S[2], "Bm9", True), (S[2], S[3], "Gmaj9", True),
    (S[3], S[4], "Em9", True), (S[4], PB0, "D/F#", True), (PB0, HL, "Gmaj9", False),
    (HL, HL + 2, "Gmaj9", True), (HL + 2, END, "A6", True), (END, TOTAL, "Dmaj9", False),
]
travels = [(S[i] + TM["hold"], S[i + 1]) for i in range(4)]
def in_travel(t): return any(a <= t < b for a, b in travels)
def chord_at(t):
    for a, b, c, g in sections:
        if a <= t < b: return CH[c]
    return CH["Dmaj9"]

for a, b, c, groove in sections:
    ms = CH[c]
    put(music, a, pad([m + 12 for m in ms[1:]], b - a + 0.3), 1.0 if groove else 0.7)
    put(send, a, pad([m + 12 for m in ms[1:]], b - a + 0.3), 0.5)
    if a == 0:   # intro: one quiet chord per bar
        for bar in np.arange(0, b, 2 * 2 * BEAT):
            for k, m in enumerate(ms[1:]): put(music, bar + k * 0.02, keys(m + 12, 2.4, 0.45), 1, -0.2 + 0.1 * k)
    if c == "Dmaj9" and a == END:   # resolved ending chord, no drums
        for k, m in enumerate([ms[0]] + [x + 12 for x in ms[1:]] + [ms[2] + 24]):
            put(music, a + 0.03 * k, keys(m, 4.0, 0.8), 1, -0.3 + 0.12 * k); put(send, a, keys(m, 4.0, 0.5))
    if not groove: continue
    for bt in np.arange(a, b - 1e-6, BEAT):
        bi = int(round((bt - a) / BEAT))
        travel = in_travel(bt)
        if not travel:
            put(drums, bt, kick(1.0 if bi % 4 == 0 else 0.85)); kick_env[int(bt * SR):int(bt * SR) + int(0.3 * SR)] = np.maximum(kick_env[int(bt * SR):int(bt * SR) + int(0.3 * SR)], np.exp(-tt(0.3)[: max(0, min(int(0.3 * SR), N - int(bt * SR)))] * 9))
            if bi % 2 == 1: put(drums, bt, snap(0.9), 1, 0.1); put(send, bt, snap(0.5), 0.6)
            put(music, bt, bass(ms[0] if bi % 4 != 3 else ms[0] + 7, BEAT * 0.9), 1)
        for k in range(4): put(drums, bt + k * BEAT / 4, shaker(1.0 if k == 2 else 0.55 if not travel else 0.3), 1, 0.35)
        # eighth-note arpeggio
        for k in range(2):
            m = ms[1:][(bi * 2 + k) % 4] + 24
            put(music, bt + k * BEAT / 2, pluck(m, 0.35, 0.33 if not travel else 0.18), 1, -0.4 + 0.8 * ((bi * 2 + k) % 4) / 3)

# lift melody over the headline (32-36)
mel = [(0, 74), (0.5, 76), (1.0, 78), (1.5, 81), (2.0, 78), (2.75, 76), (3.0, 81), (3.5, 83)]
for o, m in mel: put(music, HL + o, lead(m, 1.2, 0.8), 1, 0.15); put(send, HL + o, lead(m, 1.2, 0.5))

# ---------- event cues ----------
pent = [74, 76, 78, 81, 83, 86]
ki = 0
for c in data["cues"]:
    t, ty = c["t"], c["type"]
    if ty == "key":
        put(fx, t, tick(2600 + 400 * (ki % 3), 0.9), 1, 0.2 * ((ki % 5) - 2) / 2)
        if t < S[1]: put(music, t, keys(pent[ki % len(pent)], 0.6, 0.18), 1, 0.3)   # one note per typed char in the opening
        ki += 1
    elif ty == "click": put(fx, t, snap(0.35) + np.pad(tick(1800, 1.2), (0, len(snap(0.35)) - len(tick(1800)))), 1, 0.1)
    elif ty == "count": put(fx, t, tick(2200 + 900 * ((t * 10) % 3), 1.1))
    elif ty == "paste": put(fx, t, snap(0.6), 1); put(fx, t, blip(86, 0.8))
    elif ty == "pop": put(fx, t, blip(81 + (chord_at(t)[2] % 12) - 9, 1.0), 1, -0.1); put(send, t, blip(81, 0.5))
    elif ty == "chime":
        m = max(chord_at(t)[1:]) + 24
        put(fx, t, chime(m, 1.0), 1, 0.2); put(fx, t + 0.09, chime(m + 7, 0.6), 1, -0.2); put(send, t, chime(m, 0.8))
    elif ty == "whoosh": put(fx, t - 0.05, sweep(c["v"] + 0.1, up=False, vel=1.0), 1)
    elif ty == "land": put(fx, t, impact(0.35)); put(drums, t, kick(1.0))
    elif ty == "rise": put(fx, t, sweep(c["v"], up=True, vel=1.2)); put(send, t, sweep(c["v"], up=True, vel=0.5))
    elif ty == "impact": put(fx, t, impact(1.0)); put(send, t, impact(0.4))
    elif ty == "word": put(music, t, keys(pent[int(round((t - HL) * 10)) % 6] if t < END else 86, 1.0, 0.3), 1, 0.2)
    elif ty == "hl": put(fx, t, chime(90, 0.6), 1, 0.3)

# ---------- mix ----------
side = 1 - 0.55 * kick_env
music *= side
t_all = np.arange(N) / SR
# intro sits well under the groove (>= 6 dB)
intro_gain = np.where(t_all < S[1], 0.75, 1.0)
music *= intro_gain; fx *= np.where(t_all < S[1], 0.8, 1.0)
ir_t = tt(1.4); ir = rng.standard_normal((2, len(ir_t))) * np.exp(-ir_t * 4.2)
ir = np.stack([lp(ir[0], 6000), lp(ir[1], 6000)])
ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
rev = np.stack([fftconvolve(send[i], ir[i])[:N] for i in range(2)]) * 0.5
rev *= np.where(t_all < S[1], 0.4, 1.0)
mix = music + drums * 0.9 + fx + rev
mix = np.stack([hp(mix[i], 28, 2) for i in range(2)])
# fade at the very end
fade = np.clip((TOTAL - t_all) / 2.2, 0, 1) ** 1.5
mix *= np.where(t_all > TOTAL - 2.2, fade, 1)

def write(x, path):
    y = np.tanh(x * 1.2) / 1.2
    pk = np.max(np.abs(y))
    if pk > 0.98: y *= 0.98 / pk
    wavfile.write(path, SR, (y.T * 32767).astype(np.int16))

def lufs(path):
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)[-1])

out = os.path.join(HERE, "walkthrough.wav")
g = 0.5
for _ in range(4):
    write(mix * g, out); L = lufs(out)
    if abs(L - TARGET_LUFS) < 0.3: break
    g *= 10 ** ((TARGET_LUFS - L) / 20)
print(f"integrated loudness: {L:.1f} LUFS (gain {g:.3f})")

# section RMS report
sr, y = wavfile.read(out); y = y.astype(float) / 32767
def rms(a, b):
    seg = y[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)
for name, a, b in [("intro 0-6", 0, S[1]), ("groove 6-10.5", S[1], S[1] + TM["hold"]), ("travel 10.5-12", *travels[0]), ("groove 12-16.5", S[2], S[2] + TM["hold"]),
                   ("pullback 30-32", PB0, HL), ("headline 32-36", HL, END), ("end 36-40", END, TOTAL), ("last 0.3s", TOTAL - 0.3, TOTAL)]:
    print(f"  {name:16s} {rms(a, b):6.1f} dBFS RMS")
