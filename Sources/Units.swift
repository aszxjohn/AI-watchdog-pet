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
    enum Mode: String { case flourish, hold, still, attack, cycle, pistols, field, defend, drive, float, transam }

    var anim: String
    var mode: Mode
    var fps: Double
    var hud: String?
    var fidget: [String]
    var dim: CGFloat
    var burst: Bool
    var hit: Bool
    /// GN particles drifting off the drive for as long as the state lasts.
    var gnIdle: Bool
    /// While the move plays (in → hold → out), the drift streams backwards and a tapering jet is added.
    var jet: Bool

    init(_ o: [String: Any]) {
        anim = o["anim"] as? String ?? "stand"
        mode = Mode(rawValue: o["mode"] as? String ?? "") ?? .still
        fps = o["fps"] as? Double ?? 12
        hud = o["hud"] as? String
        fidget = o["fidget"] as? [String] ?? []
        dim = CGFloat(o["dim"] as? Double ?? 1)
        burst = o["burst"] as? Bool ?? false
        hit = o["hit"] as? Bool ?? false
        gnIdle = o["gnIdle"] as? Bool ?? false
        jet = o["jet"] as? Bool ?? false
    }
}

struct Rig {
    var states: [PetState: StatePlan] = [:]
    var enter = "dash"
    var leave = "back"
    /// Sniping: muzzle tip and barrel direction in the attack pose's pixels (y down), body tilt in degrees.
    var muzzle = CGPoint.zero
    var aimDir = CGVector(dx: -1, dy: 0)
    var lean: CGFloat = 0
    /// Thinking cycle (預備射擊 → 瞄準 → 射擊): the pose it fires from and how far it tilts to fire.
    var fireAnim = "pose_b"
    var fireLean: CGFloat = -22
    /// Thinking pose "snipe": muzzle (pixels, y down) and barrel direction (y down), measured at build time.
    var snipeMuzzle: CGPoint?
    var snipeDir: CGVector?
    var snipeCore: CGPoint?
    /// Pupil in the cut-in's eye image (pixels, y down): where the lock-on square closes in.
    var cutinPupil: CGPoint?
    /// Working pose "pistol": per frame, each pistol's muzzle (pixels, y down) and pointing direction (y down),
    /// right gun first; and the body centre (for the GN particles). Measured at build time.
    var pistolMuzzles: [[CGPoint]] = []
    var pistolDirs: [[CGVector]] = []
    var pistolCore: CGPoint?
    /// Shield frames (要你批准 / 要你決定): points on the shield's face (pixels, y down) where bullets land, and the
    /// body's centre and reach (the GN field sphere). Measured at build time on the braced frame.
    var shieldHits: [CGPoint] = []
    var shieldCore: CGPoint?
    var shieldReach: CGFloat = 0
    /// 做完了: the GN drive's glowing end on the "back" frame (pixels, y down).
    var driveAt: CGPoint?
    /// …and the radius of its rounded end (pixels).
    var driveRadius: CGFloat = 12
    /// The GN field pictures' rim radius as a fraction of their width.
    var fieldRim: CGFloat = 0.46
    /// 工作中 TRANS-AM: the game's opening (head, TRANS-AM screen, standing body turning red): how many frames
    /// (transam["scr_000"]…), at what rate they play, and the frames where the screen and the standing shot start.
    var taScreenFrames = 0
    var taScreenFPS = 30.0
    var taIntroCuts: [Int] = []
    /// …and the body centre on the standing Trans-Am frame (pixels), for the GN particles.
    var taStandCore: CGPoint?
    /// …and the Trans-Am sniping shot ("ta_snipe"): muzzle (pixels), barrel direction (y down), body centre.
    var taSnipeMuzzle: CGPoint?
    var taSnipeDir: CGVector?
    var taSnipeCore: CGPoint?

    init(_ o: [String: Any]) {
        for (k, v) in o["states"] as? [String: [String: Any]] ?? [:] {
            if let st = PetState(rawValue: k) { states[st] = StatePlan(v) }
        }
        enter = o["enter"] as? String ?? enter
        leave = o["leave"] as? String ?? leave
        if let m = o["muzzle"] as? [Double], m.count == 2 { muzzle = CGPoint(x: m[0], y: m[1]) }
        if let d = o["aimDir"] as? [Double], d.count == 2 { aimDir = CGVector(dx: d[0], dy: d[1]) }
        lean = CGFloat(o["lean"] as? Double ?? 0)
        fireAnim = o["fireAnim"] as? String ?? fireAnim
        fireLean = CGFloat(o["fireLean"] as? Double ?? Double(fireLean))
        if let m = o["snipeMuzzle"] as? [Double], m.count == 2 { snipeMuzzle = CGPoint(x: m[0], y: m[1]) }
        if let d = o["snipeDir"] as? [Double], d.count == 2 { snipeDir = CGVector(dx: d[0], dy: d[1]) }
        if let c = o["snipeCore"] as? [Double], c.count == 2 { snipeCore = CGPoint(x: c[0], y: c[1]) }
        if let p = o["cutinPupil"] as? [Double], p.count == 2 { cutinPupil = CGPoint(x: p[0], y: p[1]) }
        for f in o["pistolMuzzles"] as? [[[Double]]] ?? [] {
            pistolMuzzles.append(f.filter { $0.count == 2 }.map { CGPoint(x: $0[0], y: $0[1]) })
        }
        for f in o["pistolDirs"] as? [[[Double]]] ?? [] {
            pistolDirs.append(f.filter { $0.count == 2 }.map { CGVector(dx: $0[0], dy: $0[1]) })
        }
        if let c = o["pistolCore"] as? [Double], c.count == 2 { pistolCore = CGPoint(x: c[0], y: c[1]) }
        shieldHits = (o["shieldHits"] as? [[Double]] ?? []).filter { $0.count == 2 }.map { CGPoint(x: $0[0], y: $0[1]) }
        if let c = o["shieldCore"] as? [Double], c.count == 2 { shieldCore = CGPoint(x: c[0], y: c[1]) }
        shieldReach = CGFloat(o["shieldReach"] as? Double ?? 0)
        fieldRim = CGFloat(o["fieldRim"] as? Double ?? Double(fieldRim))
        if let d = o["driveAt"] as? [Double], d.count == 2 { driveAt = CGPoint(x: d[0], y: d[1]) }
        driveRadius = CGFloat(o["driveRadius"] as? Double ?? Double(driveRadius))
        if let s = o["taScreen"] as? [Double], s.count == 2 { taScreenFrames = Int(s[0]); taScreenFPS = s[1] }
        taIntroCuts = o["taIntroCuts"] as? [Int] ?? []
        if let c = o["taStandCore"] as? [Double], c.count == 2 { taStandCore = CGPoint(x: c[0], y: c[1]) }
        if let m = o["taSnipeMuzzle"] as? [Double], m.count == 2 { taSnipeMuzzle = CGPoint(x: m[0], y: m[1]) }
        if let d = o["taSnipeDir"] as? [Double], d.count == 2 { taSnipeDir = CGVector(dx: d[0], dy: d[1]) }
        if let c = o["taSnipeCore"] as? [Double], c.count == 2 { taSnipeCore = CGPoint(x: c[0], y: c[1]) }
    }

    func plan(for state: PetState) -> StatePlan {
        states[state] ?? StatePlan(["anim": "stand", "mode": "flourish"])
    }
}

/// The rifle arm of the thinking-state puppet. In pixels, y down: the hand on the body picture it hangs
/// from, the grip (pivot) and the muzzle tip on the arm picture, and the barrel direction on the arm picture.
struct Snipe {
    let rifle: CGImage
    let size: CGSize
    let hand: CGPoint
    let grip: CGPoint
    let muzzle: CGPoint
    let barrel: CGVector
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
    /// Pieces of the thinking state's 瞄準 cut-in (cockpit, face, eye, scope, reticle, arcs, …); empty if none.
    let cutin: [String: CGImage]
    /// 要你批准's GN field pieces (shellA, shellB, rim, body, gloss), all on one square with the rim at `rig.fieldRim`.
    let field: [String: CGImage]
    /// 要你批准's attack pieces (shell, shellGlow, flash, fireA–C, smokeA/B, embers), cut from Wars' effect atlases.
    let attack: [String: CGImage]
    /// 做完了's GN drive pieces (flare, core, dot, star, puff), cut from Wars' GN effect atlases.
    let drive: [String: CGImage]
    /// 出錯了's overlay (tape): the ERROR seal tape, drawn by build_units.py.
    let alarm: [String: CGImage]
    /// 工作中 TRANS-AM: the game's opening, frame by frame (scr_000…).
    let transam: [String: CGImage]
    /// Thinking state: the rifle arm animated on top of `snipe_body` (World-parts puppet); nil if none.
    let snipe: Snipe?

    /// The animation every other one falls back to.
    let base: String

    init?(dir: URL) {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("unit.json")),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = obj["id"] as? String,
              let animsObj = obj["animations"] as? [String: [String: Any]] else { return nil }
        var anims: [String: Anim] = [:]
        for (name, a) in animsObj {
            let paths = a["frames"] as? [String] ?? []
            let frames = paths.compactMap { UnitDef.image(dir.appendingPathComponent($0)) }
            guard !frames.isEmpty, frames.count == paths.count else { return nil }
            let size = a["size"] as? [Double] ?? [Double(frames[0].width), Double(frames[0].height)]
            let anchor = a["anchor"] as? [Double] ?? [size[0] / 2, size[1] / 2]
            var segments: Anim.Segments?
            if let seg = a["segments"] as? [String: [Int]],
               let i = seg["in"], let h = seg["hold"], let o = seg["out"],
               i.count == 2, h.count == 2, o.count == 2, o[1] < frames.count {
                segments = Anim.Segments(into: i[0]...i[1], hold: h[0]...h[1], out: o[0]...o[1])
            }
            anims[name] = Anim(frames: frames,
                               size: CGSize(width: size[0], height: size[1]),
                               anchor: CGPoint(x: anchor[0], y: anchor[1]),
                               segments: segments)
        }
        let rig = Rig(obj["rig"] as? [String: Any] ?? [:])
        let base = rig.plan(for: .waiting).anim
        guard anims[base] != nil else { return nil }
        self.id = id
        self.name = obj["name"] as? String ?? id
        self.fullName = obj["fullName"] as? String ?? id
        self.code = obj["code"] as? String ?? ""
        self.anims = anims
        self.rig = rig
        self.base = base
        var fx: [String: CGImage] = [:]
        for (name, path) in obj["fx"] as? [String: String] ?? [:] {
            fx[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.fx = fx
        var cutin: [String: CGImage] = [:]
        for (name, path) in obj["cutin"] as? [String: String] ?? [:] {
            cutin[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.cutin = cutin
        var field: [String: CGImage] = [:]
        for (name, path) in obj["field"] as? [String: String] ?? [:] {
            field[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.field = field
        var attack: [String: CGImage] = [:]
        for (name, path) in obj["attack"] as? [String: String] ?? [:] {
            attack[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.attack = attack
        var drive: [String: CGImage] = [:]
        for (name, path) in obj["drive"] as? [String: String] ?? [:] {
            drive[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.drive = drive
        var alarm: [String: CGImage] = [:]
        for (name, path) in obj["alarm"] as? [String: String] ?? [:] {
            alarm[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.alarm = alarm
        var transam: [String: CGImage] = [:]
        for (name, path) in obj["transam"] as? [String: String] ?? [:] {
            transam[name] = UnitDef.image(dir.appendingPathComponent(path))
        }
        self.transam = transam
        if let o = obj["snipe"] as? [String: Any], let path = o["rifle"] as? String,
           let img = UnitDef.image(dir.appendingPathComponent(path)),
           let hand = o["hand"] as? [Double], let grip = o["grip"] as? [Double],
           let muzzle = o["muzzle"] as? [Double], let barrel = o["barrel"] as? [Double] {
            snipe = Snipe(rifle: img, size: CGSize(width: img.width, height: img.height),
                          hand: CGPoint(x: hand[0], y: hand[1]), grip: CGPoint(x: grip[0], y: grip[1]),
                          muzzle: CGPoint(x: muzzle[0], y: muzzle[1]), barrel: CGVector(dx: barrel[0], dy: barrel[1]))
        } else {
            snipe = nil
        }

    }

    func anim(_ name: String) -> Anim { anims[name] ?? anims[base]! }

    private static func image(_ url: URL) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }

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

    init(unitIds: [String], persist: Bool) {
        self.unitIds = unitIds
        self.persist = persist
        if persist, let data = try? Data(contentsOf: url),
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
            if let data = try? JSONEncoder.withDates.encode(saved) { try? data.write(to: url) }
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
