# Generates public/contour-{light,dark}.svg: topographic lines from a sum-of-sines height field.
import math, random, sys
W, H, STEP, LEVELS = 1600, 1000, 3, 16
random.seed(7)
waves = [(random.uniform(.004, .012), random.uniform(.004, .012), random.uniform(0, 6.28), random.uniform(.5, 1)) for _ in range(7)]
def h(x, y):
  return sum(a * math.sin(kx * x + ky * y * (1 if i % 2 else -1) + p + math.sin(y * .003 + i)) for i, (kx, ky, p, a) in enumerate(waves))
nx, ny = W // STEP + 1, H // STEP + 1
g = [[h(i * STEP, j * STEP) for i in range(nx)] for j in range(ny)]
lo, hi = min(map(min, g)), max(map(max, g))
def lerp(a, b, t): return a + (b - a) * t
def segs(level):
  out = []
  for j in range(ny - 1):
    for i in range(nx - 1):
      v = [g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]]
      pts = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
      cross = []
      for k in range(4):
        a, b = v[k], v[(k + 1) % 4]
        if (a < level) != (b < level):
          t = (level - a) / (b - a); p, q = pts[k], pts[(k + 1) % 4]
          cross.append((lerp(p[0], q[0], t) * STEP, lerp(p[1], q[1], t) * STEP))
      if len(cross) == 2: out.append(cross)
      elif len(cross) == 4: out += [cross[:2], cross[2:]]
  return out
def chains(sg):
  nb = {}
  key = lambda p: (round(p[0], 2), round(p[1], 2))
  for a, b in sg:
    nb.setdefault(key(a), []).append((a, b)); nb.setdefault(key(b), []).append((b, a))
  used, out = set(), []
  for a, b in sg:
    if (key(a), key(b)) in used or (key(b), key(a)) in used: continue
    chain = [a, b]; used.add((key(a), key(b)))
    for rev in (False, True):
      if rev: chain.reverse()
      while True:
        cur = chain[-1]
        nxt = next(((c, d) for c, d in nb.get(key(cur), []) if (key(c), key(d)) not in used and (key(d), key(c)) not in used), None)
        if not nxt: break
        used.add((key(nxt[0]), key(nxt[1]))); chain.append(nxt[1])
    out.append(chain)
  return out
def smooth(c):
  if len(c) < 3: return f"M{c[0][0]:.1f} {c[0][1]:.1f}L{c[-1][0]:.1f} {c[-1][1]:.1f}"
  m = lambda p, q: ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
  closed = math.dist(c[0], c[-1]) < 1
  d = f"M{m(c[0], c[1])[0]:.1f} {m(c[0], c[1])[1]:.1f}"
  for i in range(1, len(c) - 1):
    e = m(c[i], c[i + 1]); d += f"Q{c[i][0]:.1f} {c[i][1]:.1f} {e[0]:.1f} {e[1]:.1f}"
  return d + ("Z" if closed else "")
d = []
for n in range(1, LEVELS):
  d += [smooth(c) for c in chains(segs(lerp(lo, hi, n / LEVELS)))]
path = "".join(d)
for name, bg1, bg2, s1, s2, op in (
    ("light", "#f8fafc", "#dbe4f2", "#94a3b8", "#7c8fd0", .45),
    ("dark", "#0b1224", "#1d2748", "#64748b", "#7f8de0", .38)):
  open(f"public/contour-{name}.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice"><defs>'
    f'<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{bg1}"/><stop offset="1" stop-color="{bg2}"/></linearGradient>'
    f'<linearGradient id="s" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{W}" y2="{H}"><stop offset="0" stop-color="{s1}"/><stop offset="1" stop-color="{s2}"/></linearGradient></defs>'
    f'<rect width="{W}" height="{H}" fill="url(#b)"/><path d="{path}" fill="none" stroke="url(#s)" stroke-opacity="{op}" stroke-width="1.3" stroke-linecap="round"/></svg>')
