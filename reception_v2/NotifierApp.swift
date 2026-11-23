import AppKit
import Foundation

private let queueName = "reception-v2-notification-queue.json"
private let ackRequestName = "reception-v2-notification-ack-request.json"

private func runtimeDirectory() -> URL {
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: "--runtime"), index + 1 < args.count {
        return URL(fileURLWithPath: args[index + 1], isDirectory: true)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".runtime", isDirectory: true)
}

final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class TopDownView: NSView {
    override var isFlipped: Bool { true }
}

private final class CardButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let runtime = runtimeDirectory()
    var panel: CardPanel?
    private var timer: Timer?
    private var healthPanel: CardPanel?
    private var shownIncident: String?
    private var dismissedIncident: String?
    private var dismissalURL: URL { runtime.appendingPathComponent("reception-v2-health-alert-dismissed.json") }
    var currentId: String?
    private var currentRevision: Data?
    var expandedRecord = false
    private var dismissedIds = Set<String>()
    private var pendingAcknowledgements = Set<String>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        dismissedIds = loadDismissedNotices(from: runtime.appendingPathComponent("reception-v2-dismissed-notices.json"))
        pendingAcknowledgements = loadPendingAcknowledgements(from: ackRequestURL)
        dismissedIncident = loadDismissedNotices(from: dismissalURL).first
        NSApp.setActivationPolicy(.accessory)
        if let output = ProcessInfo.processInfo.environment["RECEPTION_POPUP_PREVIEW"] {
            guard let card = cards().first(where: {
                guard let id = ProcessInfo.processInfo.environment["RECEPTION_POPUP_NOTICE_ID"] else { return true }
                return $0["noticeId"] as? String == id
            }) else {
                NSApp.terminate(nil)
                return
            }
            expandedRecord = ProcessInfo.processInfo.environment["RECEPTION_POPUP_EXPANDED"] == "1"
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
        var ids = pendingAcknowledgements
        ids.formUnion(loadPendingAcknowledgements(from: ackRequestURL))
        ids.insert(id)
        guard let data = try? JSONSerialization.data(withJSONObject: ["noticeIds": ids.sorted()], options: []) else { return false }
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

    private func refreshHealthAlert() {
        let url = runtime.appendingPathComponent("reception-v2-health.json")
        guard let data = try? Data(contentsOf: url),
              let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        guard let alert = receptionHealthAlert(status) else {
            healthPanel?.orderOut(nil)
            healthPanel = nil
            shownIncident = nil
            return
        }
        guard alert.incidentID != shownIncident, alert.incidentID != dismissedIncident else { return }
        healthPanel?.orderOut(nil)
        shownIncident = alert.incidentID
        healthPanel = makeHealthPanel(alert)
        healthPanel?.orderFrontRegardless()
        NSSound(named: NSSound.Name("Glass"))?.play()
        if healthPanel?.isVisible == true {
            let event = "reception_health_alert_visible " + alert.kind + "\n"
            FileHandle.standardError.write(Data(event.utf8))
        }
    }

    func makeHealthPanel(_ alert: ReceptionHealthAlert) -> CardPanel {
        let bounds = NSRect(x: 0, y: 0, width: 430, height: 176)
        let window = CardPanel(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window.setFrameOrigin(NSPoint(x: screen.maxX - bounds.width - 24, y: screen.maxY - bounds.height - 24))
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .white
        window.hasShadow = true
        let content = NSView(frame: bounds)
        window.contentView = content
        let title = NSTextField(labelWithString: alert.title)
        title.font = .boldSystemFont(ofSize: 17)
        title.textColor = .systemRed
        title.frame = NSRect(x: 18, y: 132, width: 394, height: 25)
        content.addSubview(title)
        let time = DateFormatter()
        time.timeZone = TimeZone(identifier: "Asia/Shanghai")
        time.dateFormat = "MM-dd HH:mm:ss"
        let lastRead = alert.lastRead.map(time.string(from:)) ?? "暂无记录"
        let message = NSTextField(wrappingLabelWithString: "最后成功读取  " + lastRead + "\n" + alert.action)
        message.frame = NSRect(x: 18, y: 56, width: 394, height: 61)
        content.addSubview(message)
        let close = CardButton(title: "知道了", target: self, action: #selector(dismissHealthAlert(_:)))
        close.frame = NSRect(x: 315, y: 15, width: 97, height: 29)
        content.addSubview(close)
        return window
    }

    @objc private func dismissHealthAlert(_ sender: NSButton) {
        if let incident = shownIncident {
            dismissedIncident = incident
            try? saveDismissedNotices([incident], to: dismissalURL)
        }
        healthPanel?.orderOut(nil)
        healthPanel = nil
    }

    private func refresh() {
        refreshHealthAlert()
        let currentCards = cards()
        pendingAcknowledgements = pendingAcknowledgements.filter { pendingId in
            !currentCards.contains { $0["noticeId"] as? String == pendingId && ($0["acknowledgedAt"] as? String) != nil }
        }
        guard let card = nextVisibleCard(currentCards, excluding: pendingAcknowledgements.union(dismissedIds)),
              let id = card["noticeId"] as? String else {
            panel?.orderOut(nil); panel = nil; currentId = nil; return
        }
        let revision = try? JSONSerialization.data(withJSONObject: card, options: [.sortedKeys])
        if currentId == id, currentRevision == revision, panel?.isVisible == true { return }
        if currentId != id { expandedRecord = false }
        currentId = id
        currentRevision = revision
        panel?.orderOut(nil)
        let created = makePanel(card: card)
        panel = created
        created.orderFrontRegardless()
    }

    func makePanel(card: [String: Any]) -> CardPanel {
        let presentation = receptionCardPresentation(card)
        let width: CGFloat = 420, padding: CGFloat = 24, bodyWidth = width - 2 * padding
        let document = TopDownView(frame: NSRect(x: 0, y: 0, width: bodyWidth, height: 0))
        var cursor: CGFloat = 0
        let ink = NSColor(calibratedWhite: 0.14, alpha: 1)
        let secondary = NSColor(calibratedWhite: 0.43, alpha: 1)
        func text(_ value: String, size: CGFloat = 14, weight: NSFont.Weight = .regular,
                  color: NSColor? = nil, gap: CGFloat = 8) {
            let label = NSTextField(wrappingLabelWithString: value)
            label.font = .systemFont(ofSize: size, weight: weight)
            label.textColor = color ?? ink
            label.maximumNumberOfLines = 0
            let height = ceil(label.sizeThatFits(NSSize(width: bodyWidth, height: 10000)).height)
            label.frame = NSRect(x: 0, y: cursor, width: bodyWidth, height: max(18, height))
            document.addSubview(label)
            cursor += max(18, height) + gap
        }
        let statusWidth: CGFloat = min(178, max(72, CGFloat(presentation.contact.count) * 12 + 16))
        let name = NSTextField(wrappingLabelWithString: presentation.customer)
        name.font = .systemFont(ofSize: 14, weight: .semibold)
        name.textColor = ink
        let nameHeight = max(20, ceil(name.sizeThatFits(NSSize(width: bodyWidth - statusWidth - 12, height: 10000)).height))
        name.frame = NSRect(x: 0, y: cursor, width: bodyWidth - statusWidth - 12, height: nameHeight)
        document.addSubview(name)
        let status = NSTextField(wrappingLabelWithString: presentation.contact)
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.textColor = NSColor(calibratedRed: 0.05, green: 0.43, blue: 0.33, alpha: 1)
        let statusHeight = max(20, ceil(status.sizeThatFits(NSSize(width: statusWidth, height: 10000)).height))
        status.frame = NSRect(x: bodyWidth - statusWidth, y: cursor, width: statusWidth, height: statusHeight)
        status.alignment = .right
        document.addSubview(status)
        cursor += max(nameHeight, statusHeight) + 5
        text(presentation.openedAt.replacingOccurrences(of: "（北京时间）", with: " · 北京时间"), size: 12, color: secondary, gap: 20)
        let visibleLines = expandedRecord ? presentation.lines : compactReceptionLines(presentation.lines)
        if visibleLines.count < presentation.lines.count { text("更早的对话见完整记录", size: 12, color: secondary) }
        for line in visibleLines {
            if line.isReceipt {
                text(line.caption + "  " + line.text, size: 12, color: secondary, gap: 18)
            } else {
                text(line.caption, size: 12, weight: .medium, color: secondary, gap: 4)
                text(line.text, gap: 18)
            }
        }
        cursor += 2
        text("已完成：" + presentation.completed, size: 13, gap: 6)
        text("下一步：" + presentation.next, size: 13, weight: .medium, gap: 0)
        if expandedRecord {
            cursor += 22
            text("记录说明", size: 12, weight: .semibold, color: secondary)
            text("消息与名片仅按本程序保存的平台确认记录展示。缺少时间或发送记录时保留缺失说明。", size: 12, color: secondary)
            if let details = card["details"], let data = try? JSONSerialization.data(withJSONObject: details, options: [.prettyPrinted, .sortedKeys]), let detailText = String(data: data, encoding: .utf8) {
                text(detailText, size: 11, color: secondary, gap: 0)
            }
        }
        let documentHeight = ceil(cursor)
        document.frame.size.height = documentHeight
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let bodyHeight = min(documentHeight, max(180, screen.height - 210))
        let size = NSSize(width: width, height: 64 + bodyHeight + 72)
        let panel = CardPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.appearance = NSAppearance(named: .aqua)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.becomesKeyOnlyIfNeeded = true
        panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 24, y: screen.maxY - size.height - 24))
        let content = TopDownView(frame: NSRect(origin: .zero, size: size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.white.cgColor
        content.layer?.cornerRadius = 16
        content.layer?.masksToBounds = true
        panel.contentView = content
        let title = NSTextField(labelWithString: "客户接待")
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        title.textColor = ink
        title.frame = NSRect(x: padding, y: 23, width: 240, height: 22)
        content.addSubview(title)
        func button(_ title: String, action: Selector, frame: NSRect) -> CardButton {
            let control = CardButton(title: title, target: self, action: action)
            control.isBordered = false
            control.font = .systemFont(ofSize: 13, weight: .medium)
            control.attributedTitle = NSAttributedString(string: title, attributes: [.font: control.font!, .foregroundColor: ink])
            control.frame = frame
            control.focusRingType = .none
            content.addSubview(control)
            return control
        }
        let close = button("关闭 ×", action: #selector(dismissCard(_:)), frame: NSRect(x: width - 96, y: 18, width: 76, height: 32))
        close.identifier = NSUserInterfaceItemIdentifier("close-card")
        close.toolTip = "关闭当前提醒，本批旧提醒不会再弹出"
        let scroll = NSScrollView(frame: NSRect(x: padding, y: 64, width: bodyWidth, height: bodyHeight))
        scroll.hasVerticalScroller = documentHeight > bodyHeight
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.drawsBackground = false
        scroll.documentView = document
        content.addSubview(scroll)
        scroll.contentView.scroll(to: .zero)
        let footerY = size.height - 52
        let history = button(expandedRecord ? "收起记录" : "查看完整记录", action: #selector(showFullRecord(_:)), frame: NSRect(x: padding - 6, y: footerY, width: 116, height: 32))
        history.identifier = NSUserInterfaceItemIdentifier("full-record")
        let ack = button("知道了", action: #selector(acknowledge(_:)), frame: NSRect(x: width - padding - 96, y: footerY, width: 96, height: 32))
        ack.identifier = NSUserInterfaceItemIdentifier(card["noticeId"] as? String ?? "")
        ack.wantsLayer = true
        ack.layer?.backgroundColor = NSColor(calibratedWhite: 0.94, alpha: 1).cgColor
        ack.layer?.cornerRadius = 7
        return panel
    }

    @objc private func showFullRecord(_ sender: NSButton) {
        guard let id = currentId, let card = cards().first(where: { $0["noticeId"] as? String == id }) else { return }
        expandedRecord.toggle()
        let wasVisible = panel?.isVisible == true
        panel?.orderOut(nil)
        let created = makePanel(card: card)
        panel = created
        if wasVisible { created.orderFrontRegardless() }
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

#if !RECEPTION_NOTIFIER_TESTS
@main
struct ReceptionNotifierMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

#endif
