import AppKit
import SwiftUI

/// 角色設定 (10/30): pick a character, set its size, and for each state how it wanders — whether it does, which of the
/// screen's nine cells it prefers (click a cell to toggle it; any shape), how strongly,
/// how far a move goes, how long it rests, how fast it moves. Every change is saved at once (only what differs from
/// the character file) and shows on screen straight away; 「在畫面上預覽」 switches to showcase mode in that state.
/// Characters are found by search or by their tags (作品 › 系列 › 代數, from their character files), listed under
/// 作品 › 系列; a Gundam's 「調整這隻…」 opens it on that character and state.
final class CharacterPanel {
    private let window: NSWindow
    private let model: PanelModel

    /// `problems`: the character packages that did not load, and why; `endPreview`: back to normal mode.
    init(store: CharacterStore, units: [UnitDef], problems: [(package: String, why: String)],
         stageSize: @escaping () -> CGSize, floor: @escaping () -> CGFloat,
         preview: @escaping (PetState, String) -> Void, endPreview: @escaping () -> Void) {
        model = PanelModel(store: store, units: units, problems: problems, stageSize: stageSize, floor: floor,
                           preview: preview, endPreview: endPreview)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "角色設定"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: PanelView(model: model))
        window.contentMinSize = NSSize(width: 940, height: 600)
        window.center()
    }

    /// Shows that state's settings.
    func select(_ st: PetState) { model.state = st }

    /// Whether the Gundams are in showcase mode (the panel says so, with a way back).
    func setPreviewing(_ on: Bool) { model.previewing = on }

    /// Shows that character's state (clearing a search or filter that would hide it).
    func select(unit: String, state: PetState) {
        if model.labels.contains(where: { $0.id == unit }) {
            if !model.visible.contains(where: { $0.id == unit }) { model.clearFilters() }
            model.unitId = unit
        }
        model.state = state
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Draws the panel into a PNG without showing it (`--panel-snapshot <path>`, for checking it headless).
    func snapshot(to url: URL) {
        guard let view = window.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}

final class PanelModel: ObservableObject {
    static let states: [PetState] = [.waiting, .thinking, .working, .permission, .question, .done, .sleeping, .error]

    let store: CharacterStore
    let units: [UnitDef]
    /// Each character's name, number and tags, in the order listed.
    let labels: [CharacterLabel]
    /// The character packages that did not load, and why.
    let problems: [(package: String, why: String)]
    private let stageSize: () -> CGSize
    private let floor: () -> CGFloat
    let preview: (PetState, String) -> Void
    let endPreview: () -> Void

    @Published var unitId: String { didSet { load() } }
    /// The search box (name, number, tags).
    @Published var search = "" { didSet { keepSelectionVisible() } }
    /// Each tag level's filter (作品, 系列, 代數; "" = 全部).
    @Published var filters = ["", "", ""] { didSet { keepSelectionVisible() } }
    @Published var state: PetState = .waiting { didSet { load() } }
    @Published var height: Double = 110
    @Published var pref = WanderPref()
    /// Estimated share of time in the preferred cells (Wander.predictedShare), worked out in the background.
    @Published var share = 0.0
    @Published var estimating = false
    /// The state's settings the panel offers (declared "user": true in its state file) and their values.
    @Published var userParams: [ParamSpec] = []
    @Published var values: [String: Any] = [:]
    /// The Gundams are in showcase mode (after 「在畫面上預覽」).
    @Published var previewing = false
    private var loading = false
    private var estimateRun = 0

    init(store: CharacterStore, units: [UnitDef], problems: [(package: String, why: String)],
         stageSize: @escaping () -> CGSize, floor: @escaping () -> CGFloat,
         preview: @escaping (PetState, String) -> Void, endPreview: @escaping () -> Void) {
        self.store = store
        self.units = units
        self.problems = problems
        labels = units.map { CharacterLabel($0, store.profile($0.id)) }
            .sorted { ($0.tags.path + [$0.title]).joined(separator: "\u{1}") < ($1.tags.path + [$1.title]).joined(separator: "\u{1}") }
        self.stageSize = stageSize
        self.floor = floor
        self.preview = preview
        self.endPreview = endPreview
        unitId = labels.first?.id ?? ""  // the first row of the list
        load()
    }

    /// Search and filters only help with more than one character.
    var showFinder: Bool { labels.count > 1 }

    var stageAspect: CGFloat {
        let s = stageSize()
        return s.height > 0 ? s.width / s.height : 16 / 9
    }

    func load() {
        loading = true
        let p = store.profile(unitId)
        height = p.height
        pref = p.pref(state)
        userParams = (p.params[state] ?? []).filter(\.user)
        values = p.values[state] ?? [:]
        loading = false
        estimate()
    }

    /// Saves the state's wandering (on a change, or when a slider is let go — not while it is dragged).
    func commitPref() {
        guard !loading else { return }
        store.setPref(pref, for: state, of: unitId)
        estimate()
    }

    func commitHeight() {
        store.setHeight(height, for: unitId)
        estimate()
    }

    /// Saves one of the state's settings (演出).
    func setValue(_ v: Any, for name: String) {
        store.setValue(v, for: name, in: state, of: unitId)
        values = store.profile(unitId).values[state] ?? [:]
    }

    /// Shows a setting's value while its slider is dragged (saved by `setValue` when it is let go).
    func previewValue(_ v: Any, for name: String) { values[name] = v }

    func resetState() {
        store.reset(unitId, state: state)
        load()
    }

    func resetAll() {
        store.reset(unitId)
        load()
    }

    /// Works the estimate out in the background (3000 steps of the wander); only the latest request's answer is shown.
    private func estimate() {
        estimateRun += 1
        guard pref.wander, !pref.cells.isEmpty else {
            share = 0
            estimating = false
            return
        }
        let run = estimateRun, p = pref, h = CGFloat(height), area = CGRect(origin: .zero, size: stageSize()), f = floor()
        estimating = true
        DispatchQueue.global(qos: .userInitiated).async {
            let s = Wander.predictedShare(p, height: h, area: area, floor: f)
            DispatchQueue.main.async { [weak self] in
                guard let self, run == self.estimateRun else { return }
                self.share = s
                self.estimating = false
            }
        }
    }

    /// The character being edited is always one the list shows (else the right side and 「匯出這個角色…」 would act on
    /// one the user cannot see): when the search or filters hide it, the first one shown is picked.
    private func keepSelectionVisible() {
        let v = visible
        if let first = v.first, !v.contains(where: { $0.id == unitId }) { unitId = first.id }
    }

    // MARK: finding a character

    var current: CharacterLabel? { labels.first { $0.id == unitId } }

    /// The tag levels some character fills in (the only ones offered as filters).
    var filterLevels: [Int] {
        CharacterTags.levels.indices.filter { i in labels.contains { $0.tags[keyPath: CharacterTags.levels[i]] != nil } }
    }

    /// Passes the filters of the levels above `level` (all of them by default) and the search.
    private func passes(_ l: CharacterLabel, above level: Int = 3) -> Bool {
        for i in 0..<level where !filters[i].isEmpty && l.tags[keyPath: CharacterTags.levels[i]] != filters[i] {
            return false
        }
        return search.isEmpty || l.matches(search)
    }

    var visible: [CharacterLabel] { labels.filter { passes($0) } }

    /// A level's choices: the values among the characters the levels above it leave.
    func options(_ level: Int) -> [String] {
        Array(Set(labels.filter { passes($0, above: level) }.compactMap { $0.tags[keyPath: CharacterTags.levels[level]] }))
            .sorted()
    }

    /// Sets a level's filter; the levels below it go back to 全部 (their choices change).
    func setFilter(_ level: Int, _ v: String) {
        filters[level] = v
        for i in (level + 1)..<filters.count { filters[i] = "" }
    }

    func clearFilters() {
        search = ""
        filters = ["", "", ""]
    }

    /// The visible characters under 作品 › 系列 (未分類: no 作品 or 系列; no headings at all when nobody has tags).
    var groups: [(title: String, labels: [CharacterLabel])] {
        let anyTags = labels.contains { $0.tags.work != nil || $0.tags.series != nil }
        let by = Dictionary(grouping: visible) { l in
            [l.tags.work, l.tags.series].compactMap { $0 }.joined(separator: " › ")
        }
        return by.keys.sorted { ($0.isEmpty ? 1 : 0, $0) < ($1.isEmpty ? 1 : 0, $1) }.map { k in
            (k.isEmpty ? (anyTags ? "未分類" : "") : k, by[k] ?? [])
        }
    }

    /// e.g. 鋼彈 › 機動戰士鋼彈00 › 第三世代 › 力天使・思考中
    var breadcrumb: String {
        guard let c = current else { return state.label }
        return (c.tags.path + [c.name]).joined(separator: " › ") + "・" + state.label
    }

    /// A state's wandering in a few words: 不遊走（待在自己的位置）, 到處走, 偏好 右下, 偏好 上排, …
    func summary(_ s: PetState) -> String {
        let p = store.profile(unitId).pref(s)
        guard p.wander else { return "不遊走（待在自己的位置）" }
        return p.cells.isEmpty ? "到處走" : "偏好 " + Self.describe(p.cells)
    }

    private static let cellNames = ["左上", "上方中間", "右上", "左邊中間", "正中間", "右邊中間", "左下", "下方中間", "右下"]
    private static let lines: [(cells: Set<Int>, name: String)] = [
        ([0, 1, 2], "上排"), ([3, 4, 5], "中間一排"), ([6, 7, 8], "下排"),
        ([0, 3, 6], "左側"), ([1, 4, 7], "中間直排"), ([2, 5, 8], "右側"),
    ]

    /// Picked cells as words: whole rows and columns by name, the rest one by one (more than three parts: a count).
    static func describe(_ cells: [Int]) -> String {
        var rest = Set(cells)
        if rest.count == 9 { return "整個畫面" }
        var parts: [String] = []
        for l in lines where l.cells.isSubset(of: rest) {
            parts.append(l.name)
            rest.subtract(l.cells)
        }
        parts += rest.sorted().compactMap { $0 < cellNames.count ? cellNames[$0] : nil }
        return parts.count > 3 ? "\(cells.count) 格" : parts.joined(separator: "、")
    }
}

private struct PanelView: View {
    @ObservedObject var model: PanelModel
    @State private var confirmResetAll = false

    var body: some View {
        VStack(spacing: 0) {
            if model.previewing { previewBar }
            if model.units.isEmpty {
                VStack(spacing: 8) {
                    Text("目前沒有角色").font(.title3).bold()
                    Text("把角色包（character.json、states/、assets/）放進 ~/Library/Application Support/GundamPet/characters/<角色>/，重開程式就會載入。")
                        .font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center)
                    Button("匯入角色…") { CharacterPackage.runImport() }
                    if !model.problems.isEmpty { problemList.frame(maxWidth: 420) }
                }
                .padding(40)
                .frame(minWidth: 940, maxWidth: .infinity, minHeight: 580, maxHeight: .infinity)
            } else {
                editor
            }
        }
    }

    /// After 「在畫面上預覽」 the Gundams are in showcase mode: said here, with the way back.
    private var previewBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye")
            Text("桌寵現在在展示模式（預覽中）：畫面上只有一隻，右鍵它可以切換狀態。")
            Spacer()
            Button("結束預覽") { model.endPreview() }
        }
        .font(.callout)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Color.orange.opacity(0.18))
    }

    /// The character packages that did not load, and why (folded until opened).
    private var problemList: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(model.problems, id: \.package) { p in
                    Text("\(p.package)：\(p.why)").font(.caption).fixedSize(horizontal: false, vertical: true)
                }
                Text("詳細記錄在運行紀錄（logs/run/）。").font(.caption2).foregroundColor(.secondary)
            }
            .padding(.top, 4)
        } label: {
            Label("有 \(model.problems.count) 個角色包沒載入", systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundColor(.orange)
        }
    }

    private var editor: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("角色").font(.headline)
                if !model.problems.isEmpty { problemList }
                if model.showFinder {
                    TextField("搜尋名稱、型號、作品、系列…", text: $model.search)
                        .textFieldStyle(.roundedBorder)
                    ForEach(model.filterLevels, id: \.self) { i in
                        Picker(CharacterTags.levelNames[i], selection: Binding(get: { model.filters[i] },
                                                                             set: { model.setFilter(i, $0) })) {
                            Text("全部").tag("")
                            ForEach(model.options(i), id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.menu)
                        .font(.caption)
                    }
                }
                characterList
                // character files (CharacterPackage): install one, or share the character picked
                HStack {
                    Button("匯入角色…") { CharacterPackage.runImport() }
                    Button("匯出這個角色…") { CharacterPackage.runExport(id: model.unitId) }
                }
                .controlSize(.small)
                Divider()
                Text("角色大小").font(.headline)
                Slider(value: $model.height, in: 60...220) { editing in
                    if !editing {
                        model.height = model.height.rounded()
                        model.commitHeight()
                    }
                }
                Text("高度 \(Int(model.height)) pt（所有狀態一樣大）").font(.caption).foregroundColor(.secondary)
                Button("這個角色全部恢復預設…") { confirmResetAll = true }
                    .confirmationDialog("把「\(model.current?.name ?? model.unitId)」全部恢復預設？", isPresented: $confirmResetAll,
                                        titleVisibility: .visible) {
                        Button("全部恢復預設", role: .destructive) { model.resetAll() }
                    } message: {
                        Text("會清掉你對這個角色的所有調整：大小、8 個狀態的遊走與演出設定，改回角色檔原本的值。")
                    }
            }
            .padding(14)
            .frame(width: 250)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("狀態").font(.headline).padding(.horizontal, 14).padding(.top, 14)
                List(PanelModel.states, id: \.self, selection: Binding(get: { Optional(model.state) },
                                                                       set: { if let v = $0 { model.state = v } })) { s in
                    // the dot is the colour of the state's marker on screen
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Circle().fill(Color(nsColor: s.color)).frame(width: 8, height: 8)
                        VStack(alignment: .leading) {
                            Text(s.label)
                            Text(model.summary(s)).font(.caption).foregroundColor(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .frame(width: 170)

            Divider()

            ScrollView {
                StateEditor(model: model)
                    .padding(16)
            }
        }
        .frame(minWidth: 940, maxWidth: .infinity, minHeight: 560, maxHeight: .infinity)
    }

    /// The characters the search and filters leave, under 作品 › 系列, each with its number and 代數.
    private var characterList: some View {
        Group {
            if model.visible.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("沒有符合的角色").font(.caption).foregroundColor(.secondary)
                    Button("清除搜尋與篩選") { model.clearFilters() }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                List(selection: Binding(get: { Optional(model.unitId) }, set: { if let v = $0 { model.unitId = v } })) {
                    ForEach(model.groups, id: \.title) { g in
                        if g.title.isEmpty {
                            rows(g.labels)
                        } else {
                            Section(g.title) { rows(g.labels) }
                        }
                    }
                }
            }
        }
        .frame(minHeight: 120)
    }

    private func rows(_ labels: [CharacterLabel]) -> some View {
        ForEach(labels, id: \.id) { l in
            HStack {
                VStack(alignment: .leading) {
                    Text(l.name)
                    if !l.code.isEmpty { Text(l.code).font(.caption).foregroundColor(.secondary) }
                }
                Spacer()
                if let g = l.tags.generation {
                    Text(g).font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.18))
                        .clipShape(Capsule())
                }
            }
            .tag(Optional(l.id))
        }
    }
}

private struct StateEditor: View {
    @ObservedObject var model: PanelModel

    private var steps: [(String, String)] { [("small", "小"), ("medium", "中"), ("large", "大")] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.breadcrumb).font(.caption).foregroundColor(.secondary)
            Text("\(model.state.label)・遊走").font(.title3).bold()
            Toggle("這個狀態會在畫面上遊走", isOn: bind(\.wander))
            if !model.pref.wander {
                Text("不遊走：會回到螢幕底部自己的位置待著。").font(.caption).foregroundColor(.secondary)
            }
            Group {
                Text("偏好的區域（點格子選取或取消，可以不連續）")
                    .font(.caption).foregroundColor(.secondary)
                GridPicker(cells: bind(\.cells))
                    .frame(width: 360, height: 360 / model.stageAspect)
                HStack {
                    Text("偏好強度")
                    Slider(value: bind(\.strength, save: false), in: 0...1, onEditingChanged: saveWhenLetGo)
                    Text("\(Int(model.pref.strength * 100))%").frame(width: 44, alignment: .trailing)
                }
                Text(model.pref.cells.isEmpty
                     ? "沒選格子：完全隨機地走遍整個畫面。"
                     : "每次決定方向時，有 \(Int(model.pref.strength * 100))% 會刻意往選的格子走，其餘隨機。預計待在選的格子裡的時間："
                        + (model.estimating ? "計算中…" : "約 \(Int((model.share * 100).rounded()))%"))
                    .font(.caption).foregroundColor(.secondary)
                HStack {
                    Text("一次走多遠")
                    Picker("", selection: bind(\.step)) {
                        ForEach(steps, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                }
                HStack {
                    Text("每次停留")
                    Stepper("\(Int(model.pref.stay.first ?? 0)) 秒", value: stayBound(0), in: 0...60)
                    Text("～")
                    Stepper("\(Int(model.pref.stay.last ?? 0)) 秒", value: stayBound(1), in: 0...60)
                }
                HStack {
                    Text("移動速度")
                    Slider(value: bind(\.speed, save: false), in: 60...600, onEditingChanged: saveWhenLetGo)
                    Text("\(Int(model.pref.speed)) pt/秒").frame(width: 80, alignment: .trailing)
                }
            }
            .disabled(!model.pref.wander)
            .opacity(model.pref.wander ? 1 : 0.45)
            if !model.userParams.isEmpty {
                Divider()
                Text("\(model.state.label)・演出").font(.title3).bold()
                ForEach(model.userParams, id: \.name) { spec in
                    ParamRow(spec: spec, model: model)
                }
            }
            HStack {
                Button("在畫面上預覽") { model.preview(model.state, model.unitId) }
                Button("這個狀態恢復預設…") { confirmReset = true }
                    .confirmationDialog("把「\(model.state.label)」恢復預設？", isPresented: $confirmReset,
                                        titleVisibility: .visible) {
                        Button("恢復預設", role: .destructive) { model.resetState() }
                    } message: {
                        Text("只清掉這個狀態的遊走與演出設定，改回角色檔原本的值；其他狀態和角色大小不變。")
                    }
            }
            Text("改動會自動儲存，畫面上的鋼彈立刻套用。").font(.caption).foregroundColor(.secondary)
            Spacer()
        }
    }

    @State private var confirmReset = false

    /// `save: false` for sliders: dragging only moves the numbers; letting go saves (saveWhenLetGo).
    private func bind<T>(_ key: WritableKeyPath<WanderPref, T>, save: Bool = true) -> Binding<T> {
        Binding(get: { model.pref[keyPath: key] },
                set: {
                    model.pref[keyPath: key] = $0
                    if save { model.commitPref() }
                })
    }

    private func saveWhenLetGo(_ editing: Bool) {
        if !editing { model.commitPref() }
    }

    /// One end of the rest range; the other end follows so min ≤ max.
    private func stayBound(_ i: Int) -> Binding<Double> {
        Binding(get: {
            let s = model.pref.stay
            return i == 0 ? (s.first ?? 0) : (s.last ?? 0)
        }, set: { v in
            var lo = model.pref.stay.first ?? 0, hi = model.pref.stay.last ?? 0
            if i == 0 { lo = v; hi = max(hi, v) } else { hi = v; lo = min(lo, v) }
            model.pref.stay = [lo, hi]
            model.commitPref()
        })
    }
}

/// One of the state's settings, as the control its type calls for (declared in the state file).
private struct ParamRow: View {
    let spec: ParamSpec
    @ObservedObject var model: PanelModel

    var body: some View {
        switch spec.type {
        case "bool":
            Toggle(spec.label, isOn: Binding(get: { model.values[spec.name] as? Bool ?? false },
                                             set: { model.setValue($0, for: spec.name) }))
        case "int":
            let v = model.values[spec.name] as? Int ?? 0
            Stepper("\(spec.label)：\(v)", value: Binding(get: { v }, set: { model.setValue($0, for: spec.name) }),
                    in: spec.intRange, step: spec.intStep)
        case "number":
            let v = model.values[spec.name] as? Double ?? 0
            HStack {
                Text(spec.label)
                // dragging shows the value; letting go saves it
                Slider(value: Binding(get: { v }, set: { model.previewValue($0, for: spec.name) }),
                       in: spec.numberRange) { editing in
                    if !editing { model.setValue(model.values[spec.name] ?? v, for: spec.name) }
                }
                Text(String(format: "%.2f", v)).frame(width: 50, alignment: .trailing)
            }
        case "choice":
            Picker(spec.label, selection: Binding(get: { model.values[spec.name] as? String ?? "" },
                                                  set: { model.setValue($0, for: spec.name) })) {
                ForEach(spec.choices, id: \.value) { Text($0.label).tag($0.value) }
            }
        default:
            EmptyView()
        }
    }
}

/// The screen as nine cells: click one to select it or not (10/30: the user wanted plain clicks, no dragging).
private struct GridPicker: View {
    @Binding var cells: [Int]
    private let names = ["上左", "上中", "上右", "中左", "中中", "中右", "下左", "下中", "下右"]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(0..<3, id: \.self) { r in
                HStack(spacing: 2) {
                    ForEach(0..<3, id: \.self) { c in
                        cell(r * 3 + c)
                    }
                }
            }
        }
        .padding(2)
        .background(Color.secondary.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func cell(_ i: Int) -> some View {
        let on = cells.contains(i)
        return Button {
            cells = on ? cells.filter { $0 != i } : (cells + [i]).sorted()
        } label: {
            Text(names[i])
                .font(.caption)
                .foregroundColor(on ? .white : .secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(on ? Color.green.opacity(0.7) : Color(nsColor: .controlBackgroundColor))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
