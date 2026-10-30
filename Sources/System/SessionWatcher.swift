import Foundation

enum PetState: String, Codable {
    case thinking, working, permission, question, done, waiting, sleeping, error

    var label: String {
        switch self {
        case .thinking: return "思考中"
        case .working: return "工作中"
        case .permission: return "要你批准?"
        case .question: return "要你決定"
        case .done: return "做完了"
        case .waiting: return "等你回覆"
        case .sleeping: return "休息中"
        case .error: return "出錯了"
        }
    }
}

struct SessionInfo: Codable {
    let id: String
    let title: String
    let state: PetState
    let toolErrorAt: Date?
    let firstSeen: Date
    /// Written to within `activeMinutes` (only these get a Gundam by themselves; older ones only when picked by hand).
    var active = true
    /// When the user last wrote in it (a released session comes back once this is after the release).
    var lastPromptAt: Date?
    /// When its transcript last changed.
    var updatedAt = Date()
}

/// Follows one transcript (~/.claude/projects/<project>/<session>.jsonl) and keeps just enough
/// of it to tell what the session is doing right now.
private final class Tracker {
    let url: URL
    let firstSeen = Date()
    var created = Date.distantPast
    var mtime = Date.distantPast
    var offset: UInt64 = 0
    var carry = Data()

    var title: String?
    var lastPrompt: String?
    var pending: [String: (name: String, at: Date)] = [:]
    var lastPromptAt: Date?
    var turnEndedAt: Date?
    var errorAt: Date?
    var toolErrorAt: Date?
    var lastRecordAt = Date.distantPast

    init(url: URL) { self.url = url }

    var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let p = lastPrompt?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty { return p }
        return url.deletingLastPathComponent().lastPathComponent
    }
}

final class SessionWatcher {
    /// Tools that wait on the user by design.
    private static let askTools: Set<String> = ["AskUserQuestion", "ExitPlanMode"]
    /// Tools that are often slow on their own; a long wait on these is not a permission prompt.
    private static let slowTools: Set<String> = [
        "Agent", "Task", "Workflow", "WebSearch", "WebFetch", "Monitor", "TaskOutput", "ScheduleWakeup",
    ]
    /// On first sight only the tail of a transcript is read; that is enough to know the current state.
    private static let tailBytes: UInt64 = 2 << 20

    private let config: Config
    private let queue = DispatchQueue(label: "gundam-pet.watcher")
    private var trackers: [String: Tracker] = [:]
    private var timer: DispatchSourceTimer?
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    var onUpdate: (([SessionInfo]) -> Void)?
    /// 鎖定展示: only these transcripts (paths) are read; nil = every recent one.
    private var only: Set<String>?

    init(config: Config) { self.config = config }

    /// 鎖定展示: from now on read only these sessions (nil: all of them again), and rescan straight away.
    func watchOnly(_ paths: Set<String>?) {
        queue.async { [weak self] in
            self?.only = paths
            self?.scan()
        }
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.5)
        t.setEventHandler { [weak self] in self?.scan() }
        t.resume()
        timer = t
    }

    private func scan() {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: (config.projectsDir as NSString).expandingTildeInPath)
        let keys: [URLResourceKey] = [.contentModificationDateKey, .creationDateKey, .fileSizeKey]
        let now = Date()
        var seen = Set<String>()
        // Every session written to within activeMinutes, plus the most recent others within listHours (for picking
        // one by hand from a Gundam's right-click menu).
        var found: [(file: URL, rv: URLResourceValues, mtime: Date)] = []
        // 鎖定展示: just those files, however old, and no scan of the projects folder at all
        if let only {
            for path in only {
                let file = URL(fileURLWithPath: path)
                guard let rv = try? file.resourceValues(forKeys: Set(keys)), let mtime = rv.contentModificationDate else { continue }
                found.append((file, rv, mtime))
            }
        }
        let dirs = only != nil ? [] : (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs {
            let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys)) ?? []
            for file in files where file.pathExtension == "jsonl" && !file.lastPathComponent.hasPrefix("agent-") {
                guard let rv = try? file.resourceValues(forKeys: Set(keys)),
                      let mtime = rv.contentModificationDate,
                      now.timeIntervalSince(mtime) < max(config.activeMinutes * 60, config.listHours * 3600) else { continue }
                found.append((file, rv, mtime))
            }
        }
        found.sort { $0.mtime > $1.mtime }
        let activeAge = config.activeMinutes * 60
        let listed = found.enumerated().filter {
            only != nil || $0.offset < config.listCount || now.timeIntervalSince($0.element.mtime) < activeAge
        }
        for (_, f) in listed {
            let key = f.file.path
            seen.insert(key)
            let tracker: Tracker
            if let existing = trackers[key] {
                tracker = existing
            } else {
                tracker = Tracker(url: f.file)
                tracker.created = f.rv.creationDate ?? f.mtime
                trackers[key] = tracker
            }
            tracker.mtime = f.mtime
            read(tracker, size: UInt64(f.rv.fileSize ?? 0))
        }
        trackers = trackers.filter { seen.contains($0.key) }

        let visible = trackers.values.filter { $0.lastRecordAt != .distantPast && !isSuperseded($0) }
        let infos = visible
            .sorted { $0.firstSeen < $1.firstSeen }
            .map { t in
                SessionInfo(id: t.url.path, title: t.displayTitle, state: state(of: t, now: now),
                            toolErrorAt: t.toolErrorAt, firstSeen: t.firstSeen,
                            active: now.timeIntervalSince(t.mtime) < activeAge, lastPromptAt: t.lastPromptAt,
                            updatedAt: t.mtime)
            }
        DispatchQueue.main.async { [weak self] in self?.onUpdate?(infos) }
    }

    /// The desktop app sometimes moves a running session to a new transcript file. When a newer
    /// file with the same title in the same folder started after this one stopped, hide this one.
    private func isSuperseded(_ t: Tracker) -> Bool {
        guard let title = t.title, !title.isEmpty else { return false }
        let folder = t.url.deletingLastPathComponent()
        return trackers.values.contains { o in
            o !== t && o.title == title && o.url.deletingLastPathComponent() == folder
                && o.created > t.created && o.created >= t.mtime.addingTimeInterval(-2)
        }
    }

    private func read(_ t: Tracker, size: UInt64) {
        if size < t.offset { t.offset = 0; t.carry = Data() }
        guard size > t.offset, let fh = try? FileHandle(forReadingFrom: t.url) else { return }
        defer { try? fh.close() }
        var start = t.offset
        var skipFirstLine = false
        if t.offset == 0 && size > Self.tailBytes {
            start = size - Self.tailBytes
            skipFirstLine = true
        }
        do { try fh.seek(toOffset: start) } catch { return }
        guard let data = try? fh.readToEnd(), !data.isEmpty else { return }
        t.offset = start + UInt64(data.count)
        var lines = (t.carry + data).split(separator: 0x0A, omittingEmptySubsequences: false)
        t.carry = Data(lines.removeLast())
        if skipFirstLine, !lines.isEmpty { lines.removeFirst() }
        for line in lines where !line.isEmpty {
            ingest(t, Data(line))
        }
    }

    private func ingest(_ t: Tracker, _ line: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
        if obj["isSidechain"] as? Bool == true { return }
        let type = obj["type"] as? String ?? ""
        let ts = (obj["timestamp"] as? String).flatMap { iso.date(from: $0) }

        switch type {
        case "custom-title":
            if let s = obj["customTitle"] as? String, !s.isEmpty { t.title = s }
        case "last-prompt":
            if let s = obj["lastPrompt"] as? String { t.lastPrompt = s }
        case "user":
            ingestUser(t, obj, ts: ts)
        case "assistant":
            ingestAssistant(t, obj, ts: ts)
        case "system":
            let sub = obj["subtype"] as? String
            if sub == "stop_hook_summary" || sub == "turn_duration" {
                t.turnEndedAt = ts ?? t.lastRecordAt
                t.pending.removeAll()
            }
        default:
            break
        }
        if let ts, type == "user" || type == "assistant" || type == "system" {
            t.lastRecordAt = max(t.lastRecordAt, ts)
        }
    }

    private func ingestUser(_ t: Tracker, _ obj: [String: Any], ts: Date?) {
        let content = (obj["message"] as? [String: Any])?["content"]
        var text: String?
        if let s = content as? String {
            text = s
        } else if let blocks = content as? [[String: Any]] {
            var sawToolResult = false
            var joined = ""
            for b in blocks {
                switch b["type"] as? String {
                case "tool_result":
                    sawToolResult = true
                    if let id = b["tool_use_id"] as? String { t.pending.removeValue(forKey: id) }
                    if b["is_error"] as? Bool == true { t.toolErrorAt = ts }
                case "text":
                    joined += b["text"] as? String ?? ""
                default:
                    break
                }
            }
            if !sawToolResult && !joined.isEmpty { text = joined }
        }
        guard let text, obj["isMeta"] as? Bool != true else { return }
        if text.hasPrefix("[Request interrupted") {
            t.pending.removeAll()
            t.turnEndedAt = ts
            return
        }
        if text.hasPrefix("<local-command") { return }
        t.pending.removeAll()
        t.turnEndedAt = nil
        t.errorAt = nil
        t.lastPromptAt = ts
    }

    private func ingestAssistant(_ t: Tracker, _ obj: [String: Any], ts: Date?) {
        if obj["isApiErrorMessage"] as? Bool == true { t.errorAt = ts }
        let msg = obj["message"] as? [String: Any]
        var hasTool = false
        for b in msg?["content"] as? [[String: Any]] ?? [] where b["type"] as? String == "tool_use" {
            if let id = b["id"] as? String { t.pending[id] = (b["name"] as? String ?? "", ts ?? Date()) }
            hasTool = true
        }
        if hasTool {
            t.turnEndedAt = nil
        } else if msg?["stop_reason"] as? String == "end_turn" {
            t.turnEndedAt = ts
        }
    }

    private func state(of t: Tracker, now: Date) -> PetState {
        let quiet = now.timeIntervalSince(t.lastRecordAt)
        let asleep = quiet > config.sleepMinutes * 60
        if let err = t.errorAt, err >= (t.lastPromptAt ?? .distantPast), t.pending.isEmpty {
            return asleep ? .sleeping : .error
        }
        if !t.pending.isEmpty {
            let names = t.pending.values.map(\.name)
            if names.contains(where: Self.askTools.contains) { return .question }
            let oldest = t.pending.values.map(\.at).min() ?? now
            if quiet > config.permissionSeconds,
               now.timeIntervalSince(oldest) > config.permissionSeconds,
               !names.contains(where: Self.slowTools.contains) {
                return .permission
            }
            return .working
        }
        if let end = t.turnEndedAt {
            if now.timeIntervalSince(end) < 6 { return .done }
            return asleep ? .sleeping : .waiting
        }
        if t.lastPromptAt == nil || asleep { return asleep ? .sleeping : .waiting }
        return .thinking
    }
}
