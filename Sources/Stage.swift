import AppKit
import Metal
import QuartzCore

/// Height in pixels of the idle pose in units/*/idle (TARGET_H in tools/build_units.py).
private let sourcePoseHeight: CGFloat = 240

/// Mobile-suit HUD look for the name tag and the status marker: dark glass, thin GN-green frame
/// with two corners cut off, monospaced text.
private enum Hud {
    static let green = CGColor(red: 0.36, green: 1, blue: 0.69, alpha: 1)
    static let line = CGColor(red: 0.36, green: 1, blue: 0.69, alpha: 0.85)
    static let panel = CGColor(red: 0, green: 0.07, blue: 0.05, alpha: 0.62)
    static let orange = CGColor(red: 1, green: 0.62, blue: 0.2, alpha: 1)
    /// Tint for the (cyan) particle sprites so they read as green GN particles.
    static let gnParticle = CGColor(red: 0.25, green: 1, blue: 0.4, alpha: 1)
    /// GN beam: pink, with a white-hot core.
    static let beam = CGColor(red: 1, green: 0.35, blue: 0.7, alpha: 0.85)
    static let beamHot = CGColor(red: 1, green: 0.55, blue: 0.8, alpha: 0.9)

    /// Lock-on reticle centred on the origin: ring, four ticks, centre dot.
    static func reticle(radius r: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r))
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] as [(CGFloat, CGFloat)] {
            p.move(to: CGPoint(x: dx * (r - 3), y: dy * (r - 3)))
            p.addLine(to: CGPoint(x: dx * (r + 5), y: dy * (r + 5)))
        }
        p.addEllipse(in: CGRect(x: -1, y: -1, width: 2, height: 2))
        return p
    }

    /// Four L-shaped corner marks around a rectangle.
    static func brackets(_ r: CGRect, arm: CGFloat) -> CGPath {
        let p = CGMutablePath()
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: r.minX, y: r.minY), 1, 1), (CGPoint(x: r.maxX, y: r.minY), -1, 1),
            (CGPoint(x: r.minX, y: r.maxY), 1, -1), (CGPoint(x: r.maxX, y: r.maxY), -1, -1),
        ]
        for (c, sx, sy) in corners {
            p.move(to: CGPoint(x: c.x + sx * arm, y: c.y))
            p.addLine(to: c)
            p.addLine(to: CGPoint(x: c.x, y: c.y + sy * arm))
        }
        return p
    }

    /// Rectangle with the bottom-left and top-right corners cut off.
    static func chamfer(_ r: CGRect, cut: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: r.minX + cut, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - cut))
        p.addLine(to: CGPoint(x: r.maxX - cut, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + cut))
        p.closeSubpath()
        return p
    }
}

/// One Gundam on screen, bound to one session. Each state is acted out with the unit's own
/// animations (unit.json rig); code only adds one-off reactions and HUD / GN-particle effects.
final class PetNode {
    /// The session it follows (changed by hand from its right-click menu).
    var sessionId: String
    let unit: UnitDef
    let root = CALayer()
    private let body = CALayer()
    private let sprite = CALayer()
    /// The previous picture, fading out while the next animation fades in.
    private let ghost = CALayer()
    private let tint = CALayer()
    private let tintMask = CALayer()
    private let gn = CAEmitterLayer()
    private let gnIdle = CAEmitterLayer()
    private let jet = CAEmitterLayer()
    private let charge = CAEmitterLayer()
    private let sparks = CAEmitterLayer()
    private let beam = CALayer()
    private let beamGlow = CAGradientLayer()
    private let beamCore = CALayer()
    private let flash = CALayer()
    private let impact = CALayer()
    private let halo = CALayer()
    private let reticle = CAShapeLayer()
    private let brackets = CAShapeLayer()
    private let bubble = CAShapeLayer()
    private let bubbleText = CATextLayer()
    private let tag = CALayer()
    private let tagFrame = CAShapeLayer()
    private let tagAccent = CALayer()
    private let tagText = CATextLayer()

    private(set) var state: PetState = .waiting
    private var plan: StatePlan
    private var stateSince: CFTimeInterval
    /// When the current state began (the stage's wandering notices a change by it).
    var stateStart: CFTimeInterval { stateSince }
    private let born: CFTimeInterval
    private var leavingSince: CFTimeInterval?
    private var flashAt: CFTimeInterval = -10
    private var lastToolError: Date?
    private(set) var title = ""
    /// Where it stands (its feet; the stage's coordinates, y up). The stage's wandering moves it (10/30).
    private(set) var pos: CGPoint
    /// Its place in the row along the bottom: where it comes in, and where it stays in a state that does not wander.
    var slot: CGPoint
    /// The move under way: from, to, start, seconds.
    private var move: (from: CGPoint, to: CGPoint, start: CFTimeInterval, time: Double)?
    /// When it may set off again (the stage's wandering waits for this).
    var wanderRest: CFTimeInterval = 0
    /// The state start the stage last planned for (so it notices a change of state).
    var plannedFor: CFTimeInterval = -1
    let unitHeight: CGFloat
    private let scale: CGFloat

    // Playback of the current plan.
    private var trackStart: CFTimeInterval
    /// The "out" segment of the previous hold animation, played before the new plan starts.
    private var exiting: (anim: String, start: CFTimeInterval, fps: Double)?
    private var restUntil: CFTimeInterval = 0
    private var flourishStart: CFTimeInterval?
    private var fidget: (anim: String, from: CFTimeInterval, to: CFTimeInterval)?

    // What is on screen.
    private var shownAnim = ""
    private var shownFrame = -1
    private var fadeStart: CFTimeInterval = -10
    /// 0…1: how far into the forward move the flourish is (drives the backward stream and the jet).
    private var dashLevel: CGFloat = 0
    /// 0…1: how far the waiting pose has switched to a fidget pose (低頭 etc.).
    private var fidgetLevel: CGFloat = 0

    private let enterTime = 1.0
    private let leaveTime = 0.9
    private let fadeTime = 0.22

    var showLabel: Bool { didSet { tag.isHidden = !showLabel } }

    /// `at`: where it appears; `entering: false` skips the descent (rebuilt in place, e.g. after a size change).
    init(sessionId: String, unit: UnitDef, at: CGPoint, unitHeight: CGFloat, showLabel: Bool, now: CFTimeInterval,
         entering: Bool = true) {
        self.sessionId = sessionId
        self.unit = unit
        self.pos = at
        self.slot = at
        self.unitHeight = unitHeight
        self.scale = unitHeight / sourcePoseHeight
        self.showLabel = showLabel
        plan = unit.rig.plan(for: .waiting)
        born = entering ? now : now - 1.05
        stateSince = now
        trackStart = born + enterTime
        restUntil = trackStart + 1.5

        root.bounds = .zero
        root.position = at

        body.bounds = .zero
        body.position = CGPoint(x: 0, y: unitHeight * 0.55)
        root.addSublayer(body)

        // The GN drive sits behind the torso; its particles are drawn under the body and leave
        // towards the back (+x, the unit faces left).
        let drive = CGPoint(x: unitHeight * 0.2, y: unitHeight * 0.1)
        Fx.configureIdle(gnIdle, at: CGPoint(x: unitHeight * 0.02, y: unitHeight * 0.06), image: unit.fx["glow_a"])
        body.addSublayer(gnIdle)
        Fx.configureJet(jet, at: drive, image: unit.fx["glow_b"])
        body.addSublayer(jet)
        Fx.configureGN(gn, unitHeight: unitHeight, image: unit.fx["glow_a"])
        body.addSublayer(gn)

        for l in [sprite, ghost] {
            l.contentsScale = 2
            l.magnificationFilter = .linear
            body.addSublayer(l)
        }
        ghost.opacity = 0

        tint.backgroundColor = CGColor(red: 1, green: 0.15, blue: 0.1, alpha: 1)
        tint.opacity = 0
        tint.mask = tintMask
        body.addSublayer(tint)

        Fx.configureCharge(charge, image: unit.fx["glow_b"])
        body.addSublayer(charge)
        Fx.configureSparks(sparks, images: [unit.fx["spark_a"], unit.fx["spark_b"]].compactMap { $0 })
        body.addSublayer(sparks)

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

        let pieces: [(CALayer, CGImage?, CGSize)] = [
            (flash, unit.fx["flash"], CGSize(width: 40, height: 27)),
            (impact, unit.fx["orb"], CGSize(width: 24, height: 23)),
            (halo, unit.fx["halo"], CGSize(width: 34, height: 34)),
        ]
        for (l, img, size) in pieces {
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

        let box = CGRect(x: -unitHeight * 0.6, y: 4, width: unitHeight * 1.2, height: unitHeight * 1.08)
        brackets.path = Hud.brackets(box, arm: 12)
        brackets.fillColor = nil
        brackets.lineWidth = 1.5
        brackets.strokeColor = Hud.orange
        brackets.shadowColor = Hud.orange
        brackets.shadowOpacity = 0.7
        brackets.shadowRadius = 3
        brackets.shadowOffset = .zero
        brackets.opacity = 0
        root.addSublayer(brackets)

        let bubbleRect = CGRect(x: 0, y: 0, width: 26, height: 20)
        bubble.bounds = bubbleRect
        bubble.path = Hud.chamfer(bubbleRect.insetBy(dx: 0.5, dy: 0.5), cut: 5)
        bubble.fillColor = Hud.panel
        bubble.lineWidth = 1
        bubble.shadowOffset = .zero
        bubble.shadowRadius = 3
        bubble.shadowOpacity = 0.6
        bubble.position = CGPoint(x: unitHeight * 0.4, y: unitHeight * 1.08)
        bubbleText.contentsScale = 2
        bubbleText.alignmentMode = .center
        bubbleText.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
        bubbleText.fontSize = 13
        bubbleText.frame = CGRect(x: 0, y: 2, width: 26, height: 17)
        bubble.addSublayer(bubbleText)
        bubble.isHidden = true
        root.addSublayer(bubble)

        tagFrame.fillColor = Hud.panel
        tagFrame.strokeColor = Hud.line
        tagFrame.lineWidth = 1
        tagFrame.shadowColor = Hud.green
        tagFrame.shadowOffset = .zero
        tagFrame.shadowRadius = 3
        tagFrame.shadowOpacity = 0.45
        tagAccent.backgroundColor = Hud.green
        tagText.contentsScale = 2
        tagText.alignmentMode = .left
        tag.addSublayer(tagFrame)
        tag.addSublayer(tagAccent)
        tag.addSublayer(tagText)
        tag.isHidden = !showLabel
        root.addSublayer(tag)
        if !unit.cutin.isEmpty { buildCutin() }
        if unit.cutin["reticle"] != nil {
            let lock = LockHud(images: unit.cutin, ring: 26)
            root.addSublayer(lock.group)
            floatLock = lock
        }
        Fx.configureSnipeGN(snipeGN, at: CGPoint(x: unitHeight * 0.02, y: unitHeight * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(snipeGN, at: 0)
        buildPinkBeam()
        Fx.configurePistolGN(pistolGN, image: unit.fx["glow_a"])
        body.insertSublayer(pistolGN, at: 0)
        buildPistols()
        buildField()
        buildGuard()
        buildDrive()
        buildSleep()
        buildAlarm()
        buildTransAm()
    }

    func set(state newState: PetState, title newTitle: String, toolErrorAt: Date?, now: CFTimeInterval) {
        if newState != state || tagText.string == nil {
            let old = plan
            plan = unit.rig.plan(for: newState)
            if newState != state { begin(from: old, now: now) }
            state = newState
            stateSince = now
            refreshBubble()
            refreshLabel()
        }
        if newTitle != title {
            title = newTitle
            refreshLabel()
        }
        if let e = toolErrorAt, e != lastToolError {
            if lastToolError != nil || now - born > 2 { flashAt = now }
            lastToolError = e
        }
    }

    /// Switches playback to the new plan; a hold animation that is mid-pose first plays its "out" segment.
    private func begin(from old: StatePlan, now: CFTimeInterval) {
        if old.anim == plan.anim && old.mode == plan.mode { return }
        var start = max(now, born + enterTime)
        if old.mode == .hold, let seg = unit.anim(old.anim).segments, now - trackStart > 0 {
            let fps = max(old.fps, 12)
            exiting = (old.anim, start, fps)
            start += Double(seg.out.count) / fps
        }
        trackStart = start
        flourishStart = nil
        fidget = nil
        restUntil = start + Double.random(in: 1.5...3)
    }

    func leave(now: CFTimeInterval) {
        if leavingSince == nil { leavingSince = now }
    }

    /// Showcase: switch to a state even if it is the current one, replaying it from the start.
    func force(state newState: PetState, now: CFTimeInterval) {
        let old = newState == state ? StatePlan(["anim": "", "mode": "still"]) : plan
        plan = unit.rig.plan(for: newState)
        begin(from: old, now: now)
        state = newState
        stateSince = now
        refreshBubble()
        refreshLabel()
    }

    /// Showcase: the small shake a failed tool call causes.
    func flashToolError(now: CFTimeInterval) {
        flashAt = now
    }

    // MARK: moving (the stage's wandering)

    /// On screen and acting: not coming in or going out.
    func settled(now: CFTimeInterval) -> Bool { now - born >= enterTime && leavingSince == nil }

    var isMoving: Bool { move != nil }

    /// Where it is heading (or standing), for keeping the others clear of it.
    var destination: CGPoint { move?.to ?? pos }

    /// A looping act (TRANS-AM, twin pistols, the shield states, the sniping cycle) stops while it moves and starts
    /// over where it arrives, so a shot or a dash is never dragged across the screen; the others carry on.
    private var pausesToMove: Bool {
        [.transam, .pistols, .field, .defend, .cycle, .attack].contains(plan.mode)
    }

    /// Whether it may set off now: any time, or for a looping act only as a loop ends.
    func canDepart(now: CFTimeInterval) -> Bool {
        guard settled(now: now), exiting == nil else { return false }
        let t = now - trackStart
        let near = 1.0 / 15
        switch plan.mode {
        case .transam: return t >= TA.period && t.truncatingRemainder(dividingBy: TA.period) < near
        case .pistols:
            let c = t - Burst.raise
            return c >= Burst.period && c.truncatingRemainder(dividingBy: Burst.period) < near
        case .defend: return t >= Guard.period && t.truncatingRemainder(dividingBy: Guard.period) < near
        case .field:
            let c = t - Field.attackFrom
            return c >= Field.volley && c.truncatingRemainder(dividingBy: Field.volley) < near
        case .cycle: return t >= Cycle.period && t.truncatingRemainder(dividingBy: Cycle.period) < near
        case .attack: return false
        default: return true
        }
    }

    /// Sets off for `to` at `speed` points per second (eased in and out).
    func depart(to: CGPoint, speed: Double, now: CFTimeInterval) {
        let d = Double(hypot(to.x - pos.x, to.y - pos.y))
        guard d > 1 else { return }
        move = (pos, to, now, min(3.5, max(0.45, d / max(20, speed))))
    }

    /// Moves `pos` along the current move; on arrival a looping act starts over and the rest begins.
    private func advanceMove(now: CFTimeInterval) {
        guard let m = move else { return }
        let u = CGFloat(min(1, (now - m.start) / m.time))
        let e = u * u * (3 - 2 * u)
        pos = CGPoint(x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e)
        if u >= 1 {
            move = nil
            if pausesToMove { trackStart = now }
            arrived?(self, now)
        }
    }

    /// Called on arrival (the stage starts the rest).
    var arrived: ((PetNode, CFTimeInterval) -> Void)?

    /// Shifts it (and its place) up or down, e.g. when the name tags are switched on or off.
    func shift(dy: CGFloat) {
        pos.y += dy
        slot.y += dy
        if let m = move { move = (CGPoint(x: m.from.x, y: m.from.y + dy), CGPoint(x: m.to.x, y: m.to.y + dy), m.start, m.time) }
    }

    /// Area (in stage coordinates) that counts as clicking this Gundam: the body plus its tag.
    var hitRect: CGRect {
        CGRect(x: root.position.x - unitHeight * 0.6, y: root.position.y - 34,
               width: unitHeight * 1.2, height: unitHeight * 1.2 + 34)
    }

    /// Advances one display tick. Returns false once the leave animation has finished.
    func update(now: CFTimeInterval) -> Bool {
        advanceMove(now: now)
        // a looping act waits while it moves (see pausesToMove)
        let paused = move != nil && pausesToMove
        let age = now - born
        let st = now - stateSince
        var dx: CGFloat = 0, dy: CGFloat = 0, lean: CGFloat = 0
        var alpha: CGFloat = plan.dim
        var trail = move != nil

        let (animName, frame) = paused ? travelFrame() : pick(now: now, age: age)

        // One-off reactions per state.
        switch state {
        case .done:
            if st < 0.7 { dy = sin(st / 0.7 * .pi) * 14 }
        case .sleeping:
            dy = -4
            if plan.mode == .float { (dx, dy, lean) = adrift(t: now - trackStart) }
        case .error:
            if st < 0.7 { dx = sin(now * 46) * 3 }
            if !unit.alarm.isEmpty { (dx, dy, lean) = alarmShake(now: now) }
        default:
            break
        }
        if now - flashAt < 0.6 { dx += sin(now * 52) * 2.5 }

        var sniping = false
        if plan.mode == .attack && age >= enterTime && leavingSince == nil && exiting == nil {
            sniping = true
            lean = unit.rig.lean * .pi / 180 * CGFloat(min(1, (now - trackStart) / 0.3))
        }

        if age < enterTime {
            // Descends from above, slowing down, with a GN-particle trail.
            let p = age / enterTime
            dy += (1 - CGFloat(1 - pow(1 - p, 3))) * 110
            alpha = CGFloat(min(1, p / 0.3))
            trail = true
        }
        if let l = leavingSince {
            let p = (now - l) / leaveTime
            if p >= 1 { return false }
            dy += CGFloat(p * p) * 120
            dx += CGFloat(p) * 40
            alpha = CGFloat(1 - p)
            trail = true
        }

        show(animName, frame, now: now)
        body.transform = CATransform3DRotate(CATransform3DMakeTranslation(dx, dy, 0), lean, 0, 0, 1)
        root.position = pos
        root.opacity = Float(alpha)

        let burst = plan.burst && st < 1.2 && leavingSince == nil
        gn.birthRate = trail ? 1 : (burst ? 3 : 0)
        let calm = plan.gnIdle && age >= enterTime && leavingSince == nil
        let target = calm && plan.jet ? dashTarget(now: now) : 0
        dashLevel += (target - dashLevel) * 0.3
        let fidgeting = fidget.map { now >= $0.from && now < $0.to } ?? false
        // Opens slowly into the full circle, closes quickly once the pose ends, so leftward
        // particles stay confined to 低頭.
        fidgetLevel += ((fidgeting ? 1 : 0) - fidgetLevel) * (fidgeting ? 0.15 : 0.35)
        // 面向左邊 (resting) → 低頭 / other fidget poses → 前衝, each phase with its own particle look.
        let look = DriftLook.facingLeft.mixed(with: .aura, fidgetLevel).mixed(with: .dash, dashLevel)
        Fx.apply(look, to: gnIdle, active: calm)
        jet.birthRate = calm ? Float(dashLevel) : 0
        updateSniping(active: sniping, now: now, offset: CGPoint(x: dx, y: dy), lean: lean)
        updateHit(now: now, st: st)
        updateHud(now: now, sniping: sniping)
        if plan.mode == .cycle {
            updateCycle(now: now, offset: CGPoint(x: dx, y: dy), active: age >= enterTime && leavingSince == nil && exiting == nil && !paused)
        } else {
            hideCutin()
            hideThinking()
        }
        if plan.mode == .pistols {
            updatePistols(now: now, offset: CGPoint(x: dx, y: dy), active: age >= enterTime && leavingSince == nil && exiting == nil && !paused)
        } else {
            hidePistols()
        }
        if plan.mode == .transam {
            updateTransAm(now: now, offset: CGPoint(x: dx, y: dy), active: age >= enterTime && leavingSince == nil && exiting == nil && !paused)
        } else {
            hideTransAm()
        }
        let acting = age >= enterTime && leavingSince == nil && exiting == nil && !paused
        if plan.mode == .field { updateField(now: now, offset: CGPoint(x: dx, y: dy), active: acting) } else { hideField() }
        if plan.mode == .defend { updateGuard(now: now, offset: CGPoint(x: dx, y: dy), active: acting) } else { hideGuard() }
        if plan.mode == .drive { updateDrive(now: now, active: acting) } else { hideDrive() }
        updateSleep(now: now, active: acting && state == .sleeping)
        updateAlarm(now: now, st: st, active: acting && state == .error)
        return true
    }

    // MARK: playback

    /// The picture while a looping act waits for a move: TRANS-AM in its normal colours (it powers up again on
    /// arrival), the others on their first frame.
    private func travelFrame() -> (String, Int) {
        plan.mode == .transam ? ("stand", 0) : (plan.anim, 0)
    }

    private func pick(now: CFTimeInterval, age: CFTimeInterval) -> (String, Int) {
        if age < enterTime { return (unit.rig.enter, 0) }
        if leavingSince != nil { return (unit.rig.leave, 0) }
        if let e = exiting {
            let seg = unit.anim(e.anim).segments!
            let k = Int((now - e.start) * e.fps)
            if k < seg.out.count { return (e.anim, seg.out.lowerBound + max(0, k)) }
            exiting = nil
        }
        let a = unit.anim(plan.anim)
        let t = max(0, now - trackStart)
        switch plan.mode {
        case .still, .attack:
            return (plan.anim, 0)
        case .hold:
            return (plan.anim, holdFrame(a, t: t, fps: plan.fps))
        case .flourish:
            return flourishFrame(a, now: now)
        case .cycle:
            return cycleFrame(a, t: t)
        case .pistols:
            return (plan.anim, pistolFrame(t: t))
        case .field:
            return (plan.anim, holdFrame(a, t: t, fps: plan.fps))
        case .defend:
            return (plan.anim, guardFrame(t: t))
        case .drive:
            return (plan.anim, 0)
        case .float:
            return (plan.anim, turnFrame(t: t, count: a.frames.count))
        case .transam:
            return taFrame(t: t)
        }
    }

    /// How far into the forward move the current flourish is: ramps up over "in", stays at 1 through
    /// "hold", ramps down over "out", 0 while resting.
    private func dashTarget(now: CFTimeInterval) -> CGFloat {
        guard plan.mode == .flourish, let f = flourishStart, let seg = unit.anim(plan.anim).segments else { return 0 }
        let k = (now - f) * plan.fps
        let inEnd = Double(seg.into.upperBound + 1)
        let holdEnd = Double(seg.hold.upperBound + 1)
        let outEnd = Double(seg.out.upperBound + 1)
        if k < inEnd { return CGFloat(k / inEnd) }
        if k < holdEnd { return 1 }
        if k < outEnd { return CGFloat((outEnd - k) / (outEnd - holdEnd)) }
        return 0
    }

    /// Plays the "in" segment once, then ping-pongs inside "hold" for as long as the state lasts.
    private func holdFrame(_ a: Anim, t: Double, fps: Double) -> Int {
        let k = Int(t * fps)
        guard let seg = a.segments else {
            guard a.count > 1 else { return 0 }
            let cycle = 2 * (a.count - 1)
            let j = k % cycle
            return j < a.count ? j : cycle - j
        }
        if k <= seg.into.upperBound { return k }
        let h = seg.hold
        guard h.count > 1 else { return h.lowerBound }
        let cycle = 2 * (h.count - 1)
        let j = (k - seg.into.upperBound - 1) % cycle
        return h.lowerBound + (j < h.count ? j : cycle - j)
    }

    /// Rests on the base pose; every few seconds plays the whole move once, and sometimes strikes a
    /// fidget pose for a moment instead.
    private func flourishFrame(_ a: Anim, now: CFTimeInterval) -> (String, Int) {
        if let f = flourishStart {
            let k = Int((now - f) * plan.fps)
            if k < a.count { return (plan.anim, k) }
            flourishStart = nil
            restUntil = now + Double.random(in: 3.5...7)
            if let pose = plan.fidget.randomElement(), Double.random(in: 0...1) < 0.45 {
                let from = now + Double.random(in: 0.8...2)
                fidget = (pose, from, from + 4.4)
            }
        }
        if let fg = fidget {
            if now >= fg.from && now < fg.to { return (fg.anim, 0) }
            if now >= fg.to { fidget = nil }
        }
        if fidget == nil && now >= restUntil {
            flourishStart = now
        }
        return (plan.anim, 0)
    }

    private func show(_ name: String, _ idx: Int, now: CFTimeInterval) {
        let anim = unit.anim(name)
        if name != shownAnim {
            if !shownAnim.isEmpty {
                ghost.contents = sprite.contents
                ghost.bounds = sprite.bounds
                ghost.anchorPoint = sprite.anchorPoint
                ghost.position = sprite.position
                fadeStart = now
            }
            let size = CGSize(width: anim.size.width * scale, height: anim.size.height * scale)
            let anchor = CGPoint(x: anim.anchor.x / anim.size.width, y: 1 - anim.anchor.y / anim.size.height)
            for l in [sprite, tint] {
                l.bounds = CGRect(origin: .zero, size: size)
                l.anchorPoint = anchor
                l.position = .zero
            }
            tintMask.frame = CGRect(origin: .zero, size: size)
            shownAnim = name
            shownFrame = -1
        }
        let i = min(idx, anim.count - 1)
        if i != shownFrame {
            sprite.contents = anim.frames[i]
            tintMask.contents = anim.frames[i]
            shownFrame = i
        }
        let f = (now - fadeStart) / fadeTime
        ghost.opacity = f < 1 ? Float(1 - f) : 0
        sprite.opacity = f < 1 ? Float(min(1, f * 1.6)) : 1
    }

    // MARK: effects

    /// Body-space position (y up, relative to the pinned point) of a pixel in an animation's frame.
    private func bodyPoint(_ px: CGPoint, in anim: Anim) -> CGPoint {
        CGPoint(x: (px.x - anim.anchor.x) * scale, y: -(px.y - anim.anchor.y) * scale)
    }

    private func rotate(_ p: CGPoint, _ a: CGFloat) -> CGPoint {
        CGPoint(x: p.x * cos(a) - p.y * sin(a), y: p.x * sin(a) + p.y * cos(a))
    }

    private var beamLength: CGFloat { unitHeight * 0.45 }

    /// Where the muzzle and the beam's end are, in root space.
    private func aim(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, end: CGPoint, angle: CGFloat) {
        let rig = unit.rig
        let local = bodyPoint(rig.muzzle, in: unit.anim(plan.anim))
        let r = rotate(local, lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let len = hypot(rig.aimDir.dx, rig.aimDir.dy)
        let d = rotate(CGPoint(x: rig.aimDir.dx / len, y: -rig.aimDir.dy / len), lean)
        let end = CGPoint(x: muzzle.x + d.x * beamLength, y: muzzle.y + d.y * beamLength)
        return (muzzle, end, atan2(d.y, d.x))
    }

    /// Sniping loop: GN particles gather at the muzzle, then flash, beam, impact and recoil.
    private func updateSniping(active: Bool, now: CFTimeInterval, offset: CGPoint, lean: CGFloat) {
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

        charge.emitterPosition = bodyPoint(unit.rig.muzzle, in: unit.anim(plan.anim))
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

    // MARK: thinking — 狙擊準備 → 瞄準 → 射擊 (its own timings, values and layers; nothing here is shared)
    //
    // The whole cycle holds the World-parts sniping pose "snipe" (poses/snipe_aim_v2.json, one frame). The unit
    // only moves as one piece (the shot's recoil), so nothing can come apart.

    private enum Cycle {
        static let ready = 2.8      // 狙擊準備: holding aim, reticle searching
        static let aiming = 2.0     // 瞄準: the cockpit cut-in
        static let firing = 1.4     // 射擊: pink charge at the muzzle, thick pink beam, recoil
        static var period: Double { ready + aiming + firing }
        static let chargeFrom = 0.08
        static let shotAt = 0.42    // seconds into 射擊 when the beam leaves
        static let beamHold = 0.3   // full-thickness beam…
        static let beamFade = 0.3   // …then it thins out
    }

    private enum CyclePhase { case ready(Double), aiming(Double), firing(Double) }

    private func cyclePhase(_ t: Double) -> CyclePhase {
        let c = t.truncatingRemainder(dividingBy: Cycle.period)
        if c < Cycle.ready { return .ready(c) }
        if c < Cycle.ready + Cycle.aiming { return .aiming(c - Cycle.ready) }
        return .firing(c - Cycle.ready - Cycle.aiming)
    }

    private func cycleFrame(_ a: Anim, t: Double) -> (String, Int) {
        (plan.anim, 0)
    }

    private var boltRange: CGFloat { unitHeight * 1.75 }

    /// The thinking state's own GN particles and beam (separate from the other states').
    private let snipeGN = CAEmitterLayer()
    private let chargeGlow = CALayer()
    private let pinkBeam = CALayer()
    private let pinkBeamGlow = CAGradientLayer()
    private let pinkBeamCore = CALayer()
    private let pinkFlare = CALayer()

    private func buildPinkBeam() {
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

    private func hideThinking() {
        floatLock?.hide()
        snipeGN.birthRate = 0
        chargeGlow.opacity = 0
        pinkFlare.opacity = 0
        pinkBeam.opacity = 0
    }

    /// Muzzle (root space) and barrel direction (y up) of the thinking pose, with the body moved by `offset`
    /// and turned by `lean` radians around its pinned point.
    private func firePoint(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, dir: CGPoint) {
        let rig = unit.rig
        let anim = unit.anim(rig.fireAnim)
        let px = rig.snipeMuzzle ?? rig.muzzle
        let dv = rig.snipeDir ?? rig.aimDir
        let r = rotate(bodyPoint(px, in: anim), lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let len = max(0.001, hypot(dv.dx, dv.dy))
        return (muzzle, rotate(CGPoint(x: dv.dx / len, y: -dv.dy / len), lean))
    }

    private func updateCycle(now: CFTimeInterval, offset: CGPoint, active: Bool) {
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
                charge.emitterPosition = bodyPoint(unit.rig.snipeMuzzle ?? unit.rig.muzzle, in: unit.anim(unit.rig.fireAnim))
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
        if let core = unit.rig.snipeCore { snipeGN.emitterPosition = bodyPoint(core, in: unit.anim(unit.rig.fireAnim)) }
        Fx.applySnipeGN(SnipeGN.ready.mixed(with: SnipeGN.shot, shotLevel), to: snipeGN, active: true)
    }

    /// The floating lock-on reticle: the cut-in's own (LockHud) when this unit has one, else the plain ring.
    private func floatAim(_ p: CGPoint, closeIn: CGFloat, t: Double, flash: CGFloat, alpha: Float) {
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

    // MARK: thinking — 瞄準 cut-in: cockpit → helmet close-up → eye through the scope, reticle locks

    private let cutinPanel = CALayer()
    private let cutinBorder = CAShapeLayer()
    private let cutinLabel = CATextLayer()
    private var cutinLayers: [String: CALayer] = [:]
    private var cutinLock: LockHud?
    private var floatLock: LockHud?
    private var cutinVisible = false

    private enum Cut {
        static let open = 0.2                 // panel opens, the Gundam fades out
        static let cockpit = 0.0...0.8        // shot A
        static let face = 0.65...1.3          // shot B
        static let eye = 1.15...2.3           // shot C, reticle closes in, locks at 1.6 (stays until the panel shuts)
        static let lock = 1.6
        static let close = 0.15               // at the start of 射擊
    }

    private var cutinSize: CGSize { CGSize(width: unitHeight * 1.6, height: unitHeight * 0.95) }

    private func buildCutin() {
        let size = cutinSize
        let rect = CGRect(origin: .zero, size: size)
        let center = CGPoint(x: 0, y: unitHeight * 0.55)
        cutinPanel.bounds = rect
        cutinPanel.position = center
        cutinPanel.backgroundColor = CGColor(gray: 0, alpha: 0.9)
        let clip = CAShapeLayer()
        clip.path = Hud.chamfer(rect, cut: 10)
        cutinPanel.mask = clip
        cutinPanel.opacity = 0

        func piece(_ name: String, _ frame: CGRect, gravity: CALayerContentsGravity = .resize) -> CALayer {
            let l = CALayer()
            l.contents = unit.cutin[name]
            l.contentsGravity = gravity
            l.frame = frame
            l.opacity = 0
            cutinPanel.addSublayer(l)
            cutinLayers[name] = l
            return l
        }
        for name in ["cockpit", "face", "eye"] { _ = piece(name, rect, gravity: .resizeAspectFill) }
        let tint = piece("tint", rect)
        tint.compositingFilter = "multiplyBlendMode"
        let scopeH = size.height * 1.3
        _ = piece("scope", CGRect(x: 0, y: 0, width: scopeH * 359 / 696, height: scopeH))
        let lock = LockHud(images: unit.cutin, ring: size.height * 0.62)
        lock.group.frame = rect
        cutinPanel.addSublayer(lock.group)
        cutinLock = lock
        _ = piece("line", CGRect(x: 0, y: 0, width: size.width, height: 8))
        for l in cutinLayers.values where l.contentsGravity == .resize && l !== tint {
            l.position = CGPoint(x: size.width / 2, y: size.height / 2)
        }

        cutinLabel.string = "LOCK ON"
        cutinLabel.font = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
        cutinLabel.fontSize = 9
        cutinLabel.foregroundColor = Hud.orange
        cutinLabel.contentsScale = 2
        cutinLabel.alignmentMode = .right
        cutinLabel.frame = CGRect(x: size.width - 70, y: 6, width: 62, height: 12)
        cutinLabel.opacity = 0
        cutinPanel.addSublayer(cutinLabel)
        root.addSublayer(cutinPanel)

        cutinBorder.bounds = rect
        cutinBorder.position = center
        cutinBorder.path = Hud.chamfer(rect.insetBy(dx: 0.75, dy: 0.75), cut: 10)
        cutinBorder.fillColor = nil
        cutinBorder.strokeColor = Hud.line
        cutinBorder.lineWidth = 1.5
        cutinBorder.shadowColor = Hud.green
        cutinBorder.shadowOpacity = 0.7
        cutinBorder.shadowRadius = 3
        cutinBorder.shadowOffset = .zero
        cutinBorder.opacity = 0
        root.addSublayer(cutinBorder)
    }

    /// 0…1 across a closed range, with an ease-out.
    private func progress(_ c: Double, _ r: ClosedRange<Double>) -> CGFloat {
        let p = min(1, max(0, (c - r.lowerBound) / (r.upperBound - r.lowerBound)))
        return CGFloat(1 - pow(1 - p, 3))
    }

    /// Opacity of a shot that fades in over its first `fade` seconds and out over its last.
    private func shotAlpha(_ c: Double, _ r: ClosedRange<Double>, fade: Double = 0.15) -> Float {
        guard r.contains(c) else { return 0 }
        let a = min(1, (c - r.lowerBound) / fade, r.lowerBound == 0 ? 1 : 1)
        let b = min(1, (r.upperBound - c) / fade)
        return Float(max(0, min(r.lowerBound == 0 ? 1 : a, b)))
    }

    private func updateCutin(_ c: Double) {
        guard let face = cutinLayers["face"], let eye = cutinLayers["eye"], let cockpit = cutinLayers["cockpit"],
              let scope = cutinLayers["scope"], let tint = cutinLayers["tint"], let line = cutinLayers["line"]
        else { return }
        cutinVisible = true
        let size = cutinSize
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)

        // Panel opens like a shutter while the Gundam fades away.
        let open = progress(c, 0...Cut.open)
        cutinPanel.opacity = 1
        cutinBorder.opacity = 1
        cutinPanel.transform = CATransform3DMakeScale(1, max(0.02, open), 1)
        cutinBorder.transform = cutinPanel.transform
        body.opacity = Float(1 - open)

        // Shot A: the cockpit, slowly pushing in.
        cockpit.opacity = shotAlpha(c, Cut.cockpit)
        let pa = 1 + 0.1 * CGFloat(c / Cut.cockpit.upperBound)
        cockpit.transform = CATransform3DMakeScale(pa, pa, 1)

        // Shot B: helmet close-up, pushing in towards his eyes. (No scope dropping in — the user asked
        // for the descending scope to be left out.)
        face.opacity = shotAlpha(c, Cut.face)
        let pb = 1.05 + 0.07 * progress(c, Cut.face)
        face.transform = CATransform3DMakeScale(pb, pb, 1)
        scope.opacity = 0

        // Shot C: through the scope — the eye strip under a teal filter, the reticle closing in.
        eye.opacity = shotAlpha(c, Cut.eye, fade: 0.12)
        let pc = 1.1 + 0.05 * progress(c, Cut.eye)
        eye.transform = CATransform3DMakeScale(pc, pc, 1)
        tint.opacity = eye.opacity * 0.55
        let hud = Cut.eye.lowerBound + 0.1
        let closeIn = progress(c, hud...Cut.lock)
        let hudAlpha: Float = c >= hud ? min(1, Float((c - hud) / 0.1)) : 0
        let locked = c >= Cut.lock
        let flash: CGFloat = locked && c < Cut.lock + 0.15 ? 1 + CGFloat(Cut.lock + 0.15 - c) * 2 : 1
        // The reticle closes in on his pupil: where it sits in the eye image, through the aspect fill and push-in.
        var target = mid
        if let pupil = unit.rig.cutinPupil, let img = unit.cutin["eye"] {
            let iw = CGFloat(img.width), ih = CGFloat(img.height)
            let fill = max(size.width / iw, size.height / ih) * pc
            target = CGPoint(x: mid.x + (pupil.x - iw / 2) * fill, y: mid.y - (pupil.y - ih / 2) * fill)
        }
        cutinLock?.layout(at: target, closeIn: closeIn, spin: c, flash: flash, alpha: hudAlpha)
        // One scan line sweeps down while it searches, then the lock label blinks.
        let sweep = progress(c, hud...Cut.lock)
        line.opacity = c >= hud && c < Cut.lock ? hudAlpha * 0.9 : 0
        line.position = CGPoint(x: mid.x, y: size.height * (1 - sweep))
        cutinLabel.opacity = locked ? (Int(c * 10) % 2 == 0 ? 1 : 0.35) : 0
        cutinBorder.strokeColor = locked ? Hud.orange : Hud.line
        cutinBorder.shadowColor = locked ? Hud.orange : Hud.green
    }

    /// Start of 射擊: the panel snaps shut and the Gundam fades back in to fire.
    private func closeCutin(_ c: Double) {
        guard cutinVisible || c < Cut.close else { return }
        let p = CGFloat(min(1, c / Cut.close))
        cutinPanel.transform = CATransform3DMakeScale(1, max(0.02, 1 - p), 1)
        cutinBorder.transform = cutinPanel.transform
        cutinPanel.opacity = Float(1 - p)
        cutinBorder.opacity = Float(1 - p)
        body.opacity = Float(min(1, c / 0.2))
        if p >= 1 { hideCutin() }
    }

    private func hideCutin() {
        guard cutinVisible || body.opacity < 1 else { return }
        cutinVisible = false
        cutinPanel.opacity = 0
        cutinBorder.opacity = 0
        body.opacity = 1
    }

    // MARK: working — TRANS-AM (Cross Rays' "Trans-Am" attack, told with G Gen Wars' own Trans-Am pieces)
    //
    // ①② the game's own opening, frame by frame from the Cross Rays video: the camera coming down onto the head,
    // the eyes flashing, the TRANS-AM screen, the standing body turning red → ③ out of the panel the red standing
    // body bursts out in a white flash and red GN particles →
    // ⑤ first shot → ⑥ high-speed: darts to three places leaving afterimages, firing at each →
    // ⑨ Lockon's cut-in (the sniping cycle's, unchanged) → ⑩ full-power beam, the target blows up → ⑪ the red
    // drains back to normal. The opening plays in a panel like Lockon's. Every shot is fired from the Trans-Am
    // sniping pose ("ta_snipe", 10/30: full armament, Wars' own Trans-Am firing frame; frame 1 has the muzzle lit),
    // with Wars' own pink beam-rifle effects; ⑪ swaps back to 等你回覆's standing pose under a white flash. GN
    // particles follow the sniping fan (back and to the right), green throughout. Its own layers.

    private enum TA {
        static let intro = 0.0..<3.75              // the video's 112 frames at 30 fps (3.73 s), in the panel
        static let reveal = 3.75..<4.55
        static let first = 4.55..<5.35             // (④, the rifle close-up, was taken out on 10/30)
        static let dash = 5.35..<8.35             // (⑦⑧, the head and muzzle close-ups, were taken out on 10/30)
        static let lockon = 8.35..<10.35
        static let burst = 10.35..<12.15
        static let release = 12.15..<13.15
        static let period = 13.15
        static let shutter = 0.15                 // panel opening / closing
        static let lit = 0.4                      // the lit-muzzle frame after each shot
        static let drain = 0.25                   // ⑪ the white flash up to the swap to normal colours
        static let firstShot = 0.25               // into ⑤
        /// ⑥: where it darts (× unitHeight from its place, + = right / up), one after another, then back over its
        /// place at the full-power shot's height (`rise`), so it is already there for Lockon's cut-in and ⑩.
        /// (10/30: starts low and climbs with the first dodges, long sweeps left and right — 1.6 / 1.9 / 2.3 — then
        /// plunges right and far down (0.65) and swoops back up to the right; mostly leftwards, as the showcase unit
        /// stands at the screen's right edge and goes no further right than 0.3.)
        static let stops: [CGPoint] = [CGPoint(x: -1.6, y: -0.08), CGPoint(x: 0.3, y: 0.08), CGPoint(x: -2.0, y: 0.2),
                                       CGPoint(x: -0.6, y: -0.45)]
        static let dashTime = 0.2
        static let hold = 0.5                     // at each stop; it fires 0.1 s in
        static let ghosts = 5
        static let charge = 0.25...0.75           // ⑩, after Lockon's panel has shut
        static let bigShot = 0.75
        static let bigHold = 0.7
        static let bigFade = 0.35
        static let rise: CGFloat = 0.45           // ⑩ how high it rises to fire (× unitHeight)
        static let red = CGColor(red: 1, green: 0.3, blue: 0.5, alpha: 1)
        static let pink = CGColor(red: 1, green: 0.32, blue: 0.75, alpha: 1)
        /// GN particles: the sniping fan, and a stronger push of it (still never to the left) at bursts and shots.
        static let fan = DriftLook(range: 3.0, longitude: 0.1, velocity: 58, yAccel: 2, xAccel: 16, rate: 4.2, speed: 1, halo: 0)
        static let gush = DriftLook(range: 3.0, longitude: 0.1, velocity: 130, yAccel: 2, xAccel: 24, rate: 10, speed: 1, halo: 0)
    }

    private let taPanel = CALayer()
    private let taBorder = CAShapeLayer()
    private let taSystem = CALayer()
    private var taScreen: [CGImage] = []
    private var taGhosts: [CALayer] = []
    private var taTrail: [(image: Any?, bounds: CGRect, anchor: CGPoint, at: CGPoint)] = []
    private var taBolts: [CALayer] = []
    private var taBig: CALayer?
    private var taFx: [String: CALayer] = [:]
    /// ⑩ where the full-power beam ends and the target blows up, fixed when it fires.
    private var taHit: CGPoint?
    private var taBlast: [String: CALayer] = [:]
    private let taGN = CAEmitterLayer()

    /// A beam: Wars' own pink beam-rifle bar (DV_efe), its middle stretched along the shot so the rounded ends keep
    /// their shape.
    private func makeTABeam() -> CALayer {
        let b = CALayer()
        b.contents = unit.transam["fx_beam"]
        b.contentsGravity = .resize
        b.contentsCenter = CGRect(x: 0.42, y: 0, width: 0.16, height: 1)
        b.anchorPoint = CGPoint(x: 0, y: 0.5)
        b.opacity = 0
        root.addSublayer(b)
        return b
    }

    private func layoutTABeam(_ b: CALayer, from p: CGPoint, dir: CGPoint, length: CGFloat, thick: CGFloat, alpha: Float) {
        b.bounds = CGRect(x: 0, y: 0, width: length, height: thick)
        if let im = unit.transam["fx_beam"] { b.contentsScale = CGFloat(im.height) / max(1, thick) }
        b.position = p
        b.transform = CATransform3DMakeRotation(atan2(dir.y, dir.x), 0, 0, 1)
        b.opacity = alpha
    }

    private func buildTransAm() {
        guard !unit.transam.isEmpty else { return }
        let h = unitHeight
        let size = cutinSize
        let rect = CGRect(origin: .zero, size: size)
        let center = CGPoint(x: 0, y: h * 0.55)
        taPanel.bounds = rect
        taPanel.position = center
        taPanel.backgroundColor = CGColor(gray: 0, alpha: 0.9)
        let clip = CAShapeLayer()
        clip.path = Hud.chamfer(rect, cut: 10)
        taPanel.mask = clip
        taPanel.opacity = 0
        // ①② The game's opening, one video frame at a time.
        taScreen = (0..<unit.rig.taScreenFrames).compactMap { unit.transam[String(format: "scr_%03d", $0)] }
        taSystem.frame = rect
        taSystem.contentsGravity = .resizeAspectFill
        taSystem.opacity = 0
        taPanel.addSublayer(taSystem)
        root.addSublayer(taPanel)
        taBorder.bounds = rect
        taBorder.position = center
        taBorder.path = Hud.chamfer(rect.insetBy(dx: 0.75, dy: 0.75), cut: 10)
        taBorder.fillColor = nil
        taBorder.lineWidth = 1.5
        taBorder.shadowOpacity = 0.7
        taBorder.shadowRadius = 3
        taBorder.shadowOffset = .zero
        taBorder.opacity = 0
        root.addSublayer(taBorder)

        for _ in 0..<TA.ghosts {
            let g = CALayer()
            g.opacity = 0
            root.insertSublayer(g, below: body)
            taGhosts.append(g)
        }
        for _ in 0..<3 { taBolts.append(makeTABeam()) }
        taBig = makeTABeam()
        // The shot's muzzle effects and the charge (Wars' pink beam-rifle pieces), sized here for a first shot
        // (× unitHeight across).
        for (name, w) in [("burst", 0.55), ("lens", 0.6), ("cross", 0.08), ("spike", 0.35), ("ring", 0.5),
                          ("orb", 0.3), ("spark", 0.5)] {
            guard let img = unit.transam["fx_\(name)"] else { continue }
            let l = CALayer()
            l.contents = img
            l.bounds = CGRect(x: 0, y: 0, width: CGFloat(w) * h, height: CGFloat(w) * h * CGFloat(img.height) / CGFloat(img.width))
            l.opacity = 0
            root.addSublayer(l)
            taFx[name] = l
        }
        // The target blowing up (Wars' blast pieces, as in 要你批准).
        for (name, k) in [("smokeA", 0.7), ("smokeB", 0.7), ("fireC", 0.75), ("fireA", 0.5), ("fireB", 0.5),
                          ("hitGlow", 0.8), ("sparkBig", 0.6), ("flash", 1.0)] {
            guard let img = unit.attack[name] else { continue }
            let l = CALayer()
            l.contents = img
            let w = CGFloat(k) * h
            l.bounds = CGRect(x: 0, y: 0, width: w, height: w * CGFloat(img.height) / CGFloat(img.width))
            l.opacity = 0
            root.addSublayer(l)
            taBlast[name] = l
        }
        Fx.configureSnipeGN(taGN, at: .zero, image: unit.fx["glow_a"])
        body.insertSublayer(taGN, at: 0)
    }

    private func hideTransAm() {
        guard !unit.transam.isEmpty else { return }
        taPanel.opacity = 0
        taBorder.opacity = 0
        for g in taGhosts { g.opacity = 0 }
        taTrail.removeAll()
        for b in taBolts { b.opacity = 0 }
        taBig?.opacity = 0
        for l in taFx.values { l.opacity = 0 }
        for l in taBlast.values { l.opacity = 0 }
        taGN.birthRate = 0
        if plan.mode != .cycle { charge.birthRate = 0 }
        sprite.shadowOpacity = 0
    }

    /// Muzzle (root space) and barrel direction (y up) of the Trans-Am sniping shot, with the body moved by `offset`
    /// and turned by `lean` radians around its pinned point.
    private func taFirePoint(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, dir: CGPoint) {
        let rig = unit.rig
        let r = rotate(bodyPoint(rig.taSnipeMuzzle ?? .zero, in: unit.anim("ta_snipe")), lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let dv = rig.taSnipeDir ?? CGVector(dx: -1, dy: 0)
        let len = max(0.001, hypot(dv.dx, dv.dy))
        return (muzzle, rotate(CGPoint(x: dv.dx / len, y: -dv.dy / len), lean))
    }

    /// ⑥ at `d` seconds in: where it is (× unitHeight), whether it is mid-dash, and seconds since its shot here.
    private func taDash(_ d: Double) -> (at: CGPoint, dashing: Bool, sinceShot: Double?) {
        let step = TA.dashTime + TA.hold
        var from = CGPoint.zero
        for (i, to) in (TA.stops + [CGPoint(x: 0, y: TA.rise)]).enumerated() {
            let s = Double(i) * step
            if d < s + TA.dashTime {
                let u = CGFloat(max(0, (d - s) / TA.dashTime))
                let e = u * u * (3 - 2 * u)
                return (CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e), true, nil)
            }
            if i < TA.stops.count && d < s + step {
                let since = d - s - TA.dashTime - 0.1
                return (to, false, since >= 0 ? since : nil)
            }
            from = to
        }
        return (.zero, false, nil)
    }

    private func taFrame(t: Double) -> (String, Int) {
        let c = t.truncatingRemainder(dividingBy: TA.period)
        // 等你回覆's standing pose (stand frame 0, facing left; 10/30) in normal colours until the opening's panel
        // starts shutting (the video has turned it red by then), and again once ⑪'s white flash has swallowed the red
        if c < TA.intro.upperBound - TA.shutter || c >= TA.release.lowerBound + TA.drain { return ("stand", 0) }
        if c < TA.first.lowerBound { return ("ta_stand", 0) }
        func lit(_ since: Double?) -> Int { (since ?? -1) >= 0 && (since ?? 0) < TA.lit ? 1 : 0 }
        if TA.first.contains(c) { return ("ta_snipe", lit(c - TA.first.lowerBound - TA.firstShot)) }
        if TA.dash.contains(c) {
            let d = c - TA.dash.lowerBound
            let s = taDash(d)
            // the last dash, back home just before Lockon's cut-in, glides in the sniping pose: no standing pose
            // next to the cut-in (10/30)
            let homing = d >= Double(TA.stops.count) * (TA.dashTime + TA.hold)
            return s.dashing && !homing ? ("ta_stand", 0) : ("ta_snipe", lit(s.sinceShot))
        }
        if c >= TA.burst.lowerBound && c < TA.release.lowerBound {
            let e = c - TA.burst.lowerBound
            return ("ta_snipe", e >= TA.charge.lowerBound && e < TA.bigShot + TA.bigHold ? 1 : 0)
        }
        return ("ta_snipe", 0)
    }

    /// The panel for ①②, the game's opening as the video ran it: the camera coming down onto the head, the eyes
    /// flashing, the black cut, the TRANS-AM screen, the standing body turning red. It opens and shuts like Lockon's
    /// panel while the unit behind fades out; its edge goes pink with the screen and red with the standing shot.
    private func updateTAPanel(_ c: Double) {
        guard TA.intro.contains(c) else {
            taPanel.opacity = 0
            taBorder.opacity = 0
            return
        }
        let open = min(progress(c - TA.intro.lowerBound, 0...TA.shutter), progress(TA.intro.upperBound - c, 0...TA.shutter))
        taPanel.opacity = 1
        taBorder.opacity = 1
        let s = CATransform3DMakeScale(1, max(0.02, open), 1)
        taPanel.transform = s
        taBorder.transform = s
        body.opacity = Float(1 - open)
        let i = Int((c - TA.intro.lowerBound) * unit.rig.taScreenFPS)
        if !taScreen.isEmpty { taSystem.contents = taScreen[min(i, taScreen.count - 1)] }
        taSystem.opacity = 1
        let cuts = unit.rig.taIntroCuts
        let border = cuts.count == 2 ? (i < cuts[0] ? Hud.line : i < cuts[1] ? TA.pink : TA.red) : TA.pink
        taBorder.strokeColor = border
        taBorder.shadowColor = border
    }

    private func updateTransAm(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        guard active, !unit.transam.isEmpty else { hideTransAm(); return }
        let h = unitHeight
        let t = max(0, now - trackStart)
        let c = t.truncatingRemainder(dividingBy: TA.period)
        for b in taBolts { b.opacity = 0 }
        taBig?.opacity = 0
        for l in taFx.values { l.opacity = 0 }
        for l in taBlast.values { l.opacity = 0 }
        charge.birthRate = 0
        for g in taGhosts { g.opacity = 0 }

        updateTAPanel(c)
        if TA.lockon.contains(c) {
            updateCutin(c - TA.lockon.lowerBound)
        } else if c >= TA.burst.lowerBound && c < TA.burst.lowerBound + 0.25 {
            closeCutin(c - TA.burst.lowerBound)
        }

        // ⑩ it fires the full-power shot from higher up so the beam has room before the window's bottom edge. The
        // dashes climb to that height and end there (10/30), so it holds it through Lockon's cut-in and ⑩, and comes
        // back down as the red drains.
        var rise: CGFloat = 0
        if c >= TA.lockon.lowerBound {
            rise = TA.rise * h * (TA.release.contains(c)
                ? 1 - progress(c - TA.release.lowerBound, 0...(TA.release.upperBound - TA.release.lowerBound)) : 1)
        }
        // The target: along the barrel from where it fires, high enough that the locked reticle stays in the
        // window; the name tag slides right to clear it (as in the sniping cycle).
        let rest = taFirePoint(offset: CGPoint(x: offset.x, y: offset.y + rise), lean: 0)
        let lockedSize = floatLock?.extent(closeIn: 1) ?? 12
        let floor = -root.position.y + 2 + lockedSize
        let reach = min(boltRange * 0.75, max(20, (rest.muzzle.y - floor) / max(0.2, -rest.dir.y)))
        let aimPoint = CGPoint(x: rest.muzzle.x + rest.dir.x * reach, y: rest.muzzle.y + rest.dir.y * reach)
        tag.position.x = max(0, aimPoint.x + lockedSize + 4 + tag.bounds.width / 2) * progress(t, 0...0.4)

        let red = c >= TA.reveal.lowerBound && c < TA.release.upperBound
        var off = CGPoint(x: offset.x, y: offset.y + rise)
        var turn: CGFloat = 0
        var gush: CGFloat = 0
        // A red glow round the body the whole time it is in Trans-Am.
        if red && !TA.release.contains(c) {
            sprite.shadowColor = TA.red
            sprite.shadowOffset = .zero
            sprite.shadowRadius = 6
            sprite.shadowOpacity = 0.55
        } else {
            sprite.shadowOpacity = 0
        }

        /// One of the shot effects at `p`, turned `rot` radians, scaled `k`, at `alpha`.
        func put(_ name: String, at p: CGPoint, rot: CGFloat, scale k: CGFloat, alpha: CGFloat) {
            guard let l = taFx[name] else { return }
            l.position = p
            l.transform = CATransform3DScale(CATransform3DMakeRotation(rot, 0, 0, 1), k, k, 1)
            l.opacity = Float(max(0, min(1, alpha)))
        }

        /// A shot `since` seconds ago from the Trans-Am sniping pose, as Wars draws it: a white flash over the unit,
        /// the kick back along the barrel, the pink beam, and at the muzzle a cloud of light bursting out, a lens
        /// flare that stays while the beam holds, a cross flare and a spiky flash; `ring` adds a shock ring.
        func fire(_ since: Double, beam: CALayer, thick: CGFloat, hold: Double, fade: Double, kick k: CGFloat,
                  ring: Bool = false, to target: CGPoint? = nil) {
            let kk = CGFloat(exp(-since * 7))
            let back = k * kk
            off = CGPoint(x: off.x - rest.dir.x * back, y: off.y - rest.dir.y * back)
            turn = -0.06 * kk * (rest.dir.x < 0 ? 1 : -1)
            let m = taFirePoint(offset: off, lean: turn)
            if since < 0.08 {
                tint.backgroundColor = CGColor(gray: 1, alpha: 1)
                tint.opacity = Float(0.6 * (1 - since / 0.08))
            }
            guard since < hold + fade else { return }
            let f = since < hold ? 1 : CGFloat(1 - (since - hold) / fade)
            // `target`: the beam stops there (the blast sits on its end), else it runs on out of the window
            let full = target.map { max(10, ($0.x - m.muzzle.x) * m.dir.x + ($0.y - m.muzzle.y) * m.dir.y) } ?? boltRange * 1.4
            let len = full * CGFloat(min(1, since / 0.06))
            let w = thick * (0.4 + 0.6 * f) * (1 + 0.06 * CGFloat(sin(now * 70)))
            // the bar's rounded end fades in over 0.28 of its height: start it that far back inside the bore, or a
            // thick beam leaves a gap in front of the muzzle
            let tail = 0.3 * w
            layoutTABeam(beam, from: CGPoint(x: m.muzzle.x - m.dir.x * tail, y: m.muzzle.y - m.dir.y * tail),
                         dir: m.dir, length: len + tail, thick: w, alpha: Float(f))
            let ang = atan2(m.dir.y, m.dir.x)
            // (the bar's bright middle is a fifth of its height and its glow half: beams are drawn twice as thick)
            let size = min(2, sqrt(thick / 24))
            let s = CGFloat(since)
            func ahead(_ d: CGFloat) -> CGPoint { CGPoint(x: m.muzzle.x + m.dir.x * d, y: m.muzzle.y + m.dir.y * d) }
            put("burst", at: ahead(0.12 * h * size), rot: ang, scale: size * (0.5 + 0.7 * min(1, s / 0.1)),
                alpha: 1 - s / 0.35)
            put("lens", at: m.muzzle, rot: 0, scale: size * (1.3 - 0.4 * min(1, s / 0.3)), alpha: f)
            put("cross", at: m.muzzle, rot: ang, scale: size * (0.6 + 0.6 * min(1, s / 0.05)), alpha: 1 - s / 0.18)
            put("spike", at: ahead(0.1 * h * size), rot: ang, scale: size * (0.7 + 0.5 * min(1, s / 0.08)),
                alpha: 1 - s / 0.2)
            if ring {
                put("ring", at: m.muzzle, rot: 0, scale: size * (0.4 + 1.0 * min(1, s / 0.3)), alpha: 0.7 * (1 - s / 0.4))
            }
            gush = max(gush, CGFloat(max(0, 1 - since / 0.4)))
        }

        if TA.reveal.contains(c) {
            // ③ out of the panel in a white flash, red GN particles gushing.
            let e = c - TA.reveal.lowerBound
            tint.backgroundColor = CGColor(gray: 1, alpha: 1)
            tint.opacity = Float(max(0, 0.9 - e * 2.5))
            sprite.shadowOpacity = Float(0.55 + 0.45 * max(0, 1 - e * 1.5))
            sprite.shadowRadius = 6 + 6 * CGFloat(max(0, 1 - e * 1.5))
            gush = CGFloat(max(0, 1 - e / 0.6))
            let lift = 6 * CGFloat(sin(min(1, e / 0.8) * .pi))
            off = CGPoint(x: off.x, y: off.y + lift)
        } else if TA.first.contains(c) {
            let since = c - TA.first.lowerBound - TA.firstShot
            if since >= 0, let b = taBolts.first { fire(since, beam: b, thick: 30, hold: 0.2, fade: 0.25, kick: 7) }
        } else if TA.dash.contains(c) {
            // ⑥ darting about, afterimages left behind on the way.
            let d = c - TA.dash.lowerBound
            let s = taDash(d)
            off = CGPoint(x: off.x + s.at.x * h, y: off.y + s.at.y * h)
            if let since = s.sinceShot, let i = TA.stops.firstIndex(of: s.at) {
                fire(since, beam: taBolts[i % taBolts.count], thick: 18, hold: 0.12, fade: 0.15, kick: 4)
            }
            if s.dashing { gush = max(gush, 0.5) }
            taTrail.append((sprite.contents, sprite.bounds, sprite.anchorPoint,
                            CGPoint(x: body.position.x + off.x, y: body.position.y + off.y)))
            if taTrail.count > TA.ghosts * 3 + 1 { taTrail.removeFirst(taTrail.count - TA.ghosts * 3 - 1) }
            for (k, g) in taGhosts.enumerated() {
                let i = taTrail.count - 1 - (k + 1) * 3
                guard i >= 0 else { continue }
                let p = taTrail[i]
                let moved = hypot(p.at.x - body.position.x - off.x, p.at.y - body.position.y - off.y)
                g.contents = p.image
                g.bounds = p.bounds
                g.anchorPoint = p.anchor
                g.position = p.at
                g.opacity = moved > 3 ? Float(0.45 * (1 - Double(k) / Double(TA.ghosts))) : 0
            }
        } else if c >= TA.burst.lowerBound && c < TA.release.upperBound {
            // ⑩ charge at the muzzle, then the full-power beam; the target blows up; ⑪ the red drains away.
            let e = c - TA.burst.lowerBound
            if TA.charge.contains(e) {
                // a ball of light swelling at the muzzle, rings closing in on it, particles drawn in
                let m = taFirePoint(offset: off, lean: 0)
                let p = CGFloat((e - TA.charge.lowerBound) / (TA.charge.upperBound - TA.charge.lowerBound))
                put("orb", at: m.muzzle, rot: 0, scale: 0.5 + 1.5 * p, alpha: 0.5 + 0.5 * p)
                let q = (p * 3).truncatingRemainder(dividingBy: 1)
                put("ring", at: m.muzzle, rot: 0, scale: 1.6 - 1.3 * q, alpha: 0.9 * q)
                charge.emitterPosition = bodyPoint(unit.rig.taSnipeMuzzle ?? .zero, in: unit.anim("ta_snipe"))
                charge.birthRate = 1
            }
            let since = e - TA.bigShot
            if since < 0 { taHit = nil } else if taHit == nil { taHit = aimPoint }
            let hit = taHit ?? aimPoint
            if since >= 0, let big = taBig {
                if since < TA.bigHold + TA.bigFade {
                    // the beam's weight shakes it (before the shot is laid out, so the beam shakes with the muzzle)
                    off = CGPoint(x: off.x + 2.5 * CGFloat(sin(now * 73)), y: off.y + 2 * CGFloat(sin(now * 91 + 1)))
                    gush = 1
                }
                fire(since, beam: big, thick: 90, hold: TA.bigHold, fade: TA.bigFade, kick: 12, ring: true, to: hit)
            }
            if e >= TA.charge.lowerBound && e < TA.bigShot + TA.bigHold + 0.3 {
                let pulse: CGFloat = since >= 0 && since < 0.2 ? 1 + CGFloat(0.2 - since) * 2.5 : 1
                floatAim(hit, closeIn: 1, t: now, flash: pulse,
                         alpha: since > TA.bigHold ? Float(max(0, 1 - (since - TA.bigHold) / 0.3)) : 0.95)
            }
            let be = since - 0.12
            if be >= 0 {
                func blast(_ name: String, at d: CGPoint, delay: Double, grow: ClosedRange<CGFloat>, growTime: Double,
                           life: Double, spin: CGFloat = 0) {
                    guard let l = taBlast[name] else { return }
                    let q = be - delay
                    guard q >= 0, q < life else { return }
                    let g = grow.lowerBound + (grow.upperBound - grow.lowerBound) * CGFloat(min(1, q / growTime))
                    l.position = CGPoint(x: hit.x + d.x * h, y: hit.y + d.y * h)
                    l.transform = CATransform3DScale(CATransform3DMakeRotation(spin * CGFloat(q), 0, 0, 1), g, g, 1)
                    l.opacity = Float(min(1, q / 0.05) * max(0, 1 - max(0, q - life * 0.45) / (life * 0.55)))
                }
                blast("flash", at: .zero, delay: 0, grow: 0.5...2.4, growTime: 0.1, life: 0.35)
                blast("hitGlow", at: .zero, delay: 0, grow: 1...2.2, growTime: 0.2, life: 0.5)
                blast("fireC", at: .zero, delay: 0.03, grow: 0.5...1.6, growTime: 0.35, life: 1.3)
                blast("fireA", at: CGPoint(x: -0.14, y: 0.08), delay: 0.12, grow: 0.5...1.4, growTime: 0.3, life: 1.0)
                blast("fireB", at: CGPoint(x: 0.13, y: -0.06), delay: 0.22, grow: 0.5...1.4, growTime: 0.3, life: 1.0)
                blast("sparkBig", at: .zero, delay: 0.02, grow: 0.6...1.4, growTime: 0.2, life: 0.45, spin: 1.5)
                blast("smokeA", at: CGPoint(x: -0.05, y: 0.12), delay: 0.35, grow: 0.6...2.0, growTime: 1.3, life: 1.6)
                blast("smokeB", at: CGPoint(x: 0.08, y: 0.05), delay: 0.5, grow: 0.6...1.8, growTime: 1.2, life: 1.4)
            }
            if TA.release.contains(c) {
                // ⑪ a white flash swallows the red pose and lets go of 等你回覆's standing pose (the Trans-Am pose
                // has no normal-colour copy to drain into).
                let r = c - TA.release.lowerBound
                tint.backgroundColor = CGColor(gray: 1, alpha: 1)
                tint.opacity = Float(r < TA.drain ? 0.9 * r / TA.drain : max(0, 0.9 * (1 - (r - TA.drain) / 0.5)))
                if r >= TA.drain && r < TA.drain + fadeTime {
                    // swap at once under the white (a cross-fade would let the red pose show through un-whitened)
                    ghost.opacity = 0
                    sprite.opacity = 1
                }
                // and a flare of light over the body hides the change of outline
                let fl = r - TA.drain
                if abs(fl) < 0.3 {
                    let core = bodyPoint(unit.rig.taSnipeCore ?? .zero, in: unit.anim("ta_snipe"))
                    put("lens", at: CGPoint(x: body.position.x + off.x + core.x, y: body.position.y + off.y + core.y),
                        rot: 0, scale: 1.6 + 0.6 * CGFloat(fl), alpha: 1 - CGFloat(abs(fl) / 0.3))
                }
                sprite.shadowColor = TA.red
                sprite.shadowRadius = 6
                sprite.shadowOpacity = Float(0.55 * max(0, 1 - r / TA.drain))
            }
        }
        body.transform = CATransform3DRotate(CATransform3DMakeTranslation(off.x, off.y, 0), turn, 0, 0, 1)

        // GN particles from the body's middle: the sniping fan, pushed harder at bursts and shots; green as in every
        // state, Trans-Am too (10/30).
        let pose = taFrame(t: t).0
        let anim = unit.anim(pose)
        if pose == "stand" {
            taGN.emitterPosition = CGPoint(x: h * 0.02, y: h * 0.06)     // where 等你回覆 releases them (configureIdle)
        } else {
            let core = (pose == "ta_stand" ? unit.rig.taStandCore : pose == "ta_snipe" ? unit.rig.taSnipeCore
                        : unit.rig.snipeCore) ?? .zero
            taGN.emitterPosition = bodyPoint(core, in: anim)
        }
        taGN.setValue(Hud.gnParticle, forKeyPath: "emitterCells.drift.color")
        Fx.applySnipeGN(TA.fan.mixed(with: TA.gush, gush), to: taGN, active: true)
    }

    // MARK: working — 舉槍 → 雙槍連射 (its own frames "pistol", timings, layers and particles; nothing shared)
    //
    // Frames (tools/build_units.py, from poses/pistol_rig_v11.json): 0–2 the arms coming up, 3 aim, 4 the right
    // gun's recoil, 5 the left gun's. Each frame's muzzles and gun directions are measured on the rig.

    private enum Burst {
        static let raise = 0.45         // 舉槍: frames 0 → 3
        static let gap = 0.13           // between shots; the two guns take turns, right first
        static let shots = 12           // per burst
        static let pause = 0.9          // holding aim between bursts
        static var period: Double { Double(shots) * gap + pause }
        static let kick = 0.07          // a gun's recoil frame and muzzle flash last this long
        static let boltLife = 0.42
        static let aimFrame = 3
    }

    private var pistolBolts: [CALayer] = []
    private let pistolFlashes = [CALayer(), CALayer()]
    private let pistolGN = CAEmitterLayer()

    private func buildPistols() {
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

    private func hidePistols() {
        pistolGN.birthRate = 0
        for l in pistolBolts { l.opacity = 0 }
        for f in pistolFlashes { f.opacity = 0 }
    }

    private func pistolFrame(t: Double) -> Int {
        if t < Burst.raise { return min(Burst.aimFrame, Int(t / Burst.raise * Double(Burst.aimFrame))) }
        let c = (t - Burst.raise).truncatingRemainder(dividingBy: Burst.period)
        let k = Int(c / Burst.gap)
        if k < Burst.shots && c - Double(k) * Burst.gap < Burst.kick { return Burst.aimFrame + 1 + k % 2 }
        return Burst.aimFrame
    }

    private func updatePistols(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        let rig = unit.rig
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

    // MARK: permission (要你批准) — 防禦待命: the full shield closes, a GN field rises around it, "!" blinks
    //
    // Frames are the shared "shield" set (played as a hold). The field is G Generation Wars' own GN フィールド pieces
    // (units/<id>/field/, cut from its GNF atlas, nothing drawn or tinted): the soft glow and two sparkle spheres behind
    // the Gundam, the rim and the bright arc along the bottom in front of it, as in the battle animation. The field is
    // about twice the Gundam's height, so the Gundam floats up a little while it holds; its timings and layers are
    // this state's own.

    private enum Field {
        static let riseFrom = 0.3       // the field starts growing as the shield finishes closing…
        static let riseTime = 0.5       // …and is full size after this long
        static let float: CGFloat = 0.55    // × unitHeight: how far the Gundam floats up inside it (keeps the bright
                                            // bottom of the field clear of the name tag)
        static let below: CGFloat = 0.06    // × the field's size: its centre sits this far below the Gundam's
        static let breathe = 1.8        // seconds per slow swell
        static let shimmer = 2.4        // the two sparkle spheres trade places this often
        /// Attack, as in the battle video (167–173.8 s): the Gundam (drawn small, so it has room) dashes about with its
        /// field while shells come in from the lower left; the first ones streak through where it just was, then it
        /// cannot get clear: shells burst on the field right in front of it, it is knocked back, the last one bursts big,
        /// the smoke clears and it drifts back to its place; repeating.
        static let size: CGFloat = 0.72     // the Gundam's (and its field's) size in this state
        static let attackFrom = 1.0     // seconds after the state starts
        static let volley = 5.6         // seconds per volley
        static let flight = 0.3         // a shell's flight time to where it was aimed
        static let boom = 1.4           // how long a burst (flash, fire, smoke) lasts
        /// Where the Gundam dashes to (× unitHeight from its place, + = right / up) and when (seconds into a volley):
        /// each move eases from the previous point, the Gundam holding (and hovering) in between.
        static let moves: [(at: ClosedRange<Double>, to: CGPoint)] = [
            (0.38...0.6, CGPoint(x: -0.5, y: 0.42)), (1.0...1.22, CGPoint(x: 0.1, y: 0.12)),
            (1.62...1.84, CGPoint(x: -0.32, y: 0.26)), (2.34...2.5, CGPoint(x: -0.2, y: 0.36)),
            (4.3...5.0, CGPoint(x: 0, y: 0))]
        /// Each shell: when it is fired (seconds into a volley; it reaches its aim `flight` later), aimed where the Gundam
        /// is then; whether it hits (bursting right in front of the Gundam, `dx`/`dy` × unitHeight from its middle) or
        /// streaks past; the angle it comes in at (degrees above level, travelling right); how big its burst is.
        /// The first two waves are three shells each (the later ones chasing it as it dashes). The hits land on
        /// different parts of the Gundam in turn (× unitHeight from its middle, measured on the shield frame): left
        /// shoulder, right shield, legs, lower right shield, the shoulder again, then the biggest in the middle — never
        /// all on one side.
        static let shots: [(at: Double, hits: Bool, dx: CGFloat, dy: CGFloat, climb: CGFloat, size: CGFloat)] = [
            (0.22, false, 0, 0, 24, 1), (0.3, false, 0, 0, 19, 1), (0.38, false, 0, 0, 15, 1),
            (0.85, false, 0, 0, 16, 1), (0.93, false, 0, 0, 11, 1), (1.01, false, 0, 0, 21, 1),
            (1.55, false, 0, 0, 24, 1),
            (2.3, true, -0.3, 0.13, 16, 0.6), (2.45, true, 0.14, 0.26, 20, 0.6), (2.6, true, -0.16, -0.36, 6, 0.6),
            (2.75, true, 0.32, -0.16, 10, 0.6), (2.9, true, -0.24, 0.2, 13, 0.55), (3.1, true, -0.05, -0.05, 5, 2.0)]
        /// Opacity of each piece (the game draws them additively and faint: clear in the middle, lit at the edge and
        /// the bottom). The arc is laid twice for the bright glow along the bottom.
        static let look: [String: Float] = ["glow": 0.04, "sphereA": 0.15, "sphereB": 0.12, "ring": 0.45, "arc": 1,
                                            "arc2": 0.8]
    }

    private let fieldBack = CALayer()
    private let fieldFront = CALayer()
    private var fieldPieces: [String: CALayer] = [:]
    /// One set per shell of a volley: the shell and its glow, then the burst's flash, fires, smokes and embers.
    private var attackSets: [[String: CALayer]] = []

    /// The field's radius on screen: about the Gundam's height.
    private var fieldRadius: CGFloat { unitHeight * 1.0 }

    private func buildField() {
        let side = fieldRadius / max(0.1, unit.rig.fieldRim)    // each picture's width puts the sphere on the radius
        let rect = CGRect(x: 0, y: 0, width: side, height: side)
        for (container, names) in [(fieldBack, ["glow", "sphereB", "sphereA"]), (fieldFront, ["ring", "arc", "arc2"])] {
            container.bounds = rect
            container.opacity = 0
            for name in names {
                let l = CALayer()
                l.contents = unit.field[name == "arc2" ? "arc" : name]
                l.frame = rect
                l.opacity = Field.look[name] ?? 1
                container.addSublayer(l)
                fieldPieces[name] = l
            }
        }
        root.insertSublayer(fieldBack, below: body)
        root.insertSublayer(fieldFront, above: body)
        // GN particles left behind in the air as it dashes (emitted in the stage's space, so they stay put).
        Fx.configureDashTrail(dashTrail, unitHeight: unitHeight * Field.size, image: unit.fx["glow_a"])
        root.insertSublayer(dashTrail, below: fieldBack)
        let h = unitHeight
        // Sizes in points (× unitHeight) of each piece, as wide as tall unless the picture says otherwise.
        let sizes: [String: CGFloat] = ["smokeA": 0.95, "smokeB": 0.9, "fireA": 0.82, "fireB": 0.7, "fireC": 0.55,
                                        "embers": 0.6, "flash": 0.75, "shellGlow": 0.36, "shell": 0.26]
        for _ in Field.shots {
            var set: [String: CALayer] = [:]
            for name in ["smokeA", "smokeB", "fireA", "fireB", "fireC", "embers", "flash", "shellGlow", "shell"] {
                guard let img = unit.attack[name] else { continue }
                let l = CALayer()
                l.contents = img
                let w = (sizes[name] ?? 0.4) * h
                l.bounds = CGRect(x: 0, y: 0, width: w, height: w * CGFloat(img.height) / CGFloat(img.width))
                l.opacity = 0
                root.addSublayer(l)
                set[name] = l
            }
            attackSets.append(set)
        }
    }

    private func hideField() {
        fieldBack.opacity = 0
        fieldFront.opacity = 0
        for set in attackSets { for l in set.values { l.opacity = 0 } }
        dashTrail.birthRate = 0
        bubble.opacity = 1
        if !CATransform3DIsIdentity(bubble.transform) {
            bubble.transform = CATransform3DIdentity
            brackets.transform = CATransform3DIdentity
        }
    }

    private func updateField(now: CFTimeInterval, offset: CGPoint, active: Bool) {
        guard active, !unit.field.isEmpty else { hideField(); return }
        let t = max(0, now - trackStart)
        let anim = unit.anim(plan.anim)
        let p = min(1, max(0, (t - Field.riseFrom) / Field.riseTime))
        let grow = CGFloat(1 - pow(1 - p, 3))
        let h = unitHeight
        let k = Field.size
        let c = t >= Field.attackFrom ? (t - Field.attackFrom).truncatingRemainder(dividingBy: Field.volley) : -1
        // Where the Gundam is: its place (floated up as the field forms), plus the dash it is in, plus a gentle hover,
        // plus the knock-back from hits.
        let lift = Field.float * h * grow
        let hover = CGPoint(x: CGFloat(sin(t * 2 * .pi / 5.3)) * 0.03 * h * grow,
                            y: CGFloat(sin(t * 2 * .pi / 3.2)) * 0.025 * h * grow)
        let dash = dashOffset(c)
        let prev = dashOffset(c - 1.0 / 60)
        let hits = updateAttack(c: c, at: { cc in self.middle(offset: offset, lift: lift, anim: anim, move: self.dashOffset(cc)) })
        let move = CGPoint(x: dash.x * h + hover.x + hits.knock.x + hits.shake.x,
                           y: dash.y * h + lift + hover.y + hits.knock.y + hits.shake.y)
        // Leaning into each dash, GN particles streaming off behind it.
        let vx = (dash.x - prev.x) * h * 60
        let speed = hypot(vx, (dash.y - prev.y) * h * 60)
        let lean = max(-0.2, min(0.2, -vx * 0.0006))
        let anchor = CGPoint(x: body.position.x + offset.x + move.x, y: body.position.y + offset.y + move.y)
        body.transform = CATransform3DRotate(CATransform3DScale(
            CATransform3DMakeTranslation(anchor.x - body.position.x, anchor.y - body.position.y, 0), k, k, 1), lean, 0, 0, 1)
        let core = unit.rig.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        let mid = CGPoint(x: anchor.x + core.x * k, y: anchor.y + core.y * k)
        dashTrail.emitterPosition = mid
        dashTrail.birthRate = speed > h * 0.6 ? 1 : 0
        // The "!" marker and the alert corners go along with it, drawn around the smaller Gundam (scaled about the
        // same point the Gundam is).
        let pin = body.position
        bubble.transform = CATransform3DMakeTranslation((k - 1) * (bubble.position.x - pin.x) + move.x,
                                                        (k - 1) * (bubble.position.y - pin.y) + move.y, 0)
        brackets.transform = CATransform3DScale(CATransform3DMakeTranslation((1 - k) * pin.x + move.x,
                                                                             (1 - k) * pin.y + move.y, 0), k, k, 1)
        let centre = CGPoint(x: mid.x, y: mid.y - Field.below * fieldRadius * 2 * k)
        let swell = CGFloat(1 + 0.012 * sin(t * 2 * .pi / Field.breathe))
        let s = (0.3 + 0.7 * grow) * swell * k
        for f in [fieldBack, fieldFront] {
            f.position = centre
            f.transform = CATransform3DMakeScale(s, s, 1)
            f.opacity = Float(p)
        }
        // The two sparkle spheres turn slowly against each other and trade brightness: the particles glitter.
        let w = Float(sin(t * 2 * .pi / Field.shimmer))
        fieldPieces["sphereA"]?.transform = CATransform3DMakeRotation(CGFloat(-t * 2 * .pi / 30), 0, 0, 1)
        fieldPieces["sphereB"]?.transform = CATransform3DMakeRotation(CGFloat(t * 2 * .pi / 22), 0, 0, 1)
        fieldPieces["sphereA"]?.opacity = (Field.look["sphereA"] ?? 0) * (1 + 0.35 * w) + Float(0.2 * hits.flash)
        fieldPieces["sphereB"]?.opacity = (Field.look["sphereB"] ?? 0) * (1 - 0.35 * w)
        fieldPieces["arc"]?.opacity = (Field.look["arc"] ?? 1) * Float(0.8 + 0.2 * sin(t * 2 * .pi / Field.breathe))
        // A hit lights the whole surface up for a moment.
        fieldPieces["ring"]?.opacity = (Field.look["ring"] ?? 0) + Float(0.55 * hits.flash)
        // "!" blinks while it waits for the go-ahead.
        bubble.opacity = Int(now * 3) % 2 == 0 ? 1 : 0.3
    }

    /// Where the dashes have taken the Gundam at a time in the volley (× unitHeight from its place).
    private func dashOffset(_ c: Double) -> CGPoint {
        guard c >= 0 else { return .zero }
        var at = CGPoint.zero
        for m in Field.moves {
            if c <= m.at.lowerBound { break }
            let u = CGFloat(min(1, (c - m.at.lowerBound) / (m.at.upperBound - m.at.lowerBound)))
            let e = u * u * (3 - 2 * u)
            at = CGPoint(x: at.x + (m.to.x - at.x) * e, y: at.y + (m.to.y - at.y) * e)
            if c < m.at.upperBound { break }
        }
        return at
    }

    /// The Gundam's middle on screen for a given dash offset (without hover or knock-back).
    private func middle(offset: CGPoint, lift: CGFloat, anim: Anim, move: CGPoint) -> CGPoint {
        let core = unit.rig.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        return CGPoint(x: body.position.x + offset.x + move.x * unitHeight + core.x * Field.size,
                       y: body.position.y + offset.y + lift + move.y * unitHeight + core.y * Field.size)
    }

    private func fieldCentre(offset: CGPoint, lift: CGFloat, anim: Anim) -> CGPoint {
        let core = unit.rig.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        return CGPoint(x: body.position.x + offset.x + core.x,
                       y: body.position.y + offset.y + lift + core.y - Field.below * fieldRadius * 2)
    }

    private let dashTrail = CAEmitterLayer()

    /// Shells fly in from the lower left, aimed where the Gundam is when they are fired: the early ones streak through
    /// the spot it has just left, the last ones burst on the field right in front of it. `at(c)` = the Gundam's middle
    /// at volley time c. Returns the knock-back, the shake and how bright the field flashes.
    private func updateAttack(c: Double, at: (Double) -> CGPoint) -> (knock: CGPoint, shake: CGPoint, flash: CGFloat) {
        for set in attackSets { for l in set.values { l.opacity = 0 } }
        guard c >= 0 else { return (.zero, .zero, 0) }
        let h = unitHeight
        var flash: CGFloat = 0
        var knock = CGPoint.zero, shake = CGPoint.zero
        func put(_ l: CALayer?, _ q: CGPoint, scale: CGFloat, alpha: CGFloat, extra: CATransform3D? = nil) {
            guard let l else { return }
            l.position = q
            let base = CATransform3DMakeScale(scale * Field.size, scale * Field.size, 1)
            l.transform = extra.map { CATransform3DConcat($0, base) } ?? base
            l.opacity = Float(max(0, min(1, alpha)))
        }
        for (i, shot) in Field.shots.enumerated() where i < attackSets.count {
            let set = attackSets[i]
            let climb = shot.climb * .pi / 180
            let dir = CGPoint(x: cos(climb), y: sin(climb))
            let aim = at(shot.at)                       // where the Gundam was when this shell was fired
            let land = shot.at + Field.flight
            let span = h * 2.6                          // distance flown to the aim point
            let fly = c - shot.at
            // A miss keeps going past the spot (and off), a hit stops where it bursts.
            let flyEnd = shot.hits ? Field.flight : Field.flight * 2.2
            if fly >= 0 && fly < flyEnd {
                let d = span * CGFloat(fly / Field.flight) - span
                let q = CGPoint(x: aim.x + dir.x * d, y: aim.y + dir.y * d)
                let turn = CATransform3DMakeRotation(atan2(dir.y, dir.x) - .pi / 2, 0, 0, 1)
                let fade = shot.hits ? 1 : CGFloat(min(1, (flyEnd - fly) / 0.12))
                put(set["shell"], q, scale: 1.3, alpha: fade, extra: CATransform3DScale(turn, 0.9, 1.6, 1))
                put(set["shellGlow"], CGPoint(x: q.x - dir.x * h * 0.09, y: q.y - dir.y * h * 0.09), scale: 1.3,
                    alpha: 0.55 * fade, extra: CATransform3DScale(turn, 0.6, 2.2, 1))
            }
            guard shot.hits else { continue }
            let age = c - land
            guard age >= 0 && age < Field.boom else { continue }
            let e = CGFloat(age)
            let z = shot.size
            // On the Gundam where it is when the shell lands, knock-back from the earlier hits included.
            let m = at(land)
            let kb = knockBack(land - 0.001)
            let hit = CGPoint(x: m.x + kb.x + shot.dx * h * Field.size, y: m.y + kb.y + shot.dy * h * Field.size)
            let ease = { (x: CGFloat) in 1 - (1 - min(1, max(0, x))) * (1 - min(1, max(0, x))) }
            func show(_ name: String, _ q: CGPoint, scale: CGFloat, alpha: CGFloat, spin: CGFloat = 0) {
                put(set[name], q, scale: scale * z, alpha: alpha, extra: CATransform3DMakeRotation(spin, 0, 0, 1))
            }
            let r = h * Field.size * z
            // White flash first…
            show("flash", hit, scale: 0.7 + 1.6 * ease(e / 0.12), alpha: 1 - e / 0.18)
            // …the fireballs swell and burn out…
            let spin = CGFloat(i) * 1.7
            show("fireA", hit, scale: 0.45 + 0.9 * ease(e / 0.5), alpha: e < 0.28 ? 1 : 1 - (e - 0.28) / 0.3, spin: spin)
            show("fireB", CGPoint(x: hit.x - r * 0.12, y: hit.y + r * 0.08), scale: 0.4 + 0.8 * ease((e - 0.05) / 0.45),
                 alpha: e < 0.05 ? 0 : (e < 0.32 ? 1 : 1 - (e - 0.32) / 0.3), spin: -spin)
            show("fireC", CGPoint(x: hit.x + r * 0.06, y: hit.y - r * 0.08), scale: 0.5 + 0.9 * ease(e / 0.35),
                 alpha: e < 0.2 ? 1 : 1 - (e - 0.2) / 0.25, spin: spin * 0.5)
            show("embers", hit, scale: 0.7 + 1.1 * ease(e / 0.5), alpha: 1 - e / 0.55)
            // …and the smoke billows up and thins out.
            let rise = r * 0.4 * ease(e / Field.boom)
            show("smokeA", CGPoint(x: hit.x - r * 0.1, y: hit.y + rise), scale: 0.6 + 0.9 * ease(e / 1.1),
                 alpha: e < 0.15 ? e / 0.15 * 0.7 : 0.7 * (1 - (e - 0.15) / (Field.boom - 0.15)), spin: spin)
            show("smokeB", CGPoint(x: hit.x + r * 0.05, y: hit.y + rise * 0.7), scale: 0.5 + 0.8 * ease((e - 0.1) / 1.1),
                 alpha: e < 0.25 ? max(0, (e - 0.1) / 0.15) * 0.6 : 0.6 * (1 - (e - 0.25) / (Field.boom - 0.25)), spin: -spin)
            flash = max(flash, max(0, 1 - e / 0.3))
            let sk = 2.5 * z * max(0, 1 - e / 0.16)
            shake = CGPoint(x: shake.x + sk * CGFloat(sin(Double(e) * 95)), y: shake.y + sk * CGFloat(cos(Double(e) * 80)))
        }
        knock = knockBack(c)
        return (knock, shake, flash)
    }

    /// How far the hits have shoved the Gundam back (right and a little down) at a time in the volley; each shove
    /// eases back as the smoke clears.
    private func knockBack(_ c: Double) -> CGPoint {
        let h = unitHeight
        var knock = CGPoint.zero
        for shot in Field.shots where shot.hits {
            let e = CGFloat(c - shot.at - Field.flight)
            guard e >= 0 && e < CGFloat(Field.boom) + 0.3 else { continue }
            let u = min(1, e / 0.2)
            let back = (1 - (1 - u) * (1 - u)) * max(0, 1 - max(0, e - 0.6) / 1.0)
            knock = CGPoint(x: knock.x + 0.12 * h * min(1, shot.size) * back, y: knock.y - 0.035 * h * min(1, shot.size) * back)
        }
        return knock
    }

    // MARK: question (要你決定) — 支援防禦: stands, dashes forward leaning into a burst of GN particles, braces behind the
    // full shield; a volley of tracers sparks off it all over its face and each round shoves it back; then it boosts
    // forward again, opens the shield and settles back to standing where it began; looping. Frames are the shared
    // "shield" set; timings, rounds, sparks and particles are its own (G Generation Wars pieces in units/<id>/attack/).

    private enum Guard {
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
    private func guardRandom(_ loop: Int, _ round: Int, _ salt: Int) -> CGFloat {
        var x = UInt64(truncatingIfNeeded: loop &* 73856093 ^ round &* 19349663 ^ salt &* 83492791) &+ 0x9E3779B97F4A7C15
        x = (x ^ (x >> 30)) &* 0xBF58476D1CE4E5B9
        x = (x ^ (x >> 27)) &* 0x94D049BB133111EB
        x ^= x >> 31
        return CGFloat(x % 10_000) / 10_000
    }

    /// Where round `i` of loop `loop` lands (× unitHeight from the Gundam's middle): a random part, never the same
    /// part twice in a row, nudged a little.
    private func guardSpot(_ loop: Int, _ i: Int) -> CGPoint {
        let n = Guard.spots.count
        func pick(_ j: Int) -> Int { Int(guardRandom(loop, j, 1) * CGFloat(n)) % n }
        var k = pick(i)
        if i > 0 && k == pick(i - 1) { k = (k + 1 + Int(guardRandom(loop, i, 2) * CGFloat(n - 1))) % n }
        let s = Guard.spots[k]
        return CGPoint(x: s.x + (guardRandom(loop, i, 3) - 0.5) * 0.08, y: s.y + (guardRandom(loop, i, 4) - 0.5) * 0.08)
    }

    /// One set per round: the tracer and its glow, then the hit's glow and sparks.
    private var guardRounds: [[String: CALayer]] = []
    /// GN particles: a strong jet off the back while it dashes or boosts, and — while it is being hit — the slow fan
    /// trailing back and to the right from its middle that 等你回覆 has when it faces left (a copy of those values).
    private let guardJet = CAEmitterLayer()
    private let guardAura = CAEmitterLayer()

    private func buildGuard() {
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

    private func hideGuard() {
        for set in guardRounds { for l in set.values { l.opacity = 0 } }
        guardJet.birthRate = 0
        guardAura.birthRate = 0
    }

    /// 0…1 across a range, eased in and out.
    private func ease(_ c: Double, _ r: ClosedRange<Double>) -> CGFloat {
        let u = CGFloat(min(1, max(0, (c - r.lowerBound) / (r.upperBound - r.lowerBound))))
        return u * u * (3 - 2 * u)
    }

    private func guardFrame(t: Double) -> Int {
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
    private func guardKnock(_ c: Double) -> CGFloat {
        guard let first = Guard.volley.first?.at, let last = Guard.volley.last?.at, c > first else { return 0 }
        var k = Guard.retreat * CGFloat(min(1, (c - first) / (last - first + 0.2)))
        for r in Guard.volley where c > r.at {
            let e = CGFloat(c - r.at)
            k += Guard.shove * min(1, e / 0.05) * max(0, 1 - e / 0.3)
        }
        return k
    }

    private func updateGuard(now: CFTimeInterval, offset: CGPoint, active: Bool) {
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
        let core = unit.rig.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
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

    // MARK: done (做完了) — turned away, GN particles pouring out of the GN drive on its back
    //
    // The "back" frame; the drive's glowing end is rig.driveAt. Its pieces are Wars' own GN effects (units/<id>/drive/):
    // a flare and faint green core breathing on the drive (the flare's middle see-through, so the drive shows), and an
    // emitter letting out dots, sparkles and soft puffs that spill outwards and sink, with a big gush as the state
    // starts. Its own layers and timings.

    private enum Drive {
        static let gush = 0.9           // seconds of the opening gush
        static let pulse = 1.6          // seconds per breath of the glow
    }

    private let driveFlare = CALayer()
    private let driveCore = CALayer()
    private let driveGN = CAEmitterLayer()

    private func buildDrive() {
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

    private func hideDrive() {
        driveFlare.opacity = 0
        driveCore.opacity = 0
        driveGN.birthRate = 0
    }

    private func updateDrive(now: CFTimeInterval, active: Bool) {
        guard active, let at = unit.rig.driveAt, !unit.drive.isEmpty else { hideDrive(); return }
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

    // MARK: sleeping (休息中) — curled up in the closed shields, adrift in zero gravity, slowly letting out GN particles
    //
    // The "turn" frames (build_units.py: the game's own cocoon turn, left 3/4 → front; a mirrored right half broke
    // the turn at the front, so only this half). It slowly turns from the left 3/4 view (its old look) to the front
    // and back, while wandering a little and tilting, each on its own slow period so the drift never quite repeats.
    // GN particles fan out back and to the right like 等你回覆 facing left (never to the left), fewer and slower, the
    // release swelling and easing like slow breathing.
    // Keyed on the state (休息中 only). Its own layer and timings.

    private enum Sleep {
        static let turn = 10.0                 // seconds for left 3/4 → front → left 3/4
        static let settle = 2.0                // seconds for the drift to grow in after it arrives
        static let wander = CGSize(width: 8, height: 4)   // how far it drifts sideways / up and down (points)
        static let rise: CGFloat = 1           // middle height of the drift (was dy -4 when it just sat)
        static let tilt: CGFloat = 5           // degrees it tilts either way
        static let periods = (x: 17.0, y: 11.0, tilt: 13.0)
    }

    private enum SleepGN {
        static let start = 0.5                       // seconds after it arrives
        static let fadeIn = 1.5                      // seconds to come up to full release
        static let breath = 5.0                      // seconds per slow breath of the release
        static let low = 0.4                         // release at the bottom of a breath (fraction of full)
    }

    /// 0 = left 3/4 (where it starts) … 1 = front; eased at both ends.
    private func turnFrame(t: CFTimeInterval, count: Int) -> Int {
        let toFront = 0.5 - 0.5 * cos(max(0, t) * 2 * .pi / Sleep.turn)
        return Int((toFront * Double(count - 1)).rounded())
    }

    /// The zero-gravity drift: sideways, up and down, tilt.
    private func adrift(t: CFTimeInterval) -> (CGFloat, CGFloat, CGFloat) {
        let t = max(0, t)
        let on = CGFloat(min(1, t / Sleep.settle))
        let p = Sleep.periods
        let dx = Sleep.wander.width * CGFloat(sin(t * 2 * .pi / p.x)) * on
        let dy = Sleep.rise + Sleep.wander.height * CGFloat(sin(t * 2 * .pi / p.y + 1)) * on
        let lean = Sleep.tilt * .pi / 180 * CGFloat(sin(t * 2 * .pi / p.tilt + 2)) * on
        return (dx, dy, lean)
    }

    private let sleepGN = CAEmitterLayer()

    private func buildSleep() {
        // the same body point 等你回覆 releases from (configureIdle)
        Fx.configureSleepGN(sleepGN, at: CGPoint(x: unitHeight * 0.02, y: unitHeight * 0.06), image: unit.fx["glow_a"])
        body.insertSublayer(sleepGN, at: 0)
    }

    private func updateSleep(now: CFTimeInterval, active: Bool) {
        let t = now - trackStart - SleepGN.start
        guard active, t > 0 else { sleepGN.birthRate = 0; return }
        let on = min(1, t / SleepGN.fadeIn)
        let breath = SleepGN.low + (1 - SleepGN.low) * (0.5 - 0.5 * cos(t * 2 * .pi / SleepGN.breath))
        sleepGN.birthRate = Float(on * breath)
    }

    // MARK: error (出錯了) — sealed off behind an ERROR tape, shaking under hit after hit until it blows
    //
    // The shield hold frames (shared hold mode, so this keys on the state). On the "glass" in front of it — not on the
    // unit, so it stays put while the unit shakes — one seal tape across its middle (units/<id>/alarm/, drawn by
    // build_units.py; an ERROR plate over its head was taken out at the user's word). Each round small hits land on
    // random body parts (Wars' glow, fireball and sparks), closer together and harder as the round goes on, with a
    // growing tremble, glitchy jumps and a deepening red glow, until a big blast; then it settles and the next round
    // starts. GN particles sputter out in 等你回覆's fan (back and to the right, never left). Its own layers and
    // timings; the opening hit (updateHit) is kept.

    private enum Alarm {
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

    private struct AlarmHit {
        let at: Double
        let spot: CGPoint
        let fire: String
        let side: CGFloat
        let turn: CGFloat
    }

    private var alarmRound = -1
    private var alarmHits: [AlarmHit] = []
    private var alarmSets: [[String: CALayer]] = []
    private var alarmBlast: [String: CALayer] = [:]
    private let alarmTape = CALayer()
    private let alarmGN = CAEmitterLayer()

    private func buildAlarm() {
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

    private func hideAlarm() {
        alarmTape.opacity = 0
        for set in alarmSets { for l in set.values { l.opacity = 0 } }
        for l in alarmBlast.values { l.opacity = 0 }
        alarmGN.birthRate = 0
    }

    /// Round `n`'s hits: closer together as the round goes on, each on a body part picked at random (not the same
    /// one twice running) — the same within a round, different every round.
    private func alarmRoundHits(_ n: Int) -> [AlarmHit] {
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
    private func alarmBuild(_ c: Double) -> CGFloat {
        if c < Alarm.blast { return CGFloat(pow(c / Alarm.blast, 1.6)) }
        return CGFloat(max(0, 1 - (c - Alarm.blast) / Alarm.calm))
    }

    /// The shaking: a tremble that grows through the round, a jolt from every hit, now and then a glitchy jump
    /// sideways, and a big shove at the blast. (dx, dy, lean)
    private func alarmShake(now: CFTimeInterval) -> (CGFloat, CGFloat, CGFloat) {
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

    private func updateAlarm(now: CFTimeInterval, st: CFTimeInterval, active: Bool) {
        guard active, !unit.alarm.isEmpty else { hideAlarm(); return }
        let h = unitHeight
        let anim = unit.anim(plan.anim)
        let t = max(0, now - trackStart)
        let n = Int(t / Alarm.cycle)
        let c = t - Double(n) * Alarm.cycle
        let b = alarmBuild(c)
        let core = unit.rig.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
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

    /// Hit reaction for errors: sparks, a white-then-red flash.
    private func updateHit(now: CFTimeInterval, st: CFTimeInterval) {
        let hit = plan.hit && leavingSince == nil
        sparks.birthRate = hit && st < 0.25 ? 1 : 0
        if hit && st < 0.5 {
            // A smoke ring opens over the body when the hit lands.
            halo.position = body.position
            halo.opacity = Float(max(0, 0.9 - st * 1.8))
            let hs = CGFloat(1 + st * 4)
            halo.transform = CATransform3DMakeScale(hs, hs, 1)
        }
        if hit {
            tint.backgroundColor = st < 0.1 ? CGColor(gray: 1, alpha: 1) : CGColor(red: 1, green: 0.15, blue: 0.1, alpha: 1)
            tint.opacity = st < 0.1 ? 0.7 : Float(st < 1.2 ? 0.32 : 0.18)
        } else {
            tint.opacity = 0
        }
    }

    private func updateHud(now: CFTimeInterval, sniping: Bool) {
        let active = leavingSince == nil && now - born > enterTime
        if !sniping {
            if active && plan.hud == "scan" {
                // Sweeps an area ahead of the unit, as if looking for a target.
                let base = CGPoint(x: -unitHeight * 0.72, y: unitHeight * 0.5)
                reticle.position = CGPoint(x: base.x + CGFloat(sin(now * 0.9)) * 10,
                                           y: base.y + CGFloat(sin(now * 1.7 + 1)) * 10)
                reticle.strokeColor = Hud.green
                reticle.shadowColor = Hud.green
                reticle.transform = CATransform3DMakeRotation(CGFloat(now * 0.8), 0, 0, 1)
                reticle.opacity = 0.9
            } else {
                reticle.opacity = 0
            }
        }
        brackets.opacity = active && plan.hud == "alert" ? (Int(now * 2.5) % 2 == 0 ? 1 : 0.25) : 0
    }

    // MARK: tag and marker

    private func refreshBubble() {
        let mark: String?
        switch state {
        case .thinking: mark = "…"
        case .permission: mark = "!"
        case .question: mark = "?"
        case .done: mark = "✓"
        case .sleeping: mark = "z"
        case .error: mark = "!!"
        case .working, .waiting: mark = nil
        }
        bubble.isHidden = mark == nil
        guard let mark else { return }
        bubble.position = bubbleHome
        let color = stateColor.cgColor
        bubbleText.string = mark
        bubbleText.foregroundColor = color
        bubble.strokeColor = color
        bubble.shadowColor = color
    }

    /// Where the marker sits: over the right shoulder, except with the sniping animation (cycle mode), whose pose
    /// is wider and would be covered there — it goes just past the far shoulder plate instead.
    private var bubbleHome: CGPoint {
        if plan.mode == .cycle, unit.rig.snipeMuzzle != nil {
            let anim = unit.anim(unit.rig.fireAnim)
            let p = bodyPoint(CGPoint(x: anim.size.width + 8, y: 6), in: anim)
            return CGPoint(x: body.position.x + p.x, y: body.position.y + p.y)
        }
        // The twin-pistol pose's head and V-fin reach where the marker usually sits: up and right, above the shield.
        // (0.5, 1.28) brought in towards the body's middle with the pose shrunk to 等你回覆's size (×0.73, 10/30)
        if plan.mode == .pistols { return CGPoint(x: unitHeight * 0.36, y: unitHeight * 0.98) }
        return CGPoint(x: unitHeight * 0.4, y: unitHeight * 1.08)
    }

    /// Two-line HUD tag: "GN-002 ▸ 工作中" over the session title.
    private func refreshLabel() {
        let short = title.count > 11 ? String(title.prefix(10)) + "…" : title
        let mono = NSFont.monospacedSystemFont(ofSize: 9.5, weight: .semibold)
        let s = NSMutableAttributedString(string: unit.code, attributes: [
            .font: mono,
            .foregroundColor: NSColor(red: 0.36, green: 1, blue: 0.69, alpha: 1),
            .kern: 0.4,
        ])
        s.append(NSAttributedString(string: " ▸ \(state.label)\n", attributes: [
            .font: mono,
            .foregroundColor: stateColor,
        ]))
        s.append(NSAttributedString(string: short, attributes: [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: NSColor(white: 0.95, alpha: 1),
        ]))
        tagText.string = s
        let h: CGFloat = 32
        let rect = CGRect(x: 0, y: 0, width: max(ceil(s.size().width) + 18, 70), height: h)
        tag.bounds = rect
        tag.position = CGPoint(x: 0, y: -16)
        tagFrame.frame = rect
        tagFrame.path = Hud.chamfer(rect.insetBy(dx: 0.5, dy: 0.5), cut: 6)
        tagAccent.frame = CGRect(x: 3, y: 7, width: 2, height: h - 14)
        tagText.frame = CGRect(x: 10, y: 1, width: rect.width - 12, height: h - 3)
    }

    private var stateColor: NSColor {
        switch state {
        case .working: return NSColor(red: 0.45, green: 1, blue: 0.6, alpha: 1)
        case .thinking: return NSColor(red: 0.5, green: 0.85, blue: 1, alpha: 1)
        case .permission, .question: return NSColor(red: 1, green: 0.72, blue: 0.3, alpha: 1)
        case .done: return NSColor(red: 0.6, green: 1, blue: 0.5, alpha: 1)
        case .waiting: return NSColor(white: 0.85, alpha: 1)
        case .sleeping: return NSColor(white: 0.6, alpha: 1)
        case .error: return NSColor(red: 1, green: 0.45, blue: 0.4, alpha: 1)
        }
    }
}

/// How the waiting-state GN particles look in one phase of the pose. The phases are blended value by
/// value, so the particles change shape smoothly instead of switching.
struct DriftLook {
    /// Spread (radians) and direction of the drift cell; 0 = +x = behind the unit (it faces left).
    var range: CGFloat
    var longitude: CGFloat
    var velocity: CGFloat
    var yAccel: CGFloat
    /// Push towards +x: particles fall behind, so the unit seems to be moving left through them.
    var xAccel: CGFloat
    /// Layer multipliers: birth rate (drift cell base is 30/s) and speed.
    var rate: CGFloat
    var speed: CGFloat
    /// Faint full-circle halo cell, 0…1 (10/s at 1, times `rate`).
    var halo: CGFloat

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

    func mixed(with o: DriftLook, _ t: CGFloat) -> DriftLook {
        func m(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * t }
        return DriftLook(range: m(range, o.range), longitude: m(longitude, o.longitude),
                         velocity: m(velocity, o.velocity), yAccel: m(yAccel, o.yAccel), xAccel: m(xAccel, o.xAccel),
                         rate: m(rate, o.rate), speed: m(speed, o.speed), halo: m(halo, o.halo))
    }
}

/// The cut-in's lock-on reticle — ring, turning diamond, centre square, four closing arcs — as one group,
/// laid out in its parent's coordinates: over his pupil in the cut-in, and floating over the target.
final class LockHud {
    let group = CALayer()
    private let ring = CALayer()
    private let diamond = CALayer()
    private let square = CALayer()
    private var arcs: [CALayer] = []

    /// `ring`: the ring image's size in points; the other pieces scale with it.
    init(images: [String: CGImage], ring r: CGFloat) {
        func piece(_ name: String, _ w: CGFloat, _ h: CGFloat, _ l: CALayer = CALayer()) -> CALayer {
            l.contents = images[name]
            l.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            l.minificationFilter = .trilinear      // the thin lines stay solid when shrunk a lot
            l.opacity = 0
            group.addSublayer(l)
            return l
        }
        _ = piece("diamond", r * 1.3, r * 1.3, diamond)
        _ = piece("reticle", r, r, ring)
        _ = piece("square", r * 0.32, r * 0.32, square)
        // The square is a thin, half-transparent line in the sheet; a glow keeps it readable over his face.
        square.shadowColor = Hud.green
        square.shadowOpacity = 1
        square.shadowRadius = 1.5
        square.shadowOffset = .zero
        // All four arcs from arc_a: in the sheet arc_d is a dark-green fade frame (the "missing" bottom-right
        // arc) and arc_b / arc_c are different lengths.
        arcs = (0..<4).map { _ in piece("arc_a", r * 0.5, r * 0.45) }
    }

    /// How far the symbol reaches from its centre (the arcs are outermost).
    func extent(closeIn: CGFloat) -> CGFloat {
        ring.bounds.width * (0.95 - 0.35 * closeIn + 0.3)
    }

    /// closeIn 0 = searching (spread out, diamond turning with `spin`) … 1 = locked; flash > 1 pops the ring.
    func layout(at p: CGPoint, closeIn: CGFloat, spin t: Double, flash: CGFloat, alpha: Float) {
        ring.opacity = alpha
        ring.position = p
        let rs = (1.35 - 0.35 * closeIn) * flash
        ring.transform = CATransform3DMakeScale(rs, rs, 1)
        diamond.opacity = alpha * 0.6
        diamond.position = p
        diamond.transform = CATransform3DMakeRotation(CGFloat(t) * 1.2 * (1 - closeIn) + .pi / 4 * closeIn, 0, 0, 1)
        square.opacity = alpha
        square.position = p
        let ss = 2.2 - 1.2 * closeIn
        square.transform = CATransform3DMakeScale(ss, ss, 1)
        let radius = ring.bounds.width * (0.95 - 0.35 * closeIn)
        for (k, arc) in arcs.enumerated() {
            let ang = CGFloat(k) * .pi / 2 + .pi / 4 + (1 - closeIn) * 0.9
            arc.opacity = alpha
            arc.position = CGPoint(x: p.x + cos(ang) * radius, y: p.y + sin(ang) * radius)
            arc.transform = CATransform3DMakeRotation(ang - .pi / 4, 0, 0, 1)
        }
    }

    func hide() {
        for l in group.sublayers ?? [] { l.opacity = 0 }
    }
}

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

/// Particle setups and the soft-dot sprite they use.
private enum Fx {
    static func dot(_ color: CGColor) -> CGImage? {
        let size = 32
        guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let colors = [CGColor(gray: 1, alpha: 1), color, color.copy(alpha: 0) ?? color] as CFArray
        guard let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors,
                                 locations: [0, 0.35, 1]) else { return nil }
        let c = CGPoint(x: size / 2, y: size / 2)
        ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: CGFloat(size) / 2, options: [])
        return ctx.makeImage()
    }

    private static let white = dot(CGColor(gray: 1, alpha: 0.6))

    /// Green GN particles drifting off the unit (trail when flying, burst when done).
    static func configureGN(_ e: CAEmitterLayer, unitHeight: CGFloat, image: CGImage?) {
        let cell = CAEmitterCell()
        cell.contents = image ?? white
        cell.birthRate = 30
        cell.lifetime = 1.2
        cell.velocity = 28
        cell.velocityRange = 18
        cell.emissionRange = .pi * 2
        cell.yAcceleration = -20
        cell.scale = image == nil ? 0.22 : 0.45
        cell.scaleRange = 0.12
        cell.spin = 1.5
        cell.spinRange = 3
        cell.scaleSpeed = -0.12
        cell.alphaSpeed = -0.8
        cell.color = Hud.green
        e.emitterCells = [cell]
        e.emitterPosition = CGPoint(x: 0, y: unitHeight * 0.05)
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: unitHeight * 0.35, height: unitHeight * 0.35)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// GN particles from the drive at the body's centre: a "drift" cell whose spread, direction and speed
    /// change with the pose (see DriftLook), plus a faint full-circle "halo" cell used while resting.
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

    /// Shards thrown off when hit: the sheet's shard pieces if there are any, orange dots otherwise.
    static func configureSparks(_ e: CAEmitterLayer, images: [CGImage]) {
        let sources: [CGImage?] = images.isEmpty ? [white] : images
        e.emitterCells = sources.map { img in
            let cell = CAEmitterCell()
            cell.contents = img
            cell.birthRate = images.isEmpty ? 160 : 70
            cell.lifetime = 0.45
            cell.velocity = 95
            cell.velocityRange = 40
            cell.emissionRange = .pi * 2
            cell.yAcceleration = -160
            cell.scale = images.isEmpty ? 0.12 : 0.45
            cell.scaleSpeed = -0.4
            cell.spin = 6
            cell.spinRange = 10
            cell.alphaSpeed = -2
            cell.color = images.isEmpty ? Hud.orange : CGColor(gray: 1, alpha: 1)
            return cell
        }
        e.emitterPosition = .zero
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: 30, height: 30)
        e.renderMode = .additive
        e.birthRate = 0
    }
}

/// The transparent, click-through strip along the bottom of the screen that holds every Gundam.
final class Stage {
    let window: NSWindow
    private let host = CALayer()
    private var nodes: [String: PetNode] = [:]
    private var leaving: [PetNode] = []
    private var order: [String] = []
    private let units: [String: UnitDef]
    private let pool: Pool
    private var config: Config
    private var timer: Timer?
    private var lastDebugWrite: CFTimeInterval = 0
    private(set) var lastSessions: [SessionInfo] = []

    /// Showcase mode: one Gundam whose state is picked from its right-click menu.
    private(set) var isShowcase = false
    private let showcaseId = "showcase"
    private var mouseTimer: Timer?
    /// Called when a mode is picked from a Gundam's right-click menu (true = showcase / debug, false = normal), so
    /// the app switches modes (and puts the live sessions back when leaving showcase).
    var onPickMode: ((Bool) -> Void)?
    /// Called when "角色設定…" is picked from a Gundam's right-click menu.
    var onOpenSettings: (() -> Void)?
    /// The characters, for the settings panel.
    var unitList: [UnitDef] { units.values.sorted { $0.id < $1.id } }
    /// The lowest a Gundam stands (its name tag below it).
    var floorY: CGFloat { labelBand }
    /// Every recent session (the watcher's list), for picking one for a Gundam by hand.
    var sessionList: [SessionInfo] = []
    /// "管理 session…" from a Gundam's right-click menu: called with the session it follows.
    var onManageSessions: ((String) -> Void)?
    /// Session → the Gundam following it ("GN-002 力天使"), for the session window.
    var shownSessions: [String: String] {
        Dictionary(uniqueKeysWithValues: nodes.values.filter { $0.sessionId != showcaseId }
            .map { ($0.sessionId, "\($0.unit.code) \($0.unit.name)") })
    }

    private var labelBand: CGFloat { config.showLabels ? 34 : 6 }
    /// Each character's size and wandering (character file + the user's changes from the settings panel).
    let characters: CharacterStore
    private var rng = SystemRandomNumberGenerator()
    private var slotWidth: CGFloat { CGFloat(units.keys.map { characters.profile($0).height }.max() ?? 110) * 1.7 }
    private func height(of unit: UnitDef) -> CGFloat { CGFloat(characters.profile(unit.id).height) }
    /// --offscreen: the strip is rendered into a texture instead of a window (for snapshots with particles).
    private var offscreen: OffscreenRenderer?

    init(units: [UnitDef], pool: Pool, config: Config, characters: CharacterStore, offscreen: Bool = false) {
        self.characters = characters
        self.units = Dictionary(uniqueKeysWithValues: units.map { ($0.id, $0) })
        self.pool = pool
        self.config = config
        window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let view = StageView()
        if !offscreen { view.layer = host }
        view.wantsLayer = true
        window.contentView = view
        layoutWindow()
        if offscreen {
            host.frame = CGRect(origin: .zero, size: window.frame.size)
            host.backgroundColor = CGColor(red: 0.22, green: 0.24, blue: 0.3, alpha: 1)
            self.offscreen = OffscreenRenderer(layer: host, size: window.frame.size)
        } else {
            window.orderFrontRegardless()
            // Right-clicking a Gundam opens its menu, in either mode: the strip stays click-through except while the
            // pointer is over a Gundam.
            view.menuAt = { [weak self] p in self?.menu(at: p) }
            let m = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.trackMouse() }
            RunLoop.main.add(m, forMode: .common)
            mouseTimer = m
        }

        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// The screen the Gundams stand on: the one picked in the menu if it is connected, else the main screen (the one
    /// with the menu bar — not NSScreen.main, which follows whichever screen has the focused window).
    var screen: NSScreen? {
        NSScreen.screens.first { $0.localizedName == config.screen } ?? NSScreen.screens.first ?? NSScreen.main
    }

    /// Moves the Gundams to another screen and remembers it (config.json "screen").
    func show(on screen: NSScreen) {
        config.screen = screen.localizedName
        config.save()
        layoutWindow()
    }

    /// "顯示在" submenu: one item per connected screen, the current one ticked.
    func screenMenu() -> NSMenuItem {
        let item = NSMenuItem(title: "顯示在", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        let current = screen
        for (i, s) in NSScreen.screens.enumerated() {
            let main = s == NSScreen.screens.first ? "(主螢幕)" : ""
            let entry = MenuAction.item("\(s.localizedName)\(main)") { [weak self] in self?.show(on: s) }
            entry.state = s == current ? .on : .off
            entry.tag = i
            sub.addItem(entry)
        }
        item.submenu = sub
        return item
    }

    func layoutWindow() {
        guard let screen = screen else { return }
        // The whole screen bar the menu bar and the Dock: the Gundams wander all over it (10/30).
        let vf = screen.visibleFrame
        window.setFrame(vf, display: true)
        relayout()
    }

    var isVisible: Bool {
        get { window.isVisible }
        set { newValue ? window.orderFrontRegardless() : window.orderOut(nil) }
    }

    var showLabels: Bool {
        get { config.showLabels }
        set {
            let before = labelBand
            config.showLabels = newValue
            for n in nodes.values { n.showLabel = newValue }
            layoutWindow()
            for n in nodes.values { n.shift(dy: labelBand - before) }
        }
    }

    func apply(_ sessions: [SessionInfo]) {
        if isShowcase { return }
        lastSessions = sessions
        let ids = sessions.map(\.id)
        let assignment = pool.assign(ids)
        let now = CACurrentMediaTime()
        for s in sessions {
            if let n = nodes[s.id] {
                n.set(state: s.state, title: s.title, toolErrorAt: s.toolErrorAt, now: now)
                continue
            }
            guard let uid = assignment[s.id], let unit = units[uid] else { continue }
            let n = makeNode(id: s.id, unit: unit, at: CGPoint(x: window.frame.width - slotWidth, y: labelBand),
                             showLabel: config.showLabels, now: now)
            n.set(state: s.state, title: s.title, toolErrorAt: s.toolErrorAt, now: now)
            nodes[s.id] = n
            host.addSublayer(n.root)
        }
        let live = Set(ids)
        for (id, n) in nodes where !live.contains(id) {
            n.leave(now: now)
            leaving.append(n)
            nodes[id] = nil
        }
        order = ids.filter { nodes[$0] != nil }
        relayout()
    }

    // MARK: showcase

    /// `state`: what the showcase Gundam starts in (--showcase-state <name>, default 等你回覆).
    func enterShowcase(state: PetState = .waiting) {
        guard !isShowcase, let unit = units.values.sorted(by: { $0.id < $1.id }).first else { return }
        isShowcase = true
        let now = CACurrentMediaTime()
        for (id, n) in nodes {
            n.leave(now: now)
            leaving.append(n)
            nodes[id] = nil
        }
        let n = makeNode(id: showcaseId, unit: unit, at: CGPoint(x: window.frame.width - slotWidth, y: labelBand),
                         showLabel: true, now: now)
        n.set(state: state, title: "展示・右鍵切換狀態", toolErrorAt: nil, now: now)
        nodes[showcaseId] = n
        host.addSublayer(n.root)
        order = [showcaseId]
        relayout()
    }

    func exitShowcase() {
        guard isShowcase else { return }
        isShowcase = false
        if let n = nodes[showcaseId] {
            n.leave(now: CACurrentMediaTime())
            leaving.append(n)
            nodes[showcaseId] = nil
        }
        order = []
    }

    private func trackMouse() {
        let m = NSEvent.mouseLocation
        let p = CGPoint(x: m.x - window.frame.minX, y: m.y - window.frame.minY)
        // Over one of the app's own windows (角色設定, 管理 session) the Gundams never take the click, even when one
        // has wandered on top of it — else that window cannot be used there (10/30).
        let overPanel = NSApp.windows.contains { $0 !== window && $0.isVisible && $0.frame.contains(m) }
        let over = window.isVisible && !overPanel && nodes.values.contains { $0.hitRect.contains(p) }
        if window.ignoresMouseEvents == over { window.ignoresMouseEvents = !over }
    }

    /// A Gundam's right-click menu: the showcase one, or (normal mode) which session it is, then the mode switch.
    private func menu(at p: CGPoint) -> NSMenu? {
        if isShowcase { return showcaseMenu(at: p) }
        guard let n = nodes.values.first(where: { $0.hitRect.contains(p) }) else { return nil }
        let menu = NSMenu()
        let header = NSMenuItem(title: "\(n.unit.code) \(n.unit.name)・\(n.state.label)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if !n.title.isEmpty {
            let title = NSMenuItem(title: n.title, action: nil, keyEquivalent: "")
            title.isEnabled = false
            menu.addItem(title)
        }
        menu.addItem(.separator())
        let sid = n.sessionId
        menu.addItem(MenuAction.item("管理 session…（換監控、釋放）") { [weak self] in self?.onManageSessions?(sid) })
        menu.addItem(.separator())
        addModeItems(to: menu)
        menu.addItem(.separator())
        menu.addItem(MenuAction.item("角色設定…") { [weak self] in self?.onOpenSettings?() })
        if NSScreen.screens.count > 1 { menu.addItem(screenMenu()) }
        return menu
    }

    /// Switches a Gundam from one session to another in place (same Gundam, no exit / entrance).
    func retarget(from old: String, to new: String) {
        guard let n = nodes.removeValue(forKey: old), nodes[new] == nil else { return }
        n.sessionId = new
        nodes[new] = n
        pool.hand(from: old, to: new)
        order = order.map { $0 == old ? new : $0 }
        if let s = sessionList.first(where: { $0.id == new }) {
            n.set(state: s.state, title: s.title, toolErrorAt: s.toolErrorAt, now: CACurrentMediaTime())
        }
    }

    /// "一般模式" / "展示模式（Debug）", the current one ticked.
    private func addModeItems(to menu: NSMenu) {
        let normal = MenuAction.item("一般模式") { [weak self] in self?.onPickMode?(false) }
        normal.state = isShowcase ? .off : .on
        let showcase = MenuAction.item("展示模式（Debug）") { [weak self] in self?.onPickMode?(true) }
        showcase.state = isShowcase ? .on : .off
        menu.addItem(normal)
        menu.addItem(showcase)
    }

    private func showcaseMenu(at p: CGPoint) -> NSMenu? {
        guard isShowcase, let n = nodes[showcaseId], n.hitRect.contains(p) else { return nil }
        let menu = NSMenu()
        let header = NSMenuItem(title: "\(n.unit.code) \(n.unit.name)・展示模式", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        let id = showcaseId
        let states: [PetState] = [.waiting, .thinking, .working, .permission, .question, .done, .sleeping, .error]
        for st in states {
            let item = MenuAction.item(st.label) { [weak self] in
                self?.nodes[id]?.force(state: st, now: CACurrentMediaTime())
            }
            item.state = n.state == st ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(MenuAction.item("重播進場") { [weak self] in self?.replayShowcaseEntrance() })
        menu.addItem(MenuAction.item("工具出錯(抖一下)") { [weak self] in
            self?.nodes[id]?.flashToolError(now: CACurrentMediaTime())
        })
        menu.addItem(.separator())
        addModeItems(to: menu)
        menu.addItem(.separator())
        menu.addItem(MenuAction.item("角色設定…") { [weak self] in self?.onOpenSettings?() })
        if NSScreen.screens.count > 1 { menu.addItem(screenMenu()) }
        return menu
    }

    /// Showcase: switch the Gundam to a state, as the right-click menu does.
    func forceShowcase(_ st: PetState) {
        nodes[showcaseId]?.force(state: st, now: CACurrentMediaTime())
    }

    private func replayShowcaseEntrance() {
        guard let old = nodes[showcaseId] else { return }
        let now = CACurrentMediaTime()
        let state = old.state
        old.root.removeFromSuperlayer()
        let n = makeNode(id: showcaseId, unit: old.unit, at: old.slot, showLabel: true, now: now)
        n.set(state: state, title: "展示・右鍵切換狀態", toolErrorAt: nil, now: now)
        nodes[showcaseId] = n
        host.addSublayer(n.root)
        relayout()
    }

    private func makeNode(id: String, unit: UnitDef, at: CGPoint, showLabel: Bool, now: CFTimeInterval,
                          entering: Bool = true) -> PetNode {
        let n = PetNode(sessionId: id, unit: unit, at: at, unitHeight: height(of: unit), showLabel: showLabel, now: now,
                        entering: entering)
        n.arrived = { [weak self] node, now in self?.rest(node, now: now) }
        return n
    }

    /// Places in the row along the bottom: oldest session at the right edge, newer ones to its left. A Gundam comes
    /// in at its place, and goes back to it in a state that does not wander.
    private func relayout() {
        let right = window.frame.width - 24
        for (i, id) in order.enumerated() {
            nodes[id]?.slot = CGPoint(x: right - slotWidth * (CGFloat(i) + 0.5), y: labelBand)
        }
    }

    // MARK: wandering (10/30)

    /// Each tick: a Gundam that has rested long enough (and, in a looping act, has finished a loop) picks where to go
    /// next by its state's wandering (Wander.next); in a state that does not wander it goes back to its place.
    private func wander(now: CFTimeInterval) {
        let area = CGRect(origin: .zero, size: window.frame.size)
        for n in nodes.values {
            guard n.settled(now: now), !n.isMoving else { continue }
            let profile = characters.profile(n.unit.id)
            let pref = profile.pref(n.state)
            if n.plannedFor != n.stateStart {
                n.plannedFor = n.stateStart
                n.wanderRest = now + (pref.wander ? 0.6 : 0)
            }
            if !pref.wander {
                if hypot(n.pos.x - n.slot.x, n.pos.y - n.slot.y) > 2, n.canDepart(now: now) {
                    n.depart(to: n.slot, speed: pref.speed, now: now)
                }
                continue
            }
            guard now >= n.wanderRest, n.canDepart(now: now) else { continue }
            let others = nodes.values.filter { $0 !== n }.map(\.destination)
            let to = Wander.next(from: n.pos, pref: pref, height: n.unitHeight, area: area, floor: labelBand,
                                 others: others, random: &rng)
            n.depart(to: to, speed: pref.speed, now: now)
        }
    }

    private func rest(_ n: PetNode, now: CFTimeInterval) {
        let stay = characters.profile(n.unit.id).pref(n.state).stay
        let lo = stay.first ?? 4, hi = max(lo, stay.last ?? lo)
        n.wanderRest = now + Double.random(in: lo...hi)
    }

    /// After a character's settings change: rebuild its Gundams in place if its size changed (no entrance).
    func characterChanged(_ id: String) {
        let now = CACurrentMediaTime()
        for (sid, n) in nodes where n.unit.id == id && n.unitHeight != height(of: n.unit) {
            let fresh = makeNode(id: sid, unit: n.unit, at: n.pos, showLabel: sid == showcaseId || config.showLabels,
                                 now: now, entering: false)
            fresh.slot = n.slot
            fresh.set(state: n.state, title: n.title, toolErrorAt: nil, now: now)
            n.root.removeFromSuperlayer()
            nodes[sid] = fresh
            host.addSublayer(fresh.root)
        }
        relayout()
    }

    /// Settings panel's 預覽: showcase mode with the given character and state.
    func preview(_ st: PetState) {
        if !isShowcase { onPickMode?(true) }
        forceShowcase(st)
    }

    private func tick() {
        let now = CACurrentMediaTime()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        wander(now: now)
        for n in nodes.values { _ = n.update(now: now) }
        leaving = leaving.filter { n in
            if n.update(now: now) { return true }
            n.root.removeFromSuperlayer()
            return false
        }
        CATransaction.commit()
        offscreen?.render()
        if config.debug, now - lastDebugWrite > 2 {
            lastDebugWrite = now
            writeDebug()
        }
    }

    private func writeDebug() {
        let dir = Config.dir.appendingPathComponent("logs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let rows = lastSessions.map { s -> [String: String] in
            ["title": s.title, "state": s.state.rawValue, "unit": nodes[s.id]?.unit.name ?? "-", "id": s.id]
        }
        if let data = try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]) {
            try? data.write(to: dir.appendingPathComponent("state.json"))
        }
        snapshot(to: dir.appendingPathComponent("snapshot.png"))
    }

    /// Saves the strip on a dark background, for checking it without screen capture. With --offscreen the
    /// picture comes from the real renderer (particles included); otherwise CALayer.render(in:), which skips them.
    func snapshot(to url: URL) {
        if let off = offscreen {
            if let img = off.image() { Self.writePNG(img, to: url) }
            return
        }
        let size = window.frame.size
        let w = Int(size.width * 2), h = Int(size.height * 2)
        guard w > 0, h > 0,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        ctx.setFillColor(CGColor(red: 0.22, green: 0.24, blue: 0.3, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: 2, y: 2)
        host.render(in: ctx)
        if let img = ctx.makeImage() { Self.writePNG(img, to: url) }
    }

    private static func writePNG(_ img: CGImage, to url: URL) {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
    }
}

/// Core Animation's own renderer drawing a layer tree into a Metal texture. Unlike CALayer.render(in:)
/// it runs emitter layers, so snapshots show the particles.
final class OffscreenRenderer {
    private let renderer: CARenderer
    private let texture: MTLTexture
    private let queue: MTLCommandQueue
    private let width: Int
    private let height: Int

    init?(layer: CALayer, size: CGSize) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        width = Int(size.width)
        height = Int(size.height)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height,
                                                         mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .managed
        guard let tex = device.makeTexture(descriptor: d) else { return nil }
        texture = tex
        self.queue = queue
        renderer = CARenderer(mtlTexture: tex, options: [kCARendererMetalCommandQueue: queue])
        renderer.layer = layer
        renderer.bounds = CGRect(origin: .zero, size: size)
    }

    func render() {
        renderer.beginFrame(atTime: CACurrentMediaTime(), timeStamp: nil)
        renderer.addUpdate(renderer.bounds)
        renderer.render()
        renderer.endFrame()
    }

    func image() -> CGImage? {
        guard let cb = queue.makeCommandBuffer(), let blit = cb.makeBlitCommandEncoder() else { return nil }
        blit.synchronize(resource: texture)
        blit.endEncoding()
        cb.commit()
        cb.waitUntilCompleted()
        let rowBytes = width * 4
        var raw = [UInt8](repeating: 0, count: rowBytes * height)
        texture.getBytes(&raw, bytesPerRow: rowBytes, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        // The texture's rows run bottom-up relative to the layer tree; flip them.
        var bytes = [UInt8](repeating: 0, count: raw.count)
        for row in 0..<height {
            let src = (height - 1 - row) * rowBytes
            bytes.replaceSubrange(row * rowBytes..<(row + 1) * rowBytes, with: raw[src..<src + rowBytes])
        }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes,
                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info, provider: provider, decode: nil,
                       shouldInterpolate: false, intent: .defaultIntent)
    }
}

/// The strip's view: forwards right-clicks (and control-clicks) to whatever menu the stage offers there.
final class StageView: NSView {
    var menuAt: ((CGPoint) -> NSMenu?)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func rightMouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let menu = menuAt?(p) {
            NSMenu.popUpContextMenu(menu, with: event, for: self)
        } else {
            super.rightMouseDown(with: event)
        }
    }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            rightMouseDown(with: event)
        } else {
            super.mouseDown(with: event)
        }
    }
}

/// A menu item that runs a closure. The item keeps the action alive through representedObject.
final class MenuAction: NSObject {
    private let run: () -> Void

    private init(_ run: @escaping () -> Void) { self.run = run }

    @objc private func fire() { run() }

    static func item(_ title: String, _ run: @escaping () -> Void) -> NSMenuItem {
        let action = MenuAction(run)
        let item = NSMenuItem(title: title, action: #selector(fire), keyEquivalent: "")
        item.target = action
        item.representedObject = action
        return item
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
