import AppKit
import SwiftUI

/// 管理 session (10/30): every recent session in one window — its state, title, when it last changed, and which
/// Gundam follows it (or that it is released) — with 釋放 / 叫回 on each row, 「給這隻監控」 when the window was
/// opened from a Gundam's right-click menu (that Gundam switches to the row's session in place), and 全部釋放.
/// A released session gets its Gundam back by itself the next time the user writes in it. 鎖定展示: tick sessions
/// (the box at the start of each row) and switch it on — only those are read and get a Gundam.
final class SessionPanel {
    struct Actions {
        var release: (String) -> Void
        var recall: (String) -> Void
        /// (the session the Gundam follows, the one picked for it)
        var monitor: (String, String) -> Void
        var releaseAll: () -> Void
        var setLocked: (String, Bool) -> Void
        var setLockOn: (Bool) -> Void
    }

    private let window: NSWindow
    let model: SessionModel

    init(actions: Actions) {
        model = SessionModel(actions: actions)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "管理 session"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SessionView(model: model))
        window.center()
    }

    var isVisible: Bool { window.isVisible }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Draws the window into a PNG without showing it (`--sessions-snapshot <path>`).
    func snapshot(to url: URL) {
        guard let view = window.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}

final class SessionModel: ObservableObject {
    struct Row: Identifiable, Equatable {
        enum Status: Equatable { case shown(String), released, none }
        let id: String
        let title: String
        let state: PetState
        let age: String
        let active: Bool
        let status: Status
        /// Ticked for 鎖定展示.
        let locked: Bool
    }

    @Published var rows: [Row] = []
    /// The session the Gundam the window was opened from follows (nil: opened from the menu bar / Dock, or that
    /// Gundam is gone).
    @Published var petSession: String?
    @Published var petName = ""
    @Published var lockOn = false
    @Published var lockedCount = 0
    let actions: SessionPanel.Actions

    init(actions: SessionPanel.Actions) { self.actions = actions }

    /// `shown`: session → the Gundam following it ("GN-002 力天使").
    func update(sessions: [SessionInfo], shown: [String: String], released: (String) -> Bool,
                locked: (String) -> Bool, lockOn: Bool, lockedCount: Int) {
        self.lockOn = lockOn
        self.lockedCount = lockedCount
        let now = Date()
        rows = sessions.sorted { $0.updatedAt > $1.updatedAt }.map { s in
            let mins = Int(now.timeIntervalSince(s.updatedAt) / 60)
            let age = mins < 1 ? "剛剛" : mins < 60 ? "\(mins) 分鐘前" : "\(mins / 60) 小時前"
            let status: Row.Status = shown[s.id].map { .shown($0) } ?? (released(s.id) ? .released : .none)
            return Row(id: s.id, title: s.title, state: s.state, age: age, active: s.active, status: status,
                       locked: locked(s.id))
        }
        if let p = petSession, shown[p] == nil { petSession = nil }
        if let p = petSession { petName = shown[p] ?? petName }
    }

    var shownCount: Int { rows.filter { if case .shown = $0.status { return true } else { return false } }.count }
}

private struct SessionView: View {
    @ObservedObject var model: SessionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(14)
            Divider()
            HStack {
                Toggle("鎖定展示：只偵測、只顯示勾選的 session", isOn: Binding(get: { model.lockOn },
                                                                     set: { model.actions.setLockOn($0) }))
                    .disabled(model.lockedCount == 0)
                Spacer()
                Text(model.lockOn ? "鎖定中：只偵測這 \(model.lockedCount) 個，其他 session 都不看。要加別的，先關掉鎖定再勾。"
                                  : "已勾 \(model.lockedCount) 個（每行最前面的框）")
                    .font(.caption).foregroundColor(model.lockOn ? .orange : .secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
            List(model.rows) { row in
                SessionRow(row: row, model: model)
            }
            Divider()
            HStack {
                Text("被釋放的 session，你下次在裡面回話時鋼彈會自己出現。")
                    .font(.caption).foregroundColor(.secondary)
                Spacer()
                if !model.lockOn {
                    Button(role: .destructive) { model.actions.releaseAll() } label: {
                        Text("全部釋放（\(model.shownCount)）")
                    }
                    .disabled(model.shownCount == 0)
                }
            }
            .padding(12)
        }
        .frame(minWidth: 640, minHeight: 360)
    }

    @ViewBuilder private var header: some View {
        if let p = model.petSession, let row = model.rows.first(where: { $0.id == p }) {
            VStack(alignment: .leading, spacing: 4) {
                Text("從 \(model.petName) 打開").font(.headline)
                Text("它現在監控：\(row.title)").font(.callout).foregroundColor(.secondary)
                Text("按某一行的「給這隻監控」，它就改跟那個 session（原本這個會被釋放）。")
                    .font(.caption).foregroundColor(.secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("最近的 session").font(.headline)
                Text("從某一隻鋼彈右鍵打開，可以指定它要監控哪一個。").font(.caption).foregroundColor(.secondary)
            }
        }
    }
}

private struct SessionRow: View {
    let row: SessionModel.Row
    @ObservedObject var model: SessionModel

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { row.locked }, set: { model.actions.setLocked(row.id, $0) }))
                .labelsHidden()
                .help("勾選：鎖定展示時只顯示勾選的 session")
            Text(row.state.label)
                .font(.caption).bold()
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).lineLimit(1).truncationMode(.tail)
                Text("\(row.age)・\(row.active ? "活躍" : "閒置")").font(.caption).foregroundColor(.secondary)
            }
            Spacer(minLength: 8)
            statusText
                .font(.caption)
                .frame(width: 150, alignment: .trailing)
            buttons
                .frame(width: 200, alignment: .trailing)
        }
        .padding(.vertical, 3)
    }

    private var isThis: Bool { row.id == model.petSession }

    @ViewBuilder private var statusText: some View {
        switch row.status {
        case .shown(let name): Text(isThis ? "\(name)（這隻）" : name).foregroundColor(.green)
        case .released: Text("已釋放").foregroundColor(.orange)
        case .none: Text("沒有鋼彈").foregroundColor(.secondary)
        }
    }

    @ViewBuilder private var buttons: some View {
        // (鎖定展示 decides on its own who has a Gundam: untick a row to drop it)
        if !model.lockOn {
            normalButtons
        }
    }

    @ViewBuilder private var normalButtons: some View {
        HStack(spacing: 6) {
            if let p = model.petSession, !isThis, !isShownByOther {
                Button("給這隻監控") { model.actions.monitor(p, row.id) }
            }
            switch row.status {
            case .shown: Button("釋放") { model.actions.release(row.id) }
            case .released, .none: Button("叫回") { model.actions.recall(row.id) }
            }
        }
    }

    private var isShownByOther: Bool {
        if case .shown = row.status { return !isThis }
        return false
    }
}
