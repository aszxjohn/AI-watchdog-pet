import AppKit
import QuartzCore

/// TransAm's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class TransAmParts: ActParts {
    required init() {}
    var taPanel: CALayer = CALayer()
    var taBorder: CAShapeLayer = CAShapeLayer()
    var taSystem: CALayer = CALayer()
    var taScreen: [CGImage] = []
    var taGhosts: [CALayer] = []
    var taTrail: [(image: Any?, bounds: CGRect, anchor: CGPoint, at: CGPoint)] = []
    var taBolts: [CALayer] = []
    var taBig: CALayer?
    var taFx: [String: CALayer] = [:]
    var taHit: CGPoint?
    var taBlast: [String: CALayer] = [:]
    var taGN: CAEmitterLayer = CAEmitterLayer()
}

extension PetNode {
    var transAmParts: TransAmParts { parts(TransAmParts.self) }
    var taPanel: CALayer { transAmParts.taPanel }
    var taBorder: CAShapeLayer { transAmParts.taBorder }
    var taSystem: CALayer { transAmParts.taSystem }
    var taScreen: [CGImage] {
        get { transAmParts.taScreen }
        set { transAmParts.taScreen = newValue }
    }
    var taGhosts: [CALayer] {
        get { transAmParts.taGhosts }
        set { transAmParts.taGhosts = newValue }
    }
    var taTrail: [(image: Any?, bounds: CGRect, anchor: CGPoint, at: CGPoint)] {
        get { transAmParts.taTrail }
        set { transAmParts.taTrail = newValue }
    }
    var taBolts: [CALayer] {
        get { transAmParts.taBolts }
        set { transAmParts.taBolts = newValue }
    }
    var taBig: CALayer? {
        get { transAmParts.taBig }
        set { transAmParts.taBig = newValue }
    }
    var taFx: [String: CALayer] {
        get { transAmParts.taFx }
        set { transAmParts.taFx = newValue }
    }
    var taHit: CGPoint? {
        get { transAmParts.taHit }
        set { transAmParts.taHit = newValue }
    }
    var taBlast: [String: CALayer] {
        get { transAmParts.taBlast }
        set { transAmParts.taBlast = newValue }
    }
    var taGN: CAEmitterLayer { transAmParts.taGN }

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

    enum TA {
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

    /// ⑩ where the full-power beam ends and the target blows up, fixed when it fires.

    /// A beam: Wars' own pink beam-rifle bar (DV_efe), its middle stretched along the shot so the rounded ends keep
    /// their shape.
    func makeTABeam() -> CALayer {
        let b = CALayer()
        b.contents = unit.transam["fx_beam"]
        b.contentsGravity = .resize
        b.contentsCenter = CGRect(x: 0.42, y: 0, width: 0.16, height: 1)
        b.anchorPoint = CGPoint(x: 0, y: 0.5)
        b.opacity = 0
        root.addSublayer(b)
        return b
    }

    func layoutTABeam(_ b: CALayer, from p: CGPoint, dir: CGPoint, length: CGFloat, thick: CGFloat, alpha: Float) {
        b.bounds = CGRect(x: 0, y: 0, width: length, height: thick)
        if let im = unit.transam["fx_beam"] { b.contentsScale = CGFloat(im.height) / max(1, thick) }
        b.position = p
        b.transform = CATransform3DMakeRotation(atan2(dir.y, dir.x), 0, 0, 1)
        b.opacity = alpha
    }

    func buildTransAm() {
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
        taScreen = (0..<unit.dy.taScreenFrames).compactMap { unit.transam[String(format: "scr_%03d", $0)] }
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

    func hideTransAm() {
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
    func taFirePoint(offset: CGPoint, lean: CGFloat) -> (muzzle: CGPoint, dir: CGPoint) {
        let rig = unit.dy
        let r = rotate(bodyPoint(rig.taSnipeMuzzle ?? .zero, in: unit.anim("ta_snipe")), lean)
        let muzzle = CGPoint(x: body.position.x + offset.x + r.x, y: body.position.y + offset.y + r.y)
        let dv = rig.taSnipeDir ?? CGVector(dx: -1, dy: 0)
        let len = max(0.001, hypot(dv.dx, dv.dy))
        return (muzzle, rotate(CGPoint(x: dv.dx / len, y: -dv.dy / len), lean))
    }

    /// ⑥ at `d` seconds in: where it is (× unitHeight), whether it is mid-dash, and seconds since its shot here.
    func taDash(_ d: Double) -> (at: CGPoint, dashing: Bool, sinceShot: Double?) {
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

    func taFrame(t: Double) -> (String, Int) {
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
    func updateTAPanel(_ c: Double) {
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
        let i = Int((c - TA.intro.lowerBound) * unit.dy.taScreenFPS)
        if !taScreen.isEmpty { taSystem.contents = taScreen[min(i, taScreen.count - 1)] }
        taSystem.opacity = 1
        let cuts = unit.dy.taIntroCuts
        let border = cuts.count == 2 ? (i < cuts[0] ? Hud.line : i < cuts[1] ? TA.pink : TA.red) : TA.pink
        taBorder.strokeColor = border
        taBorder.shadowColor = border
    }

    func updateTransAm(now: CFTimeInterval, offset: CGPoint, active: Bool) {
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
                charge.emitterPosition = bodyPoint(unit.dy.taSnipeMuzzle ?? .zero, in: unit.anim("ta_snipe"))
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
                    let core = bodyPoint(unit.dy.taSnipeCore ?? .zero, in: unit.anim("ta_snipe"))
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
            let core = (pose == "ta_stand" ? unit.dy.taStandCore : pose == "ta_snipe" ? unit.dy.taSnipeCore
                        : unit.dy.snipeCore) ?? .zero
            taGN.emitterPosition = bodyPoint(core, in: anim)
        }
        taGN.setValue(Hud.gnParticle, forKeyPath: "emitterCells.drift.color")
        Fx.applySnipeGN(TA.fan.mixed(with: TA.gush, gush), to: taGN, active: true)
    }
}
