// swift-tools-version: 6.0
// WASIShims Package - Higher-level WASI providers for HTTP, CLI, clocks, and process management

import PackageDescription

let package = Package(
    name: "WASIShims",
    platforms: [
        .macOS(.v15),
        .iOS(.v18)
    ],
    products: [
        .library(
            name: "WASIShims",
            targets: ["WASIShims"]),
    ],
    dependencies: [
        // Core WASIP2 runtime
        .package(path: "../WASIP2Harness"),
        // WasmKit for runtime types
        .package(url: "https://github.com/swiftwasm/WasmKit.git", branch: "main"),
    ],
    targets: [
        .target(
            name: "WASIShims",
            dependencies: [
                "WASIP2Harness",
                .product(name: "WasmKit", package: "WasmKit"),
            ]),
        .testTarget(
            name: "WASIShimsTests",
            dependencies: ["WASIShims"]),
    ]
)
