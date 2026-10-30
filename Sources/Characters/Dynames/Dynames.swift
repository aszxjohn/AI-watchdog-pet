import AppKit
import QuartzCore

/// 力天使 (GN-002 Gundam Dynames): its module. Everything the system does not know about this character lives in
/// Sources/Characters/Dynames: the acts its states play (one file each), the values its build measured (DynamesRig),
/// its effect pictures, and the order its layers are built in. The system reaches it only through CharacterKit.
enum Dynames {
    static let id = "dynames"

    static func register() {
        PetNode.kits[id] = CharacterKit(build: build, acts: acts)
    }

    /// Its layers, once per Gundam, in the order they stack.
    private static func build(_ n: PetNode) {
        n.buildWaiting()
        // the charge glow (sniping, TRANS-AM) sits over the body's tint, under the hit sparks
        Fx.configureCharge(n.charge, image: n.unit.fx["glow_b"])
        n.body.insertSublayer(n.charge, below: n.sparks)
        n.buildAttack()
        if !n.unit.cutin.isEmpty { n.buildCutin() }
        if n.unit.cutin["reticle"] != nil {
            let lock = LockHud(images: n.unit.cutin, ring: 26)
            n.root.addSublayer(lock.group)
            n.floatLock = lock
        }
        Fx.configureSnipeGN(n.snipeGN, at: CGPoint(x: n.unitHeight * 0.02, y: n.unitHeight * 0.06), image: n.unit.fx["glow_a"])
        n.body.insertSublayer(n.snipeGN, at: 0)
        n.buildPinkBeam()
        Fx.configurePistolGN(n.pistolGN, image: n.unit.fx["glow_a"])
        n.body.insertSublayer(n.pistolGN, at: 0)
        n.buildPistols()
        n.buildField()
        n.buildGuard()
        n.buildDrive()
        n.buildSleep()
        n.buildAlarm()
        n.buildTransAm()
    }

    /// Its acts, in the order they update each tick.
    private static let acts: [Act] = [
        // 等你回覆 (locked): the system plays its frames ("flourish"); this is its GN drift and jet
        Act(mode: .flourish,
            update: { n, now, _, _ in n.updateWaiting(now: now, playing: true) },
            hide: { n, now in n.updateWaiting(now: now, playing: false) }),
        // the first sniping loop (no state plays it now)
        Act(mode: .attack,
            update: { n, now, off, acting in n.updateSniping(active: acting, now: now, offset: off, lean: n.attackLean(now)) },
            hide: { n, now in n.updateSniping(active: false, now: now, offset: .zero, lean: 0) },
            loopEnds: { _ in false },
            react: { n, now, _, _, _, lean in if n.settled(now: now) { lean = n.attackLean(now) } }),
        // 狙擊 (locked, 10/29): 預備射擊 → 瞄準 (Lockon's cut-in) → 射擊
        Act(mode: .cycle,
            frame: { n, t, _ in n.cycleFrame(n.unit.anim(n.plan.anim), t: t) },
            update: { n, now, off, acting in n.updateCycle(now: now, offset: off, active: acting) },
            hide: { n, _ in n.hideCutin(); n.hideThinking() },
            loopEnds: { t in t >= PetNode.Cycle.period && t.truncatingRemainder(dividingBy: PetNode.Cycle.period) < near },
            bubble: { n in n.snipeBubble }),
        // 思考中: twin pistols
        Act(mode: .pistols,
            frame: { n, t, _ in (n.plan.anim, n.pistolFrame(t: t)) },
            update: { n, now, off, acting in n.updatePistols(now: now, offset: off, active: acting) },
            hide: { n, _ in n.hidePistols() },
            loopEnds: { t in
                let c = t - PetNode.Burst.raise
                return c >= PetNode.Burst.period && c.truncatingRemainder(dividingBy: PetNode.Burst.period) < near
            },
            // the pose's head and V-fin reach where the marker usually sits: up and right, above the shield
            bubble: { n in CGPoint(x: n.unitHeight * 0.36, y: n.unitHeight * 0.98) }),
        // 工作中: TRANS-AM
        Act(mode: .transam,
            frame: { n, t, _ in n.taFrame(t: t) },
            update: { n, now, off, acting in n.updateTransAm(now: now, offset: off, active: acting) },
            hide: { n, _ in n.hideTransAm() },
            loopEnds: { t in t >= PetNode.TA.period && t.truncatingRemainder(dividingBy: PetNode.TA.period) < near },
            // waits in its normal colours; powers up again on arrival
            travel: { _ in ("stand", 0) }),
        // 要你批准: GN field around the closed shield
        Act(mode: .field,
            frame: { n, t, _ in (n.plan.anim, n.holdFrame(n.unit.anim(n.plan.anim), t: t, fps: n.plan.fps)) },
            update: { n, now, off, acting in n.updateField(now: now, offset: off, active: acting) },
            hide: { n, _ in n.hideField() },
            loopEnds: { t in
                let c = t - PetNode.Field.attackFrom
                return c >= PetNode.Field.volley && c.truncatingRemainder(dividingBy: PetNode.Field.volley) < near
            }),
        // 要你決定: support defend
        Act(mode: .defend,
            frame: { n, t, _ in (n.plan.anim, n.guardFrame(t: t)) },
            update: { n, now, off, acting in n.updateGuard(now: now, offset: off, active: acting) },
            hide: { n, _ in n.hideGuard() },
            loopEnds: { t in t >= PetNode.Guard.period && t.truncatingRemainder(dividingBy: PetNode.Guard.period) < near }),
        // 做完了: GN drive pouring out particles
        Act(mode: .drive,
            update: { n, now, _, acting in n.updateDrive(now: now, active: acting) },
            hide: { n, _ in n.hideDrive() }),
        // 休息中: adrift, turning in the closed shields
        Act(mode: .float,
            frame: { n, t, _ in (n.plan.anim, n.turnFrame(t: t, count: n.unit.anim(n.plan.anim).frames.count)) },
            update: { n, now, _, acting in n.updateSleep(now: now, active: acting && n.state == .sleeping) },
            hide: { n, now in n.updateSleep(now: now, active: false) },
            react: { n, now, _, dx, dy, lean in (dx, dy, lean) = n.adrift(t: now - n.trackStart) }),
        // 出錯了: the ERROR tape over whatever plays, shaking under hit after hit
        Act(state: .error,
            update: { n, now, _, acting in n.updateAlarm(now: now, st: now - n.stateStart, active: acting) },
            hide: { n, now in n.updateAlarm(now: now, st: now - n.stateStart, active: false) },
            react: { n, now, _, dx, dy, lean in if !n.unit.alarm.isEmpty { (dx, dy, lean) = n.alarmShake(now: now) } }),
    ]

    /// How close to a loop's end a looping act may set off (about two ticks).
    private static let near = 1.0 / 15
}

extension StatePlan.Mode {
    static let attack = Self(rawValue: "attack")
    static let cycle = Self(rawValue: "cycle")
    static let pistols = Self(rawValue: "pistols")
    static let transam = Self(rawValue: "transam")
    static let field = Self(rawValue: "field")
    static let defend = Self(rawValue: "defend")
    static let drive = Self(rawValue: "drive")
    static let float = Self(rawValue: "float")
}

/// Layers more than one act uses.
final class DynamesParts: ActParts {
    required init() {}
    /// GN particles drawn into the muzzle as a shot charges (sniping, TRANS-AM).
    var charge = CAEmitterLayer()
}

extension PetNode {
    var charge: CAEmitterLayer { parts(DynamesParts.self).charge }

    /// The first sniping loop's tilt as it takes aim.
    func attackLean(_ now: CFTimeInterval) -> CGFloat {
        unit.dy.lean * .pi / 180 * CGFloat(min(1, (now - trackStart) / 0.3))
    }

    /// The marker with the sniping pose: just past the far shoulder plate (its pose is wider).
    var snipeBubble: CGPoint {
        guard unit.dy.snipeMuzzle != nil else { return CGPoint(x: unitHeight * 0.4, y: unitHeight * 1.08) }
        let anim = unit.anim(unit.dy.fireAnim)
        let p = bodyPoint(CGPoint(x: anim.size.width + 8, y: 6), in: anim)
        return CGPoint(x: body.position.x + p.x, y: body.position.y + p.y)
    }
}

extension UnitDef {
    /// Its effect pictures (unit.json groups).
    var cutin: [String: CGImage] { pictures["cutin"] ?? [:] }
    var field: [String: CGImage] { pictures["field"] ?? [:] }
    var attack: [String: CGImage] { pictures["attack"] ?? [:] }
    var drive: [String: CGImage] { pictures["drive"] ?? [:] }
    var alarm: [String: CGImage] { pictures["alarm"] ?? [:] }
    var transam: [String: CGImage] { pictures["transam"] ?? [:] }

    /// Its build's measured values (unit.json "rig"), parsed once.
    var dy: DynamesRig {
        if let r = cache[Dynames.id] as? DynamesRig { return r }
        let r = DynamesRig(rig.raw)
        cache[Dynames.id] = r
        return r
    }
}

/// The values tools/build_units.py measured for 力天使 (unit.json "rig"): muzzles, barrel directions, body centres…
struct DynamesRig {
    /// Sniping: muzzle tip and barrel direction in the attack pose's pixels (y down), body tilt in degrees.
    var muzzle = CGPoint.zero
    var aimDir = CGVector(dx: -1, dy: 0)
    var lean: CGFloat = 0
    /// Thinking cycle (預備射擊 → 瞄準 → 射擊): the pose it fires from and how far it tilts to fire.
    var fireAnim = "pose_b"
    var fireLean: CGFloat = -22
    /// Sniping pose "snipe": muzzle (pixels, y down) and barrel direction (y down), measured at build time.
    var snipeMuzzle: CGPoint?
    var snipeDir: CGVector?
    var snipeCore: CGPoint?
    /// Pupil in the cut-in's eye image (pixels, y down): where the lock-on square closes in.
    var cutinPupil: CGPoint?
    /// Twin pistols: per frame, each pistol's muzzle (pixels, y down) and pointing direction (y down), right gun
    /// first; and the body centre (for the GN particles).
    var pistolMuzzles: [[CGPoint]] = []
    var pistolDirs: [[CGVector]] = []
    var pistolCore: CGPoint?
    /// Shield frames (要你批准 / 要你決定): points on the shield's face (pixels, y down) where bullets land, and the
    /// body's centre and reach (the GN field sphere), measured on the braced frame.
    var shieldHits: [CGPoint] = []
    var shieldCore: CGPoint?
    var shieldReach: CGFloat = 0
    /// 做完了: the GN drive's glowing end on the "back" frame (pixels, y down), and its rounded end's radius.
    var driveAt: CGPoint?
    var driveRadius: CGFloat = 12
    /// The GN field pictures' rim radius as a fraction of their width.
    var fieldRim: CGFloat = 0.46
    /// TRANS-AM: the game's opening (frame count, rate, the frames where the screen and the standing shot start);
    /// the standing body's centre; the sniping shot's muzzle, barrel direction (y down) and body centre.
    var taScreenFrames = 0
    var taScreenFPS = 30.0
    var taIntroCuts: [Int] = []
    var taStandCore: CGPoint?
    var taSnipeMuzzle: CGPoint?
    var taSnipeDir: CGVector?
    var taSnipeCore: CGPoint?

    init(_ o: [String: Any]) {
        func point(_ k: String) -> CGPoint? {
            guard let v = o[k] as? [Double], v.count == 2 else { return nil }
            return CGPoint(x: v[0], y: v[1])
        }
        func vector(_ k: String) -> CGVector? {
            guard let v = o[k] as? [Double], v.count == 2 else { return nil }
            return CGVector(dx: v[0], dy: v[1])
        }
        muzzle = point("muzzle") ?? muzzle
        aimDir = vector("aimDir") ?? aimDir
        lean = CGFloat(o["lean"] as? Double ?? 0)
        fireAnim = o["fireAnim"] as? String ?? fireAnim
        fireLean = CGFloat(o["fireLean"] as? Double ?? Double(fireLean))
        snipeMuzzle = point("snipeMuzzle")
        snipeDir = vector("snipeDir")
        snipeCore = point("snipeCore")
        cutinPupil = point("cutinPupil")
        for f in o["pistolMuzzles"] as? [[[Double]]] ?? [] {
            pistolMuzzles.append(f.filter { $0.count == 2 }.map { CGPoint(x: $0[0], y: $0[1]) })
        }
        for f in o["pistolDirs"] as? [[[Double]]] ?? [] {
            pistolDirs.append(f.filter { $0.count == 2 }.map { CGVector(dx: $0[0], dy: $0[1]) })
        }
        pistolCore = point("pistolCore")
        shieldHits = (o["shieldHits"] as? [[Double]] ?? []).filter { $0.count == 2 }.map { CGPoint(x: $0[0], y: $0[1]) }
        shieldCore = point("shieldCore")
        shieldReach = CGFloat(o["shieldReach"] as? Double ?? 0)
        fieldRim = CGFloat(o["fieldRim"] as? Double ?? Double(fieldRim))
        driveAt = point("driveAt")
        driveRadius = CGFloat(o["driveRadius"] as? Double ?? Double(driveRadius))
        if let s = o["taScreen"] as? [Double], s.count == 2 { taScreenFrames = Int(s[0]); taScreenFPS = s[1] }
        taIntroCuts = o["taIntroCuts"] as? [Int] ?? []
        taStandCore = point("taStandCore")
        taSnipeMuzzle = point("taSnipeMuzzle")
        taSnipeDir = vector("taSnipeDir")
        taSnipeCore = point("taSnipeCore")
    }
}
