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
        let size = NSSize(width: 480, height: 540)
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
        title.frame = NSRect(x: 24, y: 478, width: 432, height: 28)
        content.addSubview(title)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 66, width: 432, height: 394))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let fields = card["fields"] as? [String: String] ?? [:]
        let timeline = card["timeline"] as? [String: String] ?? [:]
        let details = card["details"] as? [String: Any] ?? [:]
        let quote = timeline["customerText"] ?? details["customerText"] as? String ?? details["customer_text"] as? String ?? "原话未记录"
        let text = [
            "客户  " + (fields["客户"] ?? ""),
            "最近开口  " + (timeline["openedAt"] ?? "时间未记录"),
            "客户说\n" + quote,
            "已完成\n" + (fields["我已完成"] ?? "操作未记录"),
            "我方发送记录\n" + (timeline["sentMessages"] ?? "旧通知没有保存发送明细"),
            "联系方式\n" + (fields["联系方式"] ?? "未获得"),
            "下一步\n" + (fields["下一步"] ?? "")
        ].joined(separator: "\n\n")
        let body = NSTextView(frame: NSRect(x: 0, y: 0, width: 414, height: 394))
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
        ack.frame = NSRect(x: 344, y: 20, width: 112, height: 32)
        ack.target = self
        ack.action = #selector(acknowledge(_:))
        ack.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        content.addSubview(ack)
        return panel
    }

    @objc private func dismissCard(_ sender: Any?) {
        if let id = currentId { dismissedIds.insert(id) }
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
