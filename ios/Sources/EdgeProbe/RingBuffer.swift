import Foundation

/// Bounded, drop-oldest ring buffer. Thread-safe via NSLock.
///
/// When you push into a full buffer the OLDEST element is evicted and
/// `droppedCount` increments. This is Critical Path #5 from docs/TEST-PLAN.md:
/// when the network dies, the SDK must NOT grow unbounded (OOM) and must NOT
/// block the caller. The dropped counter gets shipped as a `meta.droppedSpans`
/// attribute on the next successful export so on-call can see silent loss.
///
/// Why drop-oldest and not drop-newest:
/// - Newest spans are most valuable for debugging the current session.
/// - The common failure mode is "network down for a while, then recovers" —
///   if you drop-newest you'd throw away the spans describing the recovery,
///   which are the ones on-call actually wants to see.
///
/// Why not a bounded `DispatchQueue` or `Semaphore` instead:
/// - We never want `trace()` to block on anything but a quick lock acquire.
///   A semaphore that stalls the caller until a batch drain completes would
///   violate Critical Path #4 (main thread never blocks on export).
internal final class RingBuffer<Element>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Element] = []
    private let capacity: Int
    private var _droppedCount: Int = 0

    init(capacity: Int) {
        precondition(capacity > 0, "ring buffer capacity must be > 0")
        self.capacity = capacity
        self.storage.reserveCapacity(capacity)
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return storage.count
    }

    var droppedCount: Int {
        lock.lock(); defer { lock.unlock() }
        return _droppedCount
    }

    /// Append an element. If the buffer is full, evicts the OLDEST element and
    /// increments `droppedCount`. Never blocks on anything but the lock.
    func push(_ element: Element) {
        lock.lock(); defer { lock.unlock() }
        if storage.count >= capacity {
            storage.removeFirst()
            _droppedCount += 1
        }
        storage.append(element)
    }

    /// Take everything out of the buffer and return it in FIFO order.
    /// Atomic w.r.t. push — nothing can be appended between snapshot and clear.
    func drain() -> [Element] {
        lock.lock(); defer { lock.unlock() }
        let snapshot = storage
        storage.removeAll(keepingCapacity: true)
        return snapshot
    }

    /// Read and zero the dropped counter atomically.
    /// Called from the batch processor right before a flush, so the counter
    /// rides on the first payload of the next outbound batch.
    func consumeDroppedCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        let n = _droppedCount
        _droppedCount = 0
        return n
    }
}
