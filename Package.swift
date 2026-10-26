// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PaperEdge",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "PaperEdgeApp", targets: ["PaperEdgeApp"])
    ],
    targets: [
        .executableTarget(
            name: "PaperEdgeApp",
            resources: [
                .copy("Resources/index.html"),
                .copy("Resources/help.html"),
                .copy("Resources/qieji-logo-v1.png"),
                .copy("Resources/scripts"),
                .copy("Resources/styles"),
                .copy("Resources/vendor"),
                .copy("MacResources")
            ]
        )
    ],
    swiftLanguageModes: [.v5]
)
