import AppKit
import QuartzCore

/// The cut-in's lock-on reticle — ring, turning diamond, centre square, four closing arcs — as one group,
/// laid out in its parent's coordinates: over his pupil in the cut-in, and floating over the target.
final class LockHud {
    let group = CALayer()
    let ring = CALayer()
    let diamond = CALayer()
    let square = CALayer()
    var arcs: [CALayer] = []

    /// `ring`: the ring image's size in points; the other pieces scale with it.
    init(images: [String: CGImage], ring r: CGFloat) {
        func piece(_ name: String, _ w: CGFloat, _ h: CGFloat, _ l: CALayer = CALayer()) -> CALayer {
            l.contents = images[name]
            l.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            l.minificationFilter = .trilinear      // the thin lines stay solid when shrunk a lot
            l.opacity = 0
            group.addSublayer(l)
            return l
        }
        _ = piece("diamond", r * 1.3, r * 1.3, diamond)
        _ = piece("reticle", r, r, ring)
        _ = piece("square", r * 0.32, r * 0.32, square)
        // The square is a thin, half-transparent line in the sheet; a glow keeps it readable over his face.
        square.shadowColor = Hud.green
        square.shadowOpacity = 1
        square.shadowRadius = 1.5
        square.shadowOffset = .zero
        // All four arcs from arc_a: in the sheet arc_d is a dark-green fade frame (the "missing" bottom-right
        // arc) and arc_b / arc_c are different lengths.
        arcs = (0..<4).map { _ in piece("arc_a", r * 0.5, r * 0.45) }
    }

    /// How far the symbol reaches from its centre (the arcs are outermost).
    func extent(closeIn: CGFloat) -> CGFloat {
        ring.bounds.width * (0.95 - 0.35 * closeIn + 0.3)
    }

    /// closeIn 0 = searching (spread out, diamond turning with `spin`) … 1 = locked; flash > 1 pops the ring.
    func layout(at p: CGPoint, closeIn: CGFloat, spin t: Double, flash: CGFloat, alpha: Float) {
        ring.opacity = alpha
        ring.position = p
        let rs = (1.35 - 0.35 * closeIn) * flash
        ring.transform = CATransform3DMakeScale(rs, rs, 1)
        diamond.opacity = alpha * 0.6
        diamond.position = p
        diamond.transform = CATransform3DMakeRotation(CGFloat(t) * 1.2 * (1 - closeIn) + .pi / 4 * closeIn, 0, 0, 1)
        square.opacity = alpha
        square.position = p
        let ss = 2.2 - 1.2 * closeIn
        square.transform = CATransform3DMakeScale(ss, ss, 1)
        let radius = ring.bounds.width * (0.95 - 0.35 * closeIn)
        for (k, arc) in arcs.enumerated() {
            let ang = CGFloat(k) * .pi / 2 + .pi / 4 + (1 - closeIn) * 0.9
            arc.opacity = alpha
            arc.position = CGPoint(x: p.x + cos(ang) * radius, y: p.y + sin(ang) * radius)
            arc.transform = CATransform3DMakeRotation(ang - .pi / 4, 0, 0, 1)
        }
    }

    func hide() {
        for l in group.sublayers ?? [] { l.opacity = 0 }
    }
}
