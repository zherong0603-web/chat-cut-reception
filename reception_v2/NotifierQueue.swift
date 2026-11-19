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
