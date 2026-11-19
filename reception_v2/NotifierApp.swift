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
        if let output = ProcessInfo.processInfo.environment["RECEPTION_POPUP_PREVIEW"], let card = cards().first {
            let preview = makePanel(card: card)
            if let view = preview.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: output))
                }
            }
            NSApp.terminate(nil)
            return
        }
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
        panel.appearance = NSAppearance(named: .aqua)
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
        content.layer?.backgroundColor = NSColor.white.cgColor
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
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 354, height: 600))
        var cursor: CGFloat = 0
        func block(_ text: String, role: String? = nil, outgoing: Bool = false, muted: Bool = false) {
            let inset: CGFloat = role == nil ? 0 : 12
            let x: CGFloat = outgoing ? 30 : 0
            let width: CGFloat = role == nil ? 350 : 320
            let value = NSTextField(wrappingLabelWithString: text)
            value.font = .systemFont(ofSize: muted ? 12 : 14)
            value.textColor = muted ? .secondaryLabelColor : NSColor(calibratedWhite: 0.15, alpha: 1)
            let measured = (text as NSString).boundingRect(with: NSSize(width: width - inset * 2, height: 10000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: value.font!]).height
            let labelHeight = max(20, ceil(measured) + 4)
            let height = labelHeight + (role == nil ? 0 : 40)
            let container = NSView(frame: NSRect(x: x, y: cursor, width: width, height: height))
            if let role = role {
                container.wantsLayer = true
                container.layer?.cornerRadius = 10
                container.layer?.backgroundColor = (outgoing ? NSColor(calibratedRed: 0.91, green: 0.95, blue: 1, alpha: 1) : NSColor(calibratedWhite: 0.95, alpha: 1)).cgColor
                let caption = NSTextField(labelWithString: role)
                caption.font = .systemFont(ofSize: 11, weight: .medium)
                caption.textColor = .secondaryLabelColor
                caption.frame = NSRect(x: 12, y: height - 26, width: width - 24, height: 16)
                container.addSubview(caption)
            }
            value.frame = NSRect(x: inset, y: role == nil ? 0 : 12, width: width - inset * 2, height: labelHeight)
            container.addSubview(value)
            document.addSubview(container)
            cursor += height + 14
        }
        block((fields["客户"] ?? "") + "  ·  " + (fields["联系方式"] ?? ""), muted: true)
        if quote != "原话未记录" && quote != "尚未记录客户文字原话" && !quote.isEmpty {
            block(quote, role: "客户  " + (timeline["openedAt"] ?? ""))
        }
        if let sent = timeline["sentMessages"], sent != "本程序没有发送记录", !sent.isEmpty {
            for message in sent.components(separatedBy: "\n") { block(message, role: "我方", outgoing: true) }
        }
        if let completed = fields["我已完成"], !completed.isEmpty { block("已完成  " + completed, muted: true) }
        if let next = fields["下一步"], !next.isEmpty { block("下一步  " + next, muted: true) }
        let documentHeight = max(cursor, 292)
        for view in document.subviews { view.frame.origin.y = documentHeight - view.frame.maxY }
        document.frame.size.height = documentHeight
        scroll.documentView = document
        content.addSubview(scroll)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, documentHeight - 292)))
        let history = NSButton(title: "查看完整记录", target: self, action: #selector(showFullRecord(_:)))
        history.bezelStyle = .inline
        history.frame = NSRect(x: 24, y: 20, width: 126, height: 32)
        history.toolTip = "在本窗口滚动查看最近十条发送记录"
        content.addSubview(history)
        let ack = NSButton(title: "知道了", target: nil, action: nil)
        ack.bezelStyle = .rounded
        ack.frame = NSRect(x: 284, y: 20, width: 112, height: 32)
        ack.target = self
        ack.action = #selector(acknowledge(_:))
        ack.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        content.addSubview(ack)
        return panel
    }

    @objc private func showFullRecord(_ sender: NSButton) {
        guard let scroll = panel?.contentView?.subviews.compactMap({ $0 as? NSScrollView }).first else { return }
        guard let panel = panel, let content = panel.contentView else { return }
        let expanding = sender.title == "查看完整记录"
        let delta: CGFloat = expanding ? 160 : -160
        var frame = panel.frame
        frame.origin.y -= delta
        frame.size.height += delta
        panel.setFrame(frame, display: true)
        content.frame.size.height += delta
        for view in content.subviews where view !== scroll && view.frame.minY > 300 { view.frame.origin.y += delta }
        scroll.frame.size.height += delta
        sender.title = expanding ? "收起记录" : "查看完整记录"
        scroll.flashScrollers()
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
