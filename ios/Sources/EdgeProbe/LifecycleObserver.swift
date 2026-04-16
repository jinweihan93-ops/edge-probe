import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// Flushes a `BatchSpanProcessor` when the host app is about to be suspended.
///
/// Without this hook, a user who locks their phone with spans still sitting
/// in the ring buffer loses up to `flushInterval` seconds (2s default) of
/// telemetry — exactly the spans describing the final moments before
/// backgrounding, which are the ones an engineer investigating a crash or
/// hang most wants.
///
/// On iOS we listen for `UIApplication.didEnterBackgroundNotification` and
/// do the flush inside a `beginBackgroundTask(withName:)` window so iOS
/// gives us ~5 seconds to complete before suspension. `willResignActive`
/// was considered but fires for transient interruptions (phone call, pulled
/// notification shade, Control Center) and would cause unnecessary network
/// traffic; `didEnterBackground` is the committed signal.
///
/// On non-iOS platforms this is a no-op, by design. macOS, Linux, and Swift
/// tests all hit the fallback path where only the `flushForBackground()`
/// test hook is available.
internal final class LifecycleObserver: @unchecked Sendable {
    private let processor: BatchSpanProcessor
    private let notificationCenter: NotificationCenter
    private var observer: NSObjectProtocol?
    private static let log = Logger(subsystem: "dev.edgeprobe.sdk", category: "lifecycle")

    init(processor: BatchSpanProcessor, notificationCenter: NotificationCenter = .default) {
        self.processor = processor
        self.notificationCenter = notificationCenter
    }

    /// Register for OS background notifications. Idempotent — safe to call
    /// more than once; only the first call actually registers.
    func start() {
        #if canImport(UIKit) && !os(watchOS)
        guard observer == nil else { return }
        observer = notificationCenter.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.flushForBackground()
        }
        Self.log.debug("LifecycleObserver registered for didEnterBackgroundNotification")
        #endif
    }

    /// Drain the batch processor now, wrapped in a `beginBackgroundTask` on
    /// iOS so iOS grants extra runtime before suspension. Exposed as
    /// `internal` so tests can exercise the flush logic without UIKit in
    /// the test environment.
    internal func flushForBackground() {
        #if canImport(UIKit) && !os(watchOS)
        // Request more time so the flush can drain before iOS suspends us.
        // Task name shows up in Instruments traces, so make it specific.
        var taskId: UIBackgroundTaskIdentifier = .invalid
        taskId = UIApplication.shared.beginBackgroundTask(withName: "edgeprobe.flush") {
            // Expiration handler — called if iOS runs out of patience.
            // End the task so we don't get marked as a runaway background process.
            if taskId != .invalid {
                UIApplication.shared.endBackgroundTask(taskId)
                taskId = .invalid
            }
        }

        processor.flushNow()
        processor.waitUntilIdle(timeout: 3.0)

        if taskId != .invalid {
            UIApplication.shared.endBackgroundTask(taskId)
        }
        #else
        // Non-iOS path: no background task concept, just drain.
        processor.flushNow()
        processor.waitUntilIdle(timeout: 3.0)
        #endif
    }

    /// Whether the OS notification observer is currently registered.
    /// Internal for tests; not part of the public API.
    internal var isObserving: Bool { observer != nil }

    deinit {
        if let observer {
            notificationCenter.removeObserver(observer)
        }
    }
}
