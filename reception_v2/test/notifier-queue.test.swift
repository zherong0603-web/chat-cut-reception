import Foundation

@main
struct NotifierQueueTest {
    static func main() {
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
