import AppKit
import QuartzCore

/// Alarm's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class AlarmParts: ActParts {
    required init() {}
    var alarmRound: Int = -1
    var alarmHits: [PetNode.AlarmHit] = []
    var alarmSets: [[String: CALayer]] = []
    var alarmBlast: [String: CALayer] = [:]
    var alarmTape: CALayer = CALayer()
    var alarmGN: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var alarmParts: AlarmParts { parts(AlarmParts.self) }
    var alarmRound: Int {
        get { alarmParts.alarmRound }
        set { alarmParts.alarmRound = newValue }
    }
    var alarmHits: [PetNode.AlarmHit] {
        get { alarmParts.alarmHits }
        set { alarmParts.alarmHits = newValue }
    }
    var alarmSets: [[String: CALayer]] {
        get { alarmParts.alarmSets }
        set { alarmParts.alarmSets = newValue }
    }
    var alarmBlast: [String: CALayer] {
        get { alarmParts.alarmBlast }
        set { alarmParts.alarmBlast = newValue }
    }
    var alarmTape: CALayer { alarmParts.alarmTape }
    var alarmGN: CAEmitterLayer { alarmParts.alarmGN }

    // MARK: error (出錯了) — sealed off behind an ERROR tape, shaking under hit after hit until it blows
    //
    // The shield hold frames (shared hold mode, so this keys on the state). On the "glass" in front of it — not on the
    // unit, so it stays put while the unit shakes — one seal tape across its middle (units/<id>/alarm/, drawn by
    // build_units.py; an ERROR plate over its head was taken out at the user's word). Each round small hits land on
    // random body parts (Wars' glow, fireball and sparks), closer together and harder as the round goes on, with a
    // growing tremble, glitchy jumps and a deepening red glow, until a big blast; then it settles and the next round
    // starts. GN particles sputter out in 等你回覆's fan (back and to the right, never left). Its own layers and
    // timings; the opening hit (updateHit) is kept.

    enum Alarm {
        static let cycle = 6.0                 // seconds per round
        static let blast = 5.2                 // when in the round the big blast goes off
        static let calm = 0.8                  // seconds after the blast for it to settle
        static let first = 0.5                 // first hit of a round
        static let life = 0.35                 // seconds one hit's glow, fireball and sparks last
        static let pool = 6                    // hit effect sets (hits overlapping at once)
        /// Where hits land, × unitHeight from the shield core (a copy of 要你決定's body-part spots).
        static let spots: [CGPoint] = [
            CGPoint(x: -0.2, y: 0.28), CGPoint(x: -0.3, y: 0.13), CGPoint(x: 0.14, y: 0.26), CGPoint(x: 0.02, y: 0.38),
            CGPoint(x: -0.05, y: -0.05), CGPoint(x: -0.38, y: -0.05), CGPoint(x: -0.16, y: -0.36),
            CGPoint(x: -0.3, y: -0.25), CGPoint(x: 0.32, y: -0.16)]
        /// Effect sizes × unitHeight: a hit's glow, fireball and sparks; the blast's flash and fireball / sparks.
        static let size = (glow: 0.3, fire: 0.26, spark: 0.32, flash: 0.9, big: 0.7)
    }

    struct AlarmHit {
        let at: Double
        let spot: CGPoint
        let fire: String
        let side: CGFloat
        let turn: CGFloat
    }


    func buildAlarm() {
        guard let tape = unit.alarm["tape"] else { return }
        let h = unitHeight
        let k = h / 110 / 2                    // the picture is 2× its size at the default unit height
        alarmTape.contents = tape
        alarmTape.bounds = CGRect(x: 0, y: 0, width: CGFloat(tape.width) * k, height: CGFloat(tape.height) * k)
        alarmTape.opacity = 0
        root.addSublayer(alarmTape)
        func piece(_ name: String, _ size: Double) -> CALayer? {
            guard let img = unit.attack[name] else { return nil }
            let l = CALayer()
            l.contents = img
            let w = CGFloat(size) * h
            l.bounds = CGRect(x: 0, y: 0, width: w, height: w * CGFloat(img.height) / CGFloat(img.width))
            l.opacity = 0
            body.addSublayer(l)
            return l
        }
        let s = Alarm.size
        for _ in 0..<Alarm.pool {
            var set: [String: CALayer] = [:]
            for (name, size) in [("hitGlow", s.glow), ("fireA", s.fire), ("fireB", s.fire), ("fireC", s.fire), ("spark", s.spark)] {
                set[name] = piece(name, size)
            }
            alarmSets.append(set)
        }
        for (name, size) in [("flash", s.flash), ("fireC", s.big), ("sparkBig", s.big)] {
            alarmBlast[name] = piece(name, size)
        }
        Fx.configureAlarmGN(alarmGN, at: CGPoint(x: h * 0.02, y: h * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(alarmGN, at: 0)
    }

    func hideAlarm() {
        alarmTape.opacity = 0
        for set in alarmSets { for l in set.values { l.opacity = 0 } }
        for l in alarmBlast.values { l.opacity = 0 }
        alarmGN.birthRate = 0
    }

    /// Round `n`'s hits: closer together as the round goes on, each on a body part picked at random (not the same
    /// one twice running) — the same within a round, different every round.
    func alarmRoundHits(_ n: Int) -> [AlarmHit] {
        if n == alarmRound { return alarmHits }
        var hits: [AlarmHit] = []
        var t = Alarm.first
        var last = -1
        var i = 0
        while t < Alarm.blast - 0.15 {
            var s = Int(guardRandom(n, i, 11) * CGFloat(Alarm.spots.count)) % Alarm.spots.count
            if s == last { s = (s + 1) % Alarm.spots.count }
            last = s
            let p = Alarm.spots[s]
            hits.append(AlarmHit(at: t,
                                 spot: CGPoint(x: p.x + (guardRandom(n, i, 12) - 0.5) * 0.08,
                                               y: p.y + (guardRandom(n, i, 13) - 0.5) * 0.08),
                                 fire: ["fireA", "fireB", "fireC"][i % 3],
                                 side: guardRandom(n, i, 14) < 0.5 ? -1 : 1,
                                 turn: guardRandom(n, i, 15) * 2 * .pi))
            t += (0.55 - 0.42 * t / Alarm.blast) * Double(0.6 + 0.8 * guardRandom(n, i, 16))
            i += 1
        }
        alarmRound = n
        alarmHits = hits
        return hits
    }

    /// How worked up it is, 0…1: rising through the round to the blast, then dropping back.
    func alarmBuild(_ c: Double) -> CGFloat {
        if c < Alarm.blast { return CGFloat(pow(c / Alarm.blast, 1.6)) }
        return CGFloat(max(0, 1 - (c - Alarm.blast) / Alarm.calm))
    }

    /// The shaking: a tremble that grows through the round, a jolt from every hit, now and then a glitchy jump
    /// sideways, and a big shove at the blast. (dx, dy, lean)
    func alarmShake(now: CFTimeInterval) -> (CGFloat, CGFloat, CGFloat) {
        let t = max(0, now - trackStart)
        let n = Int(t / Alarm.cycle)
        let c = t - Double(n) * Alarm.cycle
        let b = alarmBuild(c)
        var dx = (1.2 + 3.5 * b) * CGFloat(0.6 * sin(now * 47) + 0.4 * sin(now * 83 + 1.3))
        var dy = (0.8 + 2.0 * b) * CGFloat(0.6 * sin(now * 59 + 0.5) + 0.4 * sin(now * 97))
        var lean = (0.5 + 1.5 * b) * .pi / 180 * CGFloat(sin(now * 37))
        for hit in alarmRoundHits(n) where c >= hit.at && c < hit.at + 0.15 {
            let k = CGFloat(1 - (c - hit.at) / 0.15)
            let hard = CGFloat(hit.at / Alarm.blast)
            dx += hit.side * (3 + 4 * hard) * k
            dy += (1 + 1.5 * hard) * k
            lean += hit.side * (1.5 + 2.5 * hard) * .pi / 180 * k
        }
        let slot = Int(now * 20)                // 0.05 s slots
        if guardRandom(slot, 0, 21) < 0.04 + 0.16 * b {
            dx += (guardRandom(slot, 0, 22) < 0.5 ? -1 : 1) * (5 + 4 * guardRandom(slot, 0, 23))
        }
        if c >= Alarm.blast && c < Alarm.blast + 0.3 {
            let k = CGFloat(1 - (c - Alarm.blast) / 0.3)
            dx += 9 * k * CGFloat(sin(now * 61))
            dy += 6 * k
        }
        return (dx, dy, lean)
    }

    func updateAlarm(now: CFTimeInterval, st: CFTimeInterval, active: Bool) {
        guard active, !unit.alarm.isEmpty else { hideAlarm(); return }
        let h = unitHeight
        let anim = unit.anim(plan.anim)
        let t = max(0, now - trackStart)
        let n = Int(t / Alarm.cycle)
        let c = t - Double(n) * Alarm.cycle
        let b = alarmBuild(c)
        let core = unit.dy.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        bubble.isHidden = true                  // the tape says it
        // The tape across its middle, flickering now and then like a bad screen and jumping a few points sideways.
        let slot = Int(now * 20)
        let jitter = guardRandom(slot, 1, 31) < 0.05 + 0.1 * b ? (guardRandom(slot, 1, 32) - 0.5) * 6 : 0
        alarmTape.position = CGPoint(x: body.position.x + core.x + jitter, y: body.position.y + core.y)
        alarmTape.opacity = guardRandom(slot, 1, 33) < 0.04 + 0.08 * b ? 0.35 : 0.95
        // Hits: a glow, a small fireball and sparks on the struck part.
        var flash: CGFloat = 0
        for set in alarmSets { for l in set.values { l.opacity = 0 } }
        for (i, hit) in alarmRoundHits(n).enumerated() where c >= hit.at && c < hit.at + Alarm.life {
            let e = CGFloat(c - hit.at)
            let set = alarmSets[i % alarmSets.count]
            let p = CGPoint(x: core.x + hit.spot.x * h, y: core.y + hit.spot.y * h)
            if let g = set["hitGlow"] {
                g.position = p
                let s = 0.6 + 0.8 * min(1, e / 0.06)
                g.transform = CATransform3DMakeScale(s, s, 1)
                g.opacity = Float(max(0, 1 - e / 0.22))
            }
            if let f = set[hit.fire] {
                f.position = p
                let s = 0.4 + 0.6 * min(1, e / 0.1)
                f.transform = CATransform3DMakeScale(s, s, 1)
                f.opacity = Float(max(0, 1 - max(0, e - 0.1) / 0.25))
            }
            if let sp = set["spark"] {
                sp.position = p
                let s = 0.5 + 0.7 * min(1, e / 0.12)
                sp.transform = CATransform3DScale(CATransform3DMakeRotation(hit.turn, 0, 0, 1), s, s, 1)
                sp.opacity = Float(max(0, 1 - e / 0.3))
            }
            flash = max(flash, max(0, 1 - e / 0.12))
        }
        // The blast at the end of the round: a white flash, a big fireball and sparks in its middle.
        let be = CGFloat(c - Alarm.blast)
        let blasting = be >= 0 && be < 0.7
        for (name, l) in alarmBlast {
            guard blasting else { l.opacity = 0; continue }
            l.position = core
            let flashPiece = name == "flash"
            let s = flashPiece ? 0.5 + 1.5 * min(1, be / 0.08) : 0.5 + 0.7 * min(1, be / 0.15)
            l.transform = CATransform3DMakeScale(s, s, 1)
            l.opacity = Float(max(0, 1 - be / (flashPiece ? 0.25 : 0.7)))
        }
        // A red glow over the unit that deepens as it builds and pulses with each hit; white at the blast.
        if st > 0.5 {
            let white = blasting && be < 0.12
            tint.backgroundColor = white ? CGColor(gray: 1, alpha: 1) : CGColor(red: 1, green: 0.15, blue: 0.1, alpha: 1)
            tint.opacity = white ? 0.7 : Float(0.1 + 0.12 * b + 0.15 * flash)
        }
        // GN particles sputtering: on and off in 0.1 s bursts, more often as it builds, gushing at hits and the blast.
        let on = guardRandom(slot / 2, 2, 41) < 0.55 + 0.3 * b
        alarmGN.birthRate = Float((on ? 0.6 + 0.6 * b : 0.12) + 1.5 * flash + (blasting && be < 0.3 ? 3 : 0))
    }
}
