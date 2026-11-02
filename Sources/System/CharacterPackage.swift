import AppKit
import UniformTypeIdentifiers

/// Character files (10/30): a character travels as one file, to be shared and installed on another Mac.
///
/// What the app reads:
///   1. A package folder `<id>/`: character.json, states/<state>.json, assets/ (unit.json and its pictures). The app's
///      own characters ship this way (Resources/characters/<id>/); installed ones live in
///      ~/Library/Application Support/GundamPet/characters/<id>/ and win over the app's own of the same id.
///   2. A character file `<name>.gpet`: that folder zipped (one top folder `<id>/`) with manifest.json added. A plain
///      `.zip` laid out the same way (a zipped package folder, no manifest) is read too.
///   3. Inside a character file, optionally, settings.json: the exporter's own changes from the 角色設定 panel (size,
///      wandering, 演出 values), the same shape as ~/Library/Application Support/GundamPet/characters/<id>.json.
///
/// manifest.json:
///   {"format": "gundam-pet-character", "formatVersion": 1, "id", "name", "code", "exportedAt",
///    "states": {state: "script" | "module" | "plain"}, "requires": {"module": id} (only when a state needs one),
///    "settings": true/false, "files": count}
/// A state is acted out by its script ("script", travels with the file), by the character's own code compiled into
/// the app ("module": an app without that module plays its frames plainly), or by the system's plain playback of the
/// frames unit.json's rig names ("plain").
enum CharacterPackage {
    static let format = "gundam-pet-character"
    static let formatVersion = 1
    static let fileExtension = "gpet"
    /// Declared in Info.plist (UTExportedTypeDeclarations), so Finder opens a .gpet with the app.
    static var contentType: UTType { UTType(filenameExtension: fileExtension) ?? .zip }

    enum Failure: LocalizedError {
        case noSuchCharacter(String)
        case notAPackage(String)
        case unsafe(String)
        case newerFormat(Int)
        case badFile(String)
        case tool(String)
        case idMismatch(String)

        var errorDescription: String? {
            switch self {
            case .noSuchCharacter(let id): return "找不到角色「\(id)」。"
            case .notAPackage(let why): return "這不是角色檔：\(why)"
            case .unsafe(let why): return "角色檔裡有不安全的內容，已拒絕：\(why)"
            case .newerFormat(let v): return "角色檔是較新的格式（第 \(v) 版），這個版本的程式只讀得懂第 \(formatVersion) 版以前的。"
            case .badFile(let name): return "角色檔裡的 \(name) 讀不出來（不是正確的 JSON）。"
            case .tool(let why): return "壓縮／解壓失敗：\(why)"
            case .idMismatch(let what):
                return "角色代號前後不一致，已拒絕（裝進去會跟別的角色撞名，讓程式起不來）：\(what)。"
            }
        }
    }

    /// What a character file holds, checked and unpacked (into a temporary folder), not yet installed.
    struct Inspection {
        let id: String
        let name: String
        let code: String
        let states: [String: String]
        /// The character module it needs for some states, and whether this app has it.
        let requiresModule: String?
        let moduleAvailable: Bool
        let hasSettings: Bool
        /// A character of this id is already installed (it is moved aside, not deleted) / ships with the app.
        let replacesInstalled: Bool
        let overridesBuiltIn: Bool
        /// The unpacked package folder.
        let root: URL
    }

    static let stateNames = ["waiting", "thinking", "working", "permission", "question", "done", "sleeping", "error"]

    /// What a character may be at most, unpacked (Dynames: about 20 MB in some 260 files).
    static let maxBytes = 300_000_000
    static let maxFiles = 5000
    /// How many replaced copies of one character characters/.replaced/ keeps.
    static let keepReplaced = 3

    /// Where installed characters (and the user's settings for every character) live.
    static var userDir: URL { Config.dir.appendingPathComponent("characters") }

    // MARK: export

    /// Writes character `id` (as the app has loaded it) to a character file at `dest`.
    static func export(id: String, to dest: URL, includeSettings: Bool) throws {
        guard let pkg = UnitDef.packages()[id] else { throw Failure.noSuchCharacter(id) }
        try export(package: pkg, id: id, to: dest,
                   settings: includeSettings ? userDir.appendingPathComponent("\(id).json") : nil)
    }

    /// Writes the package folder `pkg` to a character file at `dest`, with `settings` (a user settings file) if given
    /// and present.
    static func export(package pkg: URL, id: String, to dest: URL, settings: URL?) throws {
        let fm = FileManager.default
        let stage = fm.temporaryDirectory.appendingPathComponent("gpet-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: stage) }
        let top = stage.appendingPathComponent(id)
        try fm.createDirectory(at: top, withIntermediateDirectories: true)
        for item in ["character.json", "states", "assets"] {
            let from = pkg.appendingPathComponent(item)
            if fm.fileExists(atPath: from.path) { try fm.copyItem(at: from, to: top.appendingPathComponent(item)) }
        }
        guard fm.fileExists(atPath: top.appendingPathComponent("assets/unit.json").path) else {
            throw Failure.notAPackage("\(pkg.path) 裡沒有 assets/unit.json")
        }
        var withSettings = false
        if let s = settings, fm.fileExists(atPath: s.path) {
            try fm.copyItem(at: s, to: top.appendingPathComponent("settings.json"))
            withSettings = true
        }
        // Finder's leftovers stay home.
        for f in files(under: top) where f.lastPathComponent == ".DS_Store" { try? fm.removeItem(at: f) }

        let character = read(top.appendingPathComponent("character.json")) ?? [:]
        let unit = read(top.appendingPathComponent("assets/unit.json")) ?? [:]
        let kinds = stateKinds(of: top, id: id)
        var manifest: [String: Any] = [
            "format": format, "formatVersion": formatVersion, "id": id,
            "name": character["name"] ?? unit["name"] ?? id, "code": character["code"] ?? unit["code"] ?? "",
            "exportedAt": ISO8601DateFormatter().string(from: Date()), "states": kinds, "settings": withSettings,
            "files": files(under: top).count + 1,
        ]
        if kinds.values.contains("module") { manifest["requires"] = ["module": id] }
        try write(manifest, to: top.appendingPathComponent("manifest.json"))

        // written beside the destination first and swapped in only when whole: a failed export never costs the file
        // that was there
        let partial = dest.deletingLastPathComponent().appendingPathComponent(".\(dest.lastPathComponent)-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: partial) }
        // plain files only: no resource forks, extended attributes, quarantine or ACLs (no __MACOSX/._ entries)
        try run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent", top.path,
                                   partial.path])
        if fm.fileExists(atPath: dest.path) {
            _ = try fm.replaceItemAt(dest, withItemAt: partial)
        } else {
            try fm.moveItem(at: partial, to: dest)
        }
    }

    /// How each state of the package at `dir` is acted out: "script" (its state file has one; it replaces the
    /// character's own acts), "module" (this app's code for the character: an act for the state's mode, or one tied
    /// to the state) or "plain".
    static func stateKinds(of dir: URL, id: String) -> [String: String] {
        let rig = (read(dir.appendingPathComponent("assets/unit.json"))?["rig"] as? [String: Any])?["states"]
            as? [String: Any] ?? [:]
        let acts = PetNode.kits[id]?.acts ?? []
        var out: [String: String] = [:]
        for name in stateNames {
            guard let st = PetState(rawValue: name) else { continue }
            let mode = (rig[name] as? [String: Any])?["mode"] as? String
            let scripted = read(dir.appendingPathComponent("states/\(name).json"))?["script"] != nil
            if scripted {
                out[name] = "script"           // a script replaces the character's own acts for the state
            } else if acts.contains(where: { $0.state == st }) {
                out[name] = "module"
            } else if let m = mode, acts.contains(where: { $0.mode?.rawValue == m }) {
                out[name] = "module"
            } else {
                out[name] = "plain"
            }
        }
        return out
    }

    // MARK: import

    /// Opens a character file (or a package folder) and checks it, installing nothing yet.
    static func inspect(_ src: URL) throws -> Inspection {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: src.path, isDirectory: &isDir) else { throw Failure.notAPackage("找不到 \(src.path)") }
        let root: URL
        if isDir.boolValue {
            // a package folder: looked at where it is first (a wrong folder is never copied), then checked in a copy,
            // so installing never moves the user's own folder
            guard fm.fileExists(atPath: src.appendingPathComponent("assets/unit.json").path) else {
                throw Failure.notAPackage("這個資料夾不是角色包（裡面沒有 assets/unit.json）")
            }
            try measure(src)
            let tmp = fm.temporaryDirectory.appendingPathComponent("gpet-\(UUID().uuidString)")
            let copy = tmp.appendingPathComponent(src.lastPathComponent)
            do {
                try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                try fm.copyItem(at: src, to: copy)
                try verifyTree(tmp)
            } catch {
                try? fm.removeItem(at: tmp)
                throw error
            }
            root = copy
        } else {
            root = try unpack(src)
        }
        do {
            return try check(root)
        } catch {
            try? fm.removeItem(at: root.deletingLastPathComponent())
            throw error
        }
    }

    /// Checks an unpacked package folder (in its own temporary folder) and reads what it holds.
    private static func check(_ root: URL) throws -> Inspection {
        let fm = FileManager.default
        for f in files(under: root.deletingLastPathComponent(), withLinks: true)
        where (try? f.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
            throw Failure.unsafe("捷徑檔 \(f.lastPathComponent)")
        }

        let manifest = read(root.appendingPathComponent("manifest.json"))
        if let m = manifest {
            guard m["format"] as? String == format else { throw Failure.notAPackage("manifest.json 不是角色檔的格式") }
            let v = m["formatVersion"] as? Int ?? 0
            if v > formatVersion { throw Failure.newerFormat(v) }
        }
        guard fm.fileExists(atPath: root.appendingPathComponent("assets/unit.json").path) else {
            throw Failure.notAPackage("裡面沒有 assets/unit.json")
        }
        // every JSON it carries must read, or the character would half load
        for f in files(under: root) where f.pathExtension == "json" {
            if read(f) == nil { throw Failure.badFile(f.path.replacingOccurrences(of: root.path + "/", with: "")) }
        }
        let character = read(root.appendingPathComponent("character.json")) ?? [:]
        let unit = read(root.appendingPathComponent("assets/unit.json")) ?? [:]
        guard unit["rig"] is [String: Any] else { throw Failure.notAPackage("assets/unit.json 沒有 rig") }
        // every picture it names is inside the package (no absolute paths, no ..)
        if let bad = outsidePaths(unit).first { throw Failure.unsafe("assets/unit.json 指到角色包外面的檔：\(bad)") }
        // one id everywhere: unit.json's (what the app loads it by), the manifest's, character.json's and the package
        // folder's — a file put together from two characters, or renamed by hand, is refused
        guard let id = unit["id"] as? String, !id.isEmpty else { throw Failure.notAPackage("assets/unit.json 沒有 id") }
        var ids = [("assets/unit.json", id)]
        if let v = manifest?["id"] { ids.append(("manifest.json", "\(v)")) }
        if let v = character["id"] { ids.append(("character.json", "\(v)")) }
        ids.append(("資料夾", root.lastPathComponent))
        if Set(ids.map(\.1)).count > 1 {
            throw Failure.idMismatch(ids.map { "\($0.0) 是「\($0.1)」" }.joined(separator: "、"))
        }
        guard id.range(of: "^[a-z0-9][a-z0-9_-]{0,39}$", options: .regularExpression) != nil else {
            throw Failure.unsafe("角色代號「\(id)」只能用小寫英文、數字、- 和 _")
        }
        let kinds = manifest?["states"] as? [String: String] ?? stateKinds(of: root, id: id)
        let module = (manifest?["requires"] as? [String: Any])?["module"] as? String
            ?? (kinds.values.contains("module") ? id : nil)
        let builtIn = Bundle.main.resourceURL?.appendingPathComponent("characters/\(id)/assets/unit.json")
        return Inspection(
            id: id, name: (character["name"] ?? unit["name"] ?? manifest?["name"]) as? String ?? id,
            code: (character["code"] ?? unit["code"] ?? manifest?["code"]) as? String ?? "",
            states: kinds, requiresModule: module, moduleAvailable: module.map { PetNode.kits[$0] != nil } ?? true,
            hasSettings: fm.fileExists(atPath: root.appendingPathComponent("settings.json").path),
            replacesInstalled: fm.fileExists(atPath: userDir.appendingPathComponent(id).path),
            overridesBuiltIn: builtIn.map { fm.fileExists(atPath: $0.path) } ?? false, root: root)
    }

    /// Installs what `inspect` checked into the user's characters folder (`base`). A copy already installed under the
    /// same id is moved to characters/.replaced/ (not deleted); so are the user's settings for it when
    /// `applySettings` takes the file's settings.json in their place. Returns the installed folder.
    @discardableResult
    static func install(_ i: Inspection, applySettings: Bool, into base: URL = userDir) throws -> URL {
        let fm = FileManager.default
        let temp = i.root.deletingLastPathComponent()
        defer { try? fm.removeItem(at: temp) }
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        let stamp = DateFormatter.stamp.string(from: Date())
        let aside = base.appendingPathComponent(".replaced")
        let dest = base.appendingPathComponent(i.id)
        var old: URL?
        if fm.fileExists(atPath: dest.path) {
            try fm.createDirectory(at: aside, withIntermediateDirectories: true)
            let o = aside.appendingPathComponent("\(i.id)-\(stamp)")
            try fm.moveItem(at: dest, to: o)
            old = o
        }
        // the new one goes in whole or not at all: if it cannot, the old one goes back where it was
        do {
            do { try fm.moveItem(at: i.root, to: dest) } catch { try fm.copyItem(at: i.root, to: dest) }
        } catch {
            try? fm.removeItem(at: dest)
            if let o = old { try? fm.moveItem(at: o, to: dest) }
            throw error
        }
        pruneReplaced(aside, id: i.id)
        let shipped = dest.appendingPathComponent("settings.json")
        if fm.fileExists(atPath: shipped.path) {
            if applySettings {
                let mine = base.appendingPathComponent("\(i.id).json")
                if fm.fileExists(atPath: mine.path) {
                    try fm.createDirectory(at: aside, withIntermediateDirectories: true)
                    try fm.moveItem(at: mine, to: aside.appendingPathComponent("\(i.id)-\(stamp).json"))
                }
                try fm.moveItem(at: shipped, to: mine)
            } else {
                try fm.removeItem(at: shipped)
            }
        }
        return dest
    }

    /// Keeps the newest `keepReplaced` replaced copies of character `id` (folders and settings files each), removing
    /// older ones; each removal goes in the run log.
    static func pruneReplaced(_ aside: URL, id: String) {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: aside.path)) ?? []
        let mine = NSRegularExpression.escapedPattern(for: id)
        for suffix in ["", "\\.json"] {
            guard let re = try? NSRegularExpression(pattern: "^\(mine)-\\d{8}-\\d{6}\(suffix)$") else { continue }
            let copies = names.filter { re.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }.sorted()
            for name in copies.dropLast(keepReplaced) {
                try? fm.removeItem(at: aside.appendingPathComponent(name))
                RunLog.write(.package, "清掉較舊的角色備份 characters/.replaced/\(name)（每個角色只留最近 \(keepReplaced) 份）")
            }
        }
    }

    /// Restarts the app (once this one has quit), so a newly installed character is loaded.
    static func relaunch() {
        let app = Bundle.main.bundleURL.path
        let pid = ProcessInfo.processInfo.processIdentifier
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"$0\"", app]
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: with the user (for the menus)

    /// 匯出角色…: asks where to save character `id` and whether to put the user's settings in, then writes it in the
    /// background (a small window says it is working; the pets keep moving). Waits its turn behind any import or
    /// export under way.
    static func runExport(id: String) { enqueue { done in exportNow(id: id, done: done) } }

    private static func exportNow(id: String, done: @escaping () -> Void) {
        guard let pkg = UnitDef.packages()[id] else { alert(Failure.noSuchCharacter(id)); return done() }
        let character = read(pkg.appendingPathComponent("character.json")) ?? [:]
        let title = [character["name"] as? String, character["code"] as? String].compactMap { $0 }.joined(separator: " ")
        let panel = NSSavePanel()
        panel.title = "匯出角色"
        panel.nameFieldStringValue = "\(title.isEmpty ? id : title).\(fileExtension)"
        panel.allowedContentTypes = [contentType]
        let mine = NSButton(checkboxWithTitle: "一併匯出我在角色設定裡的調整（大小、遊走、演出）", target: nil, action: nil)
        mine.state = .on
        mine.isEnabled = FileManager.default.fileExists(atPath: userDir.appendingPathComponent("\(id).json").path)
        if !mine.isEnabled { mine.state = .off }
        panel.accessoryView = mine
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return done() }
        let withMine = mine.state == .on
        let shown = title.isEmpty ? id : title
        inBackground("正在匯出「\(shown)」…", { try export(id: id, to: url, includeSettings: withMine) }) { result in
            switch result {
            case .success:
                RunLog.write(.package, "匯出 \(id) → \(url.path)\(withMine ? "（含我的設定）" : "")")
                NSWorkspace.shared.activateFileViewerSelecting([url])
            case .failure(let error):
                alert(error)
            }
            done()
        }
    }

    /// 匯入角色…: picks a character file (or package folder), or takes `url` (a .gpet opened from Finder), checks it
    /// in the background, shows what it holds, installs it (also in the background) if the user agrees and offers to
    /// restart so it loads — or, when the file's settings were taken, restarts (they only hold from a fresh start).
    /// Several at once (files opened together, the menu chosen again) go one after another.
    static func runImport(_ url: URL? = nil) { enqueue { done in importNow(url, done: done) } }

    private static func importNow(_ url: URL?, done: @escaping () -> Void) {
        var src = url
        if src == nil {
            let panel = NSOpenPanel()
            panel.title = "匯入角色"
            panel.message = "選一個角色檔（.\(fileExtension) 或 .zip），或一個角色資料夾"
            panel.canChooseDirectories = true
            panel.allowedContentTypes = [contentType, .zip, .folder]
            NSApp.activate(ignoringOtherApps: true)
            guard panel.runModal() == .OK else { return done() }
            src = panel.url
        }
        guard let src else { return done() }
        inBackground("正在檢查「\(src.lastPathComponent)」…", { try inspect(src) }) { result in
            switch result {
            case .failure(let error):
                alert(error)
                done()
            case .success(let i):
                confirmImport(i, from: src, done: done)
            }
        }
    }

    /// The import's question (what it holds, install or not) and, if yes, the install and what follows.
    private static func confirmImport(_ i: Inspection, from src: URL, done: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = "匯入「\(i.name)」\(i.code.isEmpty ? "" : " \(i.code)")？"
        var lines: [String] = []
        let scripted = stateNames.filter { i.states[$0] == "script" }.compactMap { PetState(rawValue: $0)?.label }
        if !scripted.isEmpty { lines.append("用腳本演出：\(scripted.joined(separator: "、"))") }
        if let m = i.requiresModule {
            let native = stateNames.filter { i.states[$0] == "module" }.compactMap { PetState(rawValue: $0)?.label }
            lines.append(i.moduleAvailable
                ? "用程式內建的「\(m)」演出：\(native.joined(separator: "、"))"
                : "⚠️ 這個程式沒有「\(m)」的內建演出，\(native.joined(separator: "、")) 只會播放基本畫格")
        }
        if i.replacesInstalled { lines.append("已經裝過同一個角色：舊的會移到 characters/.replaced/ 保留（每個角色留最近 \(keepReplaced) 份）") }
        else if i.overridesBuiltIn { lines.append("程式內建同一個角色：裝好後以這份為準") }
        if i.hasSettings { lines.append("檔案裡附了匯出者的角色設定（大小、遊走、演出）。套用的話會取代你現在的設定（舊的一樣保留），並重新啟動。") }
        a.informativeText = lines.joined(separator: "\n")
        a.addButton(withTitle: "安裝")
        if i.hasSettings { a.addButton(withTitle: "安裝並套用檔案裡的設定") }
        a.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        let r = a.runModal()
        let cancel: NSApplication.ModalResponse = i.hasSettings ? .alertThirdButtonReturn : .alertSecondButtonReturn
        guard r != cancel else {
            try? FileManager.default.removeItem(at: i.root.deletingLastPathComponent())
            return done()
        }
        let settings = i.hasSettings && r == .alertSecondButtonReturn
        inBackground("正在安裝「\(i.name)」…", { try install(i, applySettings: settings) }) { result in
            if case .failure(let error) = result {
                alert(error)
                return done()
            }
            RunLog.write(.package, "匯入 \(i.name)（\(src.lastPathComponent)）\(i.replacesInstalled ? "，取代已安裝的版本" : "")"
                         + (settings ? "，套用檔案裡的設定" : ""))
            let waiting = jobs.isEmpty ? "" : "\n還有 \(jobs.count) 個角色檔在排隊，處理完再重新啟動。"
            let finished = NSAlert()
            finished.messageText = "「\(i.name)」已安裝"
            if settings {
                // the settings in memory would be saved over the file's at the next change in the panel: start afresh
                finished.informativeText = "要重新啟動才會用上檔案裡的設定。" + waiting
                finished.addButton(withTitle: jobs.isEmpty ? "重新啟動" : "好")
                finished.runModal()
                restart()
                return done()
            }
            finished.informativeText = "重新啟動後就會出現在角色清單裡。" + waiting
            finished.addButton(withTitle: jobs.isEmpty ? "現在重新啟動" : "排隊的處理完就重新啟動")
            finished.addButton(withTitle: "稍後")
            if finished.runModal() == .alertFirstButtonReturn { restart() }
            done()
        }
    }

    // MARK: one at a time

    /// Imports and exports run one at a time, each with its own dialogs: one asked for while another is under way
    /// (several .gpet files opened together, a menu chosen again) waits its turn. A restart one of them asks for waits
    /// until the last one is done. Main thread only.
    private static var jobs: [(@escaping () -> Void) -> Void] = []
    private static var running = false
    private static var restartWhenIdle = false

    /// Runs `job` now, or after the ones before it; it calls its `done` when it has finished (dialogs included).
    static func enqueue(_ job: @escaping (_ done: @escaping () -> Void) -> Void) {
        jobs.append(job)
        if running { RunLog.write(.package, "前一個角色檔還在處理，這個排在後面（共 \(jobs.count) 個在等）") }
        runNext()
    }

    private static func runNext() {
        guard !running else { return }
        guard !jobs.isEmpty else {
            if restartWhenIdle {
                restartWhenIdle = false
                relaunch()
            }
            return
        }
        running = true
        let job = jobs.removeFirst()
        job {
            running = false
            runNext()
        }
    }

    /// Restarts now, or (others waiting) once the last of them is done.
    private static func restart() {
        restartWhenIdle = true
    }

    /// Does `work` off the main thread while a small window says what is going on, then hands the result back on the
    /// main thread.
    private static func inBackground<T>(_ what: String, _ work: @escaping () throws -> T,
                                        then finish: @escaping (Result<T, Error>) -> Void) {
        let progress = ProgressWindow(what)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try work() }
            DispatchQueue.main.async {
                progress.close()
                finish(result)
            }
        }
    }

    private static func alert(_ error: Error) {
        RunLog.write(.error, "角色檔處理失敗：\(error.localizedDescription)")
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "角色檔處理失敗"
        a.informativeText = error.localizedDescription
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    // MARK: helpers

    /// Unpacks a zipped character file into a fresh temporary folder, after checking its entries; returns its one top
    /// folder (macOS's __MACOSX leftovers aside). What ditto actually wrote is checked again on disk (verifyTree): the
    /// listing is what the zip says about itself, the disk is what it holds.
    private static func unpack(_ zip: URL) throws -> URL {
        guard let list = try? run("/usr/bin/zipinfo", ["-1", zip.path], capture: true) else {
            throw Failure.notAPackage("不是 zip 壓縮檔")
        }
        let names = list.split(separator: "\n").map(String.init)
        guard !names.isEmpty else { throw Failure.notAPackage("不是 zip 壓縮檔，或裡面是空的") }
        guard names.count <= maxFiles else { throw Failure.unsafe("檔案太多（\(names.count) 個，最多 \(maxFiles) 個）") }
        for n in names where n.hasPrefix("/") || n.split(separator: "/").contains("..") {
            throw Failure.unsafe("路徑 \(n)")
        }
        // the long listing: a link entry ("l" in front of its permissions) is refused before anything is unpacked
        let long = (try? run("/usr/bin/zipinfo", [zip.path], capture: true)) ?? ""
        if let link = long.split(separator: "\n").first(where: { $0.hasPrefix("l") }) {
            throw Failure.unsafe("捷徑檔 \(link.split(separator: " ").last ?? "")")
        }
        // a zip bomb never gets unpacked, by what it says it holds (and, after, by what it really wrote)
        let totals = try run("/usr/bin/zipinfo", ["-t", zip.path], capture: true)
        if let r = totals.range(of: #"(\d+) bytes uncompressed"#, options: .regularExpression),
           let bytes = Int(totals[r].split(separator: " ")[0]), bytes > maxBytes {
            throw Failure.unsafe("解壓後太大（超過 \(maxBytes / 1_000_000) MB）")
        }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("gpet-\(UUID().uuidString)")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try run("/usr/bin/ditto", ["-x", "-k", zip.path, dir.path])
            try? fm.removeItem(at: dir.appendingPathComponent("__MACOSX"))
            try verifyTree(dir)
            let tops = ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
                .filter { !$0.lastPathComponent.hasPrefix(".") }
            if tops.count == 1, (try? tops[0].resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                return tops[0]
            }
            // zipped from inside the folder (no top folder): use the unpacked folder itself
            if fm.fileExists(atPath: dir.appendingPathComponent("assets/unit.json").path) {
                let named = dir.deletingLastPathComponent().appendingPathComponent("gpet-\(UUID().uuidString)")
                // no folder of its own to name it: it takes its id (checked against the others later)
                let id = read(dir.appendingPathComponent("assets/unit.json"))?["id"] as? String
                let top = named.appendingPathComponent(id ?? zip.deletingPathExtension().lastPathComponent)
                try fm.createDirectory(at: named, withIntermediateDirectories: true)
                do { try fm.moveItem(at: dir, to: top) } catch { try? fm.removeItem(at: named); throw error }
                return top
            }
            throw Failure.notAPackage("壓縮檔裡要有一個角色資料夾")
        } catch {
            try? fm.removeItem(at: dir)
            throw error
        }
    }

    /// What is really on disk under `dir`: plain files and folders only (no links, devices or pipes), all inside it,
    /// at most maxFiles files and maxBytes in all.
    private static func verifyTree(_ dir: URL) throws {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]
        let inside = dir.resolvingSymlinksInPath().path + "/"
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: Array(keys)) else { return }
        var count = 0, bytes = 0
        for case let f as URL in e {
            let v = try? f.resourceValues(forKeys: keys)
            if v?.isSymbolicLink == true { throw Failure.unsafe("捷徑檔 \(f.lastPathComponent)") }
            guard v?.isRegularFile == true || v?.isDirectory == true else { throw Failure.unsafe("不是一般檔案：\(f.lastPathComponent)") }
            guard f.resolvingSymlinksInPath().path.hasPrefix(inside) else { throw Failure.unsafe("路徑跑出解壓資料夾：\(f.path)") }
            if v?.isRegularFile == true {
                count += 1
                bytes += v?.fileSize ?? 0
                if count > maxFiles { throw Failure.unsafe("檔案太多（超過 \(maxFiles) 個）") }
                if bytes > maxBytes { throw Failure.unsafe("解壓後太大（超過 \(maxBytes / 1_000_000) MB）") }
            }
        }
    }

    /// A package folder's size before it is copied: refused when it is more than a character can be.
    private static func measure(_ dir: URL) throws {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey]
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: Array(keys)) else { return }
        var count = 0, bytes = 0
        for case let f as URL in e {
            guard let v = try? f.resourceValues(forKeys: keys), v.isRegularFile == true else { continue }
            count += 1
            bytes += v.fileSize ?? 0
            if count > maxFiles || bytes > maxBytes {
                throw Failure.unsafe("這個資料夾太大，不像一個角色（最多 \(maxFiles) 個檔、\(maxBytes / 1_000_000) MB）")
            }
        }
    }

    /// Strings in unit.json that name a file outside the package (absolute, or with a .. in the path).
    private static func outsidePaths(_ v: Any) -> [String] {
        if let s = v as? String {
            let looksLikePath = s.contains("/") || s.lowercased().hasSuffix(".png")
            return looksLikePath && (s.hasPrefix("/") || s.hasPrefix("~") || s.split(separator: "/").contains("..")) ? [s] : []
        }
        if let a = v as? [Any] { return a.flatMap(outsidePaths) }
        if let o = v as? [String: Any] { return o.values.flatMap(outsidePaths) }
        return []
    }

    /// Every file under `dir` (links included when asked, so they can be refused).
    private static func files(under dir: URL, withLinks: Bool = false) -> [URL] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey]
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: keys) else { return [] }
        return e.compactMap { $0 as? URL }.filter { f in
            let v = try? f.resourceValues(forKeys: Set(keys))
            return v?.isRegularFile == true || (withLinks && v?.isSymbolicLink == true)
        }
    }

    private static func read(_ url: URL) -> [String: Any]? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    private static func write(_ o: [String: Any], to url: URL) throws {
        try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]).write(to: url)
    }

    /// Runs a tool and returns what it printed. Its output and error streams are read at the same time (reading one
    /// to its end first would hang both sides once the other fills its pipe, e.g. ditto on a zip with thousands of
    /// broken entries), and it is stopped after `limit` seconds.
    @discardableResult
    static func run(_ tool: String, _ args: [String], capture: Bool = false, limit: Double = 120) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        try p.run()
        var errData = Data()
        let reading = DispatchGroup()
        reading.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            reading.leave()
        }
        let stop = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + limit, execute: stop)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        reading.wait()
        p.waitUntilExit()
        stop.cancel()
        guard p.terminationReason == .exit else { throw Failure.tool("\(tool) 超過 \(Int(limit)) 秒沒有結束，已停止") }
        guard p.terminationStatus == 0 else {
            let msg = String(decoding: errData.prefix(2000), as: UTF8.self)
            throw Failure.tool(msg.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return capture ? String(decoding: data, as: UTF8.self) : ""
    }
}

private extension DateFormatter {
    static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()
}

/// A small floating window saying what a long job is doing (a spinner and one line), shown while it runs off the
/// main thread; it cannot be closed by hand.
final class ProgressWindow {
    private let panel: NSPanel

    init(_ text: String) {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 64), styleMask: [.titled, .utilityWindow],
                        backing: .buffered, defer: false)
        panel.title = "鋼彈桌寵"
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        let spinner = NSProgressIndicator(frame: NSRect(x: 18, y: 22, width: 20, height: 20))
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: 48, y: 22, width: 258, height: 20)
        label.lineBreakMode = .byTruncatingMiddle
        panel.contentView?.addSubview(spinner)
        panel.contentView?.addSubview(label)
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
    }

    func close() { panel.orderOut(nil) }
}
