// Probe.swift: a tiny AppKit + WKWebView app used as a TEST FIXTURE for the desktop-app-testing harness.
// It has no product code. It exists so the harness techniques (PID-targeted keys/clicks, AX, window capture,
// background launch, occlusion behaviour) can be exercised and re-verified on a new macOS without a real app.
//
//   Probe --accept-first-mouse 0|1   WKWebView.acceptsFirstMouse(for:) result (default 0, like wry's default)
//         --frame x,y,w,h            window frame in global screen points, origin top-left (default 80,80,520,360)
//         --level back|normal        back = just above the desktop icons, i.e. behind every normal window
//         --yield-on-activate        if the app is ever activated, log it and hide itself (hands focus back)
//         --alpha A                  window alphaValue (e.g. 0.02: effectively invisible but not "occluded")
//         --ignore-mouse             window ignores mouse events (clicks fall through to what is underneath)
//         --title T                  window title (default "Desktop Probe")
//         --cmd-dir DIR              command channel (off unless given). DIR must be an absolute path to a real directory
//                                    owned by the current user with mode 0700 (the harness creates it with mkdtemp);
//                                    the probe REFUSES TO START otherwise. Every 200 ms, if DIR/cmd.js exists (a regular
//                                    file you own, not a symlink, not group/world-writable) its contents run as an async
//                                    JS function body in the page, {"t":"eval",...} is logged, and the file is deleted.
//                                    `#snapshot name.png` instead writes WKWebView.takeSnapshot to DIR/name.png (bare
//                                    file name only; created O_EXCL|O_NOFOLLOW; no paths, no "..").
//         --alpha A                  window alphaValue (e.g. 0.02: effectively invisible but not "occluded")
//         --ignore-mouse             window ignores mouse events (clicks fall through to what is underneath)
//         --title T                  window title (default "Desktop Probe")
//         --cmd-file PATH            every 200 ms, if PATH exists: run its contents as an async JS function body in
//                                    the page, log {"t":"eval","ms":elapsed,"result":...}, delete PATH. This mimics an
//                                    in-process bridge /eval so the probe can show what works while occluded.
//                                    A file starting with `#snapshot /abs/out.png` takes WKWebView.takeSnapshot instead.
//
// Everything the page or AppKit observes is written to stderr as one JSON object per line:
//   {"t":"key","type":"keydown","key":"a","trusted":true,"vis":"visible","docFocus":false}  ... etc.
// Native pieces for AX probes: an NSButton "Native Ping" and a menu item "Probe > Native Menu Ping".
import AppKit
import WebKit

func log(_ o: [String: Any]) {
    var o = o
    o["ms"] = Int(Date().timeIntervalSince1970 * 1000)
    if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
       let s = String(data: d, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return nil
}

// A titled NSWindow normally gets pulled back on screen; the probe wants to test off-screen placement.
// ---- command channel hardening: the channel runs JS and writes files, so it only lives in a private dir
func privateDirCanonical(_ path: String) -> String? {
    var st = stat()
    guard path.hasPrefix("/"), lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR,   // lstat: a symlink is not a dir here
          st.st_uid == getuid(), (st.st_mode & 0o077) == 0 else { return nil }
    return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
}

/// Reads and deletes DIR/cmd.js if it is a regular file owned by us, not a symlink, not group/world-writable.
func takeCommand(in dir: String) -> String? {
    let path = dir + "/cmd.js"
    let fd = open(path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else {
        if errno == ELOOP {   // a symlink was planted as cmd.js: refuse, report, remove the link (never the target)
            log(["t": "cmd-refused", "src": "native", "why": "cmd.js is a symlink"])
            unlink(path)
        }
        return nil
    }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), (st.st_mode & 0o022) == 0 else {
        log(["t": "cmd-refused", "src": "native", "why": "cmd.js is not a regular file owned by this user"])
        unlink(path); return nil
    }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while true { let n = read(fd, &buf, buf.count); if n <= 0 { break }; data.append(buf, count: n) }
    unlink(path)
    return String(data: data, encoding: .utf8)
}

/// Writes DIR/<name> (bare file name only) exclusively and without following symlinks.
func writeInDir(_ dir: String, name: String, data: Data) -> Bool {
    guard !name.isEmpty, !name.hasPrefix("."), name.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
          !name.contains("..") else { return false }
    let fd = open(dir + "/" + name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    return data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) } == data.count
}

final class ProbeWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class ProbeWebView: WKWebView {
    var acceptFirst = false
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { acceptFirst }
}

let html = """
<!doctype html><meta charset=utf-8><title>probe</title>
<style>body{font:15px -apple-system;margin:16px} input{font-size:18px;width:300px} button{font-size:16px;margin:6px}
#n{font:12px ui-monospace;color:#555}</style>
<h3>Desktop probe</h3>
<input id=field placeholder="type here" autofocus>
<button id=web-btn aria-label="Web Ping">Web Ping</button>
<div id=n></div>
<script>
const post = o => window.webkit.messageHandlers.log.postMessage(o);
const base = () => ({vis: document.visibilityState, docFocus: document.hasFocus()});
let clicks = 0;
for (const type of ['keydown','keyup','input'])
  document.addEventListener(type, e => post({t:'key', type, key:e.key||null, value:e.target.value??null, trusted:e.isTrusted, ...base()}), true);
for (const type of ['mousedown','mouseup','click'])
  document.addEventListener(type, e => post({t:'mouse', type, x:e.clientX, y:e.clientY, target:e.target.id||e.target.tagName, trusted:e.isTrusted, ...base()}), true);
document.addEventListener('visibilitychange', () => post({t:'visibilitychange', ...base()}));
window.addEventListener('focus', () => post({t:'window-focus', ...base()}));
window.addEventListener('blur', () => post({t:'window-blur', ...base()}));
document.getElementById('web-btn').addEventListener('click', () => {
  clicks++; document.getElementById('n').textContent = 'web-btn clicks: ' + clicks; post({t:'web-btn', clicks});
});
// rAF cadence: frames counted per second
let frames = 0, last = performance.now();
(function tick(now){ frames++; requestAnimationFrame(tick); })(0);
setInterval(() => { const now = performance.now(); post({t:'raf', fps: Math.round(frames*1000/(now-last)), ...base()}); frames = 0; last = now; }, 1000);
// timer cadence (setInterval 100ms) as a second signal
let ticks = 0; setInterval(() => ticks++, 100);
setInterval(() => { post({t:'timer', per_s: ticks}); ticks = 0; }, 1000);
const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height}; };
post({t:'ready', field: rect('field'), webBtn: rect('web-btn'), ...base()});
</script>
"""

final class Delegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow!
    var web: ProbeWebView!

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if var d = m.body as? [String: Any] { d["src"] = "web"; log(d) } else { log(["t": "web-raw", "body": "\(m.body)"]) }
    }

    @objc func nativePing(_ sender: Any?) { log(["t": "native-ping", "src": "native"]) }

    var cmdDir: String?

    func applicationDidFinishLaunching(_ n: Notification) {
        if let d = arg("--cmd-dir") {
            guard let canon = privateDirCanonical(d) else {
                log(["t": "fatal", "src": "native", "why": "--cmd-dir is not a private (0700, owned by you, non-symlink) directory"])
                exit(2)
            }
            cmdDir = canon
        }
        let f = (arg("--frame") ?? "80,80,520,360").split(separator: ",").compactMap { Double($0) }
        let screenH = NSScreen.screens.first?.frame.height ?? 900
        // global screen points have a top-left origin; Cocoa wants bottom-left
        let rect = NSRect(x: f[0], y: screenH - f[1] - f[3], width: f[2], height: f[3])
        window = ProbeWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = arg("--title") ?? "Desktop Probe"
        window.delegate = self
        window.isReleasedWhenClosed = false

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "log")
        web = ProbeWebView(frame: .zero, configuration: cfg)
        web.acceptFirst = (arg("--accept-first-mouse") ?? "0") == "1"
        web.translatesAutoresizingMaskIntoConstraints = false
        let button = NSButton(title: "Native Ping", target: self, action: #selector(nativePing(_:)))
        button.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        root.addSubview(web); root.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            button.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
            web.topAnchor.constraint(equalTo: root.topAnchor), web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.trailingAnchor), web.bottomAnchor.constraint(equalTo: button.topAnchor, constant: -8),
        ])
        window.contentView = root

        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(title: "Probe"); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Native Menu Ping", action: #selector(nativePing(_:)), keyEquivalent: "")
        appMenu.items.last?.target = self
        appMenu.addItem(withTitle: "Quit Probe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = main

        if arg("--level") == "back" {
            window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        }
        if let al = arg("--alpha"), let v = Double(al) { window.alphaValue = CGFloat(v) }
        if CommandLine.arguments.contains("--ignore-mouse") { window.ignoresMouseEvents = true }
        web.loadHTMLString(html, baseURL: nil)
        window.orderFront(nil)   // NOT makeKeyAndOrderFront / activate: launching must not take focus
        window.setFrame(rect, display: true)   // AppKit may have moved a titled window on screen at creation; force it
        log(["t": "frame", "src": "native", "requested": "\(rect)", "actual": "\(window.frame)"])

        let nc = NotificationCenter.default
        nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            log(["t": "app-active", "src": "native"])
            if CommandLine.arguments.contains("--yield-on-activate") { NSApp.hide(nil); log(["t": "yielded"]) }
        }
        nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in log(["t": "app-resign", "src": "native"]) }
        nc.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { _ in log(["t": "window-key", "src": "native"]) }
        nc.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] _ in
            log(["t": "occlusion", "visible": self?.window.occlusionState.contains(.visible) ?? false, "src": "native"])
        }
        // the web view's rect in GLOBAL screen points with a top-left origin (what CGEvent/CGWindowList use)
        let wr = window.convertToScreen(web.convert(web.bounds, to: nil))
        let webScreen = [wr.origin.x, screenH - wr.origin.y - wr.height, wr.width, wr.height]
        let br = window.convertToScreen(button.convert(button.bounds, to: nil))
        let nativeBtn = [br.origin.x, screenH - br.origin.y - br.height, br.width, br.height]
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            log(["t": "native-state", "src": "native", "active": NSApp.isActive,
                 "occluded": !self.window.occlusionState.contains(.visible), "mini": self.window.isMiniaturized,
                 "key": self.window.isKeyWindow])
        }
        if let dir = cmdDir {
            Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                guard let self = self, let js = takeCommand(in: dir) else { return }
                let t0 = Date()
                if js.hasPrefix("#snapshot ") {   // in-process WKWebView.takeSnapshot -> DIR/<name>
                    let name = String(js.dropFirst(10)).trimmingCharacters(in: .whitespacesAndNewlines)
                    self.web.takeSnapshot(with: nil) { img, err in
                        let ms = Int(Date().timeIntervalSince(t0) * 1000)
                        guard let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                              let png = rep.representation(using: .png, properties: [:]) else {
                            log(["t": "eval", "src": "native", "elapsed_ms": ms, "error": "snapshot failed: \(String(describing: err))"]); return
                        }
                        let ok = writeInDir(dir, name: name, data: png)
                        log(["t": "eval", "src": "native", "elapsed_ms": ms, ok ? "result" : "error": ok ? "snapshot-written \(name)" : "snapshot refused or failed for name \(name)"])
                    }
                    return
                }
                self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                    let ms = Int(Date().timeIntervalSince(t0) * 1000)
                    switch r {
                    case .success(let v): log(["t": "eval", "src": "native", "elapsed_ms": ms, "result": "\(v)"])
                    case .failure(let e): log(["t": "eval", "src": "native", "elapsed_ms": ms, "error": "\(e)"])
                    }
                }
            }
        }
        // every mouse/key event that reaches AppKit's sendEvent, before any view sees it
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .mouseMoved, .leftMouseDragged, .keyDown, .scrollWheel]) { e in
            log(["t": "appkit-event", "src": "native", "type": "\(e.type.rawValue)", "window": e.windowNumber,
                 "loc": "\(e.locationInWindow)", "active": NSApp.isActive])
            return e
        }
        log(["t": "launched", "src": "native", "webScreen": webScreen, "nativeBtn": nativeBtn, "pid": ProcessInfo.processInfo.processIdentifier,
             "acceptFirstMouse": web.acceptFirst, "windowNumber": window.windowNumber,
             "active": NSApp.isActive, "frame": "\(rect)"])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
