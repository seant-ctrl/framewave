export type EasingName = 'linear' | 'ease-in-out' | 'ease-out-expo' | 'spring' | 'ease-out-cubic' | 'ease-in-out-quint'

// Spring-like curve with a small overshoot, normalized so f(0)=0 and f(1)=1.
const springRaw = (t: number): number => 1 - Math.pow(2, -8 * t) * Math.cos(t * 7.5 - 0.6) * 0.32 - Math.pow(2, -8 * t) * 0.68
const s0 = springRaw(0)
const s1 = springRaw(1)

export const easings: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  'ease-in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  'ease-out-expo': (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  'ease-out-cubic': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in-out-quint': (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  spring: (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return (springRaw(t) - s0) / (s1 - s0)
  }
}

export function ease(name: string, t: number): number {
  const fn = easings[name as EasingName] ?? easings['ease-in-out']
  return fn(Math.min(1, Math.max(0, t)))
}

/** Smoothstep between edges */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * Exponential smoothing that is frame-rate independent.
 * `halfLife` is the time (ms) for the value to move halfway to the target.
 */
export function expSmooth(current: number, target: number, dtMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return target
  const k = 1 - Math.pow(0.5, dtMs / halfLifeMs)
  return current + (target - current) * k
}

/** Second-order (spring-damper) smoother — gives natural acceleration and settling. */
export class SpringSmoother {
  x: number
  v = 0
  constructor(
    initial: number,
    public stiffness = 120,
    public damping = 22
  ) {
    this.x = initial
  }
  reset(x: number): void {
    this.x = x
    this.v = 0
  }
  step(target: number, dtMs: number): number {
    let dt = Math.min(dtMs, 100) / 1000
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
    dt /= steps
    for (let i = 0; i < steps; i++) {
      const a = this.stiffness * (target - this.x) - this.damping * this.v
      this.v += a * dt
      this.x += this.v * dt
    }
    return this.x
  }
}
