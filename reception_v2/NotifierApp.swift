import AppKit
import Foundation

private let queueName = "reception-v2-notification-queue.json"
private let ackRequestName = "reception-v2-notification-ack-request.json"
private let labels: [String: String] = [
    "ready_to_follow": "可以跟进",
    "needs_operator": "需要你处理",
    "send_failed": "消息没有发出去",
]

private func runtimeDirectory() -> URL {
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: "--runtime"), index + 1 < args.count {
        return URL(fileURLWithPath: args[index + 1], isDirectory: true)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".runtime", isDirectory: true)
}

private final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let runtime = runtimeDirectory()
    private var panel: CardPanel?
    private var timer: Timer?
    private var currentId: String?
    private var dismissedIds = Set<String>()
    private var pendingAcknowledgements = Set<String>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        dismissedIds = loadDismissedNotices(from: runtime.appendingPathComponent("reception-v2-dismissed-notices.json"))
        NSApp.setActivationPolicy(.accessory)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        refresh()
    }

    private var queueURL: URL { runtime.appendingPathComponent(queueName) }
  private var ackRequestURL: URL { runtime.appendingPathComponent(ackRequestName) }

    private func cards() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: queueURL),
              let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return value
    }

    private func requestAcknowledgement(_ id: String) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: ["noticeId": id], options: []) else { return false }
        let temp = ackRequestURL.path + ".swift.tmp"
        do {
            try data.write(to: URL(fileURLWithPath: temp), options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp)
            if FileManager.default.fileExists(atPath: ackRequestURL.path) { try FileManager.default.removeItem(at: ackRequestURL) }
            try FileManager.default.moveItem(atPath: temp, toPath: ackRequestURL.path)
            pendingAcknowledgements.insert(id)
            return true
        } catch { return false }
    }

    private func refresh() {
        let currentCards = cards()
        pendingAcknowledgements = pendingAcknowledgements.filter { pendingId in
            !currentCards.contains { $0["noticeId"] as? String == pendingId && ($0["acknowledgedAt"] as? String) != nil }
        }
        guard let card = nextVisibleCard(currentCards, excluding: pendingAcknowledgements.union(dismissedIds)),
              let id = card["noticeId"] as? String else {
            panel?.orderOut(nil); panel = nil; currentId = nil; return
        }
        if currentId == id, panel?.isVisible == true { return }
        currentId = id
        panel?.close()
        let created = makePanel(card: card)
        panel = created
        created.orderFrontRegardless()
    }

    private func makePanel(card: [String: Any]) -> CardPanel {
        let size = NSSize(width: 420, height: 440)
        let panel = CardPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        if let close = panel.standardWindowButton(.closeButton) { close.target = self; close.action = #selector(dismissCard(_:)) }
        panel.level = .floating
        panel.isOpaque = true
        panel.backgroundColor = .white
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.becomesKeyOnlyIfNeeded = true
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 24, y: screen.maxY - size.height - 24))
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.wantsLayer = true
        content.layer?.cornerRadius = 14
        content.layer?.masksToBounds = true
        panel.contentView = content
        let kind = card["kind"] as? String ?? "needs_operator"
        let title = NSTextField(labelWithString: labels[kind] ?? "需要你处理")
        title.font = .boldSystemFont(ofSize: 20)
        title.textColor = NSColor(calibratedRed: 0.08, green: 0.38, blue: 0.31, alpha: 1)
        title.frame = NSRect(x: 24, y: 378, width: 372, height: 28)
        content.addSubview(title)
        let close = NSButton(title: "关闭 ×", target: self, action: #selector(dismissCard(_:)))
        close.bezelStyle = .inline
        close.frame = NSRect(x: 326, y: 382, width: 74, height: 24)
        content.addSubview(close)
        title.frame.size.width = 260
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 66, width: 372, height: 292))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let fields = card["fields"] as? [String: String] ?? [:]
        let timeline = card["timeline"] as? [String: String] ?? [:]
        let details = card["details"] as? [String: Any] ?? [:]
        let quote = timeline["customerText"] ?? details["customerText"] as? String ?? details["customer_text"] as? String ?? "原话未记录"
        var sections = ["客户  " + (fields["客户"] ?? "")]
        if let time = timeline["openedAt"], time != "时间未记录" && time != "尚未记录客户文字开口" { sections.append(time) }
        if quote != "原话未记录" && quote != "尚未记录客户文字原话" && !quote.isEmpty { sections.append("客户\n" + quote) }
        if let sent = timeline["sentMessages"], sent != "本程序没有发送记录", !sent.isEmpty {
            sections.append("我方\n" + sent)
        }
        if let completed = fields["我已完成"], !completed.isEmpty { sections.append("已完成  " + completed) }
        if let contact = fields["联系方式"], !contact.isEmpty { sections.append("联系方式  " + contact) }
        if let next = fields["下一步"], !next.isEmpty { sections.append("下一步  " + next) }
        let text = sections.joined(separator: "\n\n")
        let body = NSTextView(frame: NSRect(x: 0, y: 0, width: 354, height: 292))
        body.isEditable = false
        body.isSelectable = true
        body.drawsBackground = false
        body.textColor = NSColor(calibratedWhite: 0.16, alpha: 1)
        body.font = .systemFont(ofSize: 14)
        body.textContainerInset = NSSize(width: 0, height: 8)
        body.isVerticallyResizable = true
        body.isHorizontallyResizable = false
        body.textContainer?.widthTracksTextView = true
        body.string = text
        scroll.documentView = body
        content.addSubview(scroll)
        let ack = NSButton(title: "知道了", target: nil, action: nil)
        ack.bezelStyle = .rounded
        ack.frame = NSRect(x: 284, y: 20, width: 112, height: 32)
        ack.target = self
        ack.action = #selector(acknowledge(_:))
        ack.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        content.addSubview(ack)
        return panel
    }

    @objc private func dismissCard(_ sender: Any?) {
        var updated = dismissedIds
        for card in cards() { if let id = card["noticeId"] as? String { updated.insert(id) } }
        do {
            try saveDismissedNotices(updated, to: runtime.appendingPathComponent("reception-v2-dismissed-notices.json"))
            dismissedIds = updated
        } catch { return }
        panel?.orderOut(nil); panel = nil; currentId = nil
    }

    @objc private func acknowledge(_ sender: NSButton) {
        let id = sender.identifier?.rawValue ?? ""
        guard requestAcknowledgement(id) else { return }
        panel?.orderOut(nil); panel = nil; currentId = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.refresh() }
    }
}

@main
struct ReceptionNotifierMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
