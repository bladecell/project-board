# Generates public/contour-{light,dark}.svg: topographic lines from a sum-of-sines height field.
import math, random, sys
W, H, STEP, LEVELS = 1600, 1000, 10, 16
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
d = []
for n in range(1, LEVELS):
  lv = lerp(lo, hi, n / LEVELS)
  d += [f"M{a[0]:.0f} {a[1]:.0f}L{b[0]:.0f} {b[1]:.0f}" for a, b in segs(lv)]
path = "".join(d)
for name, bg, stroke, op in (("light", "#f8fafc", "#94a3b8", .45), ("dark", "#0f172a", "#64748b", .35)):
  open(f"public/contour-{name}.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice"><rect width="{W}" height="{H}" fill="{bg}"/><path d="{path}" fill="none" stroke="{stroke}" stroke-opacity="{op}" stroke-width="1.2" stroke-linecap="round"/></svg>')
