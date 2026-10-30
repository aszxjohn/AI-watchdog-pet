import AppKit
import QuartzCore

/// Cutin's layers and state, one set per Gundam (reached through the accessors below by their old names).
final class CutinParts: ActParts {
    required init() {}
    var cutinPanel: CALayer = CALayer()
    var cutinBorder: CAShapeLayer = CAShapeLayer()
    var cutinLabel: CATextLayer = CATextLayer()
    var cutinLayers: [String: CALayer] = [:]
    var cutinLock: LockHud?
    var floatLock: LockHud?
    var cutinVisible: Bool = false
}

extension PetNode {
    var cutinParts: CutinParts { parts(CutinParts.self) }
    var cutinPanel: CALayer { cutinParts.cutinPanel }
    var cutinBorder: CAShapeLayer { cutinParts.cutinBorder }
    var cutinLabel: CATextLayer { cutinParts.cutinLabel }
    var cutinLayers: [String: CALayer] {
        get { cutinParts.cutinLayers }
        set { cutinParts.cutinLayers = newValue }
    }
    var cutinLock: LockHud? {
        get { cutinParts.cutinLock }
        set { cutinParts.cutinLock = newValue }
    }
    var floatLock: LockHud? {
        get { cutinParts.floatLock }
        set { cutinParts.floatLock = newValue }
    }
    var cutinVisible: Bool {
        get { cutinParts.cutinVisible }
        set { cutinParts.cutinVisible = newValue }
    }

    // MARK: thinking — 瞄準 cut-in: cockpit → helmet close-up → eye through the scope, reticle locks


    enum Cut {
        static let open = 0.2                 // panel opens, the Gundam fades out
        static let cockpit = 0.0...0.8        // shot A
        static let face = 0.65...1.3          // shot B
        static let eye = 1.15...2.3           // shot C, reticle closes in, locks at 1.6 (stays until the panel shuts)
        static let lock = 1.6
        static let close = 0.15               // at the start of 射擊
    }

    var cutinSize: CGSize { CGSize(width: unitHeight * 1.6, height: unitHeight * 0.95) }

    func buildCutin() {
        let size = cutinSize
        let rect = CGRect(origin: .zero, size: size)
        let center = CGPoint(x: 0, y: unitHeight * 0.55)
        cutinPanel.bounds = rect
        cutinPanel.position = center
        cutinPanel.backgroundColor = CGColor(gray: 0, alpha: 0.9)
        let clip = CAShapeLayer()
        clip.path = Hud.chamfer(rect, cut: 10)
        cutinPanel.mask = clip
        cutinPanel.opacity = 0

        func piece(_ name: String, _ frame: CGRect, gravity: CALayerContentsGravity = .resize) -> CALayer {
            let l = CALayer()
            l.contents = unit.cutin[name]
            l.contentsGravity = gravity
            l.frame = frame
            l.opacity = 0
            cutinPanel.addSublayer(l)
            cutinLayers[name] = l
            return l
        }
        for name in ["cockpit", "face", "eye"] { _ = piece(name, rect, gravity: .resizeAspectFill) }
        let tint = piece("tint", rect)
        tint.compositingFilter = "multiplyBlendMode"
        let scopeH = size.height * 1.3
        _ = piece("scope", CGRect(x: 0, y: 0, width: scopeH * 359 / 696, height: scopeH))
        let lock = LockHud(images: unit.cutin, ring: size.height * 0.62)
        lock.group.frame = rect
        cutinPanel.addSublayer(lock.group)
        cutinLock = lock
        _ = piece("line", CGRect(x: 0, y: 0, width: size.width, height: 8))
        for l in cutinLayers.values where l.contentsGravity == .resize && l !== tint {
            l.position = CGPoint(x: size.width / 2, y: size.height / 2)
        }

        cutinLabel.string = "LOCK ON"
        cutinLabel.font = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
        cutinLabel.fontSize = 9
        cutinLabel.foregroundColor = Hud.orange
        cutinLabel.contentsScale = 2
        cutinLabel.alignmentMode = .right
        cutinLabel.frame = CGRect(x: size.width - 70, y: 6, width: 62, height: 12)
        cutinLabel.opacity = 0
        cutinPanel.addSublayer(cutinLabel)
        root.addSublayer(cutinPanel)

        cutinBorder.bounds = rect
        cutinBorder.position = center
        cutinBorder.path = Hud.chamfer(rect.insetBy(dx: 0.75, dy: 0.75), cut: 10)
        cutinBorder.fillColor = nil
        cutinBorder.strokeColor = Hud.line
        cutinBorder.lineWidth = 1.5
        cutinBorder.shadowColor = Hud.green
        cutinBorder.shadowOpacity = 0.7
        cutinBorder.shadowRadius = 3
        cutinBorder.shadowOffset = .zero
        cutinBorder.opacity = 0
        root.addSublayer(cutinBorder)
    }



    func updateCutin(_ c: Double) {
        guard let face = cutinLayers["face"], let eye = cutinLayers["eye"], let cockpit = cutinLayers["cockpit"],
              let scope = cutinLayers["scope"], let tint = cutinLayers["tint"], let line = cutinLayers["line"]
        else { return }
        cutinVisible = true
        let size = cutinSize
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)

        // Panel opens like a shutter while the Gundam fades away.
        let open = progress(c, 0...Cut.open)
        cutinPanel.opacity = 1
        cutinBorder.opacity = 1
        cutinPanel.transform = CATransform3DMakeScale(1, max(0.02, open), 1)
        cutinBorder.transform = cutinPanel.transform
        body.opacity = Float(1 - open)

        // Shot A: the cockpit, slowly pushing in.
        cockpit.opacity = shotAlpha(c, Cut.cockpit)
        let pa = 1 + 0.1 * CGFloat(c / Cut.cockpit.upperBound)
        cockpit.transform = CATransform3DMakeScale(pa, pa, 1)

        // Shot B: helmet close-up, pushing in towards his eyes. (No scope dropping in — the user asked
        // for the descending scope to be left out.)
        face.opacity = shotAlpha(c, Cut.face)
        let pb = 1.05 + 0.07 * progress(c, Cut.face)
        face.transform = CATransform3DMakeScale(pb, pb, 1)
        scope.opacity = 0

        // Shot C: through the scope — the eye strip under a teal filter, the reticle closing in.
        eye.opacity = shotAlpha(c, Cut.eye, fade: 0.12)
        let pc = 1.1 + 0.05 * progress(c, Cut.eye)
        eye.transform = CATransform3DMakeScale(pc, pc, 1)
        tint.opacity = eye.opacity * 0.55
        let hud = Cut.eye.lowerBound + 0.1
        let closeIn = progress(c, hud...Cut.lock)
        let hudAlpha: Float = c >= hud ? min(1, Float((c - hud) / 0.1)) : 0
        let locked = c >= Cut.lock
        let flash: CGFloat = locked && c < Cut.lock + 0.15 ? 1 + CGFloat(Cut.lock + 0.15 - c) * 2 : 1
        // The reticle closes in on his pupil: where it sits in the eye image, through the aspect fill and push-in.
        var target = mid
        if let pupil = unit.dy.cutinPupil, let img = unit.cutin["eye"] {
            let iw = CGFloat(img.width), ih = CGFloat(img.height)
            let fill = max(size.width / iw, size.height / ih) * pc
            target = CGPoint(x: mid.x + (pupil.x - iw / 2) * fill, y: mid.y - (pupil.y - ih / 2) * fill)
        }
        cutinLock?.layout(at: target, closeIn: closeIn, spin: c, flash: flash, alpha: hudAlpha)
        // One scan line sweeps down while it searches, then the lock label blinks.
        let sweep = progress(c, hud...Cut.lock)
        line.opacity = c >= hud && c < Cut.lock ? hudAlpha * 0.9 : 0
        line.position = CGPoint(x: mid.x, y: size.height * (1 - sweep))
        cutinLabel.opacity = locked ? (Int(c * 10) % 2 == 0 ? 1 : 0.35) : 0
        cutinBorder.strokeColor = locked ? Hud.orange : Hud.line
        cutinBorder.shadowColor = locked ? Hud.orange : Hud.green
    }

    /// Start of 射擊: the panel snaps shut and the Gundam fades back in to fire.
    func closeCutin(_ c: Double) {
        guard cutinVisible || c < Cut.close else { return }
        let p = CGFloat(min(1, c / Cut.close))
        cutinPanel.transform = CATransform3DMakeScale(1, max(0.02, 1 - p), 1)
        cutinBorder.transform = cutinPanel.transform
        cutinPanel.opacity = Float(1 - p)
        cutinBorder.opacity = Float(1 - p)
        body.opacity = Float(min(1, c / 0.2))
        if p >= 1 { hideCutin() }
    }

    func hideCutin() {
        guard cutinVisible || body.opacity < 1 else { return }
        cutinVisible = false
        cutinPanel.opacity = 0
        cutinBorder.opacity = 0
        body.opacity = 1
    }
}
