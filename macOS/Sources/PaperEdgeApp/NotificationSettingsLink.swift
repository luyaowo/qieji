import AppKit

enum NotificationSettingsLink {
    static func url(for bundleIdentifier: String?) -> URL? {
        guard let bundleIdentifier, !bundleIdentifier.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "x-apple.systempreferences"
        components.path = "com.apple.Notifications-Settings.extension"
        components.queryItems = [URLQueryItem(name: "id", value: bundleIdentifier)]
        return components.url
    }

    @discardableResult
    static func open(for bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> Bool {
        guard let url = url(for: bundleIdentifier) else { return false }
        return NSWorkspace.shared.open(url)
    }
}
