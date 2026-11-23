import Foundation

func nextVisibleCard(_ cards: [[String: Any]], excluding pendingAcknowledgements: Set<String>) -> [String: Any]? {
    cards.first { card in
        guard let noticeId = card["noticeId"] as? String else { return false }
        guard card["kind"] as? String == "ready_to_follow" else { return false }
        let acknowledged = card["acknowledgedAt"] != nil && !(card["acknowledgedAt"] is NSNull)
        return !acknowledged && !pendingAcknowledgements.contains(noticeId)
    }
}

func loadDismissedNotices(from url: URL) -> Set<String> {
    guard let data = try? Data(contentsOf: url),
          let ids = try? JSONDecoder().decode([String].self, from: data) else { return [] }
    return Set(ids)
}

func saveDismissedNotices(_ ids: Set<String>, to url: URL) throws {
    let data = try JSONEncoder().encode(ids.sorted())
    try data.write(to: url, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

struct ReceptionDialogueLine {
    let caption: String
    let text: String
    let isReceipt: Bool
}

struct ReceptionCardPresentation {
    let customer: String
    let contact: String
    let openedAt: String
    let lines: [ReceptionDialogueLine]
    let completed: String
    let next: String
}

private func usefulPopupText(_ value: Any?) -> String? {
    guard let value = value as? String else { return nil }
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty || ["尚未记录客户文字原话", "原话未记录", "尚未记录客户文字开口", "开口时间未留存", "时间未记录", "本程序没有发送记录"].contains(text) { return nil }
    return text
}

private func popupTime(_ value: Any?) -> String {
    guard let ms = value as? NSNumber, ms.doubleValue > 0 else { return "时间未留存" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
    formatter.dateFormat = "MM月dd日 HH:mm:ss"
    return formatter.string(from: Date(timeIntervalSince1970: ms.doubleValue / 1000))
}

func receptionCardPresentation(_ card: [String: Any]) -> ReceptionCardPresentation {
    let fields = card["fields"] as? [String: String] ?? [:]
    let timeline = card["timeline"] as? [String: Any] ?? [:]
    let details = card["details"] as? [String: Any] ?? [:]
    var lines: [ReceptionDialogueLine] = []
    let messages = timeline["messages"] as? [[String: Any]] ?? []
    var sentText = false, sentCard = false, hasOurRecord = false
    for message in messages {
        guard let text = usefulPopupText(message["text"]) else { continue }
        let time = popupTime(message["timeMs"])
        if message["role"] as? String == "customer" {
            lines.append(ReceptionDialogueLine(caption: "客户  " + time, text: text, isReceipt: false))
        } else if message["role"] as? String == "our" {
            hasOurRecord = true
            let confirmed = message["status"] as? String == "confirmed"
            if message["kind"] as? String == "card" {
                sentCard = sentCard || (confirmed && message["isAfterLatestCustomer"] as? Bool == true)
                let status = confirmed ? "企业微信名片已发出" : "企业微信名片：" + popupSendStatus(message["status"] as? String)
                lines.append(ReceptionDialogueLine(caption: time, text: status, isReceipt: true))
            } else {
                sentText = sentText || (confirmed && message["isAfterLatestCustomer"] as? Bool == true)
                let status = confirmed ? "" : " · " + popupSendStatus(message["status"] as? String)
                lines.append(ReceptionDialogueLine(caption: "我方  " + time + status, text: text, isReceipt: false))
            }
        }
    }
    if !lines.contains(where: { $0.caption.hasPrefix("客户") }), let quote = usefulPopupText(timeline["customerText"]) ?? usefulPopupText(details["customerText"]) ?? usefulPopupText(details["customer_text"]) {
        let time = usefulPopupText(timeline["openedAt"]) ?? "时间未留存"
        lines.insert(ReceptionDialogueLine(caption: "客户  " + time, text: quote, isReceipt: false), at: 0)
    }
    if !hasOurRecord {
        if let saved = usefulPopupText(timeline["sentMessages"]) {
            lines.append(ReceptionDialogueLine(caption: "我方记录", text: saved, isReceipt: false))
        } else {
            lines.append(ReceptionDialogueLine(caption: "我方", text: "本程序没有保存发送记录", isReceipt: true))
        }
    }
    var completed: [String] = []
    if sentText { completed.append("回复客户") }
    if sentCard { completed.append("发送名片") }
    let contacts = details["contacts"] as? [[String: Any]] ?? []
    if contacts.contains(where: { $0["kind"] as? String == "wecom_added" && $0["verified"] as? Bool == true }) { completed.append("确认已加企微") }
    if completed.isEmpty, fields["我已完成"] == "已读取当前客户资料" { completed.append("已读取当前客户资料") }
    return ReceptionCardPresentation(
        customer: usefulPopupText(fields["客户"]) ?? "客户名称未留存",
        contact: usefulPopupText(fields["联系方式"]) ?? "尚未获得联系方式",
        openedAt: usefulPopupText(timeline["openedAt"]) ?? "开口时间未留存",
        lines: lines,
        completed: completed.isEmpty ? "尚无已确认操作" : completed.joined(separator: "、"),
        next: usefulPopupText(fields["下一步"]) ?? "查看客户情况"
    )
}

private func popupSendStatus(_ status: String?) -> String {
    switch status {
    case "failed": return "发送失败"
    case "prepared": return "尚未提交"
    default: return "未确认发出"
    }
}

func loadPendingAcknowledgements(from url: URL) -> Set<String> {
    guard let data = try? Data(contentsOf: url),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
    return Set(request["noticeIds"] as? [String] ?? [request["noticeId"] as? String].compactMap { $0 })
}

func compactReceptionLines(_ lines: [ReceptionDialogueLine]) -> [ReceptionDialogueLine] {
    let start = max(0, lines.count - 6)
    var indexes = Set(start..<lines.count)
    if let lastCustomer = lines.lastIndex(where: { $0.caption.hasPrefix("客户  ") }) { indexes.insert(lastCustomer) }
    return indexes.sorted().map { lines[$0] }
}

struct ReceptionHealthAlert {
    let kind: String
    let title: String
    let action: String
    let lastRead: Date?

    var incidentID: String {
        kind + ":" + (lastRead.map { String($0.timeIntervalSince1970) } ?? "none")
    }
}

func receptionHealthAlert(_ status: [String: Any], now: Date = Date()) -> ReceptionHealthAlert? {
    guard status["armed"] as? Bool == true else { return nil }
    let clock = ISO8601DateFormatter()
    func date(_ key: String) -> Date? {
        guard let value = status[key] as? String else { return nil }
        clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = clock.date(from: value) { return parsed }
        clock.formatOptions = [.withInternetDateTime]
        return clock.date(from: value)
    }
    let lastRead = date("last_successful_sidebar_read_at")
    let issue: (String, String, String)
    if status["error"] as? String == "auth_required" {
        issue = ("auth_required", "紧急：小红书登录失效，自动接待已停止", "请从项目目录打开“重新登录小红书.command”，完成原账号验证。")
    } else if status["running"] as? Bool == false {
        issue = ("worker_stopped", "紧急：小红书自动接待已停止", "后台服务当前未运行，请查看接待自检。")
    } else if date("last_tick_at_utc").map({ now.timeIntervalSince($0) > 90 }) ?? true {
        issue = ("heartbeat_stalled", "紧急：小红书接待心跳中断", "后台状态已超过 90 秒未更新，请查看接待自检。")
    } else if lastRead.map({ now.timeIntervalSince($0) > 90 }) ?? true {
        // A new worker may need time to finish its initial read.
        if lastRead == nil, let started = date("started_at_utc"), now.timeIntervalSince(started) <= 90 { return nil }
        issue = ("sidebar_stalled", "紧急：小红书消息读取中断", "后台未取得新消息读取记录，请查看接待自检。")
    } else { return nil }
    return ReceptionHealthAlert(kind: issue.0, title: issue.1, action: issue.2, lastRead: lastRead)
}
