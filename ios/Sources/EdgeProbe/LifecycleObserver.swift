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
        // queue: .main pins the callback to the main thread, which is where
        // UIApplication.beginBackgroundTask must be invoked. MainActor.assumeIsolated
        // then bridges that runtime guarantee into Swift 6's isolation model
        // — no async hop, so the beginBackgroundTask window opens synchronously
        // with the notification.
        observer = notificationCenter.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.flushForBackground()
            }
        }
        Self.log.debug("LifecycleObserver registered for didEnterBackgroundNotification")
        #endif
    }

    #if canImport(UIKit) && !os(watchOS)
    /// iOS path: wrap the drain in a `beginBackgroundTask` so iOS grants
    /// extra runtime before suspension. `@MainActor` because `UIApplication`
    /// is — Swift 6 strict concurrency requires it.
    ///
    /// Exposed `internal` so tests can drive the flush directly without a
    /// real notification. Hosted iOS test targets must call this from a
    /// `@MainActor` context; the existing tests run on macOS via SwiftPM
    /// and hit the `#else` branch below.
    @MainActor
    internal func flushForBackground() {
        // Hold `taskId` in a MainActor-isolated reference type so the
        // expiration handler's capture is safe in Swift 6 — a plain `var`
        // captured across the beginBackgroundTask closure boundary is a
        // data-race hazard even though UIKit fires the handler on main.
        let holder = TaskHolder()
        holder.taskId = UIApplication.shared.beginBackgroundTask(withName: "edgeprobe.flush") {
            // Expiration handler: iOS runs it on main if we're taking too
            // long. assumeIsolated bridges the runtime guarantee.
            MainActor.assumeIsolated {
                if holder.taskId != .invalid {
                    UIApplication.shared.endBackgroundTask(holder.taskId)
                    holder.taskId = .invalid
                }
            }
        }

        processor.flushNow()
        processor.waitUntilIdle(timeout: 3.0)

        if holder.taskId != .invalid {
            UIApplication.shared.endBackgroundTask(holder.taskId)
        }
    }

    /// MainActor-isolated box for the background task identifier. Exists
    /// only so the expiration closure can mutate it without triggering a
    /// Swift 6 data-race diagnostic on a captured `var`.
    @MainActor
    private final class TaskHolder {
        var taskId: UIBackgroundTaskIdentifier = .invalid
    }
    #else
    /// Non-iOS path: no background task concept, just drain. Kept
    /// nonisolated so macOS/Linux unit tests drive it directly without
    /// `@MainActor` boilerplate.
    internal func flushForBackground() {
        processor.flushNow()
        processor.waitUntilIdle(timeout: 3.0)
    }
    #endif

    /// Whether the OS notification observer is currently registered.
    /// Internal for tests; not part of the public API.
    internal var isObserving: Bool { observer != nil }

    deinit {
        if let observer {
            notificationCenter.removeObserver(observer)
        }
    }
}
