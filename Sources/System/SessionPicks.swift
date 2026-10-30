import Foundation

/// Which sessions have a Gundam (10/30): every active one, except those released from a Gundam's right-click menu —
/// a released session comes back by itself the next time the user writes in it — plus those picked for a Gundam by
/// hand, which keep it even when idle until they are released. 鎖定展示 (10/30): with it on, only the sessions ticked
/// for it get a Gundam (idle or not, released or not), and the watcher reads nothing else. Kept in sessions.json.
final class SessionPicks {
    private struct Saved: Codable {
        var released: [String: Date] = [:]
        var pinned: [String] = []
        var locked: [String] = []
        var lockOn = false

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            released = try c.decodeIfPresent([String: Date].self, forKey: .released) ?? [:]
            pinned = try c.decodeIfPresent([String].self, forKey: .pinned) ?? []
            locked = try c.decodeIfPresent([String].self, forKey: .locked) ?? []
            lockOn = try c.decodeIfPresent(Bool.self, forKey: .lockOn) ?? false
        }
    }

    private var saved = Saved()
    private let url = Config.dir.appendingPathComponent("sessions.json")
    private let persist: Bool

    init(persist: Bool) {
        self.persist = persist
        if persist, let data = try? Data(contentsOf: url),
           let s = try? JSONDecoder.withDates.decode(Saved.self, from: data) {
            saved = s
        }
    }

    func isReleased(_ id: String) -> Bool { saved.released[id] != nil }
    func isPinned(_ id: String) -> Bool { saved.pinned.contains(id) }
    var releasedIds: [String] { Array(saved.released.keys) }

    // MARK: 鎖定展示

    func isLocked(_ id: String) -> Bool { saved.locked.contains(id) }
    var lockedIds: [String] { saved.locked }
    /// On only while something is ticked: unticking the last one turns it off.
    var lockOn: Bool { saved.lockOn && !saved.locked.isEmpty }

    func setLocked(_ id: String, _ on: Bool) {
        saved.locked.removeAll { $0 == id }
        if on { saved.locked.append(id) }
        if saved.locked.isEmpty { saved.lockOn = false }
        save()
    }

    func setLockOn(_ on: Bool) {
        saved.lockOn = on && !saved.locked.isEmpty
        save()
    }

    /// The sessions that get a Gundam. A released session the user has written in since its release is let back in.
    func visible(_ all: [SessionInfo]) -> [SessionInfo] {
        var changed = false
        for s in all {
            if let at = saved.released[s.id], let p = s.lastPromptAt, p > at {
                saved.released[s.id] = nil
                changed = true
            }
        }
        // forget releases of sessions long gone
        let listed = Set(all.map(\.id))
        let stale = saved.released.filter { !listed.contains($0.key) && Date().timeIntervalSince($0.value) > 7 * 86400 }
        for id in stale.keys { saved.released[id] = nil; changed = true }
        if changed { save() }
        if lockOn { return all.filter { saved.locked.contains($0.id) } }
        return all.filter { saved.released[$0.id] == nil && ($0.active || saved.pinned.contains($0.id)) }
    }

    /// Takes the session's Gundam away until the user next writes in it.
    func release(_ id: String) {
        saved.released[id] = Date()
        saved.pinned.removeAll { $0 == id }
        save()
    }

    /// Gives the session a Gundam (even if it is idle), until it is released.
    func pin(_ id: String) {
        saved.released[id] = nil
        if !saved.pinned.contains(id) { saved.pinned.append(id) }
        save()
    }

    private func save() {
        guard persist, let data = try? JSONEncoder.withDates.encode(saved) else { return }
        try? data.write(to: url)
    }
}
