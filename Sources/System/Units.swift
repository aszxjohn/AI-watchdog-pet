import Foundation
import ImageIO

struct Anim {
    struct Segments {
        let into: ClosedRange<Int>
        let hold: ClosedRange<Int>
        let out: ClosedRange<Int>
    }

    let frames: [CGImage]
    /// Frame size and pinned body point, in source pixels (top-left origin).
    let size: CGSize
    let anchor: CGPoint
    /// For rest → action → rest sequences: where the action pose starts, holds and ends.
    let segments: Segments?

    var count: Int { frames.count }
}

/// How a state is acted out (unit.json "rig.states.<state>").
struct StatePlan {
    /// The act a state plays. The system knows only the plain ones below (frame playback); a character adds its own
    /// as static members in its module and registers what they do (PetNode.acts).
    struct Mode: RawRepresentable, Hashable {
        let rawValue: String
        init(rawValue: String) { self.rawValue = rawValue }
        /// Rests on frame 0; now and then plays the whole move (and sometimes a fidget pose).
        static let flourish = Mode(rawValue: "flourish")
        /// Plays "in", loops "hold" until the state ends, plays "out" on the way out.
        static let hold = Mode(rawValue: "hold")
        /// Frame 0 only.
        static let still = Mode(rawValue: "still")
    }

    var anim: String
    var mode: Mode
    var fps: Double
    var hud: String?
    var fidget: [String]
    var dim: CGFloat
    var burst: Bool
    var hit: Bool
    /// The whole object, for a character's acts to read their own keys.
    let raw: [String: Any]

    init(_ o: [String: Any]) {
        anim = o["anim"] as? String ?? "stand"
        mode = (o["mode"] as? String).map(Mode.init(rawValue:)) ?? .still
        let f = o["fps"] as? Double ?? 12
        fps = f.isFinite && f > 0 ? f : 12
        hud = o["hud"] as? String
        fidget = o["fidget"] as? [String] ?? []
        dim = CGFloat(o["dim"] as? Double ?? 1)
        burst = o["burst"] as? Bool ?? false
        hit = o["hit"] as? Bool ?? false
        raw = o
    }
}

struct Rig {
    var states: [PetState: StatePlan] = [:]
    var enter = "dash"
    var leave = "back"
    /// The whole "rig" object: whatever else a character's build measured (muzzles, …), read by its module.
    let raw: [String: Any]

    init(_ o: [String: Any]) {
        raw = o
        for (k, v) in o["states"] as? [String: [String: Any]] ?? [:] {
            if let st = PetState(rawValue: k) { states[st] = StatePlan(v) }
        }
        enter = o["enter"] as? String ?? enter
        leave = o["leave"] as? String ?? leave
    }

    func plan(for state: PetState) -> StatePlan {
        states[state] ?? StatePlan(["anim": "stand", "mode": "flourish"])
    }
}

/// One Gundam in the pool: units/<id>/unit.json plus its frame folders (built by tools/build_units.py).
final class UnitDef {
    let id: String
    let name: String
    let fullName: String
    /// Model number shown on the HUD tag, e.g. GN-002.
    let code: String
    let anims: [String: Anim]
    let rig: Rig
    /// Effect pieces cut from the parts sheet (beam, flash, orb, halo, spark_a/b, glow_a/b).
    let fx: [String: CGImage]
    /// The unit.json object, for a character's module to read its own keys.
    let raw: [String: Any]
    /// Named groups of pictures (unit.json keys whose value maps names to picture paths, e.g. "fx", "cutin"): a
    /// character's acts take theirs by name.
    let pictures: [String: [String: CGImage]]
    /// Whatever a character's module parsed once from `raw` (its own rig values), kept here.
    var cache: [String: Any] = [:]

    /// The animation every other one falls back to.
    let base: String

    /// `dir`: a package's assets folder. A unit.json that cannot be used is not loaded, and the run log says why; a
    /// value that is out of range (a size, an anchor, a segment) falls back to a safe one, also logged (10/30).
    init?(dir: URL) {
        let package = dir.deletingLastPathComponent().lastPathComponent
        func fail(_ why: String) {
            RunLog.write(.error, "角色包 \(package)：\(why)，不載入")
            UnitDef.lastFailure = why
        }
        func note(_ why: String) { RunLog.write(.error, "角色包 \(package)：\(why)") }
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("unit.json")),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            fail("assets/unit.json 讀不到或不是 JSON 物件")
            return nil
        }
        guard let id = obj["id"] as? String, let animsObj = obj["animations"] as? [String: [String: Any]] else {
            fail("unit.json 缺 id 或 animations")
            return nil
        }
        var anims: [String: Anim] = [:]
        for (name, a) in animsObj {
            let paths = a["frames"] as? [String] ?? []
            var frames: [CGImage] = []
            for p in paths {
                guard let img = UnitDef.image(dir.appendingPathComponent(p)) else {
                    fail("動畫 \(name) 的圖讀不到：\(p)")
                    return nil
                }
                frames.append(img)
            }
            guard !frames.isEmpty else {
                fail("動畫 \(name) 沒有任何格")
                return nil
            }
            func pair(_ key: String) -> (Double, Double)? {
                guard let v = a[key] as? [Double], v.count >= 2, v[0].isFinite, v[1].isFinite else { return nil }
                return (v[0], v[1])
            }
            var size = (Double(frames[0].width), Double(frames[0].height))
            if a["size"] != nil {
                if let s = pair("size"), s.0 > 0, s.1 > 0 { size = s } else { note("動畫 \(name) 的 size 不合法，改用圖片大小") }
            }
            var anchor = (size.0 / 2, size.1 / 2)
            if a["anchor"] != nil {
                if let p = pair("anchor") { anchor = p } else { note("動畫 \(name) 的 anchor 不合法，改用正中央") }
            }
            var segments: Anim.Segments?
            if a["segments"] != nil {
                // each segment [first, last] inside the frames, first ≤ last; otherwise no segments at all
                func range(_ k: String) -> ClosedRange<Int>? {
                    guard let seg = a["segments"] as? [String: [Int]], let r = seg[k], r.count == 2,
                          r[0] >= 0, r[0] <= r[1], r[1] < frames.count else { return nil }
                    return r[0]...r[1]
                }
                if let i = range("in"), let h = range("hold"), let o = range("out") {
                    segments = Anim.Segments(into: i, hold: h, out: o)
                } else {
                    note("動畫 \(name) 的 segments 不合法（要在 0～\(frames.count - 1) 之內、起點不大於終點），改成不分段")
                }
            }
            anims[name] = Anim(frames: frames,
                               size: CGSize(width: size.0, height: size.1),
                               anchor: CGPoint(x: anchor.0, y: anchor.1),
                               segments: segments)
        }
        let rig = Rig(obj["rig"] as? [String: Any] ?? [:])
        let base = rig.plan(for: .waiting).anim
        guard anims[base] != nil else {
            fail("找不到等你回覆用的動畫 \(base)")
            return nil
        }
        self.id = id
        self.name = obj["name"] as? String ?? id
        self.fullName = obj["fullName"] as? String ?? id
        self.code = obj["code"] as? String ?? ""
        self.anims = anims
        self.rig = rig
        self.base = base
        self.raw = obj
        var pictures: [String: [String: CGImage]] = [:]
        for (key, value) in obj where key != "animations" {
            guard let paths = value as? [String: String] else { continue }
            var group: [String: CGImage] = [:]
            for (name, path) in paths { group[name] = UnitDef.image(dir.appendingPathComponent(path)) }
            pictures[key] = group
        }
        self.pictures = pictures
        self.fx = pictures["fx"] ?? [:]
    }

    func anim(_ name: String) -> Anim { anims[name] ?? anims[base]! }

    private static func image(_ url: URL) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

    /// Every character package (a folder with assets/unit.json), the app's own (Resources/characters) and the user's
    /// (~/Library/Application Support/GundamPet/characters/<id>/, which wins for the same id), by id.
    static func packages() -> [String: URL] {
        var found: [String: URL] = [:]
        let fm = FileManager.default
        for base in [Bundle.main.resourceURL?.appendingPathComponent("characters"), Config.dir.appendingPathComponent("characters")] {
            guard let base else { continue }
            for dir in (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? []
            where fm.fileExists(atPath: dir.appendingPathComponent("assets/unit.json").path) {
                found[dir.lastPathComponent] = dir
            }
        }
        return found
    }

    /// The characters of every package (its assets folder). A package is known by its folder's name, so its unit.json
    /// must have that id; one that does not is left out (two packages could otherwise load as the same character).
    static func loadPackages(_ packages: [String: URL]) -> [UnitDef] {
        loadProblems = []
        return packages.keys.sorted().compactMap { key in
            lastFailure = nil
            guard let u = UnitDef(dir: packages[key]!.appendingPathComponent("assets")) else {
                loadProblems.append((key, lastFailure ?? "原因不明"))
                return nil
            }
            guard u.id == key else {
                let why = "unit.json 的 id 是「\(u.id)」，跟資料夾名不同"
                RunLog.write(.error, "角色包 \(key)：\(why)，不載入")
                loadProblems.append((key, why))
                return nil
            }
            return u
        }
    }

    /// The packages the last `loadPackages` left out, and why (the settings panel lists them).
    private(set) static var loadProblems: [(package: String, why: String)] = []
    /// Why the last `UnitDef(dir:)` gave nil.
    private static var lastFailure: String?

    static func loadAll(from root: URL) -> [UnitDef] {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return dirs.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { UnitDef(dir: $0) }
    }
}

/// Which Gundam each session gets. No two sessions on screen share a Gundam while the pool still has
/// an unused one; once every Gundam is out, the least-used ones are handed out again. A session keeps
/// its Gundam across restarts (assignments.json) as long as that does not break the rule above.
final class Pool {
    private struct Entry: Codable {
        var unit: String
        var lastSeen: Date
    }

    private let unitIds: [String]
    private let url = Config.dir.appendingPathComponent("assignments.json")
    private let persist: Bool
    private var saved: [String: Entry] = [:]
    /// Sessions currently shown, with their Gundam. Visible sessions never change Gundam.
    private var live: [String: String] = [:]
    /// What was last written, and when: the file is written when who has which Gundam changes, or hourly (10/30;
    /// it used to be written every 1.5 seconds).
    private var written: [String: String]?
    private var writtenAt = Date.distantPast

    init(unitIds: [String], persist: Bool) {
        self.unitIds = unitIds
        self.persist = persist
        if persist,
           let data = SettingsFile.read(url, usable: { (try? JSONDecoder.withDates.decode([String: Entry].self, from: $0)) != nil }),
           let map = try? JSONDecoder.withDates.decode([String: Entry].self, from: data) {
            saved = map
        }
    }

    /// A Gundam switched from one session to another by hand keeps being the same Gundam.
    func hand(from old: String, to new: String) {
        if let u = live.removeValue(forKey: old) { live[new] = u }
    }

    /// `sessions` in on-screen order (oldest first). Returns session → unit id.
    func assign(_ sessions: [String]) -> [String: String] {
        guard !unitIds.isEmpty else { return [:] }
        let active = Set(sessions)
        live = live.filter { active.contains($0.key) }
        var used: [String: Int] = [:]
        for u in live.values { used[u, default: 0] += 1 }

        for s in sessions where live[s] == nil {
            let free = unitIds.filter { used[$0] == nil }
            let pick: String
            if let prev = saved[s]?.unit, unitIds.contains(prev), free.isEmpty || free.contains(prev) {
                pick = prev
            } else if let f = free.randomElement() {
                pick = f
            } else {
                let least = used.values.min() ?? 0
                pick = unitIds.filter { used[$0, default: 0] == least }.randomElement() ?? unitIds[0]
            }
            live[s] = pick
            used[pick, default: 0] += 1
        }

        if persist {
            let now = Date()
            for (s, u) in live { saved[s] = Entry(unit: u, lastSeen: now) }
            saved = saved.filter { now.timeIntervalSince($0.value.lastSeen) < 7 * 86400 }
            if live != written || now.timeIntervalSince(writtenAt) > 3600,
               let data = try? JSONEncoder.withDates.encode(saved) {
                SettingsFile.write(data, to: url)
                written = live
                writtenAt = now
            }
        }
        return live
    }
}

extension JSONDecoder {
    static var withDates: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

extension JSONEncoder {
    static var withDates: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}
