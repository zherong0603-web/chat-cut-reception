import Foundation

@main
struct NotifierQueueTest {
    static func main() {
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
