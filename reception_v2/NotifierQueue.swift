import Foundation

func nextVisibleCard(_ cards: [[String: Any]], excluding pendingAcknowledgements: Set<String>) -> [String: Any]? {
    cards.first { card in
        guard let noticeId = card["noticeId"] as? String else { return false }
        guard card["kind"] as? String == "ready_to_follow" else { return false }
        let acknowledged = card["acknowledgedAt"] != nil && !(card["acknowledgedAt"] is NSNull)
        return !acknowledged && !pendingAcknowledgements.contains(noticeId)
    }
}
