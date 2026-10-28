// A user-requested, nonactivating audit panel. No accessibility events, browser
// control, application activation, mouse/keyboard injection or remote content.
import AppKit
import Foundation
import Darwin

let auditPopupImplementationVersion = "2026-10-27-customer-brief-v4"

final class AuditPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// Draw plain, read-only text directly. This does not depend on NSTextView's
// editable text system, selection state or viewport layout lifecycle.
@MainActor final class AuditBodyView: NSView {
    private let inset: CGFloat = 12
    private var text = NSAttributedString(string: "")
    private(set) var characterCount = 0
    private(set) var measuredTextHeight: CGFloat = 0
    private(set) var contentRevision = 0
    private(set) var lastDrawnRevision = 0
    private(set) var drawCount = 0
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { false }

    func setText(_ value: String, viewportSize: NSSize) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 2
        text = NSAttributedString(string: value, attributes: [
            .font: NSFont.systemFont(ofSize: 15),
            .foregroundColor: NSColor.textColor,
            .paragraphStyle: paragraph
        ])
        characterCount = value.count
        contentRevision += 1
        let width = max(viewportSize.width, 2 * inset + 1)
        let availableWidth = width - 2 * inset
        measuredTextHeight = ceil(text.boundingRect(
            with: NSSize(width: availableWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        ).height)
        frame = NSRect(x: 0, y: 0, width: width,
                       height: max(viewportSize.height, measuredTextHeight + 2 * inset))
        needsDisplay = true
    }

    var hasNonemptyLayout: Bool {
        characterCount > 0 && measuredTextHeight > 0 && frame.width > 2 * inset
            && frame.height >= measuredTextHeight + 2 * inset
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill()
        bounds.fill()
        text.draw(with: NSRect(x: inset, y: inset, width: bounds.width - 2 * inset,
                               height: measuredTextHeight),
                  options: [.usesLineFragmentOrigin, .usesFontLeading])
        drawCount += 1
        lastDrawnRevision = contentRevision
    }
}

func popupCompactText(_ value: String, maximum: Int) -> String {
    let flat = value.components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }.joined(separator: " ")
    return String(flat.prefix(maximum)) + (flat.count > maximum ? "…" : "")
}

func popupBriefLine(_ value: String, label: String, maximumLines: Int) -> String {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    paragraph.lineSpacing = 2
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15),
                                                    .paragraphStyle: paragraph]
    func height(_ text: String) -> CGFloat {
        NSAttributedString(string: text, attributes: attributes).boundingRect(
            with: NSSize(width: 420, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]).height
    }
    let maximumHeight = height(Array(repeating: "一", count: maximumLines).joined(separator: "\n"))
    let flat = popupCompactText(value, maximum: 600)
    let prefix = label + "："
    if height(prefix + flat) <= maximumHeight { return prefix + flat }
    var lower = 0, upper = flat.count
    while lower < upper {
        let middle = (lower + upper + 1) / 2
        if height(prefix + String(flat.prefix(middle)) + "…") <= maximumHeight { lower = middle }
        else { upper = middle - 1 }
    }
    return prefix + String(flat.prefix(lower)) + "…"
}

func popupBriefDetails(_ payload: [String: Any]) -> String {
    var brief: [String: String]
    let hasBusinessSummary = payload["customer_brief"] is [String: String]
        || payload["business_summary"] is [String: String]
    if let provided = payload["customer_brief"] as? [String: String] {
        brief = provided
    } else if let summary = payload["business_summary"] as? [String: String] {
        let quote = summary["customer_message"] ?? ""
        var customer = (summary["customer"] ?? "昵称未记录") + " · " + (summary["activity"] ?? "接待更新")
        if !quote.isEmpty && !["尚未开口", "原话未记录", "原话待核验"].contains(quote) {
            customer += "；客户说：" + quote
        }
        brief = ["customer": customer, "reply": summary["our_reply"] ?? "回复待确认",
                 "progress": (summary["lead"] ?? "尚未确认留资") + "；" + (summary["takeover"] ?? "接管待确认"),
                 "action": summary["next_step"] ?? "核验当前接待记录"]
    } else {
        let recordedName = payload["customer_name"] as? String ?? ""
        let customer = recordedName.isEmpty || recordedName.hasPrefix("UID ") ? "昵称未记录" : recordedName
        let reply = payload["reply_text"] as? String ?? ""
        brief = ["customer": customer + "；原话待核验",
                 "reply": reply.isEmpty ? "尚未记录回复" : "发送待确认：" + reply,
                 "progress": "尚未确认留资", "action": "先核验原消息，避免重复"]
    }
    var reply = brief["reply"] ?? "回复待确认"
    reply = reply.replacingOccurrences(of: "待核实", with: "待确认")
    let unknown = ["UNKNOWN", "SUBMITTING"].contains(payload["state"] as? String ?? "")
        || ["UNKNOWN", "SUBMITTING", "SENT_UNVERIFIED"].contains(payload["card_state"] as? String ?? "")
    if unknown && !reply.contains("待确认") { reply = "发送待确认；" + reply }
    // Remove the notifier's trailing display tag, but never derive success from
    // words inside a reply. A raw legacy draft cannot prove any card result.
    if let card = reply.range(of: "企微名片：", options: .backwards) {
        reply = String(reply[..<card.lowerBound]).trimmingCharacters(in:
            .whitespacesAndNewlines.union(CharacterSet(charactersIn: "；")))
    }
    let cardState = hasBusinessSummary ? (payload["customer_card_state"] as? String
        ?? payload["card_state"] as? String ?? "NOT_CONFIRMED") : "NOT_CONFIRMED"
    let cardResult = cardState == "SENT" ? "已核验发送" :
        ["UNKNOWN", "SUBMITTING", "SENT_UNVERIFIED"].contains(cardState) ? "待确认" : "尚未确认发送"
    reply = "企微名片：" + cardResult + (reply.isEmpty ? "" : "；" + reply)
    brief["reply"] = reply
    let fields = [("customer", "客户", 2), ("reply", "回复", 3),
                  ("progress", "进展", 2), ("action", "处理", 2)]
    return fields.map { key, label, lines in
        popupBriefLine(brief[key] ?? "待核验", label: label, maximumLines: lines)
    }.joined(separator: "\n\n")
}

func popupTechnicalDetails(_ payload: [String: Any]) -> String {
    let details = payload["technical_details"] as? [String: Any] ?? payload
    guard !details.isEmpty else { return "" }
    guard JSONSerialization.isValidJSONObject(details),
          let data = try? JSONSerialization.data(withJSONObject: details,
              options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
          let value = String(data: data, encoding: .utf8) else { return "技术记录暂不可用" }
    return String(value.prefix(60000)) + (value.count > 60000 ? "\n…（详情过长，已截断）" : "")
}

struct PopupPresentation {
    private(set) var noticeID: String?
    private(set) var groupedNoticeIDs: [String]?
    private(set) var detailsExpanded = false
    private(set) var brief = ""
    private(set) var technical = ""
    private var validMembers = true
    var briefFieldCount: Int { noticeID == nil ? 0 : 4 }
    var detailsAvailable: Bool { !technical.isEmpty }
    var groupedMemberCount: Int { groupedNoticeIDs?.count ?? (noticeID == nil ? 0 : 1) }
    var displayText: String {
        detailsExpanded ? brief + "\n\n技术详情\n" + technical : brief
    }

    mutating func update(_ payload: [String: Any]) {
        guard let id = payload["notice_id"] as? String, !id.isEmpty, id.count <= 512 else { return }
        if id != noticeID { detailsExpanded = false }
        noticeID = id
        brief = popupBriefDetails(payload)
        technical = popupTechnicalDetails(payload)
        if !detailsAvailable { detailsExpanded = false }
        validMembers = true
        groupedNoticeIDs = nil
        if payload["grouped_notice_ids"] != nil {
            if let members = payload["grouped_notice_ids"] as? [String], !members.isEmpty,
               members.contains(id), Set(members).count == members.count,
               members.allSatisfy({ !$0.isEmpty && $0.count <= 512 }) {
                groupedNoticeIDs = members
            } else { validMembers = false }
        }
    }

    mutating func toggleDetails() {
        if detailsAvailable { detailsExpanded.toggle() }
    }

    func acknowledgement(at timestamp: String) -> [String: Any]? {
        guard let id = noticeID, validMembers else { return nil }
        var result: [String: Any] = ["version": 1, "notice_id": id, "action": "mark_read",
                                     "acknowledged_at_utc": timestamp]
        if let members = groupedNoticeIDs { result["notice_ids"] = members }
        return result
    }
}

func popupRenderedAcknowledgement(_ presentation: PopupPresentation, contentRevision: Int,
                                  drawnRevision: Int, at timestamp: String) -> [String: Any]? {
    guard contentRevision > 0, drawnRevision == contentRevision else { return nil }
    return presentation.acknowledgement(at: timestamp)
}

func writeJSON(_ value: [String: Any], to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".popup-" + UUID().uuidString)
    let fd = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { close(fd); unlink(temporary.path) }
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            guard count > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            offset += count
        }
    }
    guard fsync(fd) == 0, rename(temporary.path, url.path) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}

@MainActor final class AuditPopup: NSObject, NSApplicationDelegate {
    let runtime: URL
    let payloadURL: URL
    let ackURL: URL
    let healthURL: URL
    let panel: AuditPanel
    let heading = NSTextField(wrappingLabelWithString: "")
    let subtitle = NSTextField(wrappingLabelWithString: "")
    let body = AuditBodyView()
    let bodyScroll = NSScrollView()
    let status = NSTextField(wrappingLabelWithString: "")
    let review = NSButton(title: "知道了", target: nil, action: nil)
    let detailsButton = NSButton(title: "技术详情", target: nil, action: nil)
    var presentation = PopupPresentation()
    var noticeID: String?
    var acknowledgedID: String?
    var timer: Timer?
    var lastHealth: TimeInterval = 0
    var frontmostBefore: String?
    var frontmostAfter: String?
    var lastPayload: Data?

    init(runtime: URL) {
        self.runtime = runtime
        payloadURL = runtime.appendingPathComponent("popup-current.json")
        ackURL = runtime.appendingPathComponent("popup-ack.json")
        healthURL = runtime.appendingPathComponent("popup-status.json")
        panel = AuditPanel(contentRect: NSRect(x: 0, y: 0, width: 510, height: 530),
                           styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let data = try? Data(contentsOf: ackURL),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           value["version"] as? Int == 1, value["action"] as? String == "mark_read" {
            acknowledgedID = value["notice_id"] as? String
        }
        panel.title = "小红书接待动态"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 510, height: 530))
        panel.contentView = content
        heading.font = .boldSystemFont(ofSize: 20)
        heading.frame = NSRect(x: 20, y: 463, width: 470, height: 46)
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        subtitle.frame = NSRect(x: 20, y: 412, width: 470, height: 48)
        bodyScroll.frame = NSRect(x: 20, y: 132, width: 470, height: 276)
        bodyScroll.hasVerticalScroller = true
        bodyScroll.borderType = .bezelBorder
        bodyScroll.documentView = body
        body.setText("", viewportSize: bodyScroll.contentSize)
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 20, y: 48, width: 310, height: 46)
        review.bezelStyle = .rounded
        review.frame = NSRect(x: 350, y: 38, width: 140, height: 42)
        review.target = self
        review.action = #selector(markRead)
        detailsButton.bezelStyle = .rounded
        detailsButton.frame = NSRect(x: 20, y: 94, width: 130, height: 28)
        detailsButton.target = self
        detailsButton.action = #selector(toggleDetails)
        detailsButton.isEnabled = false
        // No default key equivalent; this panel never takes keyboard focus.
        [heading, subtitle, bodyScroll, status, detailsButton, review].forEach { content.addSubview($0) }
        if let screen = NSScreen.main {
            let area = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: area.maxX - 530, y: area.maxY - 560))
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        tick()
    }

    func string(_ object: [String: Any], _ key: String, maximum: Int = 12000) -> String {
        guard let value = object[key] as? String else { return "" }
        return String(value.prefix(maximum))
    }

    func tick() {
        defer { saveHealthIfDue() }
        do {
            let properties = try payloadURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard properties.isRegularFile == true, (properties.fileSize ?? Int.max) <= 262144 else { return }
            let data = try Data(contentsOf: payloadURL)
            guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  payload["version"] as? Int == 1 else { return }
            let id = string(payload, "notice_id", maximum: 512)
            guard !id.isEmpty else { return }
            let count = max(1, min(payload["pending_customer_count"] as? Int ?? payload["pending_count"] as? Int ?? 1, 99999))
            status.stringValue = "还有 \(count) 位客户动态\n仅确认通知，不影响自动接待。"
            if id != acknowledgedID && (id != noticeID || data != lastPayload) {
                let isNew = id != noticeID
                noticeID = id
                lastPayload = data
                let businessTitle = string(payload, "business_title", maximum: 180)
                heading.stringValue = businessTitle.isEmpty ? "客户接待更新" : businessTitle
                subtitle.stringValue = string(payload, "business_subtitle", maximum: 400)
                let result = string(payload, "state", maximum: 80)
                heading.textColor = ["UNKNOWN", "BLOCKED", "EXPIRED", "NOT_SENT"].contains(result) ? .systemRed : .labelColor
                presentation.update(payload)
                refreshBody()
                if isNew {
                    bodyScroll.contentView.scroll(to: .zero)
                    bodyScroll.reflectScrolledClipView(bodyScroll.contentView)
                    frontmostBefore = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
                    panel.orderFrontRegardless() // Does not activate this application.
                    frontmostAfter = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
                    NSSound(named: NSSound.Name("Glass"))?.play()
                }
                lastHealth = 0
            }
        } catch {
            // A partly updated/missing payload never dismisses the unread panel.
        }
    }

    func refreshBody() {
        body.setText(presentation.displayText, viewportSize: bodyScroll.contentSize)
        detailsButton.isEnabled = presentation.detailsAvailable
        detailsButton.title = presentation.detailsExpanded ? "收起详情" : "技术详情"
    }

    @objc func toggleDetails() {
        guard noticeID != nil, presentation.detailsAvailable else { return }
        presentation.toggleDetails()
        refreshBody()
        bodyScroll.contentView.scroll(to: .zero)
        bodyScroll.reflectScrolledClipView(bodyScroll.contentView)
        lastHealth = 0
    }

    func saveHealthIfDue() {
        if Date().timeIntervalSince1970 - lastHealth >= 5 {
            lastHealth = Date().timeIntervalSince1970
            try? writeJSON([
                "version": 1, "running": true, "pid": ProcessInfo.processInfo.processIdentifier,
                "implementation_version": auditPopupImplementationVersion,
                "recorded_at_utc": ISO8601DateFormatter().string(from: Date()),
                "notice_id": noticeID as Any? ?? NSNull(), "window_visible_reported": panel.isVisible,
                "window_is_key": panel.isKeyWindow, "window_is_main": panel.isMainWindow,
                "can_become_key": panel.canBecomeKey, "can_become_main": panel.canBecomeMain,
                "frontmost_before_show": frontmostBefore as Any? ?? NSNull(),
                "frontmost_after_show": frontmostAfter as Any? ?? NSNull(),
                "frontmost_current": NSWorkspace.shared.frontmostApplication?.bundleIdentifier as Any? ?? NSNull(),
                "body_renderer": "plain_attributed_string_draw",
                "body_character_count": body.characterCount,
                "body_nonempty_layout": body.hasNonemptyLayout,
                "body_frame_width": body.frame.width, "body_frame_height": body.frame.height,
                "body_measured_text_height": body.measuredTextHeight,
                "body_content_revision": body.contentRevision,
                "body_last_drawn_revision": body.lastDrawnRevision,
                "body_draw_count": body.drawCount,
                "brief_field_count": presentation.briefFieldCount,
                "details_available": presentation.detailsAvailable,
                "details_expanded": presentation.detailsExpanded,
                "grouped_member_count": presentation.groupedMemberCount,
                "human_visibility_verified": false,
                "verification_note": "Local helper state only; user confirmation establishes visible popup."
            ], to: healthURL)
        }
    }

    @objc func markRead() {
        guard let id = noticeID else { return }
        guard let acknowledgement = popupRenderedAcknowledgement(presentation,
                contentRevision: body.contentRevision, drawnRevision: body.lastDrawnRevision,
                at: ISO8601DateFormatter().string(from: Date())) else {
            status.stringValue = "通知正在更新，本次未确认。\n请稍后再点，接待不受影响。"
            return
        }
        do {
            try writeJSON(acknowledgement, to: ackURL)
            acknowledgedID = id
            panel.orderOut(nil)
            lastHealth = 0
        } catch { status.stringValue = "未能保存审阅标记，请重试。接待不受影响。" }
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[1] == "--runtime", arguments[2].hasPrefix("/") else {
    fputs("usage: audit-popup --runtime /existing/private/runtime\n", stderr); exit(2)
}
let runtime = URL(fileURLWithPath: arguments[2], isDirectory: true).standardizedFileURL
guard (try? runtime.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { exit(2) }
let lockPath = runtime.appendingPathComponent("popup-helper.lock").path
let lockFD = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { exit(3) }
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AuditPopup(runtime: runtime)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
