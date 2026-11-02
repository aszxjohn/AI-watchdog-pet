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

// MARK: expressions

/// A small arithmetic expression from a script, e.g. "0.4+0.2*sin(2*pi*st/1.6)": numbers, + - * / ^, parentheses,
/// variables and functions (sin cos tan abs sqrt exp floor ceil round min max clamp(x, lo, hi) pow). A plain JSON
/// number is a constant. Variables come from the Gundam each tick (t: seconds since the act started, st: since the
/// state started, u: time within the script, h: its height, pi, count: frames in the step's animation), the
/// script's "vars", and the state's settings ("$name").
struct Expr {
    let eval: ([String: Double]) -> Double

    /// While a state file is read: where an expression says what it cannot use (a typo, an unknown function or name),
    /// and the names it may use besides rig.* (nil: not checked). Read on the main thread only.
    static var report: ((String) -> Void)?
    static var known: Set<String>?

    init(_ v: Any?, _ fallback: Double = 0, params: [String: Any] = [:]) {
        if let d = v as? Double { eval = { _ in d }; return }
        if let i = v as? Int { eval = { _ in Double(i) }; return }
        if let b = v as? Bool { eval = { _ in b ? 1 : 0 }; return }
        guard let raw = v as? String else { eval = { _ in fallback }; return }
        // "12pt": points, in a field that is otherwise × the Gundam's height
        var text = raw.trimmingCharacters(in: .whitespaces)
        let points = text.hasSuffix("pt") && (text.dropLast(2).last.map { $0.isNumber || $0 == ")" } ?? false)
        if points { text = String(text.dropLast(2)) }
        var p = Parser(text, params: params)
        guard let f = p.parse() else {
            Expr.report?("看不懂的運算式「\(raw)」（改用預設值 \(fallback)）")
            eval = { _ in fallback }
            return
        }
        if let known = Expr.known {
            for n in p.names.sorted() where !known.contains(n) && !n.hasPrefix("rig.") {
                Expr.report?("運算式「\(raw)」用到不認得的名字 \(n)（當作 0）")
            }
        }
        eval = points ? { e in f(e) / max(1e-9, e["h"] ?? 1) } : f
    }

    private struct Parser {
        typealias Fn = ([String: Double]) -> Double
        let chars: [Character]
        var i = 0
        let params: [String: Any]
        /// The variable names it uses.
        var names = Set<String>()

        init(_ s: String, params: [String: Any]) {
            chars = Array(s.filter { !$0.isWhitespace })
            self.params = params
        }

        mutating func parse() -> Fn? {
            let e = sum()
            return i == chars.count ? e : nil
        }

        private var peek: Character? { i < chars.count ? chars[i] : nil }

        private mutating func sum() -> Fn? {
            guard var l = product() else { return nil }
            while let c = peek, c == "+" || c == "-" {
                i += 1
                guard let r = product() else { return nil }
                let a = l
                l = c == "+" ? { a($0) + r($0) } : { a($0) - r($0) }
            }
            return l
        }

        private mutating func product() -> Fn? {
            guard var l = unary() else { return nil }
            while let c = peek, c == "*" || c == "/" || c == "%" {
                i += 1
                guard let r = unary() else { return nil }
                let a = l
                l = c == "*" ? { a($0) * r($0) } : c == "/" ? { a($0) / r($0) } : { fmod(a($0), r($0)) }
            }
            return l
        }

        /// A minus binds looser than ^ (-2^2 is -4, as in maths).
        private mutating func unary() -> Fn? {
            if peek == "-" {
                i += 1
                guard let x = unary() else { return nil }
                return { -x($0) }
            }
            return power()
        }

        private mutating func power() -> Fn? {
            guard let b = primary() else { return nil }
            if peek == "^" {
                i += 1
                guard let e = unary() else { return nil }
                return { pow(b($0), e($0)) }
            }
            return b
        }

        private mutating func primary() -> Fn? {
            guard let c = peek else { return nil }
            if c == "(" {
                i += 1
                let e = sum()
                guard peek == ")" else { return nil }
                i += 1
                return e
            }
            if c.isNumber || c == "." {
                var s = ""
                while let d = peek, d.isNumber || d == "." { s.append(d); i += 1 }
                guard let v = Double(s) else { return nil }
                return { _ in v }
            }
            guard c.isLetter || c == "_" || c == "$" else { return nil }
            var name = ""
            while let d = peek, d.isLetter || d.isNumber || d == "_" || d == "$" || d == "." { name.append(d); i += 1 }
            if peek == "(" {
                i += 1
                var args: [Fn] = []
                if peek != ")" {
                    while true {
                        guard let a = sum() else { return nil }
                        args.append(a)
                        if peek == "," { i += 1; continue }
                        break
                    }
                }
                guard peek == ")" else { return nil }
                i += 1
                return Self.function(name, args)
            }
            if name.hasPrefix("$") {
                let v = params[String(name.dropFirst())]
                let d = (v as? Double) ?? (v as? Int).map(Double.init) ?? ((v as? Bool).map { $0 ? 1 : 0 }) ?? 0
                return { _ in d }
            }
            if name == "pi" { return { _ in .pi } }
            names.insert(name)
            return { $0[name] ?? 0 }
        }

        private static func function(_ name: String, _ a: [Fn]) -> Fn? {
            func arg(_ k: Int) -> Fn { k < a.count ? a[k] : { _ in 0 } }
            let x = arg(0), y = arg(1), z = arg(2)
            switch name {
            case "sin": return { sin(x($0)) }
            case "cos": return { cos(x($0)) }
            case "tan": return { tan(x($0)) }
            case "abs": return { abs(x($0)) }
            case "sqrt": return { sqrt(x($0)) }
            case "exp": return { exp(x($0)) }
            case "floor": return { floor(x($0)) }
            case "ceil": return { ceil(x($0)) }
            case "round": return { x($0).rounded() }
            case "min": return { min(x($0), y($0)) }
            case "max": return { max(x($0), y($0)) }
            case "pow": return { pow(x($0), y($0)) }
            case "clamp": return { min(max(x($0), y($0)), z($0)) }
            default: return nil
            }
        }
    }
}

// MARK: scripts

/// A state's script (characters/<id>/states/<state>.json "script"), ready to play: its timeline flattened into
/// frame spans and timed events, with the state's settings filled in, and what plays alongside the frames (vars,
/// body, layers, emitters, particles, a JavaScript program). The format — every step, field, unit and expression —
/// is in docs/character-format.md (the one description of it; keep that file in step with this code).
final class ScriptPlan {
    struct Span {
        let start: Double
        let anim: String
        let frames: [Int]
        /// nil: a still frame (frames[0]).
        let fps: Double?
        /// For "frames": the frame index, from an expression.
        let index: Expr?
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

    /// A picture on the body (or, "in": "root", beside it: it does not shake or lean with the body). A named one is
    /// the program's to move (see ScriptProgram); a "repeat" group makes several, addressed by index.
    struct Layer {
        var name: String?
        var image: CGImage?
        var at: Any?
        var width: Expr
        /// nil: from the picture's shape.
        var height: Expr?
        /// nil: not set by the state file (a program's layer).
        var scale, opacity, rotation: Expr?
        var back: Bool
        var inRoot: Bool
        /// Where in its parent: "aboveBody" (in the root, right over the body), or under another layer by name.
        var z: String?
        var below: String?
        /// A container's pictures, each as big as it unless given a size; the program moves them (they keep what they
        /// were last given, at first their "opacity" here).
        var children: [Layer] = []
        /// Whether the state file gave a size (a container's picture without one is as big as the container).
        var sized = false
        /// Its entry in the state file (for how it is drawn: text, shape, clip, … see styleLayer).
        var raw: [String: Any] = [:]
    }

    /// An emitter with its own cells.
    struct Emitter {
        var name: String?
        var at: Any?
        var size: Expr
        var shape: CAEmitterLayerEmitterShape
        var render: CAEmitterLayerRenderMode
        var back: Bool
        var inRoot: Bool
        var z: String?
        var below: String?
        var birthRate, velocity: Expr?
        var cells: [[String: Any]]
    }

    private(set) var spans: [Span] = []
    private(set) var events: [(t: Double, ev: Event)] = []
    private(set) var length = 0.0
    /// Where the round (the looped part) starts: the intro's length.
    private(set) var intro = 0.0
    let loop: Bool
    let moveWhileActing: Bool
    private(set) var marker: CGPoint?
    /// The particle emitter's set-up, its looks, and when each look starts (round time).
    let particles: [String: Any]?
    private(set) var looks: [(t: Double, look: String)] = []
    /// Which state's script this is (its layers are kept per state).
    let key: String
    private(set) var vars: [(String, Expr)] = []
    private(set) var bodyMotion: (dx: Expr, dy: Expr, lean: Expr)?
    private(set) var layers: [Layer] = []
    private(set) var emitters: [Emitter] = []
    /// The layers' and emitters' set-up, to tell whether a Gundam's built ones still fit.
    let signature: String
    /// The state's program (states/<file>.js), if it has one.
    let program: ScriptProgram?
    /// "runWhileIdle": its program's update runs every tick, acting or not (c.acting says which; nothing is hidden
    /// for it), e.g. particles that ease out by themselves.
    let runsIdle: Bool

    let params: [String: Any]
    private let unit: UnitDef
    /// unit.json's rig numbers, as expressions see them ("rig.<key>").
    private let rigNumbers: [String: Double]
    /// Everything it was made from (the state file's script and the settings), to tell whether it can be played on.
    let source: String
    /// The particle looks the timeline switches between, read once.
    private(set) var lookTable: [String: DriftLook] = [:]
    /// The last tick's expression variables (asked for up to three times a tick).
    private var cachedEnv: (key: [Double], env: [String: Double])?

    /// The plan to play for a state's script: `old` again when nothing it was made from has changed (the same script,
    /// settings and character), so its program keeps its state and its JavaScript is not loaded anew; else a new one.
    static func make(_ o: [String: Any], params: [String: Any], unit: UnitDef, key: String,
                     reusing old: ScriptPlan?) -> ScriptPlan {
        if let old, old.key == key, old.unit === unit, old.source == Self.sourceKey(o, params) { return old }
        return ScriptPlan(o, params: params, unit: unit, key: key)
    }

    private static func sourceKey(_ o: [String: Any], _ params: [String: Any]) -> String {
        let all: [String: Any] = ["script": o, "params": params]
        return (try? JSONSerialization.data(withJSONObject: all, options: [.sortedKeys]))
            .map { String(decoding: $0, as: UTF8.self) } ?? UUID().uuidString
    }

    /// A cell's number fields (its "image", "name" and "color" are not expressions).
    static let cellFields: Set<String> = ["rate", "life", "lifeRange", "velocity", "velocityRange", "range", "longitude",
                                          "xAccel", "yAccel", "scale", "scaleRange", "scaleSpeed", "alphaRange",
                                          "alphaSpeed", "spin", "spinRange", "greenRange"]

    /// Expression problems already in the run log (each once a run).
    static var reported = Set<String>()

    init(_ o: [String: Any], params: [String: Any], unit: UnitDef, key: String) {
        self.params = params
        self.unit = unit
        self.key = key
        source = Self.sourceKey(o, params)
        rigNumbers = Dictionary(uniqueKeysWithValues: unit.rig.raw.compactMap { k, v in
            (v as? NSNumber).map { ("rig." + k, $0.doubleValue) }
        })
        // what a state file gets wrong goes in the run log (once), with where it is
        let unitId = unit.id
        Expr.report = { msg in
            let line = "角色 \(unitId) 的狀態 \(key)：\(msg)"
            if ScriptPlan.reported.insert(line).inserted { RunLog.write(.error, line) }
        }
        defer { Expr.report = nil; Expr.known = nil }
        let varNames = Set((o["vars"] as? [String: Any] ?? [:]).keys)
        Expr.known = varNames.union(["t", "st", "u", "h", "count"])
        loop = o["loop"] as? Bool ?? true
        moveWhileActing = Self.bool(o["moveWhileActing"], params) ?? false
        marker = nil
        particles = o["particles"] as? [String: Any]
        // the layers are built again when their set-up or the settings (sizes, counts may come from them) change
        let shape: [String: Any] = ["particles": o["particles"] ?? 0, "layers": o["layers"] ?? 0,
                                    "emitters": o["emitters"] ?? 0, "params": params]
        signature = (try? JSONSerialization.data(withJSONObject: shape, options: [.sortedKeys]))
            .map { String(decoding: $0, as: UTF8.self) } ?? ""
        for (k, v) in (o["vars"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) {
            vars.append((k, Expr(v, params: params)))
        }
        if let b = o["body"] as? [String: Any] {
            bodyMotion = (Expr(b["dx"], params: params), Expr(b["dy"], params: params), Expr(b["lean"], params: params))
        }
        runsIdle = o["runWhileIdle"] as? Bool ?? false
        program = (o["programSource"] as? String).map {
            ScriptProgram(source: $0, name: "\(unit.id)/\(o["program"] as? String ?? key)", params: params)
        }
        // a value the state file leaves out: the old default, or (a program's layer) not set at all
        let free = program == nil
        func expr(_ v: Any?, _ d: Double) -> Expr? { v != nil || free ? Expr(v, d, params: params) : nil }
        func layer(_ l: [String: Any]) -> Layer {
            (l["frame"] as? [Any])?.forEach { _ = Expr($0, 0, params: params) }      // read again when built
            let size = l["size"] as? [Any]
            return Layer(name: l["name"] as? String, image: picture(l["image"]), at: l["at"],
                         width: Expr(size?.first ?? l["size"], 0.3, params: params),
                         height: size.flatMap { $0.count > 1 ? Expr($0[1], 0.3, params: params) : nil },
                         scale: expr(l["scale"], 1), opacity: expr(l["opacity"], 1), rotation: expr(l["rotation"], 0),
                         back: l["back"] as? Bool ?? false, inRoot: (l["in"] as? String) == "root",
                         z: l["z"] as? String, below: l["below"] as? String,
                         children: (l["children"] as? [[String: Any]] ?? []).map(layer),
                         sized: l["size"] != nil || l["frame"] != nil, raw: l)
        }
        func addLayer(_ l: [String: Any]) { layers.append(layer(l)) }
        // {"repeat": n, "layers": [...]}: n copies of the group, each in the group's order (as they stack)
        for l in o["layers"] as? [[String: Any]] ?? [] {
            if let group = l["layers"] as? [[String: Any]] {
                for _ in 0..<max(0, Int(num(l["repeat"], 1))) { group.forEach(addLayer) }
            } else {
                addLayer(l)
            }
        }
        for e in o["emitters"] as? [[String: Any]] ?? [] {
            // the cells' numbers are read when the layers are built; looked at here so a typo is reported with the rest
            for c in e["cells"] as? [[String: Any]] ?? [] {
                for (k, v) in c where v is String && Self.cellFields.contains(k) { _ = Expr(v, 0, params: params) }
            }
            let render: CAEmitterLayerRenderMode = (e["render"] as? String) == "oldestFirst" ? .oldestFirst
                : (e["render"] as? String) == "unordered" ? .unordered : .additive
            emitters.append(Emitter(name: e["name"] as? String, at: e["at"], size: Expr(e["size"], 0.1, params: params),
                                    shape: (e["shape"] as? String) == "point" ? .point : .circle, render: render,
                                    back: e["back"] as? Bool ?? false, inRoot: (e["in"] as? String) == "root",
                                    z: e["z"] as? String, below: e["below"] as? String,
                                    birthRate: expr(e["birthRate"], 1), velocity: expr(e["velocity"], 1),
                                    cells: e["cells"] as? [[String: Any]] ?? []))
        }
        marker = (o["marker"] as? [Any]).flatMap { $0.count == 2 ? CGPoint(x: num($0[0], 0), y: num($0[1], 0)) : nil }
        // the particle looks, read once (any number may be an expression; what is left out is 0, rate and speed 1)
        for (name, v) in particles?["looks"] as? [String: [String: Any]] ?? [:] {
            func n(_ k: String, _ d: Double) -> CGFloat { CGFloat(num(v[k], d)) }
            lookTable[name] = DriftLook(range: n("range", 0), longitude: n("longitude", 0), velocity: n("velocity", 0),
                                        yAccel: n("yAccel", 0), xAccel: n("xAccel", 0), rate: n("rate", 1),
                                        speed: n("speed", 1), halo: 0)
        }
        intro = compile(o["intro"] as? [[String: Any]] ?? [], at: 0, round: 0)
        length = compile(o["timeline"] as? [[String: Any]] ?? [], at: intro, round: 0)
        spans.sort { $0.start < $1.start }
        events.sort { $0.t < $1.t }
        looks.sort { $0.t < $1.t }
    }

    /// The particle look at time `u` (nil: none set).
    func look(at u: Double) -> String? { looks.last(where: { $0.t <= u })?.look }

    /// The expression variables for a tick: time, height, the frame count (for "frames"), the rig's numbers, then the
    /// script's "vars" (settings are only ever "$name", so they never hide these). Kept for the rest of the tick.
    func env(t: Double, st: Double, h: CGFloat, count: Int = 0) -> [String: Double] {
        let key = [t, st, Double(h), Double(count)]
        if let c = cachedEnv, c.key == key { return c.env }
        var e = rigNumbers
        e["t"] = t
        e["st"] = st
        e["u"] = local(t)
        e["h"] = Double(h)
        e["count"] = Double(count)
        // a var may use others (in any order): as many passes as there are vars settle every chain
        for _ in vars.indices { for (k, x) in vars { e[k] = x.eval(e) } }
        cachedEnv = (key, e)
        return e
    }

    // MARK: values

    private func value(_ v: Any?) -> Any? {
        if let s = v as? String, s.hasPrefix("$") { return params[String(s.dropFirst())] }
        return v
    }
    /// A number in the state file, read when it is loaded: a number, "$setting" or an expression of the settings, pi
    /// and the rig's numbers (no time, no height: those change while it plays).
    private func num(_ v: Any?, _ d: Double) -> Double {
        if let n = v as? NSNumber { return Self.finite(n.doubleValue, d) }
        guard v is String else { return d }
        return Self.finite(Expr(v, d, params: params).eval(rigNumbers), d)
    }
    /// A number as an Int, 0 for NaN / ±inf (Int(_:) would stop the app) and clamped to a sane range.
    static func int(_ d: Double) -> Int { d.isFinite ? Int(max(-1e9, min(1e9, d))) : 0 }

    /// A script's number, or `fallback` when it is NaN / ±inf.
    static func finite(_ d: Double, _ fallback: Double = 0) -> Double { d.isFinite ? d : fallback }

    private static func bool(_ v: Any?, _ params: [String: Any]) -> Bool? {
        if let s = v as? String, s.hasPrefix("$") { return params[String(s.dropFirst())] as? Bool }
        return v as? Bool
    }
    private func color(_ v: Any?) -> CGColor {
        guard let c = value(v) as? [Double], c.count >= 3 else { return CGColor(gray: 1, alpha: 1) }      // white unless said
        return CGColor(red: c[0], green: c[1], blue: c[2], alpha: c.count > 3 ? c[3] : 1)
    }
    /// The keyPaths a program may set on its emitters: emitterCells.<name>.<a number of the particle kind>.
    static func cellKeyPath(_ path: String) -> Bool {
        let parts = path.split(separator: ".")
        return parts.count == 3 && parts[0] == "emitterCells" && cellNumbers.contains(String(parts[2]))
            && parts[1].allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
    }

    private static let cellNumbers: Set<String> = [
        "birthRate", "lifetime", "lifetimeRange", "velocity", "velocityRange", "emissionLongitude", "emissionLatitude",
        "emissionRange", "xAcceleration", "yAcceleration", "zAcceleration", "scale", "scaleRange", "scaleSpeed",
        "alphaRange", "alphaSpeed", "spin", "spinRange", "redRange", "greenRange", "blueRange", "redSpeed",
        "greenSpeed", "blueSpeed"]

    /// [r, g, b] or [r, g, b, a] as a colour (nil for anything else).
    static func color(_ v: Any?) -> CGColor? {
        let c = (v as? [Double]) ?? (v as? [NSNumber])?.map(\.doubleValue)
        guard let c, c.count >= 3 else { return nil }
        return CGColor(red: c[0], green: c[1], blue: c[2], alpha: c.count > 3 ? c[3] : 1)
    }
    /// A picture by "group/name" from the unit's picture groups.
    func picture(_ v: Any?) -> CGImage? {
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
        let g = (o["grow"] as? [Any])?.map { num($0, 1) } ?? [1, 1]
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
                // frames are never below 0 and an empty list plays nothing; fps must be a positive number
                let f = ((s["frames"] as? [Any])?.map { Self.int(num($0, 0)) } ?? [0, 0]).map { max(0, $0) }
                let frames = f.count == 2 && f[1] >= f[0] ? Array(f[0]...f[1]) : f
                var fps = num(s["fps"], 12)
                if !(fps.isFinite && fps > 0) { fps = 12 }
                guard !frames.isEmpty else { break }
                spans.append(Span(start: t, anim: s["anim"] as? String ?? "", frames: frames, fps: fps, index: nil))
                t += Double(frames.count) / fps
            case "frame":
                var f = Self.int(num(s["frame"], 0))
                if let list = (s["frames"] as? [Any])?.map({ Self.int(num($0, 0)) }), !list.isEmpty {
                    f = (s["pick"] as? String) == "alternate" ? list[round % list.count] : list[0]
                }
                f = max(0, f)
                spans.append(Span(start: t, anim: s["anim"] as? String ?? "", frames: [f], fps: nil, index: nil))
                t += num(s["hold"], 0)
            case "frames":
                spans.append(Span(start: t, anim: s["anim"] as? String ?? "", frames: [0], fps: nil,
                                  index: Expr(s["index"], 0, params: params)))
                t += num(s["for"], 0)
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
                // "alternate": the two guns take turns, round by round; else which gun
                let gun = (from["gun"] as? String) == "alternate" ? round % 2 : Self.int(num(from["gun"], 0))
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
                let at = (s["at"] as? [Any])?.map { num($0, 0) } ?? [0, 0.55]
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

    /// The picture at act time `t` (st: since the state started, h: height): the latest span begun by then.
    func frame(t: Double, st: Double, h: CGFloat) -> (String, Int)? {
        let u = local(t)
        guard let s = spans.last(where: { $0.start <= u }) ?? spans.first else { return nil }
        if let x = s.index {
            let n = unit.anim(s.anim).frames.count
            let e = env(t: t, st: st, h: h, count: n)
            return (s.anim, min(max(0, n - 1), max(0, Self.int(x.eval(e).rounded()))))
        }
        guard let fps = s.fps else { return (s.anim, s.frames[0]) }
        return (s.anim, s.frames[min(s.frames.count - 1, max(0, Int((u - s.start) * fps)))])
    }

    /// The events between two round times (wrapping round the end of a round).
    func events(after a: Double, upTo b: Double) -> [Event] {
        if b >= a { return events.filter { $0.t > a && $0.t <= b }.map(\.ev) }
        // wrapped round the end of a round: the rest of it, then the round's start (not the intro)
        return events.filter { $0.t > a || ($0.t >= intro && $0.t <= b) }.map(\.ev)
    }

    /// As one of the system's acts: the frame, the round's events and what plays alongside, the body's motion, and
    /// (unless it may move mid-act) leaving only as a round ends.
    func act() -> Act {
        let prog = program
        var loopEnds: ((Double) -> Bool)? = moveWhileActing || !loop || length <= intro ? nil : { [unowned self] t in
            self.roundEnds(t)
        }
        if let p = prog, p.defines("loopEnds") { loopEnds = { t in p.call("loopEnds", [t])?.toBool() ?? true } }
        // no frames of its own (no timeline, no program frame): the system plays the state's animation by its mode
        let ownFrames = !spans.isEmpty || prog?.defines("frame") == true
        return Act(
            frame: !ownFrames ? nil : { [unowned self] n, t, now in
                if let f = self.programFrame("frame", n, t: t, now: now) { return f }
                return self.frame(t: t, st: now - n.stateStart, h: n.unitHeight) ?? (n.plan.anim, 0)
            },
            update: { [unowned self] n, now, off, acting in n.runScript(self, now: now, offset: off, acting: acting) },
            hide: { n, _ in n.hideScript() },
            loopEnds: loopEnds,
            travel: { [unowned self] n in
                let now = CACurrentMediaTime()
                if let f = self.programFrame("travel", n, t: max(0, now - n.trackStart), now: now) { return f }
                return self.frame(t: 0, st: 0, h: n.unitHeight) ?? (n.plan.anim, 0)
            },
            bubble: marker.map { m in { n in CGPoint(x: n.unitHeight * m.x, y: n.unitHeight * m.y) } },
            react: bodyMotion == nil && prog?.defines("react") != true ? nil : { [unowned self] n, now, st, dx, dy, lean in
                if let p = prog, p.defines("react") {
                    p.attach(n)
                    var c = p.context(n, t: max(0, now - n.trackStart), now: now, offset: CGPoint(x: dx, y: dy),
                                      acting: n.settled(now: now))
                    c["lean"] = Double(lean)
                    guard let r = p.call("react", [c]) else { return }
                    dx = r.num("dx", dx)
                    dy = r.num("dy", dy)
                    lean = r.num("lean", lean)
                    return
                }
                guard let b = self.bodyMotion else { return }
                let e = self.env(t: max(0, now - n.trackStart), st: st, h: n.unitHeight)
                dx = CGFloat(Self.finite(b.dx.eval(e)))
                dy = CGFloat(Self.finite(b.dy.eval(e)))
                lean = CGFloat(Self.finite(b.lean.eval(e))) * .pi / 180
            })
    }

    /// The program's frame / travel picture, if it gives one.
    private func programFrame(_ fn: String, _ n: PetNode, t: Double, now: CFTimeInterval) -> (String, Int)? {
        guard let p = program, p.defines(fn) else { return nil }
        p.attach(n)
        guard let f = p.call(fn, [p.context(n, t: t, now: now, offset: .zero, acting: true)])?.frameRef
        else { return nil }
        return (f.0, max(0, f.1))
    }
}

/// One state's layers and emitters on one Gundam (kept while other states play, so their particles fade out as
/// they would).
final class ScriptSet {
    var signature = ""
    var drift: CAEmitterLayer?
    var layers: [CALayer] = []
    var emitters: [CAEmitterLayer] = []
    /// The program's layers and emitters, by name (a "repeat" group's in order).
    var named: [String: [CALayer]] = [:]
    var namedEmitters: [String: [CAEmitterLayer]] = [:]
    /// Names of containers' pictures (not hidden when a tick leaves them out).
    var children: Set<String> = []
    /// What its program got wrong, already in the run log (once each).
    var warned = Set<String>()
    /// Hidden since it last played (hiding it again would only write the same values every tick).
    var hidden = false

    func hide() {
        guard !hidden else { return }
        hidden = true
        drift?.birthRate = 0
        for l in layers { l.opacity = 0 }
        for e in emitters { e.birthRate = 0 }
    }

    func remove() {
        drift?.removeFromSuperlayer()
        for l in layers { l.removeFromSuperlayer() }
        for e in emitters { e.removeFromSuperlayer() }
    }
}

/// A script's per-Gundam playing state.
final class ScriptParts: ActParts {
    required init() {}
    /// Each scripted state's layers, by state.
    var sets: [String: ScriptSet] = [:]
    var last = -1.0
    var kickAt = -10.0
    var kickDir = CGPoint.zero
    var kick: CGFloat = 0
    var kickTime = 0.07
    /// The node's own layers a program has moved (put back when it stops).
    var movedMarker = false
    var movedBrackets = false
    var movedBodyOpacity = false
    var movedSpriteShadow = false
    var movedTag = false
    /// Whether it was hidden last tick (a program's hide() runs once as it stops acting).
    var hidden = true
    /// The script it played last tick, and the act time it started from (a new one, or a replay, starts afresh).
    weak var plan: ScriptPlan?
    var track: CFTimeInterval = -1
}

extension PetNode {
    /// Plays one tick of a script: what plays alongside the frames, its round's events since the last tick, and the
    /// jolt of the last shot.
    func runScript(_ sp: ScriptPlan, now: CFTimeInterval, offset: CGPoint, acting: Bool) {
        let p = parts(ScriptParts.self)
        // Another script than last tick (another state, the settings re-read): put back what the last one moved on the
        // Gundam itself, so nothing it left (a faded body, a moved marker or tag) carries over; a replay of the same
        // one (its time restarted) starts its events afresh.
        if p.plan !== sp {
            restoreAfterProgram(p, switching: true)
            p.plan = sp
            p.last = -1
            p.hidden = true
        }
        if p.track != trackStart {
            p.track = trackStart
            p.last = -1
        }
        for (k, s) in p.sets where k != sp.key { s.hide() }
        let set = scriptSet(for: sp, parts: p)
        // a program that failed (or ran too long) is left off: its pictures go, the Gundam is put back
        if let prog = sp.program, prog.broken != nil {
            set.hide()
            restoreAfterProgram(p)
            return
        }
        if !acting, sp.runsIdle, let prog = sp.program, prog.defines("update") {
            p.last = -1
            set.hidden = false
            prog.attach(self)
            let c = prog.context(self, t: max(0, now - trackStart), now: now, offset: offset, acting: false)
            applyProgram(prog.call("update", [c])?.toDictionary() as? [String: Any] ?? [:], sp, set: set, parts: p)
            return
        }
        guard acting else {
            if p.last >= 0 || !p.hidden { sp.program?.call("hide", []) }
            p.last = -1
            p.hidden = true
            set.hide()
            restoreAfterProgram(p)
            return
        }
        p.hidden = false
        set.hidden = false
        let t = max(0, now - trackStart)
        let u = sp.local(t)
        let e = sp.env(t: t, st: now - stateStart, h: unitHeight)
        runParticles(sp, at: u, set: set)
        runLayers(sp, env: e, set: set)
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
        if let prog = sp.program, prog.defines("update") {
            prog.attach(self)
            let c = prog.context(self, t: t, now: now, offset: offset, acting: true)
            applyProgram(prog.call("update", [c])?.toDictionary() as? [String: Any] ?? [:], sp, set: set, parts: p)
        }
    }

    func hideScript() {
        let p = parts(ScriptParts.self)
        p.last = -1
        for s in p.sets.values { s.hide() }
        restoreAfterProgram(p, switching: p.plan != nil)
        p.plan = nil
    }

    /// What a program's update returned, onto its layers, emitters and the Gundam (see ScriptProgram). Its named
    /// layers it leaves out this tick are hidden.
    private func applyProgram(_ r: [String: Any], _ sp: ScriptPlan, set: ScriptSet, parts p: ScriptParts) {
        // numbers only, and only finite ones: NaN / ±inf from a script would stop the app (layer geometry)
        func f(_ o: [String: Any], _ k: String) -> CGFloat? {
            guard let d = (o[k] as? NSNumber)?.doubleValue, d.isFinite else { return nil }
            return CGFloat(d)
        }
        let ls = r["layers"] as? [String: Any] ?? [:]
        for (name, layers) in set.named {
            let given: [[String: Any]?] = (ls[name] as? [Any]).map { $0.map { $0 as? [String: Any] } }
                ?? [ls[name] as? [String: Any]]
            let keeps = set.children.contains(name)
            if given.count > layers.count, set.warned.insert("count:" + name).inserted {
                RunLog.write(.error, "角色 \(unit.id) 的狀態 \(sp.key)：程式給了 \(given.count) 個「\(name)」，"
                             + "狀態檔只宣告 \(layers.count) 個（多的不顯示；repeat 數要跟程式的陣列一樣長）")
            }
            for (i, l) in layers.enumerated() {
                guard i < given.count, let o = given[i] else {
                    if !keeps { l.opacity = 0 }
                    continue
                }
                if let x = f(o, "x"), let y = f(o, "y") { l.position = CGPoint(x: x, y: y) }
                if ["scale", "sx", "sy", "rotation"].contains(where: { o[$0] != nil }) {
                    let k = f(o, "scale") ?? 1
                    l.transform = CATransform3DScale(CATransform3DMakeRotation(f(o, "rotation") ?? 0, 0, 0, 1),
                                                     (f(o, "sx") ?? 1) * k, (f(o, "sy") ?? 1) * k, 1)
                }
                if let op = f(o, "opacity") { l.opacity = Float(max(0, min(1, op))) } else if !keeps { l.opacity = 1 }
                // a picture by name, or one of the unit's frames (as the sprite shows it: size and pinned point)
                if let name = o["image"] as? String { l.contents = sp.picture(name) }
                if let fr = o["frame"] as? [Any], fr.count == 2, let a = fr[0] as? String,
                   let i = (fr[1] as? NSNumber)?.intValue {
                    let anim = unit.anim(a)
                    l.contents = anim.frames[min(max(0, i), anim.count - 1)]
                    l.bounds = CGRect(x: 0, y: 0, width: anim.size.width * scale, height: anim.size.height * scale)
                    l.anchorPoint = CGPoint(x: anim.anchor.x / anim.size.width, y: 1 - anim.anchor.y / anim.size.height)
                }
                if let w = f(o, "w"), let h = f(o, "h") { l.bounds = CGRect(x: 0, y: 0, width: max(0, w), height: max(0, h)) }
                if let cs = f(o, "contentsScale"), cs > 0 { l.contentsScale = cs }
                if let c = ScriptPlan.color(o["stroke"]) { (l as? CAShapeLayer)?.strokeColor = c }
                if let c = ScriptPlan.color(o["shadowColor"]) { l.shadowColor = c }
            }
        }
        for (name, v) in r["emitters"] as? [String: Any] ?? [:] {
            guard let o = v as? [String: Any], let es = set.namedEmitters[name] else { continue }
            for e in es {
                if let x = f(o, "x"), let y = f(o, "y") { e.emitterPosition = CGPoint(x: x, y: y) }
                if let b = f(o, "birthRate") { e.birthRate = Float(b) }
                if let v = f(o, "velocity") { e.velocity = Float(v) }
                for (path, value) in o["keyPaths"] as? [String: Any] ?? [:] {
                    // only a particle kind's numbers: nothing else of the app is reachable this way
                    guard ScriptPlan.cellKeyPath(path) else {
                        if set.warned.insert("keyPath:" + path).inserted {
                            RunLog.write(.error, "角色 \(unit.id) 的狀態 \(sp.key)：keyPaths 不接受「\(path)」"
                                         + "（只能是 emitterCells.<名字>.<數值屬性>）")
                        }
                        continue
                    }
                    guard let n = value as? NSNumber, n.doubleValue.isFinite else { continue }
                    e.setValue(n, forKeyPath: path)
                }
            }
        }
        if let b = r["body"] as? [String: Any] {
            let k = f(b, "scale") ?? 1
            body.transform = CATransform3DRotate(CATransform3DScale(
                CATransform3DMakeTranslation(f(b, "x") ?? 0, f(b, "y") ?? 0, 0), k, k, 1), f(b, "rotation") ?? 0, 0, 0, 1)
        }
        if let o = r["bodyOpacity"] as? NSNumber {
            body.opacity = o.floatValue
            p.movedBodyOpacity = true
        }
        if let t = r["tint"] as? [String: Any] {
            if let c = t["color"] as? [NSNumber], c.count >= 3 {
                tint.backgroundColor = CGColor(red: CGFloat(c[0].doubleValue), green: CGFloat(c[1].doubleValue),
                                               blue: CGFloat(c[2].doubleValue), alpha: 1)
            }
            if let o = f(t, "opacity") { tint.opacity = Float(o) }
        }
        if let m = r["marker"] as? [String: Any] {
            if let hidden = m["hidden"] as? Bool { bubble.isHidden = hidden }
            if let o = f(m, "opacity") { bubble.opacity = Float(o) }
            if let x = f(m, "x"), let y = f(m, "y") { bubble.transform = CATransform3DMakeTranslation(x, y, 0) }
            p.movedMarker = true
        }
        if let sh = r["spriteShadow"] as? [String: Any] {
            if let c = ScriptPlan.color(sh["color"]) { sprite.shadowColor = c }
            if let rad = f(sh, "radius") { sprite.shadowRadius = rad }
            sprite.shadowOffset = .zero
            if let o = f(sh, "opacity") { sprite.shadowOpacity = Float(o) }
            p.movedSpriteShadow = true
        }
        if let x = f(r, "tagX") {
            tag.position.x = x
            p.movedTag = true
        }
        // swap pictures at once this tick (no cross-fade), e.g. under a white flash
        if r["skipFade"] as? Bool == true {
            ghost.opacity = 0
            sprite.opacity = 1
        }
        if let b = r["brackets"] as? [String: Any] {
            let k = f(b, "scale") ?? 1
            brackets.transform = CATransform3DScale(CATransform3DMakeTranslation(f(b, "x") ?? 0, f(b, "y") ?? 0, 0), k, k, 1)
            p.movedBrackets = true
        }
    }

    /// Puts back what a program moved of the Gundam's own (marker, alert corners, body opacity, glow) once it stops;
    /// `switching` (another script takes over) also the name tag, which otherwise waits where it is while the
    /// Gundam moves.
    private func restoreAfterProgram(_ p: ScriptParts, switching: Bool = false) {
        if switching && p.movedTag {
            tag.position.x = 0
            p.movedTag = false
        }
        if p.movedMarker {
            bubble.opacity = 1
            bubble.transform = CATransform3DIdentity
            p.movedMarker = false
        }
        if p.movedBrackets {
            brackets.transform = CATransform3DIdentity
            p.movedBrackets = false
        }
        if p.movedBodyOpacity {
            body.opacity = 1
            p.movedBodyOpacity = false
        }
        if p.movedSpriteShadow {
            sprite.shadowOpacity = 0
            p.movedSpriteShadow = false
        }
    }

    /// How a layer of the state file is drawn: "gravity" (fill / aspect / center / resize), "blend": "multiply",
    /// "anchor" [x, y], "stretch" [x, y, w, h] (the picture's part that stretches), "background" [r, g, b, a],
    /// "clip" (a chamfered mask, its corner cut in points), "shadow" {color, opacity, radius}, "trilinear" (thin lines
    /// stay solid when shrunk); "shape": "chamfer" (an outline: "cut", "inset", "lineWidth", "stroke", "fill");
    /// "text" (with "font" {size, weight: bold, mono}, "color", "align").
    private func styleLayer(_ l: CALayer, _ r: [String: Any]) {
        let color = ScriptPlan.color
        if let g = r["gravity"] as? String {
            l.contentsGravity = g == "fill" ? .resizeAspectFill : g == "aspect" ? .resizeAspect : g == "center" ? .center : .resize
        }
        if r["blend"] as? String == "multiply" { l.compositingFilter = "multiplyBlendMode" }
        if let a = r["anchor"] as? [Double], a.count == 2 { l.anchorPoint = CGPoint(x: a[0], y: a[1]) }
        if let s = r["stretch"] as? [Double], s.count == 4 { l.contentsCenter = CGRect(x: s[0], y: s[1], width: s[2], height: s[3]) }
        if let bg = color(r["background"]) { l.backgroundColor = bg }
        if let cut = r["clip"] as? Double {
            let m = CAShapeLayer()
            m.path = Hud.chamfer(l.bounds, cut: CGFloat(cut))
            l.mask = m
        }
        if let s = r["shadow"] as? [String: Any] {
            l.shadowColor = color(s["color"])
            l.shadowOpacity = Float(s["opacity"] as? Double ?? 1)
            l.shadowRadius = CGFloat(s["radius"] as? Double ?? 3)
            l.shadowOffset = .zero
        }
        if r["trilinear"] as? Bool == true { l.minificationFilter = .trilinear }
        if let sh = l as? CAShapeLayer {
            let inset = CGFloat(r["inset"] as? Double ?? 0)
            sh.path = Hud.chamfer(sh.bounds.insetBy(dx: inset, dy: inset), cut: CGFloat(r["cut"] as? Double ?? 0))
            sh.fillColor = color(r["fill"])
            sh.strokeColor = color(r["stroke"])
            sh.lineWidth = CGFloat(r["lineWidth"] as? Double ?? 1)
        }
        if let t = l as? CATextLayer, let s = r["text"] as? String {
            let f = r["font"] as? [String: Any] ?? [:]
            let size = CGFloat(f["size"] as? Double ?? 12)
            let w: NSFont.Weight = (f["weight"] as? String) == "bold" ? .bold : .regular
            t.font = (f["mono"] as? Bool ?? false) ? NSFont.monospacedSystemFont(ofSize: size, weight: w)
                : NSFont.systemFont(ofSize: size, weight: w)
            t.fontSize = size
            t.string = s
            t.foregroundColor = color(r["color"]) ?? CGColor(gray: 1, alpha: 1)
            t.contentsScale = 2
            let align = r["align"] as? String
            t.alignmentMode = align == "right" ? .right : align == "center" ? .center : .left
        }
    }

    /// A point the script names: a rig key measured on the frame shown (pixels) or [x, y] × height, in body space.
    private func scriptPoint(_ at: Any?) -> CGPoint {
        if let key = at as? String, let c = unit.rig.raw[key] as? [Double], c.count == 2 {
            return bodyPoint(CGPoint(x: c[0], y: c[1]), in: unit.anim(shownAnim))
        }
        if let v = at as? [Double], v.count == 2 { return CGPoint(x: v[0] * unitHeight, y: v[1] * unitHeight) }
        return .zero
    }

    /// The state's set of layers, built on first use (and again if the script's set-up changed).
    private func scriptSet(for sp: ScriptPlan, parts p: ScriptParts) -> ScriptSet {
        if let s = p.sets[sp.key], s.signature == sp.signature { return s }
        p.sets[sp.key]?.remove()
        let s = ScriptSet()
        s.signature = sp.signature
        let base = sp.env(t: 0, st: 0, h: unitHeight)
        /// On the body (behind: under everything on it) or beside it in the Gundam's root (behind: under the body;
        /// "aboveBody": right over it); or under another of the state's layers, by name.
        func place(_ l: CALayer, inRoot: Bool, back: Bool, z: String?, below: String?) {
            let system: [String: CALayer] = ["@sparks": sparks, "@sprite": sprite, "@tint": tint, "@body": body]
            if let b = below, let other = system[b] ?? s.named[b]?.first ?? s.namedEmitters[b]?.first,
               let parent = other.superlayer {
                parent.insertSublayer(l, below: other)
                return
            }
            switch (inRoot, back || z == "belowBody") {
            case (true, true): root.insertSublayer(l, below: body)
            case (true, false): if z == "aboveBody" { root.insertSublayer(l, above: body) } else { root.addSublayer(l) }
            case (false, true): body.insertSublayer(l, at: 0)
            case (false, false): body.addSublayer(l)
            }
        }
        func make(_ l: ScriptPlan.Layer, in parent: CGRect?) -> CALayer {
            let layer: CALayer = l.raw["text"] != nil ? CATextLayer() : l.raw["shape"] != nil ? CAShapeLayer() : CALayer()
            layer.contents = l.image
            let ih = CGFloat(l.image?.height ?? 1), iw = CGFloat(max(1, l.image?.width ?? 1))
            if let p = parent, !l.sized {
                layer.frame = p                  // a container's picture: as big as the container
            } else {
                let size = { (d: Double) in CGFloat(max(0, ScriptPlan.finite(d))) * self.unitHeight }
                let w = size(l.width.eval(base))
                let h = l.height.map { size($0.eval(base)) } ?? (l.children.isEmpty ? w * ih / iw : w)
                layer.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            }
            // "frame": [x, y, w, h] in points in its parent; "center": put in its parent's middle
            if let f = l.raw["frame"] as? [Any], f.count == 4 {
                let v = f.map { CGFloat(ScriptPlan.finite(Expr($0, 0, params: sp.params).eval(base))) }
                layer.frame = CGRect(x: v[0], y: v[1], width: max(0, v[2]), height: max(0, v[3]))
            }
            if l.raw["center"] as? Bool == true, let p = parent { layer.position = CGPoint(x: p.midX, y: p.midY) }
            styleLayer(layer, l.raw)
            for c in l.children {
                let child = make(c, in: layer.bounds)
                child.opacity = Float(max(0, min(1, ScriptPlan.finite(c.opacity?.eval(base) ?? 1, 1))))
                layer.addSublayer(child)
                if let name = c.name {
                    s.named[name, default: []].append(child)
                    s.children.insert(name)
                }
            }
            return layer
        }
        for l in sp.layers {
            let layer = make(l, in: nil)
            layer.opacity = 0
            place(layer, inRoot: l.inRoot, back: l.back, z: l.z, below: l.below)
            s.layers.append(layer)
            if let name = l.name { s.named[name, default: []].append(layer) }
        }
        for em in sp.emitters {
            let e = CAEmitterLayer()
            e.emitterCells = em.cells.map { c in scriptCell(c, sp: sp, env: base) }
            e.emitterShape = em.shape
            let size = CGFloat(max(0, ScriptPlan.finite(em.size.eval(base)))) * unitHeight
            e.emitterSize = CGSize(width: size, height: size)
            if let at = em.at { e.emitterPosition = scriptPoint(at) }
            e.renderMode = em.render
            e.birthRate = 0
            place(e, inRoot: em.inRoot, back: em.back, z: em.z, below: em.below)
            s.emitters.append(e)
            if let name = em.name { s.namedEmitters[name, default: []].append(e) }
        }
        p.sets[sp.key] = s
        return s
    }

    /// One particle kind of a script's emitter (numbers may be expressions, e.g. "0.5*h").
    private func scriptCell(_ c: [String: Any], sp: ScriptPlan, env: [String: Double]) -> CAEmitterCell {
        func v(_ k: String, _ d: Double) -> CGFloat { CGFloat(ScriptPlan.finite(Expr(c[k], d, params: sp.params).eval(env), d)) }
        let cell = CAEmitterCell()
        cell.name = c["name"] as? String
        cell.contents = sp.picture(c["image"]) ?? Fx.dot(CGColor(gray: 1, alpha: 1))
        cell.birthRate = Float(v("rate", 10))
        cell.lifetime = Float(v("life", 1))
        cell.lifetimeRange = Float(v("lifeRange", 0))
        cell.velocity = v("velocity", 0)
        cell.velocityRange = v("velocityRange", 0)
        cell.emissionRange = v("range", 0)
        cell.emissionLongitude = v("longitude", 0)
        cell.xAcceleration = v("xAccel", 0)
        cell.yAcceleration = v("yAccel", 0)
        cell.scale = v("scale", 1)
        cell.scaleRange = v("scaleRange", 0)
        cell.scaleSpeed = v("scaleSpeed", 0)
        cell.alphaRange = Float(v("alphaRange", 0))
        cell.alphaSpeed = Float(v("alphaSpeed", 0))
        cell.spin = v("spin", 0)
        cell.spinRange = v("spinRange", 0)
        cell.greenRange = Float(v("greenRange", 0))
        if let col = c["color"] as? [Double], col.count >= 3 {
            cell.color = CGColor(red: col[0], green: col[1], blue: col[2], alpha: col.count > 3 ? col[3] : 1)
        }
        return cell
    }

    /// The script's pictures and emitters for this tick.
    private func runLayers(_ sp: ScriptPlan, env e: [String: Double], set: ScriptSet) {
        for (l, layer) in zip(sp.layers, set.layers) where l.name == nil || sp.program == nil {
            let fin = ScriptPlan.finite
            if l.at != nil || sp.program == nil { layer.position = scriptPoint(l.at) }
            if l.scale != nil || l.rotation != nil {
                let k = CGFloat(fin(l.scale?.eval(e) ?? 1, 1))
                layer.transform = CATransform3DScale(
                    CATransform3DMakeRotation(CGFloat(fin(l.rotation?.eval(e) ?? 0, 0)) * .pi / 180, 0, 0, 1), k, k, 1)
            }
            if let o = l.opacity { layer.opacity = Float(max(0, min(1, fin(o.eval(e), 0)))) }
        }
        for (em, layer) in zip(sp.emitters, set.emitters) where em.name == nil || sp.program == nil {
            if em.at != nil || sp.program == nil { layer.emitterPosition = scriptPoint(em.at) }
            if let b = em.birthRate { layer.birthRate = Float(max(0, ScriptPlan.finite(b.eval(e)))) }
            if let v = em.velocity { layer.velocity = Float(ScriptPlan.finite(v.eval(e), 1)) }
        }
    }

    /// The script's switchable particles: an emitter behind the body, placed on the body centre the build measured,
    /// in the look the timeline has set.
    private func runParticles(_ sp: ScriptPlan, at u: Double, set: ScriptSet) {
        guard let cfg = sp.particles else { return }
        if set.drift == nil {
            let e = CAEmitterLayer()
            Fx.configureDrift(e, image: sp.picture(cfg["image"]), cell: cfg["cell"] as? [String: Any] ?? [:],
                              size: CGFloat((cfg["size"] as? NSNumber)?.doubleValue ?? 34))
            // the particles' colour is the package's to say
            if let c = ScriptPlan.color(cfg["color"]) { e.setValue(c, forKeyPath: "emitterCells.drift.color") }
            body.insertSublayer(e, at: 0)
            set.drift = e
        }
        guard let e = set.drift else { return }
        if let key = cfg["core"] as? String { e.emitterPosition = scriptPoint(key) }
        guard let name = sp.look(at: u), let look = sp.lookTable[name] else { e.birthRate = 0; return }
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
