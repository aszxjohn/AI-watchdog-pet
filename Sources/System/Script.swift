import AppKit
import QuartzCore

// MARK: the world: shots and effects that fly on their own

/// Shots and one-off effects in stage space (y up), drawn above every Gundam (10/30). A shot keeps flying where it was
/// fired even when its Gundam moves on, and can hit another Gundam: it bursts there and that one reacts.
final class World {
    let layer = CALayer()

    /// How a shot looks and flies: a rounded bar (color, with a white core) or a picture, growing out of the muzzle.
    struct ShotLook {
        var length: CGFloat
        var thick: CGFloat
        var color: CGColor
        var image: CGImage?
        var speed: CGFloat
        var life: Double
        /// It starts fading after this share of its life.
        var fadeFrom: Double
    }

    /// A one-off effect: pictures on top of each other, scaled from `grow.from` to `grow.to` (either way) over the
    /// first 40% of its life, fading out over the rest after 45%.
    struct Burst {
        var images: [CGImage]
        var size: CGFloat
        var grow: (from: CGFloat, to: CGFloat)
        var life: Double
        var spin: CGFloat = 0
    }

    private struct Shot {
        let layer: CALayer
        let start: CGPoint
        let dir: CGPoint
        let born: CFTimeInterval
        let look: ShotLook
        weak var owner: PetNode?
        let hitPets: Bool
        let hit: Burst?
    }

    private struct Effect {
        let layers: [CALayer]
        let at: CGPoint
        let born: CFTimeInterval
        let burst: Burst
        let angle: CGFloat
    }

    private var shots: [Shot] = []
    private var effects: [Effect] = []

    init() {
        layer.zPosition = 1000
    }

    func shoot(from p: CGPoint, dir d: CGPoint, look: ShotLook, owner: PetNode, hitPets: Bool, hit: Burst?,
               now: CFTimeInterval) {
        let l = CALayer()
        l.anchorPoint = CGPoint(x: 0, y: 0.5)
        if let img = look.image {
            l.contents = img
            l.contentsGravity = .resize
        } else {
            l.backgroundColor = look.color
            l.shadowColor = look.color
            l.shadowOpacity = 1
            l.shadowRadius = 4
            l.shadowOffset = .zero
            let core = CALayer()
            core.backgroundColor = CGColor(gray: 1, alpha: 0.95)
            l.addSublayer(core)
        }
        l.opacity = 0
        layer.addSublayer(l)
        shots.append(Shot(layer: l, start: p, dir: d, born: now, look: look, owner: owner, hitPets: hitPets, hit: hit))
    }

    func burst(_ b: Burst, at p: CGPoint, angle: CGFloat = 0, now: CFTimeInterval) {
        let ls = b.images.map { img -> CALayer in
            let l = CALayer()
            l.contents = img
            l.bounds = CGRect(x: 0, y: 0, width: b.size, height: b.size * CGFloat(img.height) / CGFloat(max(1, img.width)))
            l.opacity = 0
            layer.addSublayer(l)
            return l
        }
        effects.append(Effect(layers: ls, at: p, born: now, burst: b, angle: angle))
    }

    /// Moves the shots on (a shot that reaches another Gundam bursts there) and plays the effects.
    func update(now: CFTimeInterval, pets: [PetNode]) {
        var keep: [Shot] = []
        for s in shots {
            let age = now - s.born
            guard age < s.look.life else { s.layer.removeFromSuperlayer(); continue }
            let dist = CGFloat(age) * s.look.speed
            let len = min(s.look.length, dist + 6)
            let tail = max(0, dist - len)
            let head = CGPoint(x: s.start.x + s.dir.x * dist, y: s.start.y + s.dir.y * dist)
            if s.hitPets, let target = pets.first(where: { $0 !== s.owner && $0.settled(now: now) && $0.bodyRect.contains(head) }) {
                if let h = s.hit { burst(h, at: head, now: now) }
                target.struck(now: now)
                s.layer.removeFromSuperlayer()
                continue
            }
            let l = s.layer
            l.bounds = CGRect(x: 0, y: 0, width: len, height: s.look.thick)
            if s.look.image == nil {
                l.cornerRadius = s.look.thick / 2
                l.sublayers?.first?.frame = CGRect(x: len * 0.12, y: s.look.thick * 0.3, width: len * 0.82,
                                                   height: s.look.thick * 0.4)
            }
            l.position = CGPoint(x: s.start.x + s.dir.x * tail, y: s.start.y + s.dir.y * tail)
            l.transform = CATransform3DMakeRotation(atan2(s.dir.y, s.dir.x), 0, 0, 1)
            let fade = s.look.life * s.look.fadeFrom
            l.opacity = Float(age < fade ? 1 : 1 - (age - fade) / (s.look.life - fade))
            keep.append(s)
        }
        shots = keep
        effects = effects.filter { e in
            let q = now - e.born
            guard q < e.burst.life else {
                for l in e.layers { l.removeFromSuperlayer() }
                return false
            }
            let u = CGFloat(min(1, q / (e.burst.life * 0.4)))
            let g = e.burst.grow.from + (e.burst.grow.to - e.burst.grow.from) * u
            let a = Float(q < e.burst.life * 0.45 ? 1 : max(0, 1 - (q - e.burst.life * 0.45) / (e.burst.life * 0.55)))
            for l in e.layers {
                l.position = e.at
                l.transform = CATransform3DScale(CATransform3DMakeRotation(e.angle + e.burst.spin * CGFloat(q), 0, 0, 1), g, g, 1)
                l.opacity = a
            }
            return true
        }
    }
}

// MARK: scripts

/// A state's script (characters/<id>/states/<state>.json "script"), ready to play: its timeline flattened into
/// frame spans and timed events, with the state's settings filled in. Steps (each starts when the one before ends):
///   {"do": "play", "anim", "frames": [first, last], "fps"}         plays those frames once
///   {"do": "frame", "anim", "frame" | "frames" + "pick": "alternate", "hold"}   shows one frame for `hold` seconds
///   {"do": "wait", "seconds"}                                       keeps the last frame
///   {"do": "repeat", "times", "every"?, "steps"}                   the steps `times` times (each round `every` apart)
///   {"do": "if", "param", "then", "else"}                          by a bool setting
///   {"do": "shoot", "from", "shot", "flash"?, "kick"?, "hit"?}     a shot from a measured muzzle (see Shoot)
///   {"do": "effect", "at", "burst"}                                a one-off effect
///   {"do": "particles", "look"}                                    the particles take that look from now on
/// "$name" anywhere stands for the state's setting `name`. Sizes are × the Gundam's height unless noted.
/// Top level: "intro" (steps played once at the start), "timeline" (the round, looped after the intro), "loop"
/// (default true), "moveWhileActing" (may wander mid-act; default false: it waits for the end of a round, as the
/// characters' own looping acts do), "marker" ([x, y] × height: where the state marker sits), "particles" (an
/// emitter behind the body: "image", "core" (rig key of the body centre), "size", "cell" (lifetime, …), "looks":
/// {name: {range, longitude, velocity, yAccel, xAccel, rate}}).
final class ScriptPlan {
    struct Span {
        let start: Double
        let anim: String
        let frames: [Int]
        /// nil: a still frame (frames[0]).
        let fps: Double?
    }

    /// Where a shot leaves from: a point the build measured on the frame on screen, by rig key, and which gun.
    struct Muzzle {
        var points: String
        var dirs: String
        var gun: Int
    }

    struct Shoot {
        var from: Muzzle
        var shot: World.ShotLook
        /// Its length and speed × height (resolved when fired).
        var length: CGFloat
        var speed: CGFloat
        var flash: World.Burst?
        /// The body jolts back this far (pt) and recovers over `kickTime`.
        var kick: CGFloat
        var kickTime: Double
        var hitPets: Bool
        var hit: World.Burst?
    }

    enum Event {
        case shoot(Shoot)
        case effect(World.Burst, CGPoint)
    }

    private(set) var spans: [Span] = []
    private(set) var events: [(t: Double, ev: Event)] = []
    private(set) var length = 0.0
    /// Where the round (the looped part) starts: the intro's length.
    private(set) var intro = 0.0
    let loop: Bool
    let moveWhileActing: Bool
    let marker: CGPoint?
    /// The particle emitter's set-up, its looks, and when each look starts (round time).
    let particles: [String: Any]?
    private(set) var looks: [(t: Double, look: String)] = []

    private let params: [String: Any]
    private let unit: UnitDef

    init(_ o: [String: Any], params: [String: Any], unit: UnitDef) {
        self.params = params
        self.unit = unit
        loop = o["loop"] as? Bool ?? true
        moveWhileActing = Self.bool(o["moveWhileActing"], params) ?? false
        marker = (o["marker"] as? [Double]).flatMap { $0.count == 2 ? CGPoint(x: $0[0], y: $0[1]) : nil }
        particles = o["particles"] as? [String: Any]
        intro = compile(o["intro"] as? [[String: Any]] ?? [], at: 0, round: 0)
        length = compile(o["timeline"] as? [[String: Any]] ?? [], at: intro, round: 0)
        spans.sort { $0.start < $1.start }
        events.sort { $0.t < $1.t }
        looks.sort { $0.t < $1.t }
    }

    /// The particle look at time `u` (nil: none set).
    func look(at u: Double) -> String? { looks.last(where: { $0.t <= u })?.look }

    // MARK: values

    private func value(_ v: Any?) -> Any? {
        if let s = v as? String, s.hasPrefix("$") { return params[String(s.dropFirst())] }
        return v
    }
    private func num(_ v: Any?, _ d: Double) -> Double {
        let x = value(v)
        return (x as? Double) ?? (x as? Int).map(Double.init) ?? d
    }
    private static func bool(_ v: Any?, _ params: [String: Any]) -> Bool? {
        if let s = v as? String, s.hasPrefix("$") { return params[String(s.dropFirst())] as? Bool }
        return v as? Bool
    }
    private func color(_ v: Any?) -> CGColor {
        guard let c = value(v) as? [Double], c.count >= 3 else { return CGColor(red: 1, green: 0.32, blue: 0.75, alpha: 1) }
        return CGColor(red: c[0], green: c[1], blue: c[2], alpha: c.count > 3 ? c[3] : 1)
    }
    /// A picture by "group/name" from the unit's picture groups.
    private func picture(_ v: Any?) -> CGImage? {
        guard let s = value(v) as? String else { return nil }
        let parts = s.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return unit.pictures[parts[0]]?[parts[1]]
    }
    private func burst(_ o: [String: Any]?) -> World.Burst? {
        guard let o else { return nil }
        var images = (o["images"] as? [Any] ?? []).compactMap(picture)
        if images.isEmpty, o["color"] != nil { images = [Fx.dot(color(o["color"]))].compactMap { $0 } }
        guard !images.isEmpty else { return nil }
        let g = o["grow"] as? [Double] ?? [1, 1]
        return World.Burst(images: images, size: CGFloat(num(o["size"], 24)),
                           grow: (CGFloat(g.first ?? 1), CGFloat(g.last ?? 1)), life: num(o["life"], 0.3),
                           spin: CGFloat(num(o["spin"], 0)))
    }

    // MARK: compiling

    /// Lays the steps out from `t`; returns when they end. `round`: the enclosing repeat's round (for "alternate").
    private func compile(_ steps: [[String: Any]], at t0: Double, round: Int) -> Double {
        var t = t0
        for s in steps {
            switch s["do"] as? String ?? "" {
            case "play":
                let f = s["frames"] as? [Int] ?? [0, 0]
                let frames = f.count == 2 && f[1] >= f[0] ? Array(f[0]...f[1]) : f
                let fps = num(s["fps"], 12)
                spans.append(Span(start: t, anim: s["anim"] as? String ?? "", frames: frames, fps: fps))
                t += Double(frames.count) / fps
            case "frame":
                var f = Int(num(s["frame"], 0))
                if let list = s["frames"] as? [Int], !list.isEmpty {
                    f = (s["pick"] as? String) == "alternate" ? list[round % list.count] : list[0]
                }
                spans.append(Span(start: t, anim: s["anim"] as? String ?? "", frames: [f], fps: nil))
                t += num(s["hold"], 0)
            case "wait":
                t += num(s["seconds"], 0)
            case "repeat":
                let n = Int(num(s["times"], 1))
                let every = s["every"].map { _ in num(s["every"], 0) }
                let inner = s["steps"] as? [[String: Any]] ?? []
                var at = t
                for i in 0..<max(0, n) {
                    let end = compile(inner, at: at, round: i)
                    at = every.map { t + Double(i + 1) * $0 } ?? end
                }
                t = at
            case "if":
                let yes = Self.bool(s["param"].map { "$\($0)" }, params) ?? false
                t = compile((yes ? s["then"] : s["else"]) as? [[String: Any]] ?? [], at: t, round: round)
            case "shoot":
                let from = s["from"] as? [String: Any] ?? [:]
                var gun = Int(num(from["gun"], 0))
                if (from["gun"] as? String) == "alternate" { gun = round % 2 }
                let shot = s["shot"] as? [String: Any] ?? [:]
                let hit = s["hit"] as? [String: Any] ?? [:]
                let look = World.ShotLook(length: 0, thick: CGFloat(num(shot["thick"], 4)), color: color(shot["color"]),
                                          image: picture(shot["image"]), speed: 0, life: num(shot["life"], 0.4),
                                          fadeFrom: num(shot["fadeFrom"], 0.6))
                let kick = s["kick"] as? [String: Any] ?? [:]
                events.append((t, .shoot(Shoot(
                    from: Muzzle(points: from["points"] as? String ?? "", dirs: from["dirs"] as? String ?? "", gun: gun),
                    shot: look, length: CGFloat(num(shot["length"], 0.3)), speed: CGFloat(num(shot["speed"], 7)),
                    flash: burst(s["flash"] as? [String: Any]), kick: CGFloat(num(kick["distance"], 0)),
                    kickTime: num(kick["time"], 0.07), hitPets: Self.bool(hit["pets"], params) ?? false,
                    hit: burst(hit["burst"] as? [String: Any])))))
            case "particles":
                if let l = s["look"] as? String { looks.append((t, l)) }
            case "effect":
                let at = s["at"] as? [Double] ?? [0, 0.55]
                if let b = burst(s["burst"] as? [String: Any]) {
                    events.append((t, .effect(b, CGPoint(x: at.first ?? 0, y: at.last ?? 0))))
                }
            default:
                break
            }
        }
        return t
    }

    // MARK: playing

    /// Time within the script for t since the act started: the intro once, then the round over and over.
    func local(_ t: Double) -> Double {
        guard length > 0 else { return 0 }
        guard loop, t >= intro, length > intro else { return min(t, length) }
        return intro + (t - intro).truncatingRemainder(dividingBy: length - intro)
    }

    /// Whether a round has just ended (t since the act started): when a Gundam may set off to wander.
    func roundEnds(_ t: Double) -> Bool {
        let r = length - intro
        guard r > 0, t >= length else { return false }
        return (t - intro).truncatingRemainder(dividingBy: r) < 1.0 / 15
    }

    /// The picture at round time `u`: the latest span begun by then.
    func frame(at u: Double) -> (String, Int)? {
        guard let s = spans.last(where: { $0.start <= u }) ?? spans.first else { return nil }
        guard let fps = s.fps else { return (s.anim, s.frames[0]) }
        return (s.anim, s.frames[min(s.frames.count - 1, max(0, Int((u - s.start) * fps)))])
    }

    /// The events between two round times (wrapping round the end of a round).
    func events(after a: Double, upTo b: Double) -> [Event] {
        if b >= a { return events.filter { $0.t > a && $0.t <= b }.map(\.ev) }
        // wrapped round the end of a round: the rest of it, then the round's start (not the intro)
        return events.filter { $0.t > a || ($0.t >= intro && $0.t <= b) }.map(\.ev)
    }

    /// As one of the system's acts: the frame, the round's events, and (unless it may move mid-act) leaving only as a
    /// round ends.
    func act() -> Act {
        Act(frame: { [unowned self] _, t, _ in self.frame(at: self.local(t)) ?? ("", 0) },
            update: { [unowned self] n, now, off, acting in n.runScript(self, now: now, offset: off, acting: acting) },
            hide: { n, _ in n.hideScript() },
            loopEnds: moveWhileActing || !loop || length <= intro ? nil : { [unowned self] t in self.roundEnds(t) },
            travel: { [unowned self] _ in self.frame(at: 0) ?? ("", 0) },
            bubble: marker.map { m in { n in CGPoint(x: n.unitHeight * m.x, y: n.unitHeight * m.y) } })
    }
}

/// A script's per-Gundam playing state.
final class ScriptParts: ActParts {
    required init() {}
    var emitter: CAEmitterLayer?
    /// The script the emitter was set up for.
    weak var emitterFor: ScriptPlan?
    var last = -1.0
    var kickAt = -10.0
    var kickDir = CGPoint.zero
    var kick: CGFloat = 0
    var kickTime = 0.07
}

extension PetNode {
    /// Plays one tick of a script: its round's events since the last tick, and the jolt of the last shot.
    func runScript(_ sp: ScriptPlan, now: CFTimeInterval, offset: CGPoint, acting: Bool) {
        let p = parts(ScriptParts.self)
        guard acting else {
            p.last = -1
            p.emitter?.birthRate = 0
            return
        }
        let t = max(0, now - trackStart)
        let u = sp.local(t)
        runParticles(sp, at: u, parts: p)
        if p.last >= 0 {
            for ev in sp.events(after: p.last, upTo: u) { fire(ev, now: now, offset: offset, parts: p) }
        } else {
            for ev in sp.events(after: -1, upTo: u) { fire(ev, now: now, offset: offset, parts: p) }
        }
        p.last = u
        let k = now - p.kickAt
        if k < p.kickTime {
            let j = p.kick * CGFloat(1 - k / p.kickTime)
            body.transform = CATransform3DMakeTranslation(offset.x - p.kickDir.x * j, offset.y - p.kickDir.y * j, 0)
        }
    }

    func hideScript() {
        let p = parts(ScriptParts.self)
        p.last = -1
        p.emitter?.birthRate = 0
    }

    /// The script's particles: an emitter behind the body (set up once per script), placed on the body centre the
    /// build measured, in the look the timeline has set.
    private func runParticles(_ sp: ScriptPlan, at u: Double, parts p: ScriptParts) {
        guard let cfg = sp.particles else { p.emitter?.birthRate = 0; return }
        if p.emitterFor !== sp {
            p.emitter?.removeFromSuperlayer()
            let e = CAEmitterLayer()
            let img = (cfg["image"] as? String).flatMap { name -> CGImage? in
                let parts = name.split(separator: "/", maxSplits: 1).map(String.init)
                return parts.count == 2 ? unit.pictures[parts[0]]?[parts[1]] : nil
            }
            Fx.configureDrift(e, image: img, cell: cfg["cell"] as? [String: Any] ?? [:],
                              size: CGFloat(cfg["size"] as? Double ?? 34))
            body.insertSublayer(e, at: 0)
            p.emitter = e
            p.emitterFor = sp
        }
        guard let e = p.emitter else { return }
        if let key = cfg["core"] as? String, let c = unit.rig.raw[key] as? [Double], c.count == 2 {
            e.emitterPosition = bodyPoint(CGPoint(x: c[0], y: c[1]), in: unit.anim(shownAnim))
        }
        let looks = cfg["looks"] as? [String: [String: Double]] ?? [:]
        guard let name = sp.look(at: u), let l = looks[name] else { e.birthRate = 0; return }
        let look = DriftLook(range: CGFloat(l["range"] ?? 2.6), longitude: CGFloat(l["longitude"] ?? 0.1),
                             velocity: CGFloat(l["velocity"] ?? 48), yAccel: CGFloat(l["yAccel"] ?? 0),
                             xAccel: CGFloat(l["xAccel"] ?? 16), rate: CGFloat(l["rate"] ?? 3), speed: CGFloat(l["speed"] ?? 1),
                             halo: 0)
        Fx.applyDrift(look, to: e, active: true)
    }

    private func fire(_ ev: ScriptPlan.Event, now: CFTimeInterval, offset: CGPoint, parts p: ScriptParts) {
        guard let world else { return }
        switch ev {
        case .shoot(let s):
            let anim = unit.anim(shownAnim)
            let raw = unit.rig.raw
            guard let pts = raw[s.from.points] as? [[[Double]]], let dirs = raw[s.from.dirs] as? [[[Double]]],
                  shownFrame >= 0, shownFrame < pts.count, s.from.gun < pts[shownFrame].count,
                  shownFrame < dirs.count, s.from.gun < dirs[shownFrame].count else { return }
            let m = pts[shownFrame][s.from.gun], v = dirs[shownFrame][s.from.gun]
            let b = bodyPoint(CGPoint(x: m[0], y: m[1]), in: anim)
            let muzzle = CGPoint(x: root.position.x + body.position.x + offset.x + b.x,
                                 y: root.position.y + body.position.y + offset.y + b.y)
            let len = max(0.001, hypot(v[0], v[1]))
            let d = CGPoint(x: v[0] / len, y: -v[1] / len)
            var look = s.shot
            look.length = s.length * unitHeight
            look.speed = s.speed * unitHeight
            world.shoot(from: muzzle, dir: d, look: look, owner: self, hitPets: s.hitPets, hit: s.hit, now: now)
            if let f = s.flash { world.burst(f, at: muzzle, now: now) }
            if s.kick > 0 {
                p.kickAt = now
                p.kickDir = d
                p.kick = s.kick
                p.kickTime = s.kickTime
            }
        case .effect(let b, let at):
            world.burst(b, at: CGPoint(x: root.position.x + at.x * unitHeight, y: root.position.y + at.y * unitHeight),
                        now: now)
        }
    }
}
