import AppKit

/// The app's menus (10/30 redo, for getting to things fast): the menu bar icon, the app menu and the Dock share one
/// list of items, so they read the same everywhere; the showcase Gundam's menu picks a character by its tags.
enum Menus {
    /// What the app menus show and do.
    struct App {
        var visible: Bool
        var labels: Bool
        var showcase: Bool
        var lockOn: Bool
        /// How things are right now, in a few words (the menu bar icon's menu shows it at the top).
        var status: String
        var toggleVisible: () -> Void
        var toggleLabels: () -> Void
        var openSettings: () -> Void
        /// The characters loaded (for 匯出角色), and the character file actions (CharacterPackage).
        var characters: [CharacterLabel]
        var importCharacter: () -> Void
        var exportCharacter: (String) -> Void
        var openSessions: () -> Void
        var toggleLock: () -> Void
        var toggleShowcase: () -> Void
        /// "顯示在" (only with more than one screen).
        var screens: () -> NSMenuItem?
        var openFolder: () -> Void
        var quit: () -> Void
    }

    enum Place { case statusBar, appMenu, dock }

    /// Top to bottom: what is shown, the characters (settings, character files), the sessions, the mode, then the
    /// folder and quitting (the Dock has its own 結束).
    static func appItems(_ a: App, for place: Place) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        if place == .statusBar { items += [header("鋼彈桌寵"), header(a.status), .separator()] }
        items += [checked("顯示寵物", a.visible, a.toggleVisible), checked("顯示名牌", a.labels, a.toggleLabels), .separator()]
        let settings = MenuAction.item("角色設定…", a.openSettings)
        if place != .dock { settings.keyEquivalent = "," }
        items += [settings, MenuAction.item("匯入角色…", a.importCharacter)]
        if let export = exportItem(a.characters, a.exportCharacter) { items.append(export) }
        items += [.separator(), MenuAction.item("管理 session…", a.openSessions),
                  checked("鎖定展示（只顯示勾選的 session）", a.lockOn, a.toggleLock), .separator()]
        items.append(MenuAction.item(a.showcase ? "回到一般模式" : "切到展示模式（Debug）", a.toggleShowcase))
        if let s = a.screens() { items.append(s) }
        if place != .dock {
            items += [.separator(), MenuAction.item("打開設定資料夾", a.openFolder)]
            let quit = MenuAction.item(place == .appMenu ? "結束鋼彈桌寵" : "結束", a.quit)
            quit.keyEquivalent = "q"
            items.append(quit)
        }
        return items
    }

    static func fill(_ menu: NSMenu, _ items: [NSMenuItem]) {
        menu.removeAllItems()
        for i in items { menu.addItem(i) }
    }

    /// A menu as text, submenus indented (`--menus-dump`, for checking the menus headless): ✓ ticked, ▸ a submenu,
    /// (灰) not clickable.
    static func dump(_ menu: NSMenu, indent: String = "") -> String {
        menu.items.map { i -> String in
            if i.isSeparatorItem { return indent + "  ────" }
            var line = indent + (i.state == .on ? "✓ " : "  ") + i.title
            if i.submenu != nil { line += " ▸" }
            if !i.keyEquivalent.isEmpty { line += "  ⌘\(i.keyEquivalent)" }
            if i.action == nil && i.submenu == nil { line += "  (灰)" }
            return [line, i.submenu.map { dump($0, indent: indent + "      ") }].compactMap { $0 }.joined(separator: "\n")
        }.joined(separator: "\n")
    }

    /// A grey line that is not clickable (a menu's heading, a Gundam's details).
    static func header(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    static func checked(_ title: String, _ on: Bool, _ run: @escaping () -> Void) -> NSMenuItem {
        let item = MenuAction.item(title, run)
        item.state = on ? .on : .off
        return item
    }

    // MARK: picking a character by its tags

    /// 換角色: the characters as nested submenus 作品 › 系列 › 代數 › 角色. A level where they all agree is skipped (so
    /// with one series its characters show straight away); ones without that tag go under 未分類; the branch holding
    /// `current` is ticked. nil with fewer than two characters.
    static func characterPicker(_ labels: [CharacterLabel], current: String,
                                pick: @escaping (String) -> Void) -> NSMenuItem? {
        guard labels.count > 1 else { return nil }
        let item = NSMenuItem(title: "換角色", action: nil, keyEquivalent: "")
        item.submenu = tree(labels, level: 0, current: current, pick: pick)
        return item
    }

    /// 匯出角色: the one character straight away, several picked the same way as 換角色; nil with none.
    static func exportItem(_ labels: [CharacterLabel], _ export: @escaping (String) -> Void) -> NSMenuItem? {
        guard let only = labels.first else { return nil }
        guard labels.count > 1 else { return MenuAction.item("匯出角色（\(only.name)）…") { export(only.id) } }
        let item = NSMenuItem(title: "匯出角色", action: nil, keyEquivalent: "")
        item.submenu = tree(labels, level: 0, current: nil, pick: export)
        return item
    }

    private static func tree(_ labels: [CharacterLabel], level: Int, current: String?,
                             pick: @escaping (String) -> Void) -> NSMenu {
        let menu = NSMenu()
        guard level < CharacterTags.levels.count else {
            for l in labels.sorted(by: { $0.title < $1.title }) {
                menu.addItem(checked(l.title, l.id == current) { pick(l.id) })
            }
            return menu
        }
        let key = CharacterTags.levels[level]
        let groups = Dictionary(grouping: labels) { $0.tags[keyPath: key] ?? "" }
        if groups.count == 1 { return tree(labels, level: level + 1, current: current, pick: pick) }
        // named groups in order, 未分類 last
        for name in groups.keys.sorted(by: { ($0.isEmpty ? 1 : 0, $0) < ($1.isEmpty ? 1 : 0, $1) }) {
            let members = groups[name] ?? []
            let sub = NSMenuItem(title: name.isEmpty ? "未分類" : name, action: nil, keyEquivalent: "")
            sub.submenu = tree(members, level: level + 1, current: current, pick: pick)
            sub.state = members.contains { $0.id == current } ? .on : .off
            menu.addItem(sub)
        }
        return menu
    }
}
