import AppKit
import QuartzCore

/// The first sniping loop's layers (no state plays it now): beam, flash, impact, lock-on reticle.
final class AttackParts: ActParts {
    required init() {}
    var beam = CALayer()
    var beamGlow = CAGradientLayer()
    var beamCore = CALayer()
    var flash = CALayer()
    var impact = CALayer()
    var reticle = CAShapeLayer()
}

extension PetNode {
    var attackParts: AttackParts { parts(AttackParts.self) }
    var beam: CALayer { attackParts.beam }
    var beamGlow: CAGradientLayer { attackParts.beamGlow }
    var beamCore: CALayer { attackParts.beamCore }
    var flash: CALayer { attackParts.flash }
    var impact: CALayer { attackParts.impact }
    var reticle: CAShapeLayer { attackParts.reticle }

    func buildAttack() {
        // Beam: drawn from its left edge (the muzzle) along +x, then rotated to the barrel direction.
        beam.anchorPoint = CGPoint(x: 0, y: 0.5)
        beam.opacity = 0
        beamGlow.colors = [Hud.beam.copy(alpha: 0) ?? Hud.beam, Hud.beam, Hud.beam.copy(alpha: 0) ?? Hud.beam]
        beamGlow.startPoint = CGPoint(x: 0.5, y: 0)
        beamGlow.endPoint = CGPoint(x: 0.5, y: 1)
        beam.addSublayer(beamGlow)
        beamCore.backgroundColor = CGColor(gray: 1, alpha: 0.95)
        beam.addSublayer(beamCore)
        beam.shadowColor = Hud.beam
        beam.shadowOpacity = 0.9
        beam.shadowRadius = 4
        beam.shadowOffset = .zero
        if let img = unit.fx["beam"] {
            // The sheet's own beam sprite replaces the drawn glow + core.
            beam.contents = img
            beam.contentsGravity = .resize
            beamGlow.isHidden = true
            beamCore.isHidden = true
            beam.shadowOpacity = 0
        }
        root.addSublayer(beam)
        for (l, img, size) in [(flash, unit.fx["flash"], CGSize(width: 40, height: 27)),
                               (impact, unit.fx["orb"], CGSize(width: 24, height: 23))] {
            l.contents = img ?? Fx.dot(Hud.beamHot)
            l.bounds = CGRect(origin: .zero, size: size)
            l.opacity = 0
            root.addSublayer(l)
        }
        reticle.path = Hud.reticle(radius: 9)
        reticle.fillColor = nil
        reticle.lineWidth = 1.2
        reticle.strokeColor = Hud.green
        reticle.shadowColor = Hud.green
        reticle.shadowOpacity = 0.6
        reticle.shadowRadius = 2
        reticle.shadowOffset = .zero
        reticle.opacity = 0
        root.addSublayer(reticle)
    }

    // MARK: effects



    var beamLength: CGFloat { unitHeight * 0.45 }

    /// Where the muzzle and the beam's end are, in root space.
    func aim(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, end: CGPoint, angle: CGFloat) {
        let rig = unit.dy
        let local = bodyPoint(rig.muzzle, in: unit.anim(plan.anim))
        let r = rotate(local, lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let len = hypot(rig.aimDir.dx, rig.aimDir.dy)
        let d = rotate(CGPoint(x: rig.aimDir.dx / len, y: -rig.aimDir.dy / len), lean)
        let end = CGPoint(x: muzzle.x + d.x * beamLength, y: muzzle.y + d.y * beamLength)
        return (muzzle, end, atan2(d.y, d.x))
    }

    /// Sniping loop: GN particles gather at the muzzle, then flash, beam, impact and recoil.
    func updateSniping(active: Bool, now: CFTimeInterval, offset: CGPoint, lean: CGFloat) {
        guard active else {
            charge.birthRate = 0
            beam.opacity = 0
            flash.opacity = 0
            impact.opacity = 0
            if !(plan.hit && now - stateSince < 0.5) { halo.opacity = 0 }
            return
        }
        let cycle = 1.9
        let t = now - trackStart - 0.35
        let p = t < 0 ? -1 : t.truncatingRemainder(dividingBy: cycle)
        let fire = p - 0.55
        var recoil: CGFloat = 0
        if fire >= 0 { recoil = 6 * CGFloat(exp(-fire * 10)) }
        let a = aim(offset: CGPoint(x: offset.x + recoil, y: offset.y), lean: lean)

        charge.emitterPosition = bodyPoint(unit.dy.muzzle, in: unit.anim(plan.anim))
        charge.birthRate = (p >= 0 && p < 0.55) ? 1 : 0
        if recoil > 0 {
            body.transform = CATransform3DRotate(
                CATransform3DMakeTranslation(offset.x + recoil, offset.y, 0), lean, 0, 0, 1)
        }

        if fire >= 0 && fire < 0.42 {
            let grow = CGFloat(min(1, fire / 0.05))
            let fade = fire < 0.12 ? 1 : max(0, 1 - (fire - 0.12) / 0.26)
            let thick: CGFloat = (beamGlow.isHidden ? 12 : 7) * CGFloat(max(0.35, 1 - fire * 2))
            let len = beamLength * grow
            beam.bounds = CGRect(x: 0, y: 0, width: len, height: thick)
            beamGlow.frame = beam.bounds
            beamCore.frame = CGRect(x: 0, y: thick / 2 - 0.8, width: len, height: 1.6)
            beam.position = a.muzzle
            beam.transform = CATransform3DMakeRotation(a.angle, 0, 0, 1)
            beam.opacity = Float(fade)

            flash.position = a.muzzle
            let fl = fire < 0.08 ? 1 : max(0, 1 - (fire - 0.08) / 0.12)
            flash.opacity = Float(fl)
            flash.transform = CATransform3DMakeScale(CGFloat(0.7 + fire * 5), CGFloat(0.7 + fire * 5), 1)

            impact.position = a.end
            impact.opacity = fire > 0.04 && fire < 0.3 ? Float(1 - (fire - 0.04) / 0.26) : 0
            impact.transform = CATransform3DMakeScale(CGFloat(0.6 + fire * 4), CGFloat(0.6 + fire * 4), 1)
            halo.position = a.end
            halo.opacity = fire > 0.06 ? Float(max(0, 0.8 - (fire - 0.06) * 2.4)) : 0
            let hs = CGFloat(0.5 + fire * 3)
            halo.transform = CATransform3DMakeScale(hs, hs, 1)
        } else {
            beam.opacity = 0
            flash.opacity = 0
            impact.opacity = 0
            halo.opacity = 0
        }

        reticle.position = a.end
        let locked = fire >= -0.25 && fire < 0.42
        reticle.strokeColor = locked ? Hud.orange : Hud.green
        reticle.shadowColor = reticle.strokeColor
        let pulse: CGFloat = fire >= 0 && fire < 0.15 ? 1 + CGFloat(0.15 - fire) * 3 : 1
        reticle.transform = CATransform3DMakeScale(pulse, pulse, 1)
        reticle.opacity = 0.95
    }
}
