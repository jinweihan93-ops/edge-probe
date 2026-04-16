import Foundation

/// Where the demo ships telemetry + what name to wear when it does.
///
/// Read from `Info.plist` (which project.yml populates at build time from
/// environment variables or xcconfig overrides). No hard-coded strings in
/// Swift so that flipping an endpoint never needs a recompile — change the
/// `.xcconfig`, re-open the project, done.
enum Config {

    /// Backend ingest/app endpoint. Simulator can hit `http://127.0.0.1:3000`
    /// directly because the simulator shares the Mac's network namespace. A
    /// real device on the same Wi-Fi needs your Mac's LAN IP (e.g.
    /// `http://192.168.1.42:3000`) and ATS allowance for cleartext. See
    /// ios/DemoApp/README.md for the two-line ATS snippet you'll need in
    /// the plist if you run on-device.
    static let backendURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "EDGEPROBE_BACKEND_URL") as? String,
           let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        return URL(string: "http://127.0.0.1:3000")!
    }()

    /// Web dashboard base. `share` button composes `\(webURL)/r/\(token)`.
    static let webURL: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "EDGEPROBE_WEB_URL") as? String,
           let url = URL(string: raw), !raw.isEmpty {
            return url
        }
        return URL(string: "http://127.0.0.1:3001")!
    }()

    /// Public ingest key. Shipped in the app binary on purpose — it's meant
    /// to be public, rate-limited server-side, and rotatable. Once the auth
    /// slice lands (hash-backed `api_keys` table) this key will actually be
    /// validated end-to-end; today the backend accepts any string with the
    /// right prefix.
    static let apiKey: String = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "EDGEPROBE_API_KEY") as? String, !raw.isEmpty {
            return raw
        }
        return "epk_pub_demo_voiceprobe"
    }()

    /// Dashboard bearer key. Used ONLY for the share-mint call
    /// (`POST /app/trace/:id/share`) — the ingest path uses `apiKey` above.
    /// This key maps to `orgId` via the backend's `DASHBOARD_KEYS` table.
    ///
    /// In a real product the device would NOT carry this; the user would
    /// tap "share" in the dashboard web UI, which would mint from a
    /// session-authed origin. For the demo we let the device mint directly
    /// so the whole path — trace → dashboard → share URL — fits in one
    /// tap. Don't ship this key with a public app.
    static let dashboardKey: String = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "EDGEPROBE_DASHBOARD_KEY") as? String, !raw.isEmpty {
            return raw
        }
        return "epk_dash_acme_test_0000000000000000"
    }()

    /// Which org these demo traces belong to. Matches the backend/web e2e
    /// script's `org_acme` so a fresh clone "just works" against a local
    /// backend — you don't have to provision a new org before you can see
    /// your first trace. The dashboard key above is what actually proves
    /// identity on the wire; this constant is only used to stamp the
    /// `trace.orgId` field the SDK sends on ingest.
    static let orgId = "org_acme"

    /// Which project in that org. The dashboard filter (once we ship it)
    /// will key off this.
    static let projectId = "proj_voiceprobe"
}
