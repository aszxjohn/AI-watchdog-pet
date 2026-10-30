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
    private var demo: Demo?
    private var statusItem: NSStatusItem!
    private var labelsItem: NSMenuItem!
    private var visibleItem: NSMenuItem!
    private var normalItem: NSMenuItem!
    private var showcaseItem: NSMenuItem!
    private var screenItem: NSMenuItem?
    /// The watcher's latest sessions, kept while showcase mode hides them.
    private var latest: [SessionInfo] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // --offscreen runs are headless captures: they may run next to the real one and add no menu bar item.
        let offscreen = CommandLine.arguments.contains("--offscreen")
        let me = NSRunningApplication.current
        if !offscreen, let bid = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bid).contains(where: { $0 != me }) {
            NSApp.terminate(nil)
            return
        }

        let config = Config.load()
        let demoMode = CommandLine.arguments.contains("--demo")
        let unitsDir = Bundle.main.resourceURL!.appendingPathComponent("units")
        let units = UnitDef.loadAll(from: unitsDir)
        if units.isEmpty {
            let alert = NSAlert()
            alert.messageText = "找不到任何鋼彈素材"
            alert.informativeText = unitsDir.path
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        // Each character's size and wandering: its character file, with the settings panel's changes over it.
        let characters = CharacterStore(ids: units.map(\.id))
        stage = Stage(units: units, pool: Pool(unitIds: units.map(\.id), persist: !demoMode && !offscreen),
                      config: config, characters: characters, offscreen: offscreen)
        characters.onChange = { [weak self] id in self?.stage.characterChanged(id) }
        stage.onOpenSettings = { [weak self] in self?.openSettings() }

        if demoMode {
            let d = Demo(stage: stage)
            d.run()
            demo = d
        } else {
            let w = SessionWatcher(config: config)
            w.onUpdate = { [weak self] sessions in
                self?.latest = sessions
                self?.stage.apply(sessions)
            }
            w.start()
            watcher = w
        }

        // --panel-snapshot <path>: draws the 角色設定 panel into a PNG and quits (headless check).
        if let i = CommandLine.arguments.firstIndex(of: "--panel-snapshot"),
           let path = CommandLine.arguments.dropFirst(i + 1).first {
            presentSettings(show: false)
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

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "GN"
        let menu = NSMenu()
        let header = NSMenuItem(title: "鋼彈桌寵", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        visibleItem = NSMenuItem(title: "顯示鋼彈", action: #selector(toggleVisible), keyEquivalent: "")
        visibleItem.state = .on
        labelsItem = NSMenuItem(title: "顯示名牌", action: #selector(toggleLabels), keyEquivalent: "")
        labelsItem.state = stage.showLabels ? .on : .off
        normalItem = NSMenuItem(title: "一般模式", action: #selector(pickNormal), keyEquivalent: "")
        showcaseItem = NSMenuItem(title: "展示模式（Debug，單獨一隻、右鍵切狀態）", action: #selector(pickShowcase),
                                  keyEquivalent: "")
        let settings = NSMenuItem(title: "角色設定…", action: #selector(openSettings), keyEquivalent: ",")
        let folder = NSMenuItem(title: "打開設定資料夾", action: #selector(openFolder), keyEquivalent: "")
        let quit = NSMenuItem(title: "結束", action: #selector(quit), keyEquivalent: "q")
        for item in [visibleItem!, labelsItem!, normalItem!, showcaseItem!, settings, folder, quit] {
            item.target = self
            if item === normalItem || item === settings || item === quit { menu.addItem(.separator()) }
            menu.addItem(item)
        }
        refreshModeItems()
        menu.delegate = self
        statusItem.menu = menu
    }

    /// Rebuilds "顯示在" each time the menu opens, so it lists the screens connected right now.
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu !== statusItem?.menu {
            // the app menu: tick the current mode
            for item in menu.items where item.title.hasSuffix("模式") || item.title.hasPrefix("展示模式") {
                item.state = (item.title == "一般模式") != stage.isShowcase ? .on : .off
            }
            return
        }
        if let old = screenItem { menu.removeItem(old) }
        screenItem = nil
        guard NSScreen.screens.count > 1, let at = menu.items.firstIndex(where: { $0 === showcaseItem }) else { return }
        let item = stage.screenMenu()
        menu.insertItem(item, at: at + 1)
        screenItem = item
    }

    @objc private func toggleVisible() {
        stage.isVisible.toggle()
        visibleItem?.state = stage.isVisible ? .on : .off
    }

    @objc private func toggleLabels() {
        stage.showLabels.toggle()
        labelsItem?.state = stage.showLabels ? .on : .off
    }

    @objc private func pickNormal() { setShowcase(false) }

    @objc private func pickShowcase() { setShowcase(true) }

    /// The app menu (the app shows in the Dock, so it gets a menu bar of its own while it is in front): the mode
    /// switch and 結束.
    private func setUpMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "鋼彈桌寵")
        appMenu.addItem(MenuAction.item("一般模式") { [weak self] in self?.setShowcase(false) })
        appMenu.addItem(MenuAction.item("展示模式（Debug）") { [weak self] in self?.setShowcase(true) })
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "角色設定…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        let quit = NSMenuItem(title: "結束鋼彈桌寵", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        appMenu.delegate = self
        appItem.submenu = appMenu
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    /// Right-clicking the Dock icon: the mode switch, show / hide, name tags.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let normal = MenuAction.item("一般模式") { [weak self] in self?.setShowcase(false) }
        normal.state = stage.isShowcase ? .off : .on
        let showcase = MenuAction.item("展示模式（Debug）") { [weak self] in self?.setShowcase(true) }
        showcase.state = stage.isShowcase ? .on : .off
        let visible = MenuAction.item("顯示鋼彈") { [weak self] in self?.toggleVisible() }
        visible.state = stage.isVisible ? .on : .off
        let labels = MenuAction.item("顯示名牌") { [weak self] in self?.toggleLabels() }
        labels.state = stage.showLabels ? .on : .off
        let settings = MenuAction.item("角色設定…") { [weak self] in self?.openSettings() }
        for item in [normal, showcase, NSMenuItem.separator(), visible, labels, NSMenuItem.separator(), settings] {
            menu.addItem(item)
        }
        return menu
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
            stage.apply(latest)
        }
        refreshModeItems()
    }

    private func refreshModeItems() {
        normalItem?.state = stage.isShowcase ? .off : .on
        showcaseItem?.state = stage.isShowcase ? .on : .off
    }

    /// The character settings panel (size, and each state's wandering).
    @objc private func openSettings() { presentSettings(show: true) }

    private func presentSettings(show: Bool) {
        if panel == nil {
            panel = CharacterPanel(store: stage.characters, units: stage.unitList, stageSize: { [weak self] in
                self?.stage.window.frame.size ?? CGSize(width: 1920, height: 1000)
            }, floor: { [weak self] in self?.stage.floorY ?? 34 }, preview: { [weak self] st in self?.stage.preview(st) })
        }
        if show { panel?.show() }
    }

    @objc private func openFolder() {
        NSWorkspace.shared.open(Config.dir)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
// In the Dock with its icon (10/30); --offscreen captures stay out of it.
app.setActivationPolicy(CommandLine.arguments.contains("--offscreen") ? .accessory : .regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
