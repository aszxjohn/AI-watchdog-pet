import AppKit
import Metal
import QuartzCore

/// Height in pixels of the idle pose in units/*/idle (TARGET_H in tools/build_units.py).
let sourcePoseHeight: CGFloat = 240

/// Mobile-suit HUD look for the name tag and the status marker: dark glass, thin GN-green frame
/// with two corners cut off, monospaced text.
enum Hud {
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

/// A character's own act: how one of its states is acted out beyond plain frame playback (layers, timings,
/// effects). Registered by the character's module (CharacterKit) under a mode name (unit.json
/// "rig.states.<state>.mode"), or for a state as an overlay on whatever plays (e.g. 出錯了's tape). The system calls
/// only these hooks; it knows nothing of what they draw.
struct Act {
    /// Plays when the state's mode is this…
    var mode: StatePlan.Mode?
    /// …or whenever the Gundam is in this state.
    var state: PetState?
    /// The picture for this tick (t: seconds since the act started); nil: frame 0 of the state's animation.
    var frame: ((PetNode, _ t: Double, _ now: CFTimeInterval) -> (String, Int))?
    /// Each tick while it plays (offset: the body's reaction offset this tick; acting: settled and not moving).
    var update: (PetNode, _ now: CFTimeInterval, _ offset: CGPoint, _ acting: Bool) -> Void = { _, _, _, _ in }
    /// Each tick while it does not.
    var hide: (PetNode, _ now: CFTimeInterval) -> Void = { _, _ in }
    /// A looping act: true when a loop has just ended (t since it started); only then may the Gundam set off to
    /// wander, and it waits while moving. nil: it may move any time and carries on while it does.
    var loopEnds: ((Double) -> Bool)?
    /// The picture while it waits for a move.
    var travel: ((PetNode) -> (String, Int))?
    /// Where the state marker sits (nil: the default, over the right shoulder).
    var bubble: ((PetNode) -> CGPoint)?
    /// Changes the body's reaction this tick: offset and lean (st: seconds into the state).
    var react: ((PetNode, _ now: CFTimeInterval, _ st: Double, inout CGFloat, inout CGFloat, inout CGFloat) -> Void)?
}

/// What a character's module gives the system: its layers (built once per Gundam, in its own order) and its acts.
struct CharacterKit {
    var build: (PetNode) -> Void = { _ in }
    var acts: [Act] = []
}

/// A per-Gundam store for an act's layers and state (PetNode.parts).
protocol ActParts: AnyObject { init() }

/// One Gundam on screen, bound to one session. Each state is acted out with the unit's own
/// animations (unit.json rig); code only adds one-off reactions and HUD / GN-particle effects.
final class PetNode {
    /// The session it follows (changed by hand from its right-click menu).
    var sessionId: String
    let unit: UnitDef
    let root = CALayer()
    let body = CALayer()
    let sprite = CALayer()
    /// The previous picture, fading out while the next animation fades in.
    let ghost = CALayer()
    let tint = CALayer()
    let tintMask = CALayer()
    let gn = CAEmitterLayer()
    let gnIdle = CAEmitterLayer()
    let jet = CAEmitterLayer()
    let charge = CAEmitterLayer()
    let sparks = CAEmitterLayer()
    let beam = CALayer()
    let beamGlow = CAGradientLayer()
    let beamCore = CALayer()
    let flash = CALayer()
    let impact = CALayer()
    let halo = CALayer()
    let reticle = CAShapeLayer()
    let brackets = CAShapeLayer()
    let bubble = CAShapeLayer()
    let bubbleText = CATextLayer()
    let tag = CALayer()
    let tagFrame = CAShapeLayer()
    let tagAccent = CALayer()
    let tagText = CATextLayer()

    private(set) var state: PetState = .waiting
    var plan: StatePlan
    var stateSince: CFTimeInterval
    /// When the current state began (the stage's wandering notices a change by it).
    var stateStart: CFTimeInterval { stateSince }
    let born: CFTimeInterval
    var leavingSince: CFTimeInterval?
    var flashAt: CFTimeInterval = -10
    var lastToolError: Date?
    private(set) var title = ""
    /// Where it stands (its feet; the stage's coordinates, y up). The stage's wandering moves it (10/30).
    private(set) var pos: CGPoint
    /// Its place in the row along the bottom: where it comes in, and where it stays in a state that does not wander.
    var slot: CGPoint
    /// The move under way: from, to, start, seconds.
    var move: (from: CGPoint, to: CGPoint, start: CFTimeInterval, time: Double)?
    /// When it may set off again (the stage's wandering waits for this).
    var wanderRest: CFTimeInterval = 0
    /// The state start the stage last planned for (so it notices a change of state).
    var plannedFor: CFTimeInterval = -1
    let unitHeight: CGFloat
    let scale: CGFloat

    // Playback of the current plan.
    var trackStart: CFTimeInterval
    /// The "out" segment of the previous hold animation, played before the new plan starts.
    var exiting: (anim: String, start: CFTimeInterval, fps: Double)?
    var restUntil: CFTimeInterval = 0
    var flourishStart: CFTimeInterval?
    var fidget: (anim: String, from: CFTimeInterval, to: CFTimeInterval)?

    // What is on screen.
    var shownAnim = ""
    var shownFrame = -1
    var fadeStart: CFTimeInterval = -10
    /// 0…1: how far into the forward move the flourish is (drives the backward stream and the jet).
    var dashLevel: CGFloat = 0
    /// 0…1: how far the waiting pose has switched to a fidget pose (低頭 etc.).
    var fidgetLevel: CGFloat = 0

    let enterTime = 1.0
    let leaveTime = 0.9
    let fadeTime = 0.22

    var showLabel: Bool { didSet { tag.isHidden = !showLabel } }

    // MARK: characters' acts

    /// Each character's module, by unit id (registered at launch, see CharacterModules).
    static var kits: [String: CharacterKit] = [:]
    private var kit: CharacterKit { Self.kits[unit.id] ?? CharacterKit() }
    private var actParts: [ObjectIdentifier: ActParts] = [:]

    /// An act's per-Gundam store, made on first use.
    func parts<T: ActParts>(_ type: T.Type) -> T {
        if let p = actParts[ObjectIdentifier(type)] as? T { return p }
        let p = T()
        actParts[ObjectIdentifier(type)] = p
        return p
    }

    /// The act the state plays: its script if its state file has one, else the character's act for its mode (nil: a
    /// plain one the system plays itself).
    private var currentAct: Act? { scriptAct ?? kit.acts.first { $0.mode == plan.mode } }

    /// A character's act plays when it is the mode's (and no script replaces it) or is tied to the state.
    private func plays(_ a: Act) -> Bool { a.mode.map { scriptAct == nil && $0 == plan.mode } ?? (a.state == state) }

    // MARK: the state's settings and script (characters/<id>/states/<state>.json)

    /// Where its shots and effects fly (the stage's).
    weak var world: World?
    /// The current state's settings (defaults with the user's changes), for its script and the character's acts.
    private(set) var params: [String: Any] = [:]
    /// The current state's script, if its state file has one.
    private(set) var script: ScriptPlan?
    private var scriptAct: Act?
    /// What the settings were taken from (the store's version, the state).
    private(set) var bound: (version: Int, state: PetState)?

    /// Takes the state's settings and script (the stage calls this when the state or the settings change).
    func bind(params: [String: Any], script raw: [String: Any]?, version: Int) {
        self.params = params
        script = raw.map { ScriptPlan($0, params: params, unit: unit) }
        scriptAct = script?.act()
        bound = (version, state)
    }

    /// One of the state's settings, for a character's act.
    func param<T>(_ name: String, _ fallback: T) -> T { params[name] as? T ?? fallback }

    /// Its body in stage space (what another Gundam's shot hits).
    var bodyRect: CGRect {
        CGRect(x: root.position.x - unitHeight * 0.45, y: root.position.y + unitHeight * 0.1,
               width: unitHeight * 0.9, height: unitHeight * 0.95)
    }

    /// Hit by another Gundam's shot: it shakes (as for a failed tool call).
    func struck(now: CFTimeInterval) { flashAt = now }

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
        kit.build(self)
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
    func begin(from old: StatePlan, now: CFTimeInterval) {
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
    var pausesToMove: Bool { currentAct?.loopEnds != nil }

    /// Whether it may set off now: any time, or for a looping act only as a loop ends.
    func canDepart(now: CFTimeInterval) -> Bool {
        guard settled(now: now), exiting == nil else { return false }
        return currentAct?.loopEnds?(now - trackStart) ?? true
    }

    /// Sets off for `to` at `speed` points per second (eased in and out).
    func depart(to: CGPoint, speed: Double, now: CFTimeInterval) {
        let d = Double(hypot(to.x - pos.x, to.y - pos.y))
        guard d > 1 else { return }
        move = (pos, to, now, min(3.5, max(0.45, d / max(20, speed))))
    }

    /// Moves `pos` along the current move; on arrival a looping act starts over and the rest begins.
    func advanceMove(now: CFTimeInterval) {
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
        case .error:
            if st < 0.7 { dx = sin(now * 46) * 3 }
        default:
            break
        }
        for a in kit.acts where plays(a) { a.react?(self, now, st, &dx, &dy, &lean) }
        if now - flashAt < 0.6 { dx += sin(now * 52) * 2.5 }

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
        updateHit(now: now, st: st)
        updateHud(now: now)
        // the character's acts: the ones that play this tick update, the others hide
        let acting = age >= enterTime && leavingSince == nil && exiting == nil && !paused
        for a in kit.acts {
            if plays(a) { a.update(self, now, CGPoint(x: dx, y: dy), acting) } else { a.hide(self, now) }
        }
        if let a = scriptAct { a.update(self, now, CGPoint(x: dx, y: dy), acting) } else { hideScript() }
        return true
    }

    // MARK: playback

    /// The picture while a looping act waits for a move: TRANS-AM in its normal colours (it powers up again on
    /// arrival), the others on their first frame.
    func travelFrame() -> (String, Int) {
        currentAct?.travel?(self) ?? (plan.anim, 0)
    }

    func pick(now: CFTimeInterval, age: CFTimeInterval) -> (String, Int) {
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
        if let f = scriptAct?.frame { return f(self, t, now) }
        switch plan.mode {
        case .hold:
            return (plan.anim, holdFrame(a, t: t, fps: plan.fps))
        case .flourish:
            return flourishFrame(a, now: now)
        default:
            return currentAct?.frame?(self, t, now) ?? (plan.anim, 0)
        }
    }

    /// How far into the forward move the current flourish is: ramps up over "in", stays at 1 through
    /// "hold", ramps down over "out", 0 while resting.
    func dashTarget(now: CFTimeInterval) -> CGFloat {
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
    func holdFrame(_ a: Anim, t: Double, fps: Double) -> Int {
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
    func flourishFrame(_ a: Anim, now: CFTimeInterval) -> (String, Int) {
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

    func show(_ name: String, _ idx: Int, now: CFTimeInterval) {
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

    /// Hit reaction for errors: sparks, a white-then-red flash.
    func updateHit(now: CFTimeInterval, st: CFTimeInterval) {
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

    func updateHud(now: CFTimeInterval) {
        let active = leavingSince == nil && now - born > enterTime
        do {
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

    // MARK: helpers (for every act)

    /// Body-space position (y up, relative to the pinned point) of a pixel in an animation's frame.
    func bodyPoint(_ px: CGPoint, in anim: Anim) -> CGPoint {
        CGPoint(x: (px.x - anim.anchor.x) * scale, y: -(px.y - anim.anchor.y) * scale)
    }

    func rotate(_ p: CGPoint, _ a: CGFloat) -> CGPoint {
        CGPoint(x: p.x * cos(a) - p.y * sin(a), y: p.x * sin(a) + p.y * cos(a))
    }

    /// 0…1 across a closed range, with an ease-out.
    func progress(_ c: Double, _ r: ClosedRange<Double>) -> CGFloat {
        let p = min(1, max(0, (c - r.lowerBound) / (r.upperBound - r.lowerBound)))
        return CGFloat(1 - pow(1 - p, 3))
    }

    /// Opacity of a shot that fades in over its first `fade` seconds and out over its last.
    func shotAlpha(_ c: Double, _ r: ClosedRange<Double>, fade: Double = 0.15) -> Float {
        guard r.contains(c) else { return 0 }
        let a = min(1, (c - r.lowerBound) / fade, r.lowerBound == 0 ? 1 : 1)
        let b = min(1, (r.upperBound - c) / fade)
        return Float(max(0, min(r.lowerBound == 0 ? 1 : a, b)))
    }

    /// 0…1 across a range, eased in and out.
    func ease(_ c: Double, _ r: ClosedRange<Double>) -> CGFloat {
        let u = CGFloat(min(1, max(0, (c - r.lowerBound) / (r.upperBound - r.lowerBound))))
        return u * u * (3 - 2 * u)
    }

    // MARK: tag and marker

    func refreshBubble() {
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
    var bubbleHome: CGPoint {
        currentAct?.bubble?(self) ?? CGPoint(x: unitHeight * 0.4, y: unitHeight * 1.08)
    }

    /// Two-line HUD tag: "GN-002 ▸ 工作中" over the session title.
    func refreshLabel() {
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

    var stateColor: NSColor {
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



/// Particle setups and the soft-dot sprite they use.
enum Fx {
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

    static let white = dot(CGColor(gray: 1, alpha: 0.6))

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
    /// A plain drift of particles from a circle (a script's "particles"): `cell` sets the particle (lifetime,
    /// lifetimeRange, velocityRange, scale, scaleRange, scaleSpeed, alphaRange, alphaSpeed, spin, spinRange).
    static func configureDrift(_ e: CAEmitterLayer, image: CGImage?, cell c: [String: Any], size: CGFloat) {
        func v(_ k: String, _ d: Double) -> CGFloat { CGFloat(c[k] as? Double ?? d) }
        let drift = CAEmitterCell()
        drift.name = "drift"
        drift.contents = image ?? white
        drift.birthRate = 30
        drift.lifetime = Float(v("lifetime", 2.2))
        drift.lifetimeRange = Float(v("lifetimeRange", 0.6))
        drift.velocityRange = v("velocityRange", 18)
        drift.scale = v("scale", 0.42)
        drift.scaleRange = v("scaleRange", 0.14)
        drift.scaleSpeed = v("scaleSpeed", -0.12)
        drift.alphaRange = Float(v("alphaRange", 0.3))
        drift.alphaSpeed = Float(v("alphaSpeed", -0.4))
        drift.spin = v("spin", 1)
        drift.spinRange = v("spinRange", 2)
        drift.color = Hud.gnParticle
        e.emitterCells = [drift]
        e.emitterShape = .circle
        e.emitterSize = CGSize(width: size, height: size)
        e.renderMode = .additive
        e.birthRate = 0
    }

    /// Sets a drift emitter's look (direction, spread, push, rate).
    static func applyDrift(_ look: DriftLook, to e: CAEmitterLayer, active: Bool) {
        e.setValue(look.range, forKeyPath: "emitterCells.drift.emissionRange")
        e.setValue(look.longitude, forKeyPath: "emitterCells.drift.emissionLongitude")
        e.setValue(look.velocity, forKeyPath: "emitterCells.drift.velocity")
        e.setValue(look.yAccel, forKeyPath: "emitterCells.drift.yAcceleration")
        e.setValue(look.xAccel, forKeyPath: "emitterCells.drift.xAcceleration")
        e.velocity = Float(look.speed)
        e.birthRate = active ? Float(look.rate) : 0
    }

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
    /// Shots and effects flying over the stage (above every Gundam).
    let world = World()
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

        host.addSublayer(world.layer)

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
        // --test-target: a second Gundam (等你回覆, standing still) in the showcase one's line of fire, for checking
        // that shots hit other Gundams (offscreen captures)
        if CommandLine.arguments.contains("--test-target") {
            let at = CGPoint(x: window.frame.width - slotWidth - CGFloat(characters.profile(unit.id).height) * 2.4, y: labelBand)
            let t = makeNode(id: "test-target", unit: unit, at: at, showLabel: true, now: now)
            t.set(state: .waiting, title: "靶", toolErrorAt: nil, now: now)
            nodes["test-target"] = t
            host.addSublayer(t.root)
        }
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
        n.world = world
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
        // each Gundam takes its state's settings and script when the state or the settings change
        for n in nodes.values where n.bound?.version != characters.version || n.bound?.state != n.state {
            let prof = characters.profile(n.unit.id)
            n.bind(params: prof.values[n.state] ?? [:], script: prof.scripts[n.state], version: characters.version)
        }
        for n in nodes.values { _ = n.update(now: now) }
        leaving = leaving.filter { n in
            if n.update(now: now) { return true }
            n.root.removeFromSuperlayer()
            return false
        }
        world.update(now: now, pets: Array(nodes.values))
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
