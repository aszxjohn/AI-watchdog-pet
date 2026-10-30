import AppKit

/// How a character wanders in one state (the settings panel edits these).
struct WanderPref: Codable, Equatable {
    /// false: it stays at its place in the row along the bottom of the screen.
    var wander = true
    /// The grid cells it prefers, 0…8 row by row from the top left (上左 上中 上右 / 中… / 下…); any shape.
    var cells: [Int] = []
    /// 0…1: the chance each move is a "preferred" one (heading for the cells); the rest go any way.
    var strength = 0.5
    /// How far one move goes: "small" | "medium" | "large".
    var step = "medium"
    /// Seconds it rests between moves, [min, max]. A looping act (TRANS-AM, the twin pistols…) only leaves
    /// when a loop ends, so 0 means "after every loop".
    var stay: [Double] = [4, 8]
    /// Points per second while moving.
    var speed = 240.0
    /// Room its act needs around its place (× its height): set in the character file, not in the panel.
    var room: Room?

    struct Room: Codable, Equatable {
        var left = 0.8, right = 0.8, up = 1.4
    }

    var stepRange: ClosedRange<Double> {
        switch step {
        case "small": return 1.0...2.5
        case "large": return 2.5...6.0
        default: return 1.5...4.0
        }
    }
}

/// One of a state's settings, declared in its script file ("params"): its type, default and range, and whether the
/// settings panel offers it ("user": true) — the others only the character's author changes, in the file.
struct ParamSpec {
    let name: String
    /// "bool" | "int" | "number" | "choice" | "asset" (a picture, "group/name")
    let type: String
    let defaultValue: Any
    let min: Double?
    let max: Double?
    let step: Double?
    /// For "choice": the values and how the panel names them.
    let choices: [(value: String, label: String)]
    let user: Bool
    let label: String

    init?(name: String, _ o: [String: Any]) {
        guard let type = o["type"] as? String, let d = o["default"] else { return nil }
        self.name = name
        self.type = type
        defaultValue = d
        min = o["min"] as? Double
        max = o["max"] as? Double
        step = o["step"] as? Double
        choices = (o["choices"] as? [[String: Any]] ?? []).compactMap { c in
            (c["value"] as? String).map { ($0, c["label"] as? String ?? $0) }
        }
        user = o["user"] as? Bool ?? false
        label = o["label"] as? String ?? name
    }

    /// `v` as this setting's type, or nil if it is not one.
    func accept(_ v: Any) -> Any? {
        switch type {
        case "bool": return v as? Bool
        case "int": return (v as? Double).map { Int($0) } ?? (v as? Int)
        case "number": return (v as? Double) ?? (v as? Int).map(Double.init)
        default: return v as? String
        }
    }
}

/// One character's settings: characters/<id>/character.json (size, wandering) and characters/<id>/states/<state>.json
/// (each state's script: its settings, its timeline) in the app — its own defaults — with the user's changes from
/// the settings panel laid over them (~/Library/Application Support/GundamPet/characters/<id>.json: only what
/// differs from the defaults).
struct CharacterProfile {
    var id: String
    /// On-screen height in points (every state is drawn at this size).
    var height: Double
    var states: [PetState: WanderPref]
    /// Each state's declared settings, in the file's order…
    var params: [PetState: [ParamSpec]] = [:]
    /// …and their values (defaults with the user's changes).
    var values: [PetState: [String: Any]] = [:]
    /// Each state's script ("script" in its state file), played by the system instead of the character's own act.
    var scripts: [PetState: [String: Any]] = [:]
    /// Its trail particles (character.json "trail": {"image": "group/name", "color": [r, g, b]}); nil: none.
    var trail: (image: String?, color: [Double])?

    func pref(_ s: PetState) -> WanderPref { states[s] ?? WanderPref(wander: false) }
}

final class CharacterStore {
    private(set) var defaults: [String: CharacterProfile] = [:]
    private(set) var profiles: [String: CharacterProfile] = [:]
    /// Called after a change, with the character's id.
    var onChange: ((String) -> Void)?
    /// Goes up with every change (a Gundam re-reads its state's settings when it differs).
    private(set) var version = 0

    private let userDir = Config.dir.appendingPathComponent("characters")
    private static let fallbackHeight = 110.0

    /// `packages`: each character's package folder (character.json, states/), by id.
    init(packages: [String: URL]) {
        for (id, pkg) in packages {
            var base = Self.read(pkg.appendingPathComponent("character.json")) ?? [:]
            // states/<state>.json: a state's wandering ("wander", over character.json's), settings and script
            var states = base["states"] as? [String: Any] ?? [:]
            let dir = pkg.appendingPathComponent("states")
            for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            where f.pathExtension == "json" {
                let name = f.deletingPathExtension().lastPathComponent
                guard PetState(rawValue: name) != nil, let file = Self.read(f) else { continue }
                var st = Self.merge(states[name] as? [String: Any] ?? [:], file["wander"] as? [String: Any] ?? [:])
                for k in ["params", "script"] where file[k] != nil { st[k] = file[k] }
                states[name] = st
            }
            base["states"] = states
            let mine = Self.read(userDir.appendingPathComponent("\(id).json")) ?? [:]
            defaults[id] = Self.profile(id: id, base)
            profiles[id] = Self.profile(id: id, Self.merge(base, mine))
        }
    }

    func profile(_ id: String) -> CharacterProfile {
        profiles[id] ?? CharacterProfile(id: id, height: Self.fallbackHeight, states: [:])
    }

    /// Sets one of a state's settings (the panel's 演出 controls).
    func setValue(_ v: Any, for name: String, in state: PetState, of id: String) {
        guard var p = profiles[id], let spec = p.params[state]?.first(where: { $0.name == name }),
              let ok = spec.accept(v) else { return }
        p.values[state, default: [:]][name] = ok
        profiles[id] = p
        save(id)
    }

    func setHeight(_ h: Double, for id: String) {
        guard var p = profiles[id] else { return }
        p.height = h
        profiles[id] = p
        save(id)
    }

    func setPref(_ pref: WanderPref, for state: PetState, of id: String) {
        guard var p = profiles[id] else { return }
        var pref = pref
        pref.room = p.states[state]?.room ?? defaults[id]?.states[state]?.room
        p.states[state] = pref
        profiles[id] = p
        save(id)
    }

    /// Puts one state (or, with nil, the whole character, size included) back to the character file's defaults.
    func reset(_ id: String, state: PetState? = nil) {
        guard let d = defaults[id], var p = profiles[id] else { return }
        if let s = state {
            p.states[s] = d.states[s]
            p.values[s] = d.values[s]
        } else {
            p = d
        }
        profiles[id] = p
        save(id)
    }

    /// Writes only what differs from the defaults (and deletes the file when nothing does).
    private func save(_ id: String) {
        guard let p = profiles[id], let d = defaults[id] else { return }
        var out: [String: Any] = [:]
        if p.height != d.height { out["height"] = p.height }
        var states: [String: Any] = [:]
        let enc = JSONEncoder()
        for (s, pref) in p.states where pref != d.states[s] {
            var mine = pref
            mine.room = nil
            if let data = try? enc.encode(mine), let obj = try? JSONSerialization.jsonObject(with: data) {
                states[s.rawValue] = obj
            }
        }
        // settings that differ from the state file's defaults
        for (s, vals) in p.values {
            let changed = vals.filter { k, v in !((d.values[s]?[k] as AnyObject?)?.isEqual(v) ?? false) }
            guard !changed.isEmpty else { continue }
            var st = states[s.rawValue] as? [String: Any] ?? [:]
            st["values"] = changed
            states[s.rawValue] = st
        }
        if !states.isEmpty { out["states"] = states }
        let url = userDir.appendingPathComponent("\(id).json")
        if out.isEmpty {
            try? FileManager.default.removeItem(at: url)
        } else if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
            try? FileManager.default.createDirectory(at: userDir, withIntermediateDirectories: true)
            try? data.write(to: url)
        }
        version += 1
        onChange?(id)
    }

    private static func read(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// `mine` over `base`, key by key (a state's fields one by one).
    private static func merge(_ base: [String: Any], _ mine: [String: Any]) -> [String: Any] {
        var out = base
        for (k, v) in mine {
            if let b = out[k] as? [String: Any], let m = v as? [String: Any] {
                out[k] = merge(b, m)
            } else {
                out[k] = v
            }
        }
        return out
    }

    private static func profile(id: String, _ obj: [String: Any]) -> CharacterProfile {
        var states: [PetState: WanderPref] = [:]
        let dec = JSONDecoder()
        for (k, v) in obj["states"] as? [String: Any] ?? [:] {
            guard let s = PetState(rawValue: k), let data = try? JSONSerialization.data(withJSONObject: v) else { continue }
            // missing fields fall back to WanderPref's defaults
            let full = merge((try? JSONSerialization.jsonObject(with: JSONEncoder().encode(WanderPref()))) as? [String: Any] ?? [:],
                             (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
            if let d = try? JSONSerialization.data(withJSONObject: full), let pref = try? dec.decode(WanderPref.self, from: d) {
                states[s] = pref
            }
        }
        var profile = CharacterProfile(id: id, height: obj["height"] as? Double ?? fallbackHeight, states: states)
        if let t = obj["trail"] as? [String: Any] {
            profile.trail = (t["image"] as? String, t["color"] as? [Double] ?? [1, 1, 1])
        }
        for (k, v) in obj["states"] as? [String: Any] ?? [:] {
            guard let s = PetState(rawValue: k), let st = v as? [String: Any] else { continue }
            // settings: declared by the state file (an ordered list), valued by the defaults or the user's changes
            let decl = st["params"] as? [[String: Any]] ?? []
            let specs = decl.compactMap { o in (o["name"] as? String).flatMap { ParamSpec(name: $0, o) } }
            if !specs.isEmpty {
                profile.params[s] = specs
                let set = st["values"] as? [String: Any] ?? [:]
                var vals: [String: Any] = [:]
                for sp in specs { vals[sp.name] = set[sp.name].flatMap(sp.accept) ?? sp.defaultValue }
                profile.values[s] = vals
            }
            if let script = st["script"] as? [String: Any] { profile.scripts[s] = script }
        }
        return profile
    }
}

/// Where a wandering character goes next ("方向輪盤", 10/30): from where it is, 16 candidate points one step away in
/// every direction (those that would put its act off the screen are dropped). With chance `strength` the move is a
/// preferred one: each candidate weighs exp(−4·d/σ), d = its distance to the nearest preferred cell (0 inside one),
/// σ = half a cell's height, so it heads for (or keeps to) the cells; otherwise every direction weighs the same, so it
/// still goes everywhere. Cells need not touch: it keeps near whichever is closer and free moves carry it across.
/// Other characters push candidates near them down (personal space).
enum Wander {
    /// Positions are a character's place (its feet, as PetNode's root); its middle is `height * 0.55` above that.
    static func next(from p: CGPoint, pref: WanderPref, height h: CGFloat, area: CGRect, floor: CGFloat,
                     others: [CGPoint], random r: inout SystemRandomNumberGenerator) -> CGPoint {
        let room = pref.room ?? WanderPref.Room()
        let lo = CGPoint(x: area.minX + CGFloat(room.left) * h, y: floor)
        let hi = CGPoint(x: area.maxX - CGFloat(room.right) * h, y: area.maxY - CGFloat(room.up) * h)
        guard lo.x < hi.x, lo.y <= hi.y else { return CGPoint(x: (area.minX + area.maxX) / 2, y: floor) }
        var len = CGFloat(Double.random(in: pref.stepRange, using: &r)) * h
        var cands: [CGPoint] = []
        for _ in 0..<4 {
            cands = (0..<16).compactMap { k -> CGPoint? in
                let a = 2 * CGFloat.pi * CGFloat(k) / 16 + CGFloat.random(in: -0.1...0.1, using: &r)
                let c = CGPoint(x: p.x + len * cos(a), y: p.y + len * sin(a))
                return c.x >= lo.x && c.x <= hi.x && c.y >= lo.y && c.y <= hi.y ? c : nil
            }
            if !cands.isEmpty { break }
            len *= 0.5
        }
        if cands.isEmpty {
            return CGPoint(x: min(max(p.x, lo.x), hi.x), y: min(max(p.y, lo.y), hi.y))
        }
        let cellW = area.width / 3, cellH = area.height / 3, sigma = cellH * 0.5
        let preferred = !pref.cells.isEmpty && Double.random(in: 0..<1, using: &r) < pref.strength
        let weights = cands.map { c -> Double in
            let mid = CGPoint(x: c.x, y: c.y + h * 0.55)
            var w = 1.0
            if preferred {
                let d = pref.cells.map { cellDistance(mid, cell: $0, area: area, cellW: cellW, cellH: cellH) }.min() ?? 0
                w = exp(-4 * Double(d / sigma))
            }
            // personal space: a candidate within about two heights of another Gundam (where it stands or is
            // heading) counts for little
            for o in others {
                let d = Double(hypot(o.x - c.x, o.y - c.y) / (2 * h))
                w *= 0.03 + 0.97 * (1 - exp(-d * d))
            }
            return w
        }
        let total = weights.reduce(0, +)
        guard total > 0 else { return cands[Int.random(in: 0..<cands.count, using: &r)] }
        var pick = Double.random(in: 0..<total, using: &r)
        for (c, w) in zip(cands, weights) {
            pick -= w
            if pick < 0 { return c }
        }
        return cands[cands.count - 1]
    }

    /// Which cell (0…8, row by row from the top left) a point is in. `area` is y-up, as the stage.
    static func cell(of p: CGPoint, area: CGRect) -> Int {
        let col = min(2, max(0, Int((p.x - area.minX) / (area.width / 3))))
        let row = min(2, max(0, Int((area.maxY - p.y) / (area.height / 3))))
        return row * 3 + col
    }

    private static func cellDistance(_ p: CGPoint, cell: Int, area: CGRect, cellW: CGFloat, cellH: CGFloat) -> CGFloat {
        let row = CGFloat(cell / 3), col = CGFloat(cell % 3)
        let x0 = area.minX + col * cellW, x1 = x0 + cellW
        let y1 = area.maxY - row * cellH, y0 = y1 - cellH
        let dx = max(x0 - p.x, 0, p.x - x1), dy = max(y0 - p.y, 0, p.y - y1)
        return hypot(dx, dy)
    }

    /// The settings panel's estimate: the share of time spent in the preferred cells, from 3000 simulated moves.
    static func predictedShare(_ pref: WanderPref, height h: CGFloat, area: CGRect, floor: CGFloat) -> Double {
        guard !pref.cells.isEmpty else { return 0 }
        var r = SystemRandomNumberGenerator()
        var p = CGPoint(x: area.midX, y: floor)
        var inside = 0
        let n = 3000
        for _ in 0..<n {
            p = next(from: p, pref: pref, height: h, area: area, floor: floor, others: [], random: &r)
            if pref.cells.contains(cell(of: CGPoint(x: p.x, y: p.y + h * 0.55), area: area)) { inside += 1 }
        }
        return Double(inside) / Double(n)
    }
}
