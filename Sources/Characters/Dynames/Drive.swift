import AppKit
import QuartzCore

/// Drive's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class DriveParts: ActParts {
    required init() {}
    var driveFlare: CALayer = CALayer()
    var driveCore: CALayer = CALayer()
    var driveGN: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var driveParts: DriveParts { parts(DriveParts.self) }
    var driveFlare: CALayer { driveParts.driveFlare }
    var driveCore: CALayer { driveParts.driveCore }
    var driveGN: CAEmitterLayer { driveParts.driveGN }

    // MARK: done (做完了) — turned away, GN particles pouring out of the GN drive on its back
    //
    // The "back" frame; the drive's glowing end is rig.driveAt. Its pieces are Wars' own GN effects (units/<id>/drive/):
    // a flare and faint green core breathing on the drive (the flare's middle see-through, so the drive shows), and an
    // emitter letting out dots, sparkles and soft puffs that spill outwards and sink, with a big gush as the state
    // starts. Its own layers and timings.

    enum Drive {
        static let gush = 0.9           // seconds of the opening gush
        static let pulse = 1.6          // seconds per breath of the glow
    }


    func buildDrive() {
        guard !unit.drive.isEmpty else { return }
        let h = unitHeight
        for (l, name, size) in [(driveFlare, "flare", h * 0.62), (driveCore, "core", h * 0.2)] {
            l.contents = unit.drive[name]
            l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
            l.opacity = 0
            body.addSublayer(l)
        }
        Fx.configureDriveGN(driveGN, images: unit.drive, unitHeight: h)
        body.addSublayer(driveGN)
    }

    func hideDrive() {
        driveFlare.opacity = 0
        driveCore.opacity = 0
        driveGN.birthRate = 0
    }

    func updateDrive(now: CFTimeInterval, active: Bool) {
        guard active, let at = unit.dy.driveAt, !unit.drive.isEmpty else { hideDrive(); return }
        let st = now - stateSince
        let p = bodyPoint(at, in: unit.anim(plan.anim))
        // Comes on with a flash and a gush, then breathes steadily. The flare's middle is see-through (made so at
        // build time) and the green core is faint, so the drive shows through the glow.
        let gush = CGFloat(max(0, 1 - st / Drive.gush))
        let breath = CGFloat(0.5 + 0.5 * sin(st * 2 * .pi / Drive.pulse))
        let on = CGFloat(min(1, st / 0.15))
        driveFlare.position = p
        let fs = (0.75 + 0.15 * breath + 0.7 * gush) * on
        driveFlare.transform = CATransform3DMakeScale(fs, fs, 1)
        driveFlare.opacity = Float(min(1, (0.4 + 0.2 * breath + 0.6 * gush) * on))
        driveCore.position = p
        let cs = 0.9 + 0.2 * breath
        driveCore.transform = CATransform3DMakeScale(cs, cs, 1)
        driveCore.opacity = Float((0.25 + 0.1 * breath) * on)
        driveGN.emitterPosition = p
        driveGN.birthRate = Float(on * (1 + 3 * gush))
        driveGN.velocity = Float(1 + 0.8 * gush)
    }
}
