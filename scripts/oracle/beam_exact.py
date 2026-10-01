"""
Independent exact (rational-arithmetic) Euler-Bernoulli beam solver used to
cross-check hand-derived closed-form benchmark values.

Method: singularity (Macaulay) functions with unknown reactions, unknown hinge
rotation jumps and two integration constants, solved as one linear system.

Conventions (internal):
  x  : from left end, metres
  forces: +up (kN); distributed load w: +up (kN/m)
  applied couples: +clockwise (kN*m)  -> positive jump in M(x)
  V(x) = sum of upward forces left of section (Hibbeler/Gere positive shear)
  M(x) : + sagging
  EI v'' = M,  v +up
"""
from fractions import Fraction as F
import math

def mac(x, a, n):
    """Macaulay bracket <x-a>^n (n>=0); <x-a>^0 = 1 for x>=a (right-continuous)."""
    if x < a:
        return 0
    if n == 0:
        return 1
    return (x - a) ** n

class Beam:
    def __init__(self, L):
        self.L = F(L)
        self.supports = []   # (x, kind) kind in pin, roller, fixed, spring(k)
        self.hinges = []
        self.point_forces = []   # (x, Fy_up)
        self.couples = []        # (x, C_cw)
        self.dist = []           # (a, b, w1_up, w2_up)

    # --- singularity term lists for M(x) of known loads: list of (coef, a, n)
    def known_M_terms(self):
        t = []
        for (a, P) in self.point_forces:
            t.append((F(P), F(a), 1))
        for (c, C) in self.couples:
            t.append((F(C), F(c), 0))
        for (a, b, w1, w2) in self.dist:
            a, b, w1, w2 = F(a), F(b), F(w1), F(w2)
            k = (w2 - w1) / (b - a)
            t += [(w1 / 2, a, 2), (k / 6, a, 3), (-w2 / 2, b, 2), (-k / 6, b, 3)]
        return t

    def solve(self):
        # unknowns: for each support: Ry (all), Mcw (fixed only); hinge jumps H=EI*dtheta; C1, C2
        unk = []
        for i, (x, kind) in enumerate(self.supports):
            unk.append(('R', i, F(x)))
            if kind == 'fixed':
                unk.append(('Mr', i, F(x)))
        for j, h in enumerate(self.hinges):
            unk.append(('H', j, F(h)))
        unk.append(('C1',)); unk.append(('C2',))
        n = len(unk)
        Mk = self.known_M_terms()
        L = self.L

        def int_terms(terms, times):
            out = []
            for (c, a, m) in terms:
                cc, mm = c, m
                for _ in range(times):
                    mm += 1
                    cc = cc / mm
                out.append((cc, a, mm))
            return out

        def ev(terms, x):
            return sum((c * mac(x, a, m) for (c, a, m) in terms), F(0))

        # per-unknown contribution to M, EIv', EIv as term lists
        def unk_terms(u, which):
            # which: 'V','M','th','v'
            kind = u[0]
            if kind == 'R':
                a = u[2]; base = [(F(1), a, 1)]  # in M
                if which == 'V': return [(F(1), a, 0)]
            elif kind == 'Mr':
                a = u[2]; base = [(F(1), a, 0)]
                if which == 'V': return []
            elif kind == 'H':
                a = u[2]
                if which in ('V', 'M'): return []
                if which == 'th': return [(F(1), a, 0)]
                if which == 'v': return [(F(1), a, 1)]
            elif kind == 'C1':
                if which in ('V', 'M'): return []
                if which == 'th': return [(F(1), F(-1), 0)]  # constant 1
                if which == 'v': return [(F(1), F(0), 1)]    # x
            elif kind == 'C2':
                if which in ('V', 'M', 'th'): return []
                if which == 'v': return [(F(1), F(-1), 0)]
            if which == 'M': return base
            if which == 'th': return int_terms(base, 1)
            if which == 'v': return int_terms(base, 2)

        def known(which):
            if which == 'V':
                return [(c * m, a, m - 1) for (c, a, m) in Mk if m >= 1]
            if which == 'M': return Mk
            if which == 'th': return int_terms(Mk, 1)
            if which == 'v': return int_terms(Mk, 2)

        rows, rhs = [], []
        def add_eq(which, x):
            row = [ev(unk_terms(u, which), x) for u in unk]
            rows.append(row); rhs.append(-ev(known(which), x))
        Lp = L + F(1, 10**9)  # just beyond right end: V=0, M=0 (free body equilibrium)
        add_eq('V', Lp); add_eq('M', Lp)
        for h in self.hinges:
            add_eq('M', F(h))
        for (x, kind) in self.supports:
            if isinstance(kind, tuple) and kind[0] == 'spring':
                pass
            else:
                add_eq('v', F(x))
            if kind == 'fixed':
                add_eq('th', F(x))
        # springs: R = -k * v/EI*... handled by caller-free: not used here
        assert len(rows) == n, (len(rows), n)
        sol = gauss(rows, rhs)
        self.unk = unk; self.sol = sol
        self.terms = {}
        for which in ('V', 'M', 'th', 'v'):
            tl = list(known(which))
            for u, s in zip(unk, sol):
                tl += [(c * s, a, m) for (c, a, m) in unk_terms(u, which)]
            self.terms[which] = tl
        self.ev = ev
        return dict(((u[0], u[1]) if len(u) > 1 else (u[0],), s) for u, s in zip(unk, sol))

    def V(self, x): return self.ev(self.terms['V'], F(x))
    def M(self, x): return self.ev(self.terms['M'], F(x))
    def EIth(self, x): return self.ev(self.terms['th'], F(x))
    def EIv(self, x): return self.ev(self.terms['v'], F(x))


def gauss(A, b):
    n = len(A)
    M = [list(map(F, r)) + [F(bb)] for r, bb in zip(A, b)]
    for c in range(n):
        p = next((r for r in range(c, n) if M[r][c] != 0), None)
        if p is None:
            raise ValueError('singular system: unstable / mechanism')
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c and M[r][c] != 0:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def extremes(beam, fn, N=24000):
    """Dense sampling + golden refinement of max and min of fn on [0,L], incl. one-sided limits."""
    L = float(beam.L)
    xs = [L * i / N for i in range(N + 1)]
    vals = [float(fn(F(x).limit_denominator(10**12))) for x in xs]
    best = {}
    for kind, sel in (('max', max), ('min', min)):
        i = (vals.index(sel(vals)))
        # local refine by ternary search
        lo = xs[max(i - 1, 0)]; hi = xs[min(i + 1, N)]
        for _ in range(100):
            m1 = lo + (hi - lo) / 3; m2 = hi - (hi - lo) / 3
            f1 = float(fn(F(m1))); f2 = float(fn(F(m2)))
            if (f1 < f2) == (kind == 'max'):
                lo = m1
            else:
                hi = m2
        xm = (lo + hi) / 2
        best[kind] = (xm, float(fn(F(xm))))
    return best
