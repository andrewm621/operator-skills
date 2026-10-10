// hidclick <x> <y>   REAL click: moves the user's cursor and posts at the HID tap. FOREGROUND MODE ONLY.
// The gate lives in desktop_test.tool(): it refuses unless focus_mode() == "foreground" and then sets
// DESKTOP_TEST_HID_OK=<parent pid>:<unix seconds> for that ONE run. This binary refuses without a token that names
// its actual parent and is under 10 s old, so running the cached binary directly does nothing. Call it only through
// focus-guard --foreground. (The token is a tripwire against accidents, not a security boundary.)
import Foundation
import CoreGraphics

let tok = (ProcessInfo.processInfo.environment["DESKTOP_TEST_HID_OK"] ?? "").split(separator: ":")
guard tok.count == 2, let tpid = Int32(tok[0]), let tts = Double(tok[1]), tpid == getppid(),
      abs(Date().timeIntervalSince1970 - tts) < 10 else {
    FileHandle.standardError.write("refused: hidclick only runs through desktop_test.tool() in foreground mode\n".data(using: .utf8)!); exit(3)
}

let a = CommandLine.arguments
guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else {
    FileHandle.standardError.write("usage: hidclick <x> <y>\n".data(using: .utf8)!); exit(2)
}
let p = CGPoint(x: x, y: y)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(150_000)
for t in [CGEventType.leftMouseDown, .leftMouseUp] {
    let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
    usleep(80_000)
}
