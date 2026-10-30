import AppKit
import SwiftUI

/// 角色設定 (10/30): pick a character, set its size, and for each state how it wanders — whether it does, which of the
/// screen's nine cells it prefers (click a cell to toggle it; any shape), how strongly,
/// how far a move goes, how long it rests, how fast it moves. Every change is saved at once (only what differs from
/// the character file) and shows on screen straight away; 「在畫面上預覽」 switches to showcase mode in that state.
final class CharacterPanel {
    private let window: NSWindow
    private let model: PanelModel

    init(store: CharacterStore, units: [UnitDef], stageSize: @escaping () -> CGSize, floor: @escaping () -> CGFloat,
         preview: @escaping (PetState) -> Void) {
        model = PanelModel(store: store, units: units, stageSize: stageSize, floor: floor, preview: preview)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "角色設定"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: PanelView(model: model))
        window.center()
    }

    /// Shows that state's settings.
    func select(_ st: PetState) { model.state = st }

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
    private let stageSize: () -> CGSize
    private let floor: () -> CGFloat
    let preview: (PetState) -> Void

    @Published var unitId: String { didSet { load() } }
    @Published var state: PetState = .waiting { didSet { load() } }
    @Published var height: Double = 110
    @Published var pref = WanderPref()
    /// Estimated share of time in the preferred cells (Wander.predictedShare).
    @Published var share = 0.0
    /// The state's settings the panel offers (declared "user": true in its state file) and their values.
    @Published var userParams: [ParamSpec] = []
    @Published var values: [String: Any] = [:]
    private var loading = false

    init(store: CharacterStore, units: [UnitDef], stageSize: @escaping () -> CGSize, floor: @escaping () -> CGFloat,
         preview: @escaping (PetState) -> Void) {
        self.store = store
        self.units = units
        self.stageSize = stageSize
        self.floor = floor
        self.preview = preview
        unitId = units.first?.id ?? ""
        load()
    }

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

    /// Saves the state's wandering (called on every change).
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

    func resetState() {
        store.reset(unitId, state: state)
        load()
    }

    func resetAll() {
        store.reset(unitId)
        load()
    }

    private func estimate() {
        share = pref.wander ? Wander.predictedShare(pref, height: CGFloat(height),
                                                    area: CGRect(origin: .zero, size: stageSize()), floor: floor()) : 0
    }

    func summary(_ s: PetState) -> String {
        let p = store.profile(unitId).pref(s)
        guard p.wander else { return "不遊走" }
        return p.cells.isEmpty ? "隨機遊走" : "偏好 \(p.cells.count) 格"
    }
}

private struct PanelView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text("角色").font(.headline)
                List(model.units, id: \.id, selection: Binding(get: { Optional(model.unitId) },
                                                                 set: { if let v = $0 { model.unitId = v } })) { u in
                    VStack(alignment: .leading) {
                        Text(u.name)
                        Text(u.code).font(.caption).foregroundColor(.secondary)
                    }
                }
                .frame(height: 140)
                Divider()
                Text("角色大小").font(.headline)
                Slider(value: $model.height, in: 60...220) { editing in
                    if !editing {
                        model.height = model.height.rounded()
                        model.commitHeight()
                    }
                }
                Text("高度 \(Int(model.height)) pt（所有狀態一樣大）").font(.caption).foregroundColor(.secondary)
                Spacer()
                Button("這個角色全部恢復預設") { model.resetAll() }
            }
            .padding(14)
            .frame(width: 210)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("狀態").font(.headline).padding(.horizontal, 14).padding(.top, 14)
                List(PanelModel.states, id: \.self, selection: Binding(get: { Optional(model.state) },
                                                                       set: { if let v = $0 { model.state = v } })) { s in
                    VStack(alignment: .leading) {
                        Text(s.label)
                        Text(model.summary(s)).font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            .frame(width: 150)

            Divider()

            ScrollView {
                StateEditor(model: model)
                    .padding(16)
            }
        }
        .frame(minWidth: 900, minHeight: 560)
    }
}

private struct StateEditor: View {
    @ObservedObject var model: PanelModel

    private var steps: [(String, String)] { [("small", "小"), ("medium", "中"), ("large", "大")] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
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
                    Slider(value: bind(\.strength), in: 0...1)
                    Text("\(Int(model.pref.strength * 100))%").frame(width: 44, alignment: .trailing)
                }
                Text(model.pref.cells.isEmpty
                     ? "沒選格子：完全隨機地走遍整個畫面。"
                     : "每次決定方向時，有 \(Int(model.pref.strength * 100))% 會刻意往選的格子走，其餘隨機。預計待在選的格子裡的時間：約 \(Int((model.share * 100).rounded()))%")
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
                    Slider(value: bind(\.speed), in: 60...600)
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
                Button("在畫面上預覽") { model.preview(model.state) }
                Button("這個狀態恢復預設") { model.resetState() }
            }
            Spacer()
        }
    }

    private func bind<T>(_ key: WritableKeyPath<WanderPref, T>) -> Binding<T> {
        Binding(get: { model.pref[keyPath: key] },
                set: { model.pref[keyPath: key] = $0; model.commitPref() })
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
                    in: Int(spec.min ?? 0)...Int(spec.max ?? 100), step: Int(spec.step ?? 1))
        case "number":
            let v = model.values[spec.name] as? Double ?? 0
            HStack {
                Text(spec.label)
                Slider(value: Binding(get: { v }, set: { model.setValue($0, for: spec.name) }),
                       in: (spec.min ?? 0)...(spec.max ?? 1))
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
