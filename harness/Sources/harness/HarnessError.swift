import Foundation

/// Unified error type for the harness CLI. All public-facing helpers throw
/// this or let system errors bubble — we convert them at the `main.swift`
/// boundary so exit codes and stderr messages stay consistent.
enum HarnessError: Error, CustomStringConvertible {
    /// User-facing CLI error. Exit code 2, prints to stderr.
    case usage(String)
    /// Internal bug or unhandled I/O failure. Exit code 1.
    case internalError(String)

    var description: String {
        switch self {
        case .usage(let s): return s
        case .internalError(let s): return s
        }
    }
}
