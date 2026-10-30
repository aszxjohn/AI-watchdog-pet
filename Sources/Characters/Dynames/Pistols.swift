import AppKit
import QuartzCore

/// Pistols's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class PistolsParts: ActParts {
    required init() {}
    var pistolBolts: [CALayer] = []
    var pistolFlashes: [CALayer] = [CALayer(), CALayer()]
    var pistolGN: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var pistolsParts: PistolsParts { parts(PistolsParts.self) }
    var pistolBolts: [CALayer] {
        get { pistolsParts.pistolBolts }
        set { pistolsParts.pistolBolts = newValue }
    }
    var pistolFlashes: [CALayer] { pistolsParts.pistolFlashes }
    var pistolGN: CAEmitterLayer { pistolsParts.pistolGN }

    // MARK: working — 舉槍 → 雙槍連射 (its own frames "pistol", timings, layers and particles; nothing shared)
    //
    // Frames (tools/build_units.py, from poses/pistol_rig_v11.json): 0–2 the arms coming up, 3 aim, 4 the right
    // gun's recoil, 5 the left gun's. Each frame's muzzles and gun directions are measured on the rig.

    enum Burst {
        static let raise = 0.45         // 舉槍: frames 0 → 3
        static let gap = 0.13           // between shots; the two guns take turns, right first
        static let shots = 12           // per burst
        static let pause = 0.9          // holding aim between bursts
        static var period: Double { Double(shots) * gap + pause }
        static let kick = 0.07          // a gun's recoil frame and muzzle flash last this long
        static let boltLife = 0.42
        static let aimFrame = 3
    }


    func buildPistols() {
        let pink = CGColor(red: 1, green: 0.32, blue: 0.75, alpha: 1)
        for _ in 0..<6 {
            let bolt = CALayer()
            bolt.anchorPoint = CGPoint(x: 0, y: 0.5)
            bolt.backgroundColor = pink
            bolt.shadowColor = pink
            bolt.shadowOpacity = 1
            bolt.shadowRadius = 4
            bolt.shadowOffset = .zero
            let core = CALayer()
            core.backgroundColor = CGColor(gray: 1, alpha: 0.95)
            bolt.addSublayer(core)
            bolt.opacity = 0
            root.addSublayer(bolt)
            pistolBolts.append(bolt)
        }
        for f in pistolFlashes {
            f.contents = Fx.dot(pink)
            f.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
            f.opacity = 0
            root.addSublayer(f)
        }
    }

    func hidePistols() {
        pistolGN.birthRate = 0
        for l in pistolBolts { l.opacity = 0 }
        for f in pistolFlashes { f.opacity = 0 }
    }

    func pistolFrame(t: Double) -> Int {
        if t < Burst.raise { return min(Burst.aimFrame, Int(t / Burst.raise * Double(Burst.aimFrame))) }
        let c = (t - Burst.raise).truncatingRemainder(dividingBy: Burst.period)
        let k = Int(c / Burst.gap)
        if k < Burst.shots && c - Double(k) * Burst.gap < Burst.kick { return Burst.aimFrame + 1 + k % 2 }
        return Burst.aimFrame
    }

    func updatePistols(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        let rig = unit.dy
        guard active, rig.pistolMuzzles.count > Burst.aimFrame + 2 else { hidePistols(); return }
        let anim = unit.anim(plan.anim)
        let t = max(0, now - trackStart)
        /// A gun's muzzle (root space) and pointing direction (y up) in one of the pose frames.
        func gun(_ g: Int, frame: Int, shift: CGPoint) -> (p: CGPoint, d: CGPoint) {
            let m = bodyPoint(rig.pistolMuzzles[frame][g], in: anim)
            let v = rig.pistolDirs[frame][g]
            let len = max(0.001, hypot(v.dx, v.dy))
            return (CGPoint(x: body.position.x + shift.x + m.x, y: body.position.y + shift.y + m.y),
                    CGPoint(x: v.dx / len, y: -v.dy / len))
        }
        for l in pistolBolts { l.opacity = 0 }
        for f in pistolFlashes { f.opacity = 0 }
        var firing: CGFloat = 0
        if t >= Burst.raise {
            let c = (t - Burst.raise).truncatingRemainder(dividingBy: Burst.period)
            let boltLen = unitHeight * 0.32, speed = unitHeight * 7.5, thick: CGFloat = 4.5
            var shift = offset
            for k in 0..<Burst.shots {
                let age = c - Double(k) * Burst.gap
                guard age >= 0, age < Burst.boltLife else { continue }
                let g = k % 2
                // The bolt leaves from where the gun points as it fires (its kick frame), so the gun on screen and
                // the shot it lets go always line up; each gun's bolts all fly on one straight line.
                let a = gun(g, frame: Burst.aimFrame + 1 + g, shift: offset)
                if age < Burst.kick {
                    // The whole unit jolts back a little with each shot, the gun's muzzle flashes.
                    let jolt = CGFloat(2.5 * (1 - age / Burst.kick))
                    shift = CGPoint(x: offset.x - a.d.x * jolt, y: offset.y - a.d.y * jolt)
                    let f = pistolFlashes[g]
                    f.position = a.p
                    let sc = 1.4 - 0.8 * CGFloat(age / Burst.kick)
                    f.transform = CATransform3DMakeScale(sc, sc, 1)
                    f.opacity = Float(1 - 0.5 * age / Burst.kick)
                }
                // A short pink bolt grows out of the muzzle and flies off along the gun, fading at the end.
                let bolt = pistolBolts[k % pistolBolts.count]
                let dist = CGFloat(age) * speed
                let len = min(boltLen, dist + 6)
                let tail = max(0, dist - len)
                let fadeFrom = Burst.boltLife * 0.6
                bolt.bounds = CGRect(x: 0, y: 0, width: len, height: thick)
                bolt.cornerRadius = thick / 2
                bolt.sublayers?.first?.frame = CGRect(x: len * 0.12, y: thick * 0.3, width: len * 0.82, height: thick * 0.4)
                bolt.position = CGPoint(x: a.p.x + a.d.x * tail, y: a.p.y + a.d.y * tail)
                bolt.transform = CATransform3DMakeRotation(atan2(a.d.y, a.d.x), 0, 0, 1)
                bolt.opacity = Float(age < fadeFrom ? 1 : 1 - (age - fadeFrom) / (Burst.boltLife - fadeFrom))
            }
            body.transform = CATransform3DMakeTranslation(shift.x, shift.y, 0)
            firing = c < Double(Burst.shots) * Burst.gap ? 1 : 0
        }
        if let core = rig.pistolCore { pistolGN.emitterPosition = bodyPoint(core, in: anim) }
        Fx.applyPistolGN(PistolGN.aim.mixed(with: PistolGN.firing, firing), to: pistolGN, active: true)
    }
}
