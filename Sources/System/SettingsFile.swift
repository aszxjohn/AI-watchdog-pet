import Foundation

/// The app's own settings files (config.json, sessions.json, assignments.json, characters/<id>.json), read and
/// written one way (10/30). A file that is there but cannot be read or understood is never overwritten later with
/// defaults: it is kept as <name>.broken-<time> and the run log says so. Writes are atomic, so a crash mid-write leaves
/// the old file. An offscreen run (captures, headless checks) only reads: it moves and writes nothing (11/02).
enum SettingsFile {
    private static let readOnly = CommandLine.arguments.contains("--offscreen")

    /// The file's data; nil when there is none, or when it cannot be read or `usable` rejects it (it is then set aside).
    static func read(_ url: URL, usable: (Data) -> Bool) -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            setAside(url, keepOriginal: false, why: "讀不到（\(error.localizedDescription)）")
            return nil
        }
        if usable(data) { return data }
        setAside(url, keepOriginal: false, why: "讀不懂")
        return nil
    }

    /// A file holding one JSON object.
    static func readObject(_ url: URL) -> [String: Any]? {
        read(url, usable: { (try? JSONSerialization.jsonObject(with: $0)) is [String: Any] })
            .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
    }

    static func write(_ data: Data, to url: URL) {
        guard !readOnly else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            RunLog.write(.error, "\(url.lastPathComponent) 寫不進去：\(error.localizedDescription)")
        }
    }

    /// Keeps a copy as <name>.broken-<time> (moving the file, or copying it when it stays in use).
    static func setAside(_ url: URL, keepOriginal: Bool, why: String) {
        guard !readOnly else {
            RunLog.write(.error, "\(url.lastPathComponent) \(why)（offscreen 測試執行，不動原檔）")
            return
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        let kept = url.deletingLastPathComponent().appendingPathComponent("\(url.lastPathComponent).broken-\(f.string(from: Date()))")
        let fm = FileManager.default
        do {
            if keepOriginal { try fm.copyItem(at: url, to: kept) } else { try fm.moveItem(at: url, to: kept) }
            RunLog.write(.error, "\(url.lastPathComponent) \(why)：原檔留了一份 \(kept.lastPathComponent)")
        } catch {
            RunLog.write(.error, "\(url.lastPathComponent) \(why)，而且留不下備份：\(error.localizedDescription)")
        }
    }
}
