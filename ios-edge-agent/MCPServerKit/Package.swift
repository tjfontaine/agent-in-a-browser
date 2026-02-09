// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "MCPServerKit",
    platforms: [
        .macOS(.v26),
        .iOS(.v26)
    ],
    products: [
        .library(name: "MCPServerKit", targets: ["MCPServerKit"]),
    ],
    dependencies: [
        // Local packages for WASI runtime
        .package(path: "../WASIP2Harness"),
        .package(path: "../WASIShims"),
    ],
    targets: [
        .target(
            name: "MCPServerKit",
            dependencies: [
                "WASIP2Harness",
                "WASIShims",
            ],
            path: "Sources/MCPServerKit"
        ),
        .testTarget(
            name: "MCPServerKitTests",
            dependencies: ["MCPServerKit"],
            path: "Tests/MCPServerKitTests"
        ),
    ]
)
