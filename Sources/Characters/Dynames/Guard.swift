import AppKit
import QuartzCore

/// Guard's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class GuardParts: ActParts {
    required init() {}
    var guardRounds: [[String: CALayer]] = []
    var guardJet: CAEmitterLayer = CAEmitterLayer()
    var guardAura: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var guardParts: GuardParts { parts(GuardParts.self) }
    var guardRounds: [[String: CALayer]] {
        get { guardParts.guardRounds }
        set { guardParts.guardRounds = newValue }
    }
    var guardJet: CAEmitterLayer { guardParts.guardJet }
    var guardAura: CAEmitterLayer { guardParts.guardAura }

    // MARK: question (要你決定) — 支援防禦: stands, dashes forward leaning into a burst of GN particles, braces behind the
    // full shield; a volley of tracers sparks off it all over its face and each round shoves it back; then it boosts
    // forward again, opens the shield and settles back to standing where it began; looping. Frames are the shared
    // "shield" set; timings, rounds, sparks and particles are its own (G Generation Wars pieces in units/<id>/attack/).

    enum Guard {
        static let period = 5.4
        static let dash = 0.35...0.72       // stand → dash forward, leaning in (frames 0 → 3)
        static let brace = 0.72...1.1       // the shield closes (frames 3 → 7) and it holds
        static let boost = 3.05...3.5       // pushed back by the volley, it boosts forward again
        static let open = 3.5...3.9         // the shield opens (frames 11 → 14)
        static let home = 3.9...4.5         // slides back to where it stood, upright
        static let front: CGFloat = -0.26   // × unitHeight: how far forward (left) it braces
        static let lunge: CGFloat = -0.36   // × unitHeight: how far the boost carries it before it settles
        static let shove: CGFloat = 0.045   // × unitHeight: how far each round pushes it back
        static let lean: CGFloat = 0.3      // radians, tipped forward while dashing / boosting
        static let flight = 0.18
        /// Each round: when it lands (seconds into the cycle) and the angle it comes in at (degrees, + = from above).
        /// Where it lands is picked anew every loop from `spots` (see guardSpot), so the hits wander over the Gundam.
        static let volley: [(at: Double, angle: CGFloat)] = [
            (1.15, 6), (1.32, -8), (1.48, 12), (1.66, -4), (1.82, 9), (1.98, -10),
            (2.16, 4), (2.3, -6), (2.46, 10), (2.62, -2), (2.78, 8), (2.92, -9)]
        /// Parts of the braced Gundam a round can hit (× unitHeight from its middle, + = right / up; measured on the
        /// shield frame): head, left shoulder, upper shield, top of the shield, middle, left shield edge, legs,
        /// lower left, lower right shield.
        static let spots: [CGPoint] = [
            CGPoint(x: -0.2, y: 0.28), CGPoint(x: -0.3, y: 0.13), CGPoint(x: 0.14, y: 0.26), CGPoint(x: 0.02, y: 0.38),
            CGPoint(x: -0.05, y: -0.05), CGPoint(x: -0.38, y: -0.05), CGPoint(x: -0.16, y: -0.36),
            CGPoint(x: -0.3, y: -0.25), CGPoint(x: 0.32, y: -0.16)]
        /// While the volley lasts it keeps backing away (× unitHeight in all), each round adding a jolt.
        static let retreat: CGFloat = 0.5
    }

    /// A fixed pseudo-random number in 0..<1 for (loop, round, salt): the same within a loop, different every loop.
    func guardRandom(_ loop: Int, _ round: Int, _ salt: Int) -> CGFloat {
        var x = UInt64(truncatingIfNeeded: loop &* 73856093 ^ round &* 19349663 ^ salt &* 83492791) &+ 0x9E3779B97F4A7C15
        x = (x ^ (x >> 30)) &* 0xBF58476D1CE4E5B9
        x = (x ^ (x >> 27)) &* 0x94D049BB133111EB
        x ^= x >> 31
        return CGFloat(x % 10_000) / 10_000
    }

    /// Where round `i` of loop `loop` lands (× unitHeight from the Gundam's middle): a random part, never the same
    /// part twice in a row, nudged a little.
    func guardSpot(_ loop: Int, _ i: Int) -> CGPoint {
        let n = Guard.spots.count
        func pick(_ j: Int) -> Int { Int(guardRandom(loop, j, 1) * CGFloat(n)) % n }
        var k = pick(i)
        if i > 0 && k == pick(i - 1) { k = (k + 1 + Int(guardRandom(loop, i, 2) * CGFloat(n - 1))) % n }
        let s = Guard.spots[k]
        return CGPoint(x: s.x + (guardRandom(loop, i, 3) - 0.5) * 0.08, y: s.y + (guardRandom(loop, i, 4) - 0.5) * 0.08)
    }

    /// One set per round: the tracer and its glow, then the hit's glow and sparks.
    /// GN particles: a strong jet off the back while it dashes or boosts, and — while it is being hit — the slow fan
    /// trailing back and to the right from its middle that 等你回覆 has when it faces left (a copy of those values).

    func buildGuard() {
        let h = unitHeight
        let sizes: [String: CGFloat] = ["shell": 0.15, "shellGlow": 0.22, "hitGlow": 0.32, "spark": 0.36, "sparkBig": 0.42]
        for _ in Guard.volley {
            var set: [String: CALayer] = [:]
            for name in ["shellGlow", "shell", "hitGlow", "sparkBig", "spark"] {
                guard let img = unit.attack[name] else { continue }
                let l = CALayer()
                l.contents = img
                let w = (sizes[name] ?? 0.3) * h
                l.bounds = CGRect(x: 0, y: 0, width: w, height: w * CGFloat(img.height) / CGFloat(img.width))
                l.opacity = 0
                root.addSublayer(l)
                set[name] = l
            }
            guardRounds.append(set)
        }
        Fx.configureGuardJet(guardJet, unitHeight: h, image: unit.fx["glow_a"])
        root.insertSublayer(guardJet, below: body)
        Fx.configureGuardAura(guardAura, at: CGPoint(x: h * 0.02, y: h * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(guardAura, at: 0)
    }

    func hideGuard() {
        for set in guardRounds { for l in set.values { l.opacity = 0 } }
        guardJet.birthRate = 0
        guardAura.birthRate = 0
    }


    func guardFrame(t: Double) -> Int {
        let c = t.truncatingRemainder(dividingBy: Guard.period)
        if c < Guard.dash.lowerBound { return 0 }
        if c < Guard.dash.upperBound { return min(3, Int(ease(c, Guard.dash) * 4)) }
        if c < Guard.brace.upperBound { return min(7, 3 + Int(ease(c, Guard.brace) * 5)) }
        if c < Guard.open.lowerBound {
            // Braced: rocks slowly between frames 5 and 9.
            let k = Int((c - Guard.brace.upperBound) * 5) % 8
            return 5 + (k < 4 ? k : 8 - k)
        }
        if c < Guard.open.upperBound { return min(14, 11 + Int(ease(c, Guard.open) * 4)) }
        return 0
    }

    /// How far the volley has pushed it back (× unitHeight) at a time in the cycle: a steady retreat from the first
    /// round to just after the last, each round adding a quick extra shove that eases out again.
    func guardKnock(_ c: Double) -> CGFloat {
        guard let first = Guard.volley.first?.at, let last = Guard.volley.last?.at, c > first else { return 0 }
        var k = Guard.retreat * CGFloat(min(1, (c - first) / (last - first + 0.2)))
        for r in Guard.volley where c > r.at {
            let e = CGFloat(c - r.at)
            k += Guard.shove * min(1, e / 0.05) * max(0, 1 - e / 0.3)
        }
        return k
    }

    func updateGuard(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        guard active else { hideGuard(); return }
        let t = max(0, now - trackStart)
        let c = t.truncatingRemainder(dividingBy: Guard.period)
        let h = unitHeight
        let anim = unit.anim(plan.anim)
        // Where it is (× unitHeight from its spot) and how hard it is driving forward (0…1).
        let pushed = Guard.front + guardKnock(min(c, Guard.boost.lowerBound))
        var x: CGFloat = 0, drive: CGFloat = 0
        if c < Guard.dash.lowerBound {
            x = 0
        } else if c < Guard.dash.upperBound {
            x = Guard.front * ease(c, Guard.dash)
            drive = 1
        } else if c < Guard.boost.lowerBound {
            x = Guard.front + guardKnock(c)
        } else if c < Guard.boost.upperBound {
            // Boost: shoots forward past where it braced, then settles back onto it.
            let u = ease(c, Guard.boost)
            let mid = Guard.boost.lowerBound + (Guard.boost.upperBound - Guard.boost.lowerBound) * 0.6
            x = c < mid ? pushed + (Guard.lunge - pushed) * ease(c, Guard.boost.lowerBound...mid)
                        : Guard.lunge + (Guard.front - Guard.lunge) * ease(c, mid...Guard.boost.upperBound)
            drive = 1.4 * (1 - 0.5 * u)
        } else if c < Guard.home.lowerBound {
            x = Guard.front
        } else {
            x = Guard.front * (1 - ease(c, Guard.home))
        }
        let lean = Guard.lean * min(1, drive)
        // Each round lands with a jolt.
        var jolt: CGFloat = 0
        for set in guardRounds { for l in set.values { l.opacity = 0 } }
        let loop = Int(t / Guard.period)
        let core = unit.dy.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        for (i, r) in Guard.volley.enumerated() where i < guardRounds.count {
            let set = guardRounds[i]
            let age = c - r.at                   // < 0: in flight, ≥ 0: landed
            guard age >= -Guard.flight && age < 0.4 else { continue }
            // A random part of the Gundam, wherever it has been pushed to when the round lands.
            let sp = guardSpot(loop, i)
            let bx = Guard.front + guardKnock(r.at - 0.001)
            let hit = CGPoint(x: body.position.x + offset.x + bx * h + core.x + sp.x * h,
                              y: body.position.y + offset.y + core.y + sp.y * h)
            let a = (r.angle + (guardRandom(loop, i, 5) - 0.5) * 10) * .pi / 180
            let dir = CGPoint(x: cos(a), y: -sin(a))     // travelling right, from above when angle > 0
            if age < 0 {
                let dist = h * 2.6 * CGFloat(-age / Guard.flight)
                let q = CGPoint(x: hit.x - dir.x * dist, y: hit.y - dir.y * dist)
                let turn = CATransform3DMakeRotation(atan2(dir.y, dir.x) - .pi / 2, 0, 0, 1)
                set["shell"]?.position = q
                set["shell"]?.transform = CATransform3DScale(turn, 0.8, 1.7, 1)
                set["shell"]?.opacity = 1
                set["shellGlow"]?.position = CGPoint(x: q.x - dir.x * h * 0.07, y: q.y - dir.y * h * 0.07)
                set["shellGlow"]?.transform = CATransform3DScale(turn, 0.6, 2.4, 1)
                set["shellGlow"]?.opacity = 0.6
                continue
            }
            let e = CGFloat(age)
            // The glow where it struck, and sparks thrown back towards where it came from (left), fanning out.
            set["hitGlow"]?.position = hit
            let gs = 0.7 + 0.8 * min(1, e / 0.06)
            set["hitGlow"]?.transform = CATransform3DMakeScale(gs, gs, 1)
            set["hitGlow"]?.opacity = Float(max(0, 1 - e / 0.22))
            let back = atan2(-dir.y, -dir.x) - .pi / 2          // the spark fan's tips point up in its picture
            let big = i % 3 == 1
            if let l = set[big ? "sparkBig" : "spark"] {
                l.position = CGPoint(x: hit.x - dir.x * h * 0.04, y: hit.y - dir.y * h * 0.04)
                let ss = 0.5 + 0.8 * min(1, e / 0.12)
                l.transform = CATransform3DScale(CATransform3DMakeRotation(back, 0, 0, 1), ss, ss, 1)
                l.opacity = Float(max(0, 1 - e / 0.32))
            }
            jolt = max(jolt, 2.2 * max(0, 1 - e / 0.12))
        }
        // GN particles: the jet off the drive on its back while it drives forward…
        let drv = CGPoint(x: core.x + h * 0.24, y: core.y + h * 0.04)
        guardJet.emitterPosition = CGPoint(x: body.position.x + offset.x + x * h + drv.x * cos(lean) - drv.y * sin(lean),
                                           y: body.position.y + offset.y + drv.x * sin(lean) + drv.y * cos(lean))
        guardJet.setGuardDrive(drive, lean: lean)
        // …and whenever it is not driving forward (standing at the start and end, braced, being hit and backing away),
        // the slow fan trailing back and to the right (never left).
        Fx.applyGuardAura(GuardGN.braced, to: guardAura, active: drive == 0)
        body.transform = CATransform3DRotate(CATransform3DMakeTranslation(offset.x + x * h + jolt, offset.y, 0), lean, 0, 0, 1)
    }
}
