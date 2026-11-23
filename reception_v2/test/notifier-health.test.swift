import Foundation

@main
struct NotifierHealthTest {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let clock = ISO8601DateFormatter()
        let fresh = clock.string(from: now)
        let stale = clock.string(from: now.addingTimeInterval(-120))
        let healthy: [String: Any] = ["armed": true, "running": true,
            "last_tick_at_utc": fresh, "last_successful_sidebar_read_at": fresh]
        precondition(receptionHealthAlert(healthy, now: now) == nil)
        var status = healthy
        status["error"] = "auth_required"
        status["running"] = false
        precondition(receptionHealthAlert(status, now: now)?.kind == "auth_required")
        status = healthy
        status["last_tick_at_utc"] = stale
        precondition(receptionHealthAlert(status, now: now)?.kind == "heartbeat_stalled")
        status = healthy
        status["last_successful_sidebar_read_at"] = stale
        precondition(receptionHealthAlert(status, now: now)?.kind == "sidebar_stalled")
        status = healthy
        status["running"] = false
        status["send_state"] = "stopped"
        precondition(receptionHealthAlert(status, now: now)?.kind == "worker_stopped")
        print("5 health popup scenarios passed")
    }
}
