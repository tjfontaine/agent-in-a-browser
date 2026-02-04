// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "MCPServerKit",
    platforms: [
        .macOS(.v15),
        .iOS(.v18)
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
