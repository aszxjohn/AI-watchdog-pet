import AppKit
import QuartzCore

/// Field's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class FieldParts: ActParts {
    required init() {}
    var fieldBack: CALayer = CALayer()
    var fieldFront: CALayer = CALayer()
    var fieldPieces: [String: CALayer] = [:]
    var attackSets: [[String: CALayer]] = []
    var dashTrail: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var fieldParts: FieldParts { parts(FieldParts.self) }
    var fieldBack: CALayer { fieldParts.fieldBack }
    var fieldFront: CALayer { fieldParts.fieldFront }
    var fieldPieces: [String: CALayer] {
        get { fieldParts.fieldPieces }
        set { fieldParts.fieldPieces = newValue }
    }
    var attackSets: [[String: CALayer]] {
        get { fieldParts.attackSets }
        set { fieldParts.attackSets = newValue }
    }
    var dashTrail: CAEmitterLayer { fieldParts.dashTrail }

    // MARK: permission (要你批准) — 防禦待命: the full shield closes, a GN field rises around it, "!" blinks
    //
    // Frames are the shared "shield" set (played as a hold). The field is G Generation Wars' own GN フィールド pieces
    // (units/<id>/field/, cut from its GNF atlas, nothing drawn or tinted): the soft glow and two sparkle spheres behind
    // the Gundam, the rim and the bright arc along the bottom in front of it, as in the battle animation. The field is
    // about twice the Gundam's height, so the Gundam floats up a little while it holds; its timings and layers are
    // this state's own.

    enum Field {
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

    /// One set per shell of a volley: the shell and its glow, then the burst's flash, fires, smokes and embers.

    /// The field's radius on screen: about the Gundam's height.
    var fieldRadius: CGFloat { unitHeight * 1.0 }

    func buildField() {
        let side = fieldRadius / max(0.1, unit.dy.fieldRim)    // each picture's width puts the sphere on the radius
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

    func hideField() {
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

    func updateField(now: CFTimeInterval, offset: CGPoint, active: Bool) {
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
        let core = unit.dy.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
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
    func dashOffset(_ c: Double) -> CGPoint {
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
    func middle(offset: CGPoint, lift: CGFloat, anim: Anim, move: CGPoint) -> CGPoint {
        let core = unit.dy.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        return CGPoint(x: body.position.x + offset.x + move.x * unitHeight + core.x * Field.size,
                       y: body.position.y + offset.y + lift + move.y * unitHeight + core.y * Field.size)
    }

    func fieldCentre(offset: CGPoint, lift: CGFloat, anim: Anim) -> CGPoint {
        let core = unit.dy.shieldCore.map { bodyPoint($0, in: anim) } ?? .zero
        return CGPoint(x: body.position.x + offset.x + core.x,
                       y: body.position.y + offset.y + lift + core.y - Field.below * fieldRadius * 2)
    }


    /// Shells fly in from the lower left, aimed where the Gundam is when they are fired: the early ones streak through
    /// the spot it has just left, the last ones burst on the field right in front of it. `at(c)` = the Gundam's middle
    /// at volley time c. Returns the knock-back, the shake and how bright the field flashes.
    func updateAttack(c: Double, at: (Double) -> CGPoint) -> (knock: CGPoint, shake: CGPoint, flash: CGFloat) {
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
    func knockBack(_ c: Double) -> CGPoint {
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
}
