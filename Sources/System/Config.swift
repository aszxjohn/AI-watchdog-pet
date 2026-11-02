import Foundation

/// ~/Library/Application Support/GundamPet/config.json. Missing keys fall back to the defaults below,
/// and the file is (re)written with every key so it doubles as documentation.
struct Config: Codable {
    var projectsDir = "~/.claude/projects"
    /// A session stays on screen while its transcript was written within this many minutes.
    var activeMinutes = 30.0
    /// A Gundam's right-click menu lists sessions written to within this many hours (at most `listCount` besides the
    /// active ones), to pick one for it by hand.
    var listHours = 24.0
    var listCount = 15
    /// No activity for this long → 休息中.
    var sleepMinutes = 10.0
    /// A tool call pending this long with no new transcript lines → 要你批准?
    var permissionSeconds = 8.0
    var showLabels = true
    /// Writes logs/state.json and logs/snapshot.png every 2 seconds.
    var debug = false
    /// Which screen the Gundams stand on (its name, as in System Settings › Displays); empty = the main screen. If that
    /// screen is not connected, the main screen is used.
    var screen = ""

    static let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/GundamPet")

    init() {}

    /// Each key on its own (10/30): one of the wrong type falls back to its default, and the others are still read.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Config()
        func value<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            do {
                return try c.decodeIfPresent(T.self, forKey: key) ?? fallback
            } catch {
                Config.badKeys.append(key.stringValue)
                return fallback
            }
        }
        projectsDir = value(.projectsDir, d.projectsDir)
        activeMinutes = value(.activeMinutes, d.activeMinutes)
        sleepMinutes = value(.sleepMinutes, d.sleepMinutes)
        listHours = value(.listHours, d.listHours)
        listCount = value(.listCount, d.listCount)
        permissionSeconds = value(.permissionSeconds, d.permissionSeconds)
        showLabels = value(.showLabels, d.showLabels)
        debug = value(.debug, d.debug)
        screen = value(.screen, d.screen)
    }

    /// The keys the last decode could not read (main thread, while loading).
    private static var badKeys: [String] = []

    static func load() -> Config {
        let url = dir.appendingPathComponent("config.json")
        var config = Config()
        // not even a JSON object: set aside, defaults this time; some keys of the wrong type: a copy is kept, those
        // keys take their defaults
        if let data = SettingsFile.readObject(url).flatMap({ try? JSONSerialization.data(withJSONObject: $0) }) {
            badKeys = []
            config = (try? JSONDecoder().decode(Config.self, from: data)) ?? Config()
            if !badKeys.isEmpty {
                SettingsFile.setAside(url, keepOriginal: true, why: "的 \(badKeys.joined(separator: "、")) 型別不對（改用預設值）")
            }
        }
        config.save()
        return config
    }

    func save() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(self) else { return }
        SettingsFile.write(data, to: Config.dir.appendingPathComponent("config.json"))
    }
}
