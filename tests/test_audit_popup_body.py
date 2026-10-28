"""Render the production read-only body offscreen; never create an NSWindow."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SDK = Path("/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk")
SWIFTC = Path("/Library/Developer/CommandLineTools/usr/bin/swiftc")

HARNESS = r'''
import AppKit
import Foundation

__PRODUCTION_BODY__

@MainActor func visibleInk(_ bitmap: NSBitmapImageRep) -> Int {
    // Text starts at the 12 px inset; sample the untouched background before it.
    let background = bitmap.colorAt(x: 8, y: 8)!.usingColorSpace(.deviceRGB)!
    var count = 0
    // Exclude the border and scroller, so chrome cannot pass the text check.
    for y in 25..<min(bitmap.pixelsHigh - 25, 275) {
        for x in 25..<min(bitmap.pixelsWide - 25, 425) {
            let color = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
            let delta = max(abs(color.redComponent - background.redComponent),
                            abs(color.greenComponent - background.greenComponent),
                            abs(color.blueComponent - background.blueComponent))
            if delta > 0.15 { count += 1 }
        }
    }
    return count
}

@MainActor func capture(_ scroll: NSScrollView, to url: URL) throws -> Int {
    let bitmap = scroll.bitmapImageRepForCachingDisplay(in: scroll.bounds)!
    scroll.cacheDisplay(in: scroll.bounds, to: bitmap)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
    return visibleInk(bitmap)
}

MainActor.assumeIsolated {
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let actual = popupBriefDetails([
        "customer_uid": "62985437000000001b02bead", "state": "UNKNOWN", "operation": "text",
        "customer_brief": ["customer": "，，，问报价多少？", "reply": "发送待确认，企微卡未确认",
                           "progress": "尚未确认留资", "action": "先核验原消息，避免重复"]])
    for label in ["客户：", "回复：", "进展：", "处理："] {
        precondition(actual.contains(label))
    }
    precondition(actual.contains("客户：，，，问报价多少？"))
    precondition(actual.contains("发送待确认"))
    precondition(!actual.contains("62985437000000001b02bead"))
    precondition(!actual.contains("UNKNOWN"))
    precondition(!actual.contains("NOT_CONFIRMED"))
    let legacy = popupBriefDetails(["customer_name": "UID 1b02bead", "state": "UNKNOWN",
                                   "customer_text": "从来源笔记进入", "reply_text": "草稿内容"])
    precondition(legacy.contains("客户：昵称未记录；原话待核验"))
    precondition(legacy.contains("发送待确认"))
    precondition(!legacy.contains("来源笔记"))
    let hostile = popupBriefDetails(["state": "UNKNOWN", "customer_brief": [
        "customer": String(repeating: "🇨🇳W<script>客户\n", count: 500),
        "reply": "待确认 " + String(repeating: "🇨🇳W恶意长原话\n", count: 500),
        "progress": String(repeating: "🇨🇳W尚未确认留资\n", count: 500),
        "action": "请先核验 " + String(repeating: "🇨🇳W不要重发\n", count: 500)]])
    precondition(hostile.contains("待确认"))
    precondition(hostile.contains("处理：请先核验"))
    let long = (1...240).map { "第\($0)行：原话与回复仅作纯文本显示，👋🏻 <script>客户数据</script>，不截断长正文。" }.joined(separator: "\n") + "\n尾部终点"
    var results: [[String: Any]] = []
    for appearanceName in [NSAppearance.Name.aqua, .darkAqua] {
        let mode = appearanceName == .aqua ? "light" : "dark"
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 470, height: 276))
        scroll.appearance = NSAppearance(named: appearanceName)
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let body = AuditBodyView()
        scroll.documentView = body
        body.setText("", viewportSize: scroll.contentSize)
        precondition(!body.hasNonemptyLayout)
        for (label, value) in [("actual", actual), ("hostile", hostile), ("long", long)] {
            body.setText(value, viewportSize: scroll.contentSize)
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
            let topInk = try! capture(scroll, to: output.appendingPathComponent("\(mode)-\(label)-top.png"))
            let topRevision = body.lastDrawnRevision
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, body.frame.height - scroll.contentSize.height)))
            scroll.reflectScrolledClipView(scroll.contentView)
            let bottomInk = try! capture(scroll, to: output.appendingPathComponent("\(mode)-\(label)-bottom.png"))
            results.append([
                "mode": mode, "case": label, "characters": body.characterCount,
                "nonempty_layout": body.hasNonemptyLayout, "height": body.frame.height,
                "text_height": body.measuredTextHeight,
                "viewport_height": scroll.contentSize.height,
                "top_ink_pixels": topInk, "bottom_ink_pixels": bottomInk,
                "scroll_y": scroll.contentView.bounds.minY,
                "content_revision": body.contentRevision, "top_drawn_revision": topRevision,
                "last_drawn_revision": body.lastDrawnRevision,
                "draw_count": body.drawCount, "accepts_first_responder": body.acceptsFirstResponder
            ])
        }
    }
    let data = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
'''


@unittest.skipUnless(sys.platform == "darwin" and SDK.exists() and SWIFTC.exists(),
                     "requires existing macOS AppKit SDK and Swift compiler")
class AuditPopupBodyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="chatcut-popup-body-test-")
        cls.output = Path(cls.temporary.name)
        source = (ROOT / "xhs_reception/audit_popup.swift").read_text()
        body = source[source.index("@MainActor final class AuditBodyView"):
                      source.index("\nfunc writeJSON")]
        harness = cls.output / "body.swift"
        harness.write_text(HARNESS.replace("__PRODUCTION_BODY__", body))
        executable = cls.output / "body-check"
        subprocess.run([str(SWIFTC), "-sdk", str(SDK), "-target", "arm64-apple-macos15",
                        "-framework", "AppKit", str(harness), "-o", str(executable)],
                       check=True, capture_output=True, text=True)
        result = subprocess.run([str(executable), str(cls.output)], check=True,
                                capture_output=True, text=True)
        cls.results = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_actual_notice_is_legible_in_both_appearances(self):
        cases = [row for row in self.results if row["case"] == "actual"]
        self.assertEqual({row["mode"] for row in cases}, {"dark", "light"})
        for row in cases:
            with self.subTest(mode=row["mode"]):
                self.assertTrue(row["nonempty_layout"])
                self.assertGreater(row["top_ink_pixels"], 500)
                self.assertGreater(row["bottom_ink_pixels"], 500)

    def test_long_notice_has_visible_text_at_top_and_bottom(self):
        for row in self.results:
            if row["case"] != "long":
                continue
            with self.subTest(mode=row["mode"]):
                self.assertGreater(row["characters"], 10000)
                self.assertGreater(row["height"], row["viewport_height"] * 10)
                self.assertGreater(row["scroll_y"], 0)
                self.assertGreater(row["top_ink_pixels"], 500)
                self.assertGreater(row["bottom_ink_pixels"], 500)

    def test_long_customer_fields_leave_all_four_brief_fields_in_first_viewport(self):
        cases = [row for row in self.results if row["case"] == "hostile"]
        self.assertEqual({row["mode"] for row in cases}, {"dark", "light"})
        for row in cases:
            with self.subTest(mode=row["mode"]):
                self.assertLessEqual(row["text_height"] + 24, row["viewport_height"])
                self.assertEqual(row["scroll_y"], 0)
                self.assertGreater(row["top_ink_pixels"], 500)

    def test_draw_evidence_tracks_the_current_noninteractive_content(self):
        for row in self.results:
            with self.subTest(mode=row["mode"], case=row["case"]):
                self.assertEqual(row["content_revision"], row["top_drawn_revision"])
                self.assertEqual(row["content_revision"], row["last_drawn_revision"])
                self.assertGreater(row["draw_count"], 0)
                self.assertFalse(row["accepts_first_responder"])


if __name__ == "__main__":
    unittest.main()
