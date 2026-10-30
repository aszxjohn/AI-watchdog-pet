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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Config()
        projectsDir = try c.decodeIfPresent(String.self, forKey: .projectsDir) ?? d.projectsDir
        activeMinutes = try c.decodeIfPresent(Double.self, forKey: .activeMinutes) ?? d.activeMinutes
        sleepMinutes = try c.decodeIfPresent(Double.self, forKey: .sleepMinutes) ?? d.sleepMinutes
        listHours = try c.decodeIfPresent(Double.self, forKey: .listHours) ?? d.listHours
        listCount = try c.decodeIfPresent(Int.self, forKey: .listCount) ?? d.listCount
        permissionSeconds = try c.decodeIfPresent(Double.self, forKey: .permissionSeconds) ?? d.permissionSeconds
        showLabels = try c.decodeIfPresent(Bool.self, forKey: .showLabels) ?? d.showLabels
        debug = try c.decodeIfPresent(Bool.self, forKey: .debug) ?? d.debug
        screen = try c.decodeIfPresent(String.self, forKey: .screen) ?? d.screen
    }

    static func load() -> Config {
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("config.json")
        var config = Config()
        if let data = try? Data(contentsOf: url) {
            do {
                config = try JSONDecoder().decode(Config.self, from: data)
            } catch {
                NSLog("GundamPet: config.json unreadable, using defaults: \(error)")
                return config
            }
        }
        config.save()
        return config
    }

    func save() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(self).write(to: Config.dir.appendingPathComponent("config.json"))
    }
}
