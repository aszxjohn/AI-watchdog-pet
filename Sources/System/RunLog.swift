import Darwin
import Foundation

/// 運行紀錄 (10/30): what the app does, one line per event ("2026-10-30 17:20:05.123 [mode] 切到展示模式"), in
/// ~/Library/Application Support/GundamPet/logs/run/<yyyy-MM-dd_HH>.log, one file an hour. Nothing is kept for more
/// than 24 hours: when a file is opened (at launch and each new hour) the hour files that started over 24 hours ago
/// go, and so does any other .log in logs/ not written to for 24 hours. Lines are written on a background queue; the
/// stage's tick only adds up its timings (Health). Offscreen runs (captures, headless checks) and demo mode write
/// nothing there; an offscreen run prints its error lines to stderr instead. A file that cannot be opened or written to
/// (a full disk, …) is reported once to the system console and left alone until the next hour — the log never brings
/// the app down (11/02).
enum RunLog {
    /// What a line is about (machine codes; the message after it is for reading).
    enum Kind: String {
        case app, session, pet, mode, settings, package, health, error
    }

    private static let keep: TimeInterval = 24 * 3600
    private static let offscreen = CommandLine.arguments.contains("--offscreen")
    private static let enabled = !offscreen && !CommandLine.arguments.contains("--demo")
    private static let queue = DispatchQueue(label: "GundamPet.RunLog", qos: .utility)
    private static let dir = Config.dir.appendingPathComponent("logs/run")
    private static let lineTime = formatter("yyyy-MM-dd HH:mm:ss.SSS")
    private static let fileHour = formatter("yyyy-MM-dd_HH")
    // the open file and the hour it is for (touched on the queue only)
    private static var hour = ""
    private static var handle: FileHandle?

    static func write(_ kind: Kind, _ message: String) {
        // one line per event, whatever the message holds
        let text = message.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        if offscreen, kind == .error { try? FileHandle.standardError.write(contentsOf: Data("[error] \(text)\n".utf8)) }
        guard enabled else { return }
        let now = Date()
        queue.async {
            let h = fileHour.string(from: now)
            if h != hour { open(h, now: now) }
            guard let fh = handle else { return }
            do {
                try fh.write(contentsOf: Data("\(lineTime.string(from: now)) [\(kind.rawValue)] \(text)\n".utf8))
            } catch {
                NSLog("GundamPet: run log cannot be written (%@); stopped until the next hour", "\(error)")
                try? fh.close()
                handle = nil
            }
        }
    }

    /// Waits until every line so far is on disk (before the app quits).
    static func flush() {
        guard enabled else { return }
        queue.sync { try? handle?.synchronize() }
    }

    /// A session as the log names it: the start of its transcript's file name (the id is the transcript's path) and of
    /// its title.
    static func name(_ id: String, _ title: String) -> String {
        "\(URL(fileURLWithPath: id).deletingPathExtension().lastPathComponent.prefix(8))「\(title.prefix(30))」"
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        return f
    }

    /// Opens the hour's file for appending (O_APPEND: two apps writing at once interleave their lines, never overwrite
    /// each other's), then clears out what is older than 24 hours.
    private static func open(_ h: String, now: Date) {
        let fm = FileManager.default
        try? handle?.close()
        handle = nil
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(h + ".log")
        let fd = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        if fd >= 0 {
            handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        } else {
            NSLog("GundamPet: run log %@ cannot be opened (errno %d); not written until the next hour", url.path, errno)
        }
        hour = h
        for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        where f.pathExtension == "log" {
            guard let start = fileHour.date(from: f.deletingPathExtension().lastPathComponent) else { continue }
            if now.timeIntervalSince(start) > keep { try? fm.removeItem(at: f) }
        }
        let logs = dir.deletingLastPathComponent()
        for f in (try? fm.contentsOfDirectory(at: logs, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        where f.pathExtension == "log" {
            let written = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? now
            if now.timeIntervalSince(written) > keep { try? fm.removeItem(at: f) }
        }
    }

    // MARK: health

    /// The stage's ticks added up between health lines (main thread): every 5 minutes one line with how many
    /// Gundams and sessions there are, the app's memory and CPU, the ticks per second and the slowest tick.
    final class Health {
        private let every: TimeInterval = 300
        private var start = ProcessInfo.processInfo.systemUptime
        private var cpu = RunLog.cpuSeconds()
        private var ticks = 0
        private var slowest: TimeInterval = 0

        /// One tick that took `took` seconds.
        func tick(took: TimeInterval, pets: Int, sessions: Int) {
            ticks += 1
            slowest = max(slowest, took)
            let now = ProcessInfo.processInfo.systemUptime
            let span = now - start
            guard span >= every else { return }
            let c = RunLog.cpuSeconds()
            RunLog.write(.health, String(format: "鋼彈 %d、session %d、記憶體 %.0f MB、CPU %.1f%%、平均 %.1f fps、最慢一個 tick %.1f ms",
                                         pets, sessions, RunLog.memoryMB(), (c - cpu) / span * 100,
                                         Double(ticks) / span, slowest * 1000))
            start = now
            cpu = c
            ticks = 0
            slowest = 0
        }
    }

    /// CPU time the app has used (user + system), in seconds.
    private static func cpuSeconds() -> Double {
        var u = rusage()
        getrusage(RUSAGE_SELF, &u)
        func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
        return seconds(u.ru_utime) + seconds(u.ru_stime)
    }

    /// The app's memory as Activity Monitor counts it (physical footprint), in MB.
    private static func memoryMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let r = withUnsafeMutablePointer(to: &info) { p in
            p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return r == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}
