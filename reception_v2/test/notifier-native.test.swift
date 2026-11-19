import AppKit
import Foundation

@main
struct NotifierNativeTest {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let args = CommandLine.arguments
        let directory = URL(fileURLWithPath: args[args.firstIndex(of: "--runtime")! + 1], isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("reception-v2-notification-queue.json")
        let original: [[String: Any]] = [
            ["noticeId": "native-a", "kind": "ready_to_follow", "fields": ["客户": "测试客户", "联系方式": "已添加企微", "下一步": "销售联系客户"], "details": ["customerText": "我要美国仓报价"]],
            ["noticeId": "native-b", "kind": "ready_to_follow"]
        ]
        let originalData = try JSONSerialization.data(withJSONObject: original)
        try originalData.write(to: file)
        let delegate = AppDelegate()
        let card = delegate.makePanel(card: original[0])
        delegate.panel = card
        delegate.currentId = "native-a"
        precondition(!card.isVisible && !card.canBecomeKey && !card.canBecomeMain)
        guard let content = card.contentView else { fatalError("missing content") }
        func control(_ title: String, in panel: NSPanel) -> NSButton {
            guard let button = panel.contentView?.subviews.compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else { fatalError("missing control: \(title)") }
            precondition(button.isEnabled && button.target != nil && button.action != nil)
            precondition(panel.contentView!.bounds.contains(button.frame), "control is outside the window")
            return button
        }
        let close = control("关闭 ×", in: card)
        let ack = control("知道了", in: card)
        let history = control("查看完整记录", in: card)
        precondition(card.frame.height < 420, "short conversation must not leave a fixed tall blank panel")
        let scroll = content.subviews.compactMap({ $0 as? NSScrollView }).first!
        precondition(scroll.frame.maxY < ack.frame.minY, "footer overlaps transcript")
        history.performClick(nil)
        precondition(delegate.expandedRecord, "full record action did not expand")
        precondition(delegate.panel?.isVisible == false, "offscreen test must not display any window")
        _ = control("收起记录", in: delegate.panel!)
        let expanded = delegate.panel!
        control("收起记录", in: expanded).performClick(nil)
        precondition(!delegate.expandedRecord)
        close.performClick(nil)
        precondition(loadDismissedNotices(from: directory.appendingPathComponent("reception-v2-dismissed-notices.json")) == ["native-a", "native-b"])
        let queueAfterClose = try! Data(contentsOf: file)
        precondition(queueAfterClose == originalData, "close must not mutate business queue")
        let request = directory.appendingPathComponent("reception-v2-notification-ack-request.json")
        precondition(!FileManager.default.fileExists(atPath: request.path), "close must not manufacture acknowledgement")
        ack.performClick(nil)
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: request)) as! [String: Any]
        precondition(saved["noticeIds"] as? [String] == ["native-a"], "only clicked card may be acknowledged")
        let second = delegate.makePanel(card: original[1])
        control("知道了", in: second).performClick(nil)
        let merged = try JSONSerialization.jsonObject(with: Data(contentsOf: request)) as! [String: Any]
        precondition(merged["noticeIds"] as? [String] == ["native-a", "native-b"], "a rapid second click must preserve first pending acknowledgement")
        precondition(loadPendingAcknowledgements(from: request) == ["native-a", "native-b"], "restart must retain pending acknowledgements")
        let longText = String(repeating: "这是客户的长消息，需要在正文中滚动查看。", count: 90)
        let longCard = delegate.makePanel(card: ["fields": ["客户": "测试客户"], "details": ["customerText": longText]])
        _ = control("关闭 ×", in: longCard)
        _ = control("知道了", in: longCard)
        precondition(longCard.frame.height <= (NSScreen.main?.visibleFrame.height ?? 900) - 48)
        precondition(longCard.contentView!.subviews.compactMap({ $0 as? NSScrollView }).first!.hasVerticalScroller)
        print("Native popup verified offscreen: compact layout, fixed controls, expand/collapse, persisted close, isolated ACK, rapid ACK merge, long transcript scrolling.")
    }
}
