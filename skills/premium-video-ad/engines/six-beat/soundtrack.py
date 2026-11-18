"""Original synthesized scratch track for the six beat cut (default 25 s grid). Re-time cues when a scene changes.
120 BPM, cuts at 0/3/7/10/13/16/19/22/25 s. Usage: python soundtrack.py out.wav [transpose]
"""
import sys, subprocess, re
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
TOTAL = 25.0
N = int(SR * TOTAL)
BEAT = 0.5
TR = int(sys.argv[2]) if len(sys.argv) > 2 else 0
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m + TR - 69) / 12)
def bus(): return np.zeros(N)
def place(b, sig, t, g=1.0):
    i = int(t * SR); j = min(N, i + len(sig))
    if i < N: b[i:j] += sig[: j - i] * g
def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)

# ---- voices ----
def keys(f, d=1.6):
    t = tt(d); s = sum(np.sin(2*np.pi*f*k*t) * np.exp(-t*(2.2+k*1.6)) / k**1.4 for k in range(1, 6))
    return s * np.minimum(1, t / 0.006)
def pad(fs, d):
    t = tt(d); s = np.zeros_like(t)
    for f in fs:
        for det in (-0.12, 0.0, 0.11):
            ph = 2*np.pi*f*(1+det/100*7)*t
            s += (2*((ph/(2*np.pi)) % 1) - 1) * 0.33
    s = lp(s, 1400) / len(fs)
    env = np.minimum(1, t/0.35) * np.minimum(1, (d - t)/0.3)
    return s * env
def kick():
    t = tt(0.4); f = 45 + 95*np.exp(-t*28)
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-t*7.5) * 1.0
def snap():
    t = tt(0.18); n = bp(rng.standard_normal(len(t)), 1200, 6000) * np.exp(-t*30)
    return n*0.9 + np.sin(2*np.pi*190*t)*np.exp(-t*40)*0.4
def shaker():
    t = tt(0.05); return hp(rng.standard_normal(len(t)), 7000) * np.exp(-t*90) * 0.5
def bass(f, d=0.42):
    t = tt(d); s = np.sin(2*np.pi*f*t) + 0.25*np.sin(4*np.pi*f*t)
    return s * np.minimum(1, t/0.01) * np.exp(-t*2.5) * np.minimum(1, (d-t)/0.03)
def tick(f=3200):
    t = tt(0.025); return np.sin(2*np.pi*f*t) * np.exp(-t*260)
def blip(f=1600, d=0.09):
    t = tt(d); return np.sin(2*np.pi*f*t) * np.exp(-t*45) * np.minimum(1, t/0.002)
def chime(f=1320):
    t = tt(0.9); return (np.sin(2*np.pi*f*t)*np.exp(-t*5) + 0.5*np.sin(2*np.pi*f*2.76*t)*np.exp(-t*9)) * 0.6
def whoosh(d=0.32):
    t = tt(d); n = bp(rng.standard_normal(len(t)), 500, 5000) ; env = (t/d)**2.2 * np.minimum(1,(d-t)/0.02)
    return n * env * 0.6
def sweep(d):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros_like(t); seg = len(t)//16
    for k in range(16):
        a, b = k*seg, (k+1)*seg if k < 15 else len(t)
        out[a:b] = bp(n[a:b], 300 + k*350, 900 + k*700)
    riser = np.sin(2*np.pi*np.cumsum(220 + 900*(t/d)**2)/SR) * 0.25
    return (out*0.7 + riser) * (t/d)**1.8
def impact():
    t = tt(2.2); sub = np.sin(2*np.pi*np.cumsum(38 + 50*np.exp(-t*9))/SR) * np.exp(-t*2.2)
    crash = hp(rng.standard_normal(len(t)), 4500) * np.exp(-t*2.6) * 0.35
    return sub*1.1 + crash

# ---- harmony (midi) ----
CH = {'Dmaj7': [50, 54, 57, 61], 'Bm7': [47, 50, 54, 57], 'Gmaj7': [43, 47, 50, 54], 'D': [50, 54, 57, 62],
      'A': [45, 49, 52, 57], 'Bm': [47, 50, 54, 59], 'G': [43, 47, 50, 55], 'Dadd9': [50, 54, 57, 64]}
SECT = [(7, 10, 'Gmaj7'), (10, 13, 'D'), (13, 16, 'A'), (16, 19, 'Bm'), (19, 20.5, 'G'), (20.5, 22, 'A')]

K, SN, HH, BS, PD, AR, FX, HK, ENDB = (bus() for _ in range(9))

# hook: one quiet chord per line
for t0, c in [(0, 'Dmaj7'), (1, 'Bm7'), (2, 'Gmaj7')]:
    for m in CH[c]: place(HK, keys(hz(m+12), 1.4), t0, 0.16)
place(HK, pad([hz(m) for m in CH['Dmaj7']], 3.0), 0, 0.12)

# tension: ticks doubling speed, ping per chip, riser, gate
for t0 in np.arange(3.0, 5.0, 0.5): place(FX, tick(2600), t0, 0.35)
for t0 in np.arange(5.0, 6.75, 0.25): place(FX, tick(3000), t0, 0.4)
for i, l in enumerate([0, .5, 1, 1.25, 1.5, 1.625, 1.75, 1.875]): place(FX, blip(hz(74 + [0, 2, 4, 7, 9, 11, 12, 14][i])), 3 + l, 0.22)
place(PD, pad([hz(m) for m in CH['Bm7']], 3.75), 3.0, 0.16)
place(FX, sweep(1.7), 5.05, 0.5)
place(FX, impact(), 7.0, 1.0)

# groove 7..22
for t0 in np.arange(7.0, 22.0, BEAT):
    place(K, kick(), t0, 0.9)
    if int(round((t0-7)/BEAT)) % 2 == 1: place(SN, snap(), t0, 0.55)
for t0 in np.arange(7.0, 22.0, BEAT/4): place(HH, shaker(), t0, 0.22 if int(round(t0*8)) % 2 else 0.14)
for a, b, c in SECT:
    tones = CH[c]
    place(PD, pad([hz(m+12) for m in tones], b - a + 0.25), a, 0.2)
    for j, t0 in enumerate(np.arange(a, b, BEAT/2)):
        place(BS, bass(hz(tones[0]-12)), t0, 0.5 if j % 2 == 0 else 0.32)
        place(AR, keys(hz(tones[[0, 1, 2, 3, 2, 1][j % 6]] + 24), 0.5), t0, 0.07)
# payoff lift melody
for t0, m in [(19.0, 74), (19.5, 76), (20.0, 78), (20.5, 81), (21.0, 78), (21.5, 81)]: place(FX, keys(hz(m+12), 0.9), t0, 0.12)

# event cues
for t0 in (9.85, 12.85, 15.85, 18.85, 21.8): place(FX, whoosh(), t0 - 0.17, 0.45)
for i in range(4): place(FX, chime(hz(86 + [0, 4, 7, 12][i])), 8.5 + i*0.125, 0.13)        # reveal tags
place(FX, blip(1800), 10.5, 0.3); place(FX, blip(1800), 11.5, 0.3)                        # form picks
for t0 in np.arange(10.95, 11.3, 0.035): place(FX, tick(4200), t0, 0.12)                 # typing
place(FX, chime(hz(88)), 11.3, 0.12); place(FX, snap(), 12.0, 0.4); place(FX, chime(hz(93)), 12.05, 0.16)
for t0 in np.arange(13.5, 14.0, 0.04): place(FX, tick(3600), t0, 0.1)                    # counter up
place(FX, chime(hz(86)), 13.5, 0.12)
for t0 in np.arange(14.5, 14.8, 0.05): place(FX, tick(2800), t0, 0.1)                    # counter down
place(FX, chime(hz(93)), 15.0, 0.15)
for i, t0 in enumerate([16.5, 17.0, 17.5, 18.0]): place(FX, blip(hz(81 + [0, 2, 4, 7][i])), t0, 0.28)
place(FX, chime(hz(93)), 18.05, 0.16)

# end: one resolved chord, no drums, fade
for m in CH['Dadd9']: place(ENDB, keys(hz(m+12), 3.0), 22.0, 0.2)
place(ENDB, pad([hz(m) for m in CH['Dadd9']], 3.0), 22.0, 0.22)
place(ENDB, chime(hz(86)), 22.0, 0.12); place(ENDB, blip(hz(90)), 23.0, 0.2)

# ---- mix ----
time = np.arange(N) / SR
duck = np.ones(N)
for t0 in np.arange(7.0, 22.0, BEAT):
    m = time >= t0; duck[m] = np.minimum(duck[m], 1 - 0.55*np.exp(-(time[m]-t0)/0.11))
PD *= duck; BS *= duck; AR *= (0.5 + 0.5*duck)
dry = K + SN + HH + BS + PD + AR + FX + HK + ENDB
ir_t = tt(1.3); ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t*4.5); ir = lp(ir, 5000); ir /= np.sqrt(np.sum(ir**2))
send = fftconvolve(PD + AR + FX + HK + ENDB + SN*0.3, ir)[:N]
mix = dry + send * 0.28
fade = np.ones(N); f0 = int(23.4*SR); fade[f0:] = np.linspace(1, 0, N - f0)**1.5
mix = hp(mix, 28) * fade
mix[int(6.75*SR):int(7.0*SR)] = 0.0            # hard gate before the drop
mix = np.tanh(mix * 1.1) / 1.1

def lufs(x):
    import tempfile, scipy.io.wavfile as w
    p = tempfile.mktemp(suffix='.wav'); w.write(p, SR, (np.clip(np.stack([x, x], 1), -1, 1)*32767).astype(np.int16))   # measure as the stereo file we ship
    o = subprocess.run(['ffmpeg', '-nostats', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
mix *= 0.5 / np.max(np.abs(mix))
for _ in range(3):
    L = lufs(mix); mix *= 10 ** ((-14 - L) / 20); mix = np.clip(mix, -0.98, 0.98)
print('integrated LUFS', round(lufs(mix), 2), 'peak', round(float(np.max(np.abs(mix))), 3))
def rms(a, b): s = mix[int(a*SR):int(b*SR)]; return 20*np.log10(np.sqrt(np.mean(s**2)) + 1e-9)
for name, a, b in [('hook', 0, 3), ('tension', 3, 6.75), ('gap', 6.76, 6.99), ('reveal', 7, 10), ('proofs', 10, 19), ('payoff', 19, 22), ('end', 22, 25)]:
    print(f'{name:8s} RMS {rms(a, b):7.1f} dB')
import scipy.io.wavfile as w
st = np.stack([mix, np.concatenate([mix[24:], np.zeros(24)])], 1)   # tiny haas widen
w.write(sys.argv[1], SR, (st * 32767).astype(np.int16))
print('wrote', sys.argv[1])
