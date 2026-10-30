import AppKit
import QuartzCore

/// 等你回覆 (locked 10/27)'s GN particles: a drift from the drive at the body's centre and, during the forward move,
/// a converging jet; the drift's look follows the pose (面向左邊 → 低頭 → 前衝, see DriftLook). The frames themselves are
/// the system's plain "flourish" playback. Moved here from the system on 10/30 (unchanged).
final class WaitingParts: ActParts {
    required init() {}
    var gnIdle = CAEmitterLayer()
    var jet = CAEmitterLayer()
    /// 0…1: how far into the forward move the flourish is (drives the backward stream and the jet).
    var dashLevel: CGFloat = 0
    /// 0…1: how far the waiting pose has switched to a fidget pose (低頭 etc.).
    var fidgetLevel: CGFloat = 0
}

extension PetNode {
    var waitingParts: WaitingParts { parts(WaitingParts.self) }
    var gnIdle: CAEmitterLayer { waitingParts.gnIdle }
    var jet: CAEmitterLayer { waitingParts.jet }

    /// Its emitters, under the trail and the body (as the system used to stack them).
    func buildWaiting() {
        // The GN drive sits behind the torso; its particles are drawn under the body and leave towards the back
        // (+x, the unit faces left).
        let drive = CGPoint(x: unitHeight * 0.2, y: unitHeight * 0.1)
        Fx.configureIdle(gnIdle, at: CGPoint(x: unitHeight * 0.02, y: unitHeight * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(gnIdle, at: 0)
        Fx.configureJet(jet, at: drive, image: unit.fx["glow_b"])
        body.insertSublayer(jet, at: 1)
    }

    /// Each tick (calm: its state lets the GN drift run — unit.json "gnIdle" — and it is settled on screen).
    func updateWaiting(now: CFTimeInterval, playing: Bool) {
        let p = waitingParts
        let calm = playing && (plan.raw["gnIdle"] as? Bool ?? false) && settled(now: now)
        let target = calm && (plan.raw["jet"] as? Bool ?? false) ? dashTarget(now: now) : 0
        p.dashLevel += (target - p.dashLevel) * 0.3
        let fidgeting = fidget.map { now >= $0.from && now < $0.to } ?? false
        // Opens slowly into the full circle, closes quickly once the pose ends, so leftward
        // particles stay confined to 低頭.
        p.fidgetLevel += ((fidgeting ? 1 : 0) - p.fidgetLevel) * (fidgeting ? 0.15 : 0.35)
        // 面向左邊 (resting) → 低頭 / other fidget poses → 前衝, each phase with its own particle look.
        let look = DriftLook.facingLeft.mixed(with: .aura, p.fidgetLevel).mixed(with: .dash, p.dashLevel)
        Fx.apply(look, to: gnIdle, active: calm)
        jet.birthRate = calm ? Float(p.dashLevel) : 0
    }
}

extension DriftLook {
    /// 面向左邊: a slow fan trailing back and to the right; nothing goes left (only 低頭 may).
    static let facingLeft = DriftLook(range: 2.6, longitude: 0.1, velocity: 40, yAccel: 2, xAccel: 14,
                                      rate: 2.4, speed: 1, halo: 0)
    /// 低頭: an even circle around the body, the only phase whose particles reach the left.
    static let aura = DriftLook(range: .pi * 2, longitude: 0, velocity: 60, yAccel: 0, xAccel: 0,
                                rate: 2.6, speed: 1, halo: 0)
    /// 前衝: a fast stream backwards and a little upwards, kept to the right; still much wider than the
    /// converging jet so the two read as separate layers.
    static let dash = DriftLook(range: 0.65, longitude: 0.28, velocity: 24, yAccel: 6, xAccel: 0,
                                rate: 2.5, speed: 6, halo: 0)
}
