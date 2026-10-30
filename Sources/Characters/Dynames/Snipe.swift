import AppKit
import QuartzCore

/// Snipe's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class SnipeParts: ActParts {
    required init() {}
    var snipeGN: CAEmitterLayer = CAEmitterLayer()
    var chargeGlow: CALayer = CALayer()
    var pinkBeam: CALayer = CALayer()
    var pinkBeamGlow: CAGradientLayer = CAGradientLayer()
    var pinkBeamCore: CALayer = CALayer()
    var pinkFlare: CALayer = CALayer()
}

extension PetNode {
    var snipeParts: SnipeParts { parts(SnipeParts.self) }
    var snipeGN: CAEmitterLayer { snipeParts.snipeGN }
    var chargeGlow: CALayer { snipeParts.chargeGlow }
    var pinkBeam: CALayer { snipeParts.pinkBeam }
    var pinkBeamGlow: CAGradientLayer { snipeParts.pinkBeamGlow }
    var pinkBeamCore: CALayer { snipeParts.pinkBeamCore }
    var pinkFlare: CALayer { snipeParts.pinkFlare }

    // MARK: thinking — 狙擊準備 → 瞄準 → 射擊 (its own timings, values and layers; nothing here is shared)
    //
    // The whole cycle holds the World-parts sniping pose "snipe" (poses/snipe_aim_v2.json, one frame). The unit
    // only moves as one piece (the shot's recoil), so nothing can come apart.

    enum Cycle {
        static let ready = 2.8      // 狙擊準備: holding aim, reticle searching
        static let aiming = 2.0     // 瞄準: the cockpit cut-in
        static let firing = 1.4     // 射擊: pink charge at the muzzle, thick pink beam, recoil
        static var period: Double { ready + aiming + firing }
        static let chargeFrom = 0.08
        static let shotAt = 0.42    // seconds into 射擊 when the beam leaves
        static let beamHold = 0.3   // full-thickness beam…
        static let beamFade = 0.3   // …then it thins out
    }

    enum CyclePhase { case ready(Double), aiming(Double), firing(Double) }

    func cyclePhase(_ t: Double) -> CyclePhase {
        let c = t.truncatingRemainder(dividingBy: Cycle.period)
        if c < Cycle.ready { return .ready(c) }
        if c < Cycle.ready + Cycle.aiming { return .aiming(c - Cycle.ready) }
        return .firing(c - Cycle.ready - Cycle.aiming)
    }

    func cycleFrame(_ a: Anim, t: Double) -> (String, Int) {
        (plan.anim, 0)
    }

    var boltRange: CGFloat { unitHeight * 1.75 }

    /// The thinking state's own GN particles and beam (separate from the other states').

    func buildPinkBeam() {
        let pink = CGColor(red: 1, green: 0.32, blue: 0.75, alpha: 1)
        pinkBeam.anchorPoint = CGPoint(x: 0, y: 0.5)
        pinkBeamGlow.colors = [pink.copy(alpha: 0) ?? pink, pink, CGColor(red: 1, green: 0.85, blue: 0.95, alpha: 1),
                               pink, pink.copy(alpha: 0) ?? pink]
        pinkBeamGlow.locations = [0, 0.18, 0.5, 0.82, 1]
        pinkBeamGlow.startPoint = CGPoint(x: 0.5, y: 0)
        pinkBeamGlow.endPoint = CGPoint(x: 0.5, y: 1)
        pinkBeam.addSublayer(pinkBeamGlow)
        pinkBeamCore.backgroundColor = CGColor(gray: 1, alpha: 0.95)
        pinkBeam.addSublayer(pinkBeamCore)
        pinkBeam.shadowColor = pink
        pinkBeam.shadowOpacity = 0.9
        pinkBeam.shadowRadius = 5
        pinkBeam.shadowOffset = .zero
        pinkBeam.opacity = 0
        root.addSublayer(pinkBeam)
        for (l, size) in [(chargeGlow, 26.0), (pinkFlare, 46.0)] {
            l.contents = Fx.dot(pink)
            l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
            l.opacity = 0
            root.addSublayer(l)
        }
    }

    func hideThinking() {
        floatLock?.hide()
        snipeGN.birthRate = 0
        chargeGlow.opacity = 0
        pinkFlare.opacity = 0
        pinkBeam.opacity = 0
    }

    /// Muzzle (root space) and barrel direction (y up) of the thinking pose, with the body moved by `offset`
    /// and turned by `lean` radians around its pinned point.
    func firePoint(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, dir: CGPoint) {
        let rig = unit.dy
        let anim = unit.anim(rig.fireAnim)
        let px = rig.snipeMuzzle ?? rig.muzzle
        let dv = rig.snipeDir ?? rig.aimDir
        let r = rotate(bodyPoint(px, in: anim), lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let len = max(0.001, hypot(dv.dx, dv.dy))
        return (muzzle, rotate(CGPoint(x: dv.dx / len, y: -dv.dy / len), lean))
    }

    func updateCycle(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        guard active else { hideThinking(); return }
        let t = max(0, now - trackStart)
        let rest = firePoint(offset: offset, lean: 0)
        // The target sits along the barrel, high enough that the whole locked reticle stays above the window's
        // bottom edge (root.position.y below the pinned point).
        let lockedSize = floatLock?.extent(closeIn: 1) ?? 12
        let floor = -root.position.y + 2 + lockedSize
        let reach = min(boltRange * 0.75, max(20, (rest.muzzle.y - floor) / max(0.2, -rest.dir.y)))
        let aimPoint = CGPoint(x: rest.muzzle.x + rest.dir.x * reach, y: rest.muzzle.y + rest.dir.y * reach)
        // The name tag slides right (easing in as the state starts) so it clears the locked symbol; changing
        // state puts it back (refreshLabel).
        let clear = max(0, aimPoint.x + lockedSize + 4 + tag.bounds.width / 2)
        tag.position.x = clear * progress(t, 0...0.4)

        let hasCutin = !unit.cutin.isEmpty
        let phase = cyclePhase(t)
        switch phase {
        case .aiming(let c) where hasCutin:
            updateCutin(c)
        case .firing(let c) where hasCutin && c < 0.25:
            closeCutin(c)
        default:
            hideCutin()
        }

        var shotLevel: CGFloat = 0
        chargeGlow.opacity = 0
        pinkFlare.opacity = 0
        pinkBeam.opacity = 0
        charge.birthRate = 0

        switch phase {
        case .ready(let c):
            // Searching (spread out, diamond turning) in the open space left of the muzzle, where the whole
            // symbol fits; in the last 0.8 s it slides onto the target and starts closing in.
            let a = CGFloat(now * 1.3)
            let search = CGPoint(x: aimPoint.x - 16 + cos(a) * 16, y: aimPoint.y + 32 + sin(a * 1.4) * 8)
            let settle = progress(c, (Cycle.ready - 0.8)...Cycle.ready)
            let p = CGPoint(x: search.x + (aimPoint.x - search.x) * settle, y: search.y + (aimPoint.y - search.y) * settle)
            let closeIn = (0.15 + 0.15 * CGFloat(sin(now * 2))) * (1 - settle) + 0.8 * settle
            floatAim(p, closeIn: closeIn, t: now, flash: 1, alpha: c < 0.25 ? Float(c / 0.25) * 0.95 : 0.95)

        case .aiming:
            floatAim(aimPoint, closeIn: 1, t: now, flash: 1, alpha: hasCutin ? 0 : 0.95)

        case .firing(let c):
            let shot = c - Cycle.shotAt
            // Recoil: the whole unit is shoved back along the barrel and its muzzle kicks up, then settles.
            var kick: CGFloat = 0, turn: CGFloat = 0
            if shot >= 0 {
                let k = CGFloat(exp(-shot * 7))
                kick = 9 * k
                turn = -0.07 * k * (rest.dir.x < 0 ? 1 : -1)
            }
            let off = CGPoint(x: offset.x - rest.dir.x * kick, y: offset.y - rest.dir.y * kick)
            body.transform = CATransform3DRotate(CATransform3DMakeTranslation(off.x, off.y, 0), turn, 0, 0, 1)
            let m = firePoint(offset: off, lean: turn)
            if shot >= 0 { shotLevel = CGFloat(exp(-shot * 4)) }

            if c >= Cycle.chargeFrom && shot < 0 {
                // Pink light gathers at the muzzle.
                let p = CGFloat((c - Cycle.chargeFrom) / (Cycle.shotAt - Cycle.chargeFrom))
                chargeGlow.position = m.muzzle
                let sc = 0.4 + 0.9 * p
                chargeGlow.transform = CATransform3DMakeScale(sc, sc, 1)
                chargeGlow.opacity = Float(0.4 + 0.6 * p)
                charge.emitterPosition = bodyPoint(unit.dy.snipeMuzzle ?? unit.dy.muzzle, in: unit.anim(unit.dy.fireAnim))
                charge.birthRate = 1
            }
            let life = Cycle.beamHold + Cycle.beamFade
            if shot >= 0 && shot < life {
                // A thick pink beam from the muzzle, following it through the kick, then thinning out.
                let len = boltRange * CGFloat(min(1, shot / 0.06))
                let fade = shot < Cycle.beamHold ? 1 : CGFloat(1 - (shot - Cycle.beamHold) / Cycle.beamFade)
                let thick = (5 + 15 * fade) * (1 + 0.08 * CGFloat(sin(now * 70)))
                pinkBeam.bounds = CGRect(x: 0, y: 0, width: len, height: thick)
                pinkBeamGlow.frame = pinkBeam.bounds
                pinkBeamCore.frame = CGRect(x: 0, y: thick / 2 - thick * 0.17, width: len, height: thick * 0.34)
                pinkBeamCore.cornerRadius = thick * 0.17
                pinkBeam.position = m.muzzle
                pinkBeam.transform = CATransform3DMakeRotation(atan2(m.dir.y, m.dir.x), 0, 0, 1)
                pinkBeam.opacity = Float(fade)
                pinkFlare.position = m.muzzle
                let fs = 1.3 - 0.6 * CGFloat(min(1, shot / life))
                pinkFlare.transform = CATransform3DMakeScale(fs, fs, 1)
                pinkFlare.opacity = Float(shot < 0.08 ? 1 : max(0, fade * 0.8))
            }
            let pulse: CGFloat = shot >= 0 && shot < 0.2 ? 1 + CGFloat(0.2 - shot) * 2.5 : 1
            // Rides the recoil with the barrel, so the beam keeps going through its centre.
            let onBeam = CGPoint(x: m.muzzle.x + m.dir.x * reach, y: m.muzzle.y + m.dir.y * reach)
            floatAim(onBeam, closeIn: 1, t: now, flash: pulse,
                     alpha: shot > 0.5 ? Float(max(0, 1 - (shot - 0.5) / 0.3)) : 0.95)
        }

        // GN particles from the body centre (behind the torso): the slow backward fan while holding, a ring
        // bursting out with the shot.
        if let core = unit.dy.snipeCore { snipeGN.emitterPosition = bodyPoint(core, in: unit.anim(unit.dy.fireAnim)) }
        Fx.applySnipeGN(SnipeGN.ready.mixed(with: SnipeGN.shot, shotLevel), to: snipeGN, active: true)
    }

    /// The floating lock-on reticle: the cut-in's own (LockHud) when this unit has one, else the plain ring.
    func floatAim(_ p: CGPoint, closeIn: CGFloat, t: Double, flash: CGFloat, alpha: Float) {
        if let lock = floatLock {
            reticle.opacity = 0
            lock.layout(at: p, closeIn: closeIn, spin: t, flash: flash, alpha: alpha)
            return
        }
        reticle.position = p
        reticle.strokeColor = closeIn >= 1 ? Hud.orange : Hud.green
        reticle.shadowColor = reticle.strokeColor
        reticle.transform = CATransform3DMakeScale(flash, flash, 1)
        reticle.opacity = alpha
    }
}
