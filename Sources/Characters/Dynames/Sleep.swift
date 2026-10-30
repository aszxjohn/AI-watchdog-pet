import AppKit
import QuartzCore

/// Sleep's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class SleepParts: ActParts {
    required init() {}
    var sleepGN: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var sleepParts: SleepParts { parts(SleepParts.self) }
    var sleepGN: CAEmitterLayer { sleepParts.sleepGN }

    // MARK: sleeping (休息中) — curled up in the closed shields, adrift in zero gravity, slowly letting out GN particles
    //
    // The "turn" frames (build_units.py: the game's own cocoon turn, left 3/4 → front; a mirrored right half broke
    // the turn at the front, so only this half). It slowly turns from the left 3/4 view (its old look) to the front
    // and back, while wandering a little and tilting, each on its own slow period so the drift never quite repeats.
    // GN particles fan out back and to the right like 等你回覆 facing left (never to the left), fewer and slower, the
    // release swelling and easing like slow breathing.
    // Keyed on the state (休息中 only). Its own layer and timings.

    enum Sleep {
        static let turn = 10.0                 // seconds for left 3/4 → front → left 3/4
        static let settle = 2.0                // seconds for the drift to grow in after it arrives
        static let wander = CGSize(width: 8, height: 4)   // how far it drifts sideways / up and down (points)
        static let rise: CGFloat = 1           // middle height of the drift (was dy -4 when it just sat)
        static let tilt: CGFloat = 5           // degrees it tilts either way
        static let periods = (x: 17.0, y: 11.0, tilt: 13.0)
    }

    enum SleepGN {
        static let start = 0.5                       // seconds after it arrives
        static let fadeIn = 1.5                      // seconds to come up to full release
        static let breath = 5.0                      // seconds per slow breath of the release
        static let low = 0.4                         // release at the bottom of a breath (fraction of full)
    }

    /// 0 = left 3/4 (where it starts) … 1 = front; eased at both ends.
    func turnFrame(t: CFTimeInterval, count: Int) -> Int {
        let toFront = 0.5 - 0.5 * cos(max(0, t) * 2 * .pi / Sleep.turn)
        return Int((toFront * Double(count - 1)).rounded())
    }

    /// The zero-gravity drift: sideways, up and down, tilt.
    func adrift(t: CFTimeInterval) -> (CGFloat, CGFloat, CGFloat) {
        let t = max(0, t)
        let on = CGFloat(min(1, t / Sleep.settle))
        let p = Sleep.periods
        let dx = Sleep.wander.width * CGFloat(sin(t * 2 * .pi / p.x)) * on
        let dy = Sleep.rise + Sleep.wander.height * CGFloat(sin(t * 2 * .pi / p.y + 1)) * on
        let lean = Sleep.tilt * .pi / 180 * CGFloat(sin(t * 2 * .pi / p.tilt + 2)) * on
        return (dx, dy, lean)
    }


    func buildSleep() {
        // the same body point 等你回覆 releases from (configureIdle)
        Fx.configureSleepGN(sleepGN, at: CGPoint(x: unitHeight * 0.02, y: unitHeight * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(sleepGN, at: 0)
    }

    func updateSleep(now: CFTimeInterval, active: Bool) {
        let t = now - trackStart - SleepGN.start
        guard active, t > 0 else { sleepGN.birthRate = 0; return }
        let on = min(1, t / SleepGN.fadeIn)
        let breath = SleepGN.low + (1 - SleepGN.low) * (0.5 - 0.5 * cos(t * 2 * .pi / SleepGN.breath))
        sleepGN.birthRate = Float(on * breath)
    }
}
