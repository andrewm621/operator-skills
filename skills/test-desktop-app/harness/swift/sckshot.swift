// sckshot <windowId> <out.png>   capture one window with ScreenCaptureKit (macOS 14+), no focus change.
// Alternative to `screencapture -l` (see the guide, probe P5). Needs Screen Recording for the calling process.
import Foundation
import AppKit
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count >= 3, let wid = UInt32(a[1]) else {
    FileHandle.standardError.write("usage: sckshot <windowId> <out.png>\n".data(using: .utf8)!); exit(2)
}
_ = NSApplication.shared   // initialises CoreGraphics' window-server connection (else CGS_REQUIRE_INIT asserts)
let sem = DispatchSemaphore(value: 0)
var code: Int32 = 1
Task {
    do {
        // onScreenWindowsOnly:false so occluded / off-screen windows are still listed
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let win = content.windows.first(where: { $0.windowID == wid }) else {
            FileHandle.standardError.write("window \(wid) not in SCShareableContent (\(content.windows.count) windows)\n".data(using: .utf8)!)
            code = 3; sem.signal(); return
        }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width * 2); cfg.height = Int(win.frame.height * 2)
        cfg.showsCursor = false
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let url = URL(fileURLWithPath: a[2]) as CFURL
        guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { code = 4; sem.signal(); return }
        CGImageDestinationAddImage(dest, img, nil)
        code = CGImageDestinationFinalize(dest) ? 0 : 4
        print("sck window \(wid) -> \(a[2]) \(img.width)x\(img.height)")
    } catch {
        FileHandle.standardError.write("sck error: \(error)\n".data(using: .utf8)!)
        code = 5
    }
    sem.signal()
}
sem.wait()
exit(code)
