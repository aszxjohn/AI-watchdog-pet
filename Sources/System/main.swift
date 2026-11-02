import AppKit

/// `--demo`: eight fake sessions, one per state, rotating every 10 seconds, for checking every
/// animation side by side (and the pool rule, since there are more sessions than Gundams).
final class Demo {
    private let stage: Stage
    private let start = Date()
    private var timer: Timer?
    private let states: [PetState] = [.working, .thinking, .permission, .question, .done, .waiting, .sleeping, .error]

    init(stage: Stage) { self.stage = stage }

    func run() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.step() }
        step()
    }

    private func step() {
        let k = Int(Date().timeIntervalSince(start) / 10)
        let sessions = (0..<states.count).map { i in
            SessionInfo(id: "demo-\(i)", title: "示範 session \(i + 1)", state: states[(i + k) % states.count],
                        toolErrorAt: nil, firstSeen: Date(timeIntervalSince1970: Double(i)))
        }
        stage.apply(sessions)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var stage: Stage!
    private var watcher: SessionWatcher?
    private var panel: CharacterPanel?
    private var sessionPanel: SessionPanel?
    /// Which sessions have a Gundam (released ones, ones picked by hand).
    private var picks: SessionPicks!
    private var demo: Demo?
    private var statusItem: NSStatusItem?
    /// The watcher's latest sessions, kept while showcase mode hides them.
    private var latest: [SessionInfo] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // --offscreen runs are headless captures: they may run next to the real one and add no menu bar item.
        let offscreen = CommandLine.arguments.contains("--offscreen")
        let me = NSRunningApplication.current
        // (only another real one counts: --offscreen captures run as accessory apps and may come and go)
        if !offscreen, let bid = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bid)
               .contains(where: { $0 != me && $0.activationPolicy == .regular }) {
            NSApp.terminate(nil)
            return
        }

        let config = Config.load()
        let demoMode = CommandLine.arguments.contains("--demo")
        // Every character package found (the app's own and the user's): its assets, character file and scripts.
        let packages = UnitDef.packages()
        let units = UnitDef.loadPackages(packages)
        // No characters is fine: the stage runs empty (sessions are still followed, the menus and windows work);
        // there is just nobody to act them out.
        if units.isEmpty {
            NSLog("GundamPet: no character packages found")
            RunLog.write(.error, "找不到任何角色包（舞台照常執行，只是沒有角色）")
        }
        // Each character's size and wandering: its character file, with the settings panel's changes over it.
        let characters = CharacterStore(packages: packages.filter { id, _ in units.contains { $0.id == id } })
        stage = Stage(units: units, pool: Pool(unitIds: units.map(\.id), persist: !demoMode && !offscreen),
                      config: config, characters: characters, offscreen: offscreen)
        characters.onChange = { [weak self] id in
            self?.stage.characterChanged(id)
            self?.logSettingsChange(id)
        }
        picks = SessionPicks(persist: !demoMode && !offscreen)
        stage.onManageSessions = { [weak self] sid in self?.openSessions(for: sid) }
        stage.onAdjust = { [weak self] uid, st in self?.openSettings(unit: uid, state: st) }

        if demoMode {
            let d = Demo(stage: stage)
            d.run()
            demo = d
        } else {
            let w = SessionWatcher(config: config)
            w.onUpdate = { [weak self] sessions in
                self?.logSessions(sessions)
                self?.latest = sessions
                self?.refreshSessions()
            }
            // 鎖定展示 and the sessions picked by hand take effect before the first scan
            if picks.lockOn { w.watchOnly(Set(picks.lockedIds)) }
            w.alwaysWatch(Set(picks.pinnedIds + picks.lockedIds))
            w.start()
            watcher = w
        }

        // --menus-dump <path>: writes the menus as text (the app menu, a Gundam's right-click menu, then the showcase
        // one) and quits (headless check).
        if let i = CommandLine.arguments.firstIndex(of: "--menus-dump"),
           let path = CommandLine.arguments.dropFirst(i + 1).first {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                func app(_ place: Menus.Place) -> String {
                    let m = NSMenu()
                    Menus.fill(m, Menus.appItems(self.appMenuState, for: place))
                    return Menus.dump(m)
                }
                var out = "【選單列圖示】\n" + app(.statusBar) + "\n\n【App 選單】\n" + app(.appMenu)
                out += "\n\n【Dock】\n" + app(.dock)
                out += "\n\n【右鍵・一般模式】\n" + (self.stage.someMenu().map { Menus.dump($0) } ?? "（畫面上沒有鋼彈）")
                self.setShowcase(true)
                out += "\n\n【右鍵・展示模式】\n" + (self.stage.someMenu().map { Menus.dump($0) } ?? "（沒有展示的鋼彈）")
                try? out.write(toFile: path, atomically: true, encoding: .utf8)
                NSApp.terminate(nil)
            }
            return
        }

        // --sessions-snapshot <path>: draws the 管理 session window (real sessions) into a PNG and quits.
        if let i = CommandLine.arguments.firstIndex(of: "--sessions-snapshot"),
           let path = CommandLine.arguments.dropFirst(i + 1).first {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                self.openSessions(for: self.stage.shownSessions.keys.sorted().first, show: false)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.sessionPanel?.snapshot(to: URL(fileURLWithPath: path))
                    NSApp.terminate(nil)
                }
            }
            return
        }

        // --panel-snapshot <path>: draws the 角色設定 panel into a PNG and quits (headless check; with --showcase, as it
        // looks while previewing).
        if let i = CommandLine.arguments.firstIndex(of: "--panel-snapshot"),
           let path = CommandLine.arguments.dropFirst(i + 1).first {
            presentSettings(show: false)
            if CommandLine.arguments.contains("--showcase") { panel?.setPreviewing(true) }
            if let j = CommandLine.arguments.firstIndex(of: "--panel-state"),
               let st = CommandLine.arguments.dropFirst(j + 1).first.flatMap(PetState.init(rawValue:)) {
                panel?.select(st)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.panel?.snapshot(to: URL(fileURLWithPath: path))
                NSApp.terminate(nil)
            }
            return
        }

        if let i = CommandLine.arguments.firstIndex(of: "--snap-burst") {
            let count = CommandLine.arguments.dropFirst(i + 1).first.flatMap { Int($0) } ?? 24
            snapBurst(count: count)
        }

        if !offscreen {
            setUpStatusItem()
            setUpMainMenu()
        }
        // A Gundam's right-click menu switches between normal and showcase (debug) mode.
        stage.onPickMode = { [weak self] on in self?.setShowcase(on) }
        if CommandLine.arguments.contains("--showcase") {
            if offscreen { stage.enterShowcase(state: showcaseStart) } else { setShowcase(true) }
            // --showcase-then <state>@<seconds>,…: switch states on a schedule, as if picked from the right-click menu
            // (for checking state-to-state switches in offscreen captures).
            let args = CommandLine.arguments
            if let i = args.firstIndex(of: "--showcase-then"), let list = args.dropFirst(i + 1).first {
                for step in list.split(separator: ",") {
                    let kv = step.split(separator: "@")
                    guard kv.count == 2, let st = PetState(rawValue: String(kv[0])), let at = Double(kv[1]) else { continue }
                    DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in self?.stage.forceShowcase(st) }
                }
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.stage.layoutWindow()
        }
        let built = (try? Bundle.main.executableURL?.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate.map { DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .short) }
        RunLog.write(.app, "啟動：編譯於 \(built ?? "?")；角色 \(units.count) 個（\(units.map(\.id).sorted().joined(separator: "、"))）；"
                     + "\(stage.isShowcase ? "展示" : "一般")模式；螢幕 \(config.screen.isEmpty ? "主螢幕" : config.screen)；"
                     + "鎖定展示\(picks.lockOn ? "開（\(picks.lockedIds.count) 個 session）" : "關")")
    }

    func applicationWillTerminate(_ notification: Notification) {
        RunLog.write(.app, "結束")
        RunLog.flush()
    }

    /// Writes what changed in the watcher's list to the run log: sessions that came, went or changed state.
    private func logSessions(_ sessions: [SessionInfo]) {
        let before = Dictionary(latest.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for s in sessions {
            if let b = before[s.id] {
                if b.state != s.state {
                    RunLog.write(.session, "\(RunLog.name(s.id, s.title))：\(b.state.label) → \(s.state.label)")
                }
            } else {
                RunLog.write(.session, "出現：\(RunLog.name(s.id, s.title))，\(s.state.label)")
            }
        }
        let now = Set(sessions.map(\.id))
        for b in latest where !now.contains(b.id) { RunLog.write(.session, "離開清單：\(RunLog.name(b.id, b.title))") }
    }

    /// When each character's settings were last logged: a slider being dragged changes them many times a second, so
    /// one line per character per 10 seconds.
    private var settingsLogged: [String: Date] = [:]

    private func logSettingsChange(_ id: String) {
        let now = Date()
        if let last = settingsLogged[id], now.timeIntervalSince(last) < 10 { return }
        settingsLogged[id] = now
        RunLog.write(.settings, "角色設定變更：\(id)")
    }

    /// `--snap-burst N [--snap-delay S]`: S seconds after launch (default 3.5, i.e. after the entrance),
    /// saves N snapshots 0.1 s apart to logs/burst/ and quits.
    /// Lets the animation be checked frame by frame without screen-recording permission.
    private func snapBurst(count: Int) {
        let dir = Config.dir.appendingPathComponent("logs/burst")
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var n = 0
        let args = CommandLine.arguments
        let delay = args.firstIndex(of: "--snap-delay").flatMap { args.dropFirst($0 + 1).first }.flatMap(Double.init) ?? 3.5
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { t in
                self?.stage.snapshot(to: dir.appendingPathComponent(String(format: "%03d.png", n)))
                n += 1
                if n >= count {
                    t.invalidate()
                    NSApp.terminate(nil)
                }
            }
        }
    }

    /// The menu bar icon: the app's own, small.
    private static var menuIcon: NSImage {
        let img = (NSApp.applicationIconImage.copy() as? NSImage) ?? NSImage()
        img.size = NSSize(width: 18, height: 18)
        return img
    }

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = Self.menuIcon
        item.button?.imagePosition = .imageLeft
        item.button?.title = picks.lockOn ? " 鎖" : ""
        let menu = NSMenu()
        Menus.fill(menu, Menus.appItems(appMenuState, for: .statusBar))
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    /// e.g. 「2 隻鋼彈・一般模式・鎖定展示關」, or 「目前沒有進行中的 session」.
    private var statusLine: String {
        if stage.isShowcase { return "展示模式（預覽中）" }
        let pets = stage.shownSessions.count
        let lock = "鎖定展示\(picks.lockOn ? "開（\(picks.lockedIds.count) 個）" : "關")"
        if pets == 0 { return latest.isEmpty ? "目前沒有進行中的 session・\(lock)" : "0 隻鋼彈・一般模式・\(lock)" }
        return "\(pets) 隻鋼彈・一般模式・\(lock)\(stage.isVisible ? "" : "・已隱藏")"
    }

    /// What the app menus show and do (Menus.appItems), read fresh each time one opens.
    private var appMenuState: Menus.App {
        Menus.App(visible: stage.isVisible, labels: stage.showLabels, showcase: stage.isShowcase, lockOn: picks.lockOn,
                  status: statusLine,
                  toggleVisible: { [weak self] in self?.toggleVisible() },
                  toggleLabels: { [weak self] in
                      guard let self else { return }
                      self.stage.showLabels.toggle()
                      RunLog.write(.mode, "顯示名牌：\(self.stage.showLabels ? "開" : "關")")
                  },
                  openSettings: { [weak self] in self?.openSettings() },
                  characters: stage.unitList.map(stage.label(of:)),
                  importCharacter: { CharacterPackage.runImport() },
                  exportCharacter: { CharacterPackage.runExport(id: $0) },
                  openSessions: { [weak self] in self?.openSessions(for: nil) },
                  toggleLock: { [weak self] in self?.toggleLock() },
                  toggleShowcase: { [weak self] in
                      guard let self else { return }
                      self.setShowcase(!self.stage.isShowcase)
                  },
                  screens: { [weak self] in NSScreen.screens.count > 1 ? self?.stage.screenMenu() : nil },
                  openFolder: { NSWorkspace.shared.open(Config.dir) },
                  quit: { NSApp.terminate(nil) })
    }

    /// The menu bar icon's menu and the app menu are rebuilt each time they open, so what they tick (and the screens
    /// under "顯示在") is current.
    func menuNeedsUpdate(_ menu: NSMenu) {
        Menus.fill(menu, Menus.appItems(appMenuState, for: menu === statusItem?.menu ? .statusBar : .appMenu))
    }

    private func toggleVisible() {
        stage.isVisible.toggle()
        RunLog.write(.mode, "顯示寵物：\(stage.isVisible ? "開" : "關")")
    }

    /// The app menu (the app shows in the Dock, so it gets a menu bar of its own while it is in front): the same
    /// items as the menu bar icon's.
    private func setUpMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "鋼彈桌寵")
        Menus.fill(appMenu, Menus.appItems(appMenuState, for: .appMenu))
        appMenu.delegate = self
        appItem.submenu = appMenu
        main.addItem(appItem)
        // the standard editing commands (so ⌘C／⌘V／⌘A work in the windows' text fields) and ⌘W
        let edit = NSMenu(title: "編輯")
        edit.addItem(NSMenuItem(title: "還原", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "剪下", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "拷貝", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "貼上", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "全選", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        let window = NSMenu(title: "視窗")
        window.addItem(NSMenuItem(title: "關閉視窗", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        for m in [edit, window] {
            let item = NSMenuItem()
            item.submenu = m
            main.addItem(item)
        }
        NSApp.mainMenu = main
    }

    /// Right-clicking the Dock icon: the same items (the Dock adds its own 結束).
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        Menus.fill(menu, Menus.appItems(appMenuState, for: .dock))
        return menu
    }

    /// A character file opened from Finder (double-clicking a .gpet, or dropping one on the Dock icon): 匯入角色.
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls where ["gpet", "zip"].contains(u.pathExtension.lowercased()) { CharacterPackage.runImport(u) }
    }

    /// Clicking the Dock icon brings the Gundams back if they were hidden.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !stage.isVisible { toggleVisible() }
        return false
    }

    /// --showcase-state <thinking|working|…>: the state showcase mode starts in.
    private var showcaseStart: PetState {
        let args = CommandLine.arguments
        return args.firstIndex(of: "--showcase-state").flatMap { args.dropFirst($0 + 1).first }
            .flatMap(PetState.init(rawValue:)) ?? .waiting
    }

    private func setShowcase(_ on: Bool) {
        if on == stage.isShowcase { return }
        if on {
            stage.enterShowcase(state: showcaseStart)
        } else {
            stage.exitShowcase()
            refreshSessions()
        }
        panel?.setPreviewing(on)
        RunLog.write(.mode, on ? "切到展示模式" : "回到一般模式")
    }

    /// Hands the watcher's sessions to the stage: all of them for the right-click menu, the ones with a Gundam to show.
    private func refreshSessions() {
        stage.sessionList = latest
        stage.apply(picks.visible(latest))
        refreshSessionPanel()
        // the sessions picked by hand stay listed however old they get (until released)
        watcher?.alwaysWatch(Set(picks.pinnedIds + picks.lockedIds))
    }

    /// The 管理 session window; `sid`: the session of the Gundam it was opened from (its rows get 「給這隻監控」).
    private func openSessions(for sid: String?, show: Bool = true) {
        if sessionPanel == nil {
            sessionPanel = SessionPanel(actions: .init(
                release: { [weak self] id in
                    self?.picks.release(id)
                    self?.refreshSessions()
                },
                recall: { [weak self] id in
                    self?.picks.pin(id)
                    self?.refreshSessions()
                },
                monitor: { [weak self] old, new in
                    guard let self else { return }
                    // a session that already has a Gundam: nothing changes (the old one is not released either);
                    // the window hides the button on such rows, so this is only a safeguard
                    guard self.stage.shownSessions[new] == nil else {
                        RunLog.write(.pet, "換監控取消：\(RunLog.name(new, self.latest.first { $0.id == new }?.title ?? ""))已經有鋼彈")
                        return
                    }
                    self.picks.release(old)
                    self.picks.pin(new)
                    self.stage.retarget(from: old, to: new)
                    self.sessionPanel?.model.petSession = new
                    self.refreshSessions()
                },
                releaseAll: { [weak self] in
                    guard let self else { return }
                    for s in self.picks.visible(self.latest) { self.picks.release(s.id) }
                    self.refreshSessions()
                },
                setLocked: { [weak self] id, on in
                    self?.picks.setLocked(id, on)
                    self?.applyLock()
                },
                setLockOn: { [weak self] on in
                    self?.picks.setLockOn(on)
                    self?.applyLock()
                }))
        }
        let model = sessionPanel!.model
        model.petSession = sid
        if let sid { model.petName = stage.shownSessions[sid] ?? "" }
        refreshSessionPanel()
        if show { sessionPanel?.show() }
    }

    private func refreshSessionPanel() {
        guard let p = sessionPanel else { return }
        p.model.update(sessions: latest, shown: stage.shownSessions, released: { [weak self] in
            self?.picks.isReleased($0) ?? false
        }, locked: { [weak self] in self?.picks.isLocked($0) ?? false }, lockOn: picks.lockOn,
           lockedCount: picks.lockedIds.count)
    }

    /// 鎖定展示 on: the watcher reads only the ticked sessions; off: all recent ones again. Also the menu bar title.
    private func applyLock() {
        watcher?.watchOnly(picks.lockOn ? Set(picks.lockedIds) : nil)
        statusItem?.button?.title = picks.lockOn ? " 鎖" : ""
        refreshSessions()
        RunLog.write(.mode, "鎖定展示：\(picks.lockOn ? "開（\(picks.lockedIds.count) 個 session）" : "關")")
    }

    /// The menus' 鎖定展示 switch: turns it on or off (with nothing ticked yet, opens the window to tick some).
    @objc private func toggleLock() {
        if picks.lockedIds.isEmpty {
            openSessions(for: nil)
            return
        }
        picks.setLockOn(!picks.lockOn)
        applyLock()
    }

    /// The character settings panel (size, and each state's wandering).
    private func openSettings() { presentSettings(show: true) }

    /// …opened on one character and state (a Gundam's 「調整這隻…」).
    private func openSettings(unit: String, state: PetState) {
        presentSettings(show: false)
        panel?.select(unit: unit, state: state)
        panel?.show()
    }

    private func presentSettings(show: Bool) {
        if panel == nil {
            panel = CharacterPanel(store: stage.characters, units: stage.unitList, problems: UnitDef.loadProblems,
                                   stageSize: { [weak self] in
                self?.stage.window.frame.size ?? CGSize(width: 1920, height: 1000)
            }, floor: { [weak self] in self?.stage.floorY ?? 34 },
               preview: { [weak self] st, uid in self?.stage.preview(st, unit: uid) },
               endPreview: { [weak self] in self?.setShowcase(false) })
            panel?.setPreviewing(stage.isShowcase)
        }
        if show { panel?.show() }
    }

}

CharacterModules.registerAll()
let app = NSApplication.shared
// In the Dock with its icon (10/30); --offscreen captures stay out of it.
app.setActivationPolicy(CommandLine.arguments.contains("--offscreen") ? .accessory : .regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
