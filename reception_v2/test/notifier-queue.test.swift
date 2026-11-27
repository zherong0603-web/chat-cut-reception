import Foundation

@main
struct NotifierQueueTest {
    static func main() {
        testDialoguePresentation()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try saveDismissedNotices(["a", "b"], to: url)
            precondition(loadDismissedNotices(from: url) == ["a", "b"])
            let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
            precondition(permissions == 0o600)
        } catch { fatalError("dismissal persistence failed: \(error)") }
        let cards: [[String: Any]] = [
            ["noticeId": "a", "kind": "ready_to_follow", "acknowledgedAt": NSNull()],
            ["noticeId": "failure", "kind": "send_failed", "acknowledgedAt": NSNull()],
            ["noticeId": "b", "kind": "ready_to_follow"],
            ["noticeId": "c", "kind": "ready_to_follow", "acknowledgedAt": "2026-10-28T00:00:00Z"],
        ]

        precondition(nextVisibleCard(cards, excluding: [])?["noticeId"] as? String == "a")
        precondition(nextVisibleCard(cards, excluding: ["a"])?["noticeId"] as? String == "b")
        precondition(nextVisibleCard(cards, excluding: ["a", "b"]) == nil)
    }
}

private func testDialoguePresentation() {
    let legacy: [String: Any] = [
        "fields": ["客户": "测试客户", "联系方式": "已添加企微", "我已完成": "已读取当前客户资料", "下一步": "销售联系客户"],
        "timeline": ["customerText": "尚未记录客户文字原话", "openedAt": "尚未记录客户文字开口", "sentMessages": "本程序没有发送记录"],
        "details": ["customerText": "想了解仓储服务"]
    ]
    let recovered = receptionCardPresentation(legacy)
    precondition(recovered.customer == "测试客户")
    precondition(recovered.openedAt == "开口时间未留存")
    precondition(recovered.lines.first?.text == "想了解仓储服务", "legacy placeholder must not hide saved customer speech")
    precondition(!recovered.completed.contains("回复客户"), "reading contact information is not replying")
    precondition(recovered.lines.contains { $0.text == "本程序没有保存发送记录" })
    let oldReplies = (0..<10).map { ["role": "our", "text": "旧回复\($0)", "kind": "text", "timeMs": 5000, "status": "confirmed", "isAfterLatestCustomer": false] as [String: Any] }
    let oldDialogue = receptionCardPresentation(["timeline": ["messages": [["role": "customer", "text": "客户最后的问题", "timeMs": 1000, "status": "observed"]] + oldReplies]])
    precondition(oldDialogue.lines.count == 11, "conversation must keep every stored line")
    precondition(oldDialogue.lines.contains { $0.text == "客户最后的问题" }, "card must keep latest customer speech")
    precondition(!oldDialogue.completed.contains("回复客户"), "old replies cannot count as answering the latest question")
    let unsafeLegacy = receptionCardPresentation(["fields": ["我已完成": "已发文字和企微卡"]])
    precondition(!unsafeLegacy.completed.contains("已发文字"), "legacy summaries cannot substitute for receipts")

    let structured: [String: Any] = [
        "fields": ["客户": "测试客户", "联系方式": "已添加企微"],
        "timeline": ["openedAt": "2026-11-19 19:23:45（北京时间）", "messages": [
            ["role": "customer", "timeMs": 1795087425000, "text": "美国仓", "status": "observed"],
            ["role": "our", "timeMs": 1795087427000, "text": "请添加下方企微", "status": "confirmed", "kind": "text", "isAfterLatestCustomer": true],
            ["role": "our", "timeMs": 1795087428000, "text": "企业微信名片", "status": "uncertain", "kind": "card"]
        ]]
    ]
    let dialogue = receptionCardPresentation(structured)
    precondition(dialogue.lines.count == 3)
    precondition(dialogue.lines[0].caption.contains("19:23:45"))
    precondition(dialogue.lines[1].caption.hasPrefix("我方"))
    precondition(dialogue.lines[2].text.contains("未确认发出"))
    precondition(!dialogue.completed.contains("发送名片"), "uncertain card must not become a completed action")
    precondition(dialogue.completed.contains("回复客户"))

    let states = receptionCardPresentation(["timeline": ["messages": [
        ["role": "customer", "text": "问题一", "timeMs": 1795087425000, "replyStatus": "confirmed"],
        ["role": "customer", "text": "问题二", "timeMs": 1795087426000, "replyStatus": "uncertain"],
        ["role": "customer", "text": "最后一句", "timeMs": 1795087427000, "replyStatus": "no_record"]
    ]]])
    let customerStates = states.lines.filter { $0.caption.hasPrefix("客户  ") }
    precondition(customerStates.map(\.caption).map { $0.components(separatedBy: " · ").last! } == ["已回复", "回复待核实", "本程序无回复记录"])
    precondition(states.latestReplyStatus == "本程序无回复记录")
}
