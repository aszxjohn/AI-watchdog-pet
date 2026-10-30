import AppKit
import QuartzCore

/// The thinking state's own GN particle looks (values started from 等你回覆's 面向左邊, kept separate so
/// tuning one never moves the other).
/// 要你決定's own GN particle look while it is being hit: the same values as 等你回覆's 面向左邊 (DriftLook.facingLeft),
/// copied so tuning either never moves the other — a slow fan trailing back and to the right, nothing going left.
enum GuardGN {
    static let braced = DriftLook(range: 2.6, longitude: 0.1, velocity: 40, yAccel: 2, xAccel: 14,
                                  rate: 2.4, speed: 1, halo: 0)
}

/// The working state's own GN particle looks (started from 思考中's, kept separate).
enum PistolGN {
    /// Holding aim: a fan trailing back and to the right.
    static let aim = DriftLook(range: 2.6, longitude: 0.1, velocity: 48, yAccel: 2, xAccel: 16,
                               rate: 3.2, speed: 1, halo: 0)
    /// Firing: the fan pushed harder backwards.
    static let firing = DriftLook(range: 2.2, longitude: 0.05, velocity: 80, yAccel: 0, xAccel: 26,
                                  rate: 5, speed: 1, halo: 0)
}

enum SnipeGN {
    /// Holding the rifle: a wide, dense fan trailing back and to the right.
    static let ready = DriftLook(range: 3.0, longitude: 0.1, velocity: 58, yAccel: 2, xAccel: 16,
                                 rate: 4.2, speed: 1, halo: 0)
    /// The shot: a ring bursting out all round, fading back into the fan.
    static let shot = DriftLook(range: .pi * 2, longitude: 0, velocity: 110, yAccel: 0, xAccel: 0,
                                rate: 8, speed: 1, halo: 0)
}

extension Fx {
    static func configureIdle(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let drift = CAEmitterCell()
        drift.name = "drift"
        drift.contents = image ?? white
        drift.birthRate = 30
        drift.lifetime = 2.0
        drift.lifetimeRange = 0.5
        drift.velocityRange = 8
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.12
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.45
        drift.spin = 1
        drift.spinRange = 2
        drift.color = Hud.gnParticle

        let halo = CAEmitterCell()
        halo.name = "halo"
        halo.contents = image ?? white
        halo.lifetime = 1.6
        halo.lifetimeRange = 0.4
        halo.velocity = 38
        halo.velocityRange = 8
        halo.emissionRange = .pi * 2
        halo.scale = image == nil ? 0.18 : 0.36
        halo.scaleRange = 0.1
        halo.scaleSpeed = -0.1
        halo.alphaRange = 0.3
        halo.alphaSpeed = -0.55
        halo.spin = 1
        halo.spinRange = 2
        halo.color = Hud.gnParticle

        e.emitterCells = [drift, halo]
        e.emitterPosition = p
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 12, height: 12)
        e.renderMode = .additive
        apply(.facingLeft, to: e, active: false)
    }
    static func apply(_ look: DriftLook, to e: CAEmitterLayer, active: Bool) {
        e.setValue(look.range, forKeyPath: "emitterCells.drift.emissionRange")
        e.setValue(look.longitude, forKeyPath: "emitterCells.drift.emissionLongitude")
        e.setValue(look.velocity, forKeyPath: "emitterCells.drift.velocity")
        e.setValue(look.yAccel, forKeyPath: "emitterCells.drift.yAcceleration")
        e.setValue(look.xAccel, forKeyPath: "emitterCells.drift.xAcceleration")
        e.setValue(look.xAccel * 0.8, forKeyPath: "emitterCells.halo.xAcceleration")
        e.setValue(10 * look.halo, forKeyPath: "emitterCells.halo.birthRate")
        e.velocity = Float(look.speed)
        e.birthRate = active ? Float(look.rate) : 0
    }
    /// A dense jet from the drive straight back; every particle shrinks to nothing on the way,
    /// so the stream narrows to a point behind the unit.
    static func configureJet(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let cell = CAEmitterCell()
        cell.contents = image ?? white
        cell.birthRate = 110
        cell.lifetime = 0.7
        cell.velocity = 150
        cell.velocityRange = 10
        cell.emissionLongitude = 0.15
        cell.emissionRange = 0.07
        cell.scale = image == nil ? 0.4 : 0.8
        cell.scaleSpeed = -1.1
        cell.alphaSpeed = -1.0
        cell.color = CGColor(red: 0.5, green: 1, blue: 0.6, alpha: 1)
        e.emitterCells = [cell]
        e.emitterPosition = p
        e.emitterShape = .point
        e.renderMode = .additive
        e.birthRate = 0
    }
    /// Small glints gathering at the muzzle before a shot.
    static func configureCharge(_ e: CAEmitterLayer, image: CGImage?) {
        let cell = CAEmitterCell()
        cell.contents = image ?? white
        cell.birthRate = 45
        cell.lifetime = 0.35
        cell.velocity = 8
        cell.emissionRange = .pi * 2
        cell.scale = image == nil ? 0.16 : 0.35
        cell.scaleSpeed = -0.3
        cell.alphaSpeed = -2
        cell.color = image == nil ? Hud.green : CGColor(gray: 1, alpha: 1)
        cell.spin = 2
        cell.spinRange = 4
        e.emitterCells = [cell]
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 14, height: 14)
        e.renderMode = .additive
        e.birthRate = 0
    }
    /// Thinking state's GN particles: same kind of drift cell as the waiting state's, on its own layer.
    static func configureSnipeGN(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let drift = CAEmitterCell()
        drift.name = "drift"
        drift.contents = image ?? white
        drift.birthRate = 30
        drift.lifetime = 2.4
        drift.lifetimeRange = 0.6
        drift.velocityRange = 18
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.12
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.4
        drift.spin = 1
        drift.spinRange = 2
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterPosition = p
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 34, height: 34)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// Working state's GN particles: a copy of the thinking state's drift cell, on its own layer.
    /// 做完了's GN particles out of the drive (Wars' own pieces): many small dots, a few turning sparkles and soft puffs,
    /// spilling out all round from the drive and sinking as they fade.
    static func configureDriveGN(_ e: CAEmitterLayer, images: [String: CGImage], unitHeight h: CGFloat) {
        func cell(_ name: String, rate: Float, life: Float, v: CGFloat, scale: CGFloat, fade: Float) -> CAEmitterCell {
            let c = CAEmitterCell()
            c.name = name
            c.contents = images[name] ?? white
            c.birthRate = rate
            c.lifetime = life
            c.lifetimeRange = life * 0.3
            c.velocity = v
            c.velocityRange = v * 0.6
            c.emissionRange = .pi * 2
            c.yAcceleration = -h * 0.32
            c.scale = scale
            c.scaleRange = scale * 0.4
            c.scaleSpeed = -scale * 0.35
            c.alphaSpeed = fade
            return c
        }
        let dot = cell("dot", rate: 90, life: 1.9, v: h * 0.5, scale: h * 0.016, fade: -0.5)
        dot.color = CGColor(gray: 1, alpha: 0.75)
        let star = cell("star", rate: 14, life: 1.2, v: h * 0.42, scale: h * 0.009, fade: -0.8)
        star.spin = 2
        star.spinRange = 4
        let puff = cell("puff", rate: 6, life: 1.6, v: h * 0.3, scale: h * 0.014, fade: -0.55)
        puff.color = CGColor(gray: 1, alpha: 0.4)
        e.emitterCells = [puff, dot, star]
        e.emitterShape = .circle
        // Spread over the drive (not one point) and blended normally, not added up: where many overlap at the
        // drive they stay a see-through green instead of piling up into solid white.
        e.emitterSize = CGSize(width: h * 0.16, height: h * 0.16)
        e.renderMode = .oldestFirst
        e.birthRate = 0
    }

    /// 休息中's GN particles: spread like 等你回覆 facing left (DriftLook.facingLeft's fan: from the body's middle,
    /// back and to the right, nothing to the left), but fewer and slower, fading over a longer time. The layer sits
    /// under the sprite, so they come out from behind the shields. The layer's birthRate (0…1) scales the cell's
    /// rate, so SleepGN's breath only sets that.
    static func configureSleepGN(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let look = DriftLook.facingLeft
        let drift = CAEmitterCell()
        drift.contents = image ?? white
        drift.birthRate = 24
        drift.lifetime = 3.6
        drift.lifetimeRange = 0.6
        drift.velocity = 22
        drift.velocityRange = 8
        drift.emissionRange = look.range
        drift.emissionLongitude = look.longitude
        drift.yAcceleration = look.yAccel
        drift.xAcceleration = look.xAccel
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.06
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.26
        drift.spin = 0.6
        drift.spinRange = 1.2
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterPosition = p
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 12, height: 12)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// 出錯了's GN particles: 等你回覆's facing-left fan (DriftLook.facingLeft: from the body's middle, back and to the
    /// right, nothing to the left) at its full rate and speed; updateAlarm makes it sputter through the layer's birthRate.
    static func configureAlarmGN(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let look = DriftLook.facingLeft
        let drift = CAEmitterCell()
        drift.contents = image ?? white
        drift.birthRate = 30 * Float(look.rate)
        drift.lifetime = 2.0
        drift.lifetimeRange = 0.5
        drift.velocity = look.velocity
        drift.velocityRange = 8
        drift.emissionRange = look.range
        drift.emissionLongitude = look.longitude
        drift.yAcceleration = look.yAccel
        drift.xAcceleration = look.xAccel
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.12
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.45
        drift.spin = 1
        drift.spinRange = 2
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterPosition = p
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 12, height: 12)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// 支援防禦's GN jet: a cell streaming straight back off the drive, whose rate and speed follow how hard it is
    /// driving forward (CAEmitterLayer.setGuardDrive(_:lean:)).
    static func configureGuardJet(_ e: CAEmitterLayer, unitHeight: CGFloat, image: CGImage?) {
        let jet = CAEmitterCell()
        jet.name = "jet"
        jet.contents = image ?? white
        jet.birthRate = 0
        jet.lifetime = 0.55
        jet.lifetimeRange = 0.15
        jet.velocity = 170
        jet.velocityRange = 40
        jet.emissionRange = 0.32
        jet.scale = image == nil ? 0.3 : 0.62
        jet.scaleRange = 0.18
        jet.scaleSpeed = -0.9
        jet.alphaSpeed = -1.4
        jet.color = CGColor(red: 0.45, green: 1, blue: 0.62, alpha: 1)
        e.emitterCells = [jet]
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: unitHeight * 0.14, height: unitHeight * 0.14)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// Working state's GN particles: a copy of the thinking state's drift cell, on its own layer.
    /// 支援防禦: sparks off the shield, thrown back towards where the shots came from (left) and falling.
    static func configureGuardSparks(_ e: CAEmitterLayer, images: [CGImage]) {
        let sources: [CGImage?] = images.isEmpty ? [white] : images
        e.emitterCells = sources.map { img in
            let cell = CAEmitterCell()
            cell.contents = img
            cell.birthRate = images.isEmpty ? 220 : 110
            cell.lifetime = 0.4
            cell.velocity = 120
            cell.velocityRange = 50
            cell.emissionLongitude = .pi
            cell.emissionRange = 1.3
            cell.yAcceleration = -220
            cell.scale = images.isEmpty ? 0.14 : 0.4
            cell.scaleRange = 0.06
            cell.scaleSpeed = -0.3
            cell.spin = 6
            cell.spinRange = 10
            cell.alphaSpeed = -2.2
            cell.color = images.isEmpty ? CGColor(red: 1, green: 0.72, blue: 0.3, alpha: 1) : CGColor(gray: 1, alpha: 1)
            cell.greenRange = 0.2
            return cell
        }
        e.emitterShape = .point
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// 要你批准's dash trail: a few faint GN particles left close behind as it dashes (its own copy of the GN cell,
    /// slower, shorter-lived and dimmer, so it reads as a hint, not a cloud).
    static func configureDashTrail(_ e: CAEmitterLayer, unitHeight: CGFloat, image: CGImage?) {
        let cell = CAEmitterCell()
        cell.contents = image ?? white
        cell.birthRate = 14
        cell.lifetime = 0.55
        cell.lifetimeRange = 0.15
        cell.velocity = 8
        cell.velocityRange = 6
        cell.emissionRange = .pi * 2
        cell.scale = image == nil ? 0.16 : 0.3
        cell.scaleRange = 0.08
        cell.scaleSpeed = -0.3
        cell.alphaSpeed = -1.4
        cell.color = CGColor(red: 0.36, green: 1, blue: 0.69, alpha: 0.6)
        e.emitterCells = [cell]
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: unitHeight * 0.2, height: unitHeight * 0.2)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// 要你決定's fan of GN particles from its middle: a copy of 等你回覆's drift cell (configureIdle), on its own layer.
    static func configureGuardAura(_ e: CAEmitterLayer, at p: CGPoint, image: CGImage?) {
        let drift = CAEmitterCell()
        drift.name = "drift"
        drift.contents = image ?? white
        drift.birthRate = 30
        drift.lifetime = 2.0
        drift.lifetimeRange = 0.5
        drift.velocityRange = 8
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.12
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.45
        drift.spin = 1
        drift.spinRange = 2
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterPosition = p
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 12, height: 12)
        e.renderMode = .additive
        e.birthRate = 0
    }

    static func applyGuardAura(_ look: DriftLook, to e: CAEmitterLayer, active: Bool) {
        e.setValue(look.range, forKeyPath: "emitterCells.drift.emissionRange")
        e.setValue(look.longitude, forKeyPath: "emitterCells.drift.emissionLongitude")
        e.setValue(look.velocity, forKeyPath: "emitterCells.drift.velocity")
        e.setValue(look.yAccel, forKeyPath: "emitterCells.drift.yAcceleration")
        e.setValue(look.xAccel, forKeyPath: "emitterCells.drift.xAcceleration")
        e.velocity = Float(look.speed)
        e.birthRate = active ? Float(look.rate) : 0
    }

    static func configurePistolGN(_ e: CAEmitterLayer, image: CGImage?) {
        let drift = CAEmitterCell()
        drift.name = "drift"
        drift.contents = image ?? white
        drift.birthRate = 30
        drift.lifetime = 2.2
        drift.lifetimeRange = 0.6
        drift.velocityRange = 18
        drift.scale = image == nil ? 0.2 : 0.42
        drift.scaleRange = 0.14
        drift.scaleSpeed = -0.12
        drift.alphaRange = 0.3
        drift.alphaSpeed = -0.4
        drift.spin = 1
        drift.spinRange = 2
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 34, height: 34)
        e.renderMode = .additive
        e.birthRate = 0
    }

    static func applyPistolGN(_ look: DriftLook, to e: CAEmitterLayer, active: Bool) {
        e.setValue(look.range, forKeyPath: "emitterCells.drift.emissionRange")
        e.setValue(look.longitude, forKeyPath: "emitterCells.drift.emissionLongitude")
        e.setValue(look.velocity, forKeyPath: "emitterCells.drift.velocity")
        e.setValue(look.yAccel, forKeyPath: "emitterCells.drift.yAcceleration")
        e.setValue(look.xAccel, forKeyPath: "emitterCells.drift.xAcceleration")
        e.velocity = Float(look.speed)
        e.birthRate = active ? Float(look.rate) : 0
    }

    static func applySnipeGN(_ look: DriftLook, to e: CAEmitterLayer, active: Bool) {
        e.setValue(look.range, forKeyPath: "emitterCells.drift.emissionRange")
        e.setValue(look.longitude, forKeyPath: "emitterCells.drift.emissionLongitude")
        e.setValue(look.velocity, forKeyPath: "emitterCells.drift.velocity")
        e.setValue(look.yAccel, forKeyPath: "emitterCells.drift.yAcceleration")
        e.setValue(look.xAccel, forKeyPath: "emitterCells.drift.xAcceleration")
        e.velocity = Float(look.speed)
        e.birthRate = active ? Float(look.rate) : 0
    }
}

extension CAEmitterLayer {
    /// 支援防禦's jet: aimed straight back (right, tipped with the body's lean), stronger the harder it drives.
    func setGuardDrive(_ drive: CGFloat, lean: CGFloat) {
        birthRate = 1
        setValue(lean, forKeyPath: "emitterCells.jet.emissionLongitude")
        setValue(140 * drive, forKeyPath: "emitterCells.jet.birthRate")
        setValue(120 + 110 * drive, forKeyPath: "emitterCells.jet.velocity")
    }
}
