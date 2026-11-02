import AppKit
import JavaScriptCore

/// A state's program (10/30): JavaScript in the character's package (states/<file>.js, named by the state file's
/// "script.program"), for what is worked out frame by frame — random hit spots each round, shots aimed where the
/// Gundam is, knock-back adding up hit by hit. The state file still declares the pictures and particles ("layers",
/// "emitters", each with a "name"); the program moves them. It runs in macOS's own JavaScriptCore with nothing but
/// what is handed to it below: no files, no network; one that runs too long is stopped and left off.
///
/// The program defines any of these (c: this tick, see `context`):
///   frame(c)    → [anim, index]          the picture (default: the timeline's, else the state's animation, frame 0)
///   react(c)    → {dx, dy, lean}         the body's reaction (points, radians), as the system's own reactions
///   update(c)   → {layers, emitters, body, tint, marker, brackets, bodyOpacity, spriteShadow, tagX, skipFade}
///       layers:   {name: {x, y, opacity, scale, sx, sy, rotation, image, frame, w, h, contentsScale, stroke,
///                 shadowColor} or a list of them (a "repeat" group, by index); transform = scale(sx·scale,
///                 sy·scale) after rotating by `rotation`; x, y in its parent's space; image: "group/name"; frame:
///                 [anim, index] (that frame as the sprite would show it); w, h: its size in points
///       emitters: {name: {x, y, birthRate, velocity, keyPaths: {"emitterCells.<cell>.<property>": value}}}
///       body:     {x, y, scale, rotation}: the body's whole transform (it replaces the reaction's for this tick)
///       tint:     {color: [r, g, b], opacity}   a colour laid over the picture
///       marker:   {x, y, opacity, hidden}       the state marker (moved by x, y)
///       brackets: {x, y, scale}                 the alert corners
///       spriteShadow: {color, radius, opacity}  a glow round the picture
///       tagX: the name tag's x;  skipFade: true  swaps pictures at once this tick (no cross-fade)
///   loopEnds(t) → bool                   a looping act: may only set off to wander as this is true
///   travel(c)   → [anim, index]          the picture while it waits for a move
///   hide()                               it has stopped acting (waits to move, comes in, goes out)
/// c = {t (seconds since the act started), st (since the state started), now, h (its height), acting, ox, oy (the
/// reaction offset this tick), bodyX, bodyY (the body's pinned point in its parent), markerX, markerY (the state
/// marker's place), anim and fps (the plan's animation), shownAnim, shownFrame, settled (on screen, not
/// coming in or going out), dash (how far into a flourish's forward move, 0…1), fidgeting (in a fidget pose), plan
/// (the state's unit.json rig entry), rootY (its root's height on the stage), tagWidth, fadeTime (the system's
/// cross-fade)}. The state's settings are the global `params` (declared defaults with the user's changes). The global
/// `pet` has rand(a, b, c) (a fixed number 0..<1 for three integers), point(key[, anim]) and bodyPoint(px, py[, anim])
/// (a rig point or a frame pixel in body space, [x, y]), frames(anim) (its frame count), holdFrame(anim, t, fps) (the
/// system's hold playback: in, then back and forth through the hold), imageSize("group/name") ([w, h] pixels),
/// rig(key) (unit.json's rig value) and log(text) (a line in the system log, for the character's author).
/// The full format of a character package is in docs/character-format.md.
final class ScriptProgram {
    private let context: JSContext
    private(set) var broken: String?
    private weak var node: PetNode?
    private let has: Set<String>
    let source: String

    /// JavaScriptCore's own time limit (not in its Swift headers): a program call that runs past it is stopped.
    private typealias SetLimit = @convention(c) (JSContextGroupRef, Double, OpaquePointer?, UnsafeMutableRawPointer?) -> Void
    private static let setLimit: SetLimit? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "JSContextGroupSetExecutionTimeLimit")
        .map { unsafeBitCast($0, to: SetLimit.self) }

    /// One JavaScript machine for every program (a context each), not one per Gundam and state.
    private static let machine = JSVirtualMachine()

    init(source: String, name: String, params: [String: Any] = [:]) {
        self.source = source
        context = JSContext(virtualMachine: Self.machine)
        context.name = name
        // the state's settings, as the global `params` (they do not change for the life of a program)
        context.setObject(params, forKeyedSubscript: "params" as NSString)
        if let set = Self.setLimit { set(JSContextGetGroup(context.jsGlobalContextRef), 0.25, nil, nil) }
        var failure: String?
        context.exceptionHandler = { _, e in failure = e?.toString() ?? "error" }
        context.evaluateScript(Self.prelude)
        context.evaluateScript(source, withSourceURL: URL(fileURLWithPath: name))
        let ctx = context
        has = Set(["frame", "react", "update", "loopEnds", "travel", "hide"].filter {
            ctx.objectForKeyedSubscript($0)?.isObject == true
        })
        if let f = failure { fail(f) }
        context.exceptionHandler = { [weak self] _, e in self?.fail(e?.toString() ?? "error") }
    }

    func defines(_ fn: String) -> Bool { has.contains(fn) && broken == nil }

    /// Hands the program its Gundam (for `pet`).
    func attach(_ n: PetNode) {
        guard node !== n else { return }
        node = n
        let pet = JSValue(newObjectIn: context)!
        let rand: @convention(block) (Int, Int, Int) -> Double = { a, b, c in Double(ScriptProgram.rand(a, b, c)) }
        let point: @convention(block) (String, JSValue) -> [Double]? = { [weak n] key, anim in
            guard let n, let c = n.unit.rig.raw[key] as? [Double], c.count == 2 else { return nil }
            let p = n.bodyPoint(CGPoint(x: c[0], y: c[1]), in: n.unit.anim(anim.isString ? anim.toString() : n.plan.anim))
            return [Double(p.x), Double(p.y)]
        }
        let bodyPoint: @convention(block) (Double, Double, JSValue) -> [Double] = { [weak n] x, y, anim in
            guard let n else { return [0, 0] }
            let p = n.bodyPoint(CGPoint(x: x, y: y), in: n.unit.anim(anim.isString ? anim.toString() : n.plan.anim))
            return [Double(p.x), Double(p.y)]
        }
        let frames: @convention(block) (String) -> Int = { [weak n] a in n?.unit.anim(a).count ?? 0 }
        let rig: @convention(block) (String) -> Any? = { [weak n] k in n?.unit.rig.raw[k] }
        let hold: @convention(block) (String, Double, Double) -> Int = { [weak n] a, t, fps in
            // a missing argument arrives as NaN: never let it reach Int(_:) (that would stop the app)
            guard let n, t.isFinite, fps.isFinite, fps > 0 else { return 0 }
            return n.holdFrame(n.unit.anim(a), t: min(max(0, t), 1e6), fps: fps)
        }
        pet.setObject(hold, forKeyedSubscript: "holdFrame" as NSString)
        let imageSize: @convention(block) (String) -> [Int]? = { [weak n] name in
            let parts = name.split(separator: "/", maxSplits: 1).map(String.init)
            guard let n, parts.count == 2, let img = n.unit.pictures[parts[0]]?[parts[1]] else { return nil }
            return [img.width, img.height]
        }
        pet.setObject(imageSize, forKeyedSubscript: "imageSize" as NSString)
        // for the character's author: a line in the system log (and on stderr in --offscreen runs)
        let log: @convention(block) (String) -> Void = { [weak self] msg in
            NSLog("GundamPet script %@: %@", self?.context.name ?? "?", msg)
        }
        pet.setObject(log, forKeyedSubscript: "log" as NSString)
        pet.setObject(rand, forKeyedSubscript: "rand" as NSString)
        pet.setObject(point, forKeyedSubscript: "point" as NSString)
        pet.setObject(bodyPoint, forKeyedSubscript: "bodyPoint" as NSString)
        pet.setObject(frames, forKeyedSubscript: "frames" as NSString)
        pet.setObject(rig, forKeyedSubscript: "rig" as NSString)
        context.setObject(pet, forKeyedSubscript: "pet" as NSString)
    }

    /// Calls one of the program's functions; nil if it does not define it, it fails, or it returns nothing.
    func call(_ fn: String, _ args: [Any]) -> JSValue? {
        guard defines(fn), let f = context.objectForKeyedSubscript(fn) else { return nil }
        let r = f.call(withArguments: args)
        guard broken == nil, let r, !r.isUndefined, !r.isNull else { return nil }
        return r
    }

    /// The tick's context object.
    func context(_ n: PetNode, t: Double, now: CFTimeInterval, offset: CGPoint, acting: Bool) -> [String: Any] {
        ["t": t, "st": now - n.stateStart, "now": now, "h": Double(n.unitHeight), "acting": acting,
         "ox": Double(offset.x), "oy": Double(offset.y), "bodyX": Double(n.body.position.x),
         "bodyY": Double(n.body.position.y), "markerX": Double(n.bubble.position.x),
         "markerY": Double(n.bubble.position.y), "anim": n.plan.anim, "fps": n.plan.fps, "shownAnim": n.shownAnim,
         "shownFrame": n.shownFrame, "settled": n.settled(now: now),
         "dash": Double(n.dashTarget(now: now)),
         "fidgeting": n.fidget.map { now >= $0.from && now < $0.to } ?? false, "plan": n.plan.raw,
         "rootY": Double(n.root.position.y), "tagWidth": Double(n.tag.bounds.width), "fadeTime": n.fadeTime]
    }

    private func fail(_ message: String) {
        guard broken == nil else { return }
        broken = message
        NSLog("GundamPet script %@: %@ (left off)", context.name ?? "?", message)
    }

    /// A fixed pseudo-random number in 0..<1 for three integers (the same hash the characters' own code uses).
    static func rand(_ a: Int, _ b: Int, _ c: Int) -> CGFloat {
        var x = UInt64(truncatingIfNeeded: a &* 73856093 ^ b &* 19349663 ^ c &* 83492791) &+ 0x9E3779B97F4A7C15
        x = (x ^ (x >> 30)) &* 0xBF58476D1CE4E5B9
        x = (x ^ (x >> 27)) &* 0x94D049BB133111EB
        x ^= x >> 31
        return CGFloat(x % 10_000) / 10_000
    }

    /// Helpers every program gets.
    private static let prelude = """
    function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
    // 0…1 across [a, b], smoothstep-eased / eased out (cubic)
    function ease(c, a, b) { var u = b == a ? (c >= a ? 1 : 0) : clamp((c - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); }
    function progress(c, a, b) { var p = b == a ? (c >= a ? 1 : 0) : clamp((c - a) / (b - a), 0, 1); return 1 - Math.pow(1 - p, 3); }
    // Swift's truncatingRemainder (keeps the sign of x)
    function rem(x, m) { return x % m; }
    """
}

extension JSValue {
    /// A number property (or `fallback`).
    func num(_ key: String, _ fallback: CGFloat = 0) -> CGFloat {
        let v = objectForKeyedSubscript(key)
        guard let v, v.isNumber, v.toDouble().isFinite else { return fallback }
        return CGFloat(v.toDouble())
    }

    func has(_ key: String) -> Bool {
        guard let v = objectForKeyedSubscript(key) else { return false }
        return !v.isUndefined && !v.isNull
    }

    /// [anim, index] as returned by frame / travel.
    var frameRef: (String, Int)? {
        guard isArray, let a = atIndex(0), a.isString, let i = atIndex(1), i.isNumber else { return nil }
        return (a.toString(), Int(i.toInt32()))
    }
}
