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
        guard let card = nextVisibleCard(currentCards, excluding: pendingAcknowledgements),
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
        let size = NSSize(width: 460, height: 520)
        let panel = CardPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.97)
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.becomesKeyOnlyIfNeeded = true
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 24, y: screen.maxY - size.height - 24))

        let content = NSView(frame: NSRect(origin: .zero, size: size))
        panel.contentView = content
        let kind = card["kind"] as? String ?? "needs_operator"
        let title = NSTextField(labelWithString: labels[kind] ?? "需要你处理")
        title.font = .boldSystemFont(ofSize: 22)
        title.textColor = kind == "ready_to_follow" ? .systemGreen : (kind == "send_failed" ? .systemRed : .systemOrange)
        title.frame = NSRect(x: 24, y: 470, width: 412, height: 32)
        content.addSubview(title)

        let fields = card["fields"] as? [String: String] ?? [:]
        let order = ["客户", "想了解", "联系方式", "我已完成", "下一步"]
        for (index, key) in order.enumerated() {
            let value = fields[key] ?? ""
            let row = NSTextField(wrappingLabelWithString: "\(key)：\(value)")
            row.font = .systemFont(ofSize: index == 2 ? 15 : 14, weight: index == 2 ? .semibold : .regular)
            row.textColor = .white
            row.frame = NSRect(x: 24, y: CGFloat(430 - index * 64), width: 412, height: 54)
            content.addSubview(row)
        }

        let details = card["details"] as? [String: Any] ?? [:]
        let rawCustomer = (details["customerText"] as? String) ?? (details["customer_text"] as? String) ?? "暂无额外内容"
        let detailText = "客户原话：\(rawCustomer)"
        let detailView = NSTextField(wrappingLabelWithString: detailText)
        detailView.font = .systemFont(ofSize: 12)
        detailView.textColor = NSColor(calibratedWhite: 0.82, alpha: 1)
        detailView.frame = NSRect(x: 24, y: 72, width: 412, height: 88)
        detailView.isHidden = true
        detailView.identifier = NSUserInterfaceItemIdentifier("details-body")
        detailView.toolTip = details.isEmpty ? nil : String(describing: details)
        content.addSubview(detailView)
        let detailButton = NSButton(title: "查看客户原话", target: nil, action: nil)
        detailButton.bezelStyle = .inline
        detailButton.frame = NSRect(x: 24, y: 24, width: 128, height: 28)
        detailButton.target = self
        detailButton.action = #selector(toggleDetails(_:))
        detailButton.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        content.addSubview(detailButton)

        let ack = NSButton(title: "知道了", target: nil, action: nil)
        ack.bezelStyle = .rounded
        ack.frame = NSRect(x: 324, y: 20, width: 112, height: 32)
        ack.target = self
        ack.action = #selector(acknowledge(_:))
        ack.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        content.addSubview(ack)
        return panel
    }

    @objc private func toggleDetails(_ sender: NSButton) {
        guard let content = panel?.contentView else { return }
        if let field = content.subviews.compactMap({ $0 as? NSTextField }).first(where: { $0.identifier?.rawValue == "details-body" }) {
            field.isHidden.toggle()
            sender.title = field.isHidden ? "查看客户原话" : "收起详情"
        }
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
