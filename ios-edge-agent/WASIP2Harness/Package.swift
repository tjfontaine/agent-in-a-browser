// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "WASIP2Harness",
    platforms: [
        .macOS(.v15),
        .iOS(.v18)
    ],
    products: [
        .library(name: "WASIP2Harness", targets: ["WASIP2Harness"]),
    ],
    dependencies: [
        // WasmKit for WASM runtime
        .package(url: "https://github.com/swiftwasm/WasmKit.git", branch: "main"),
        // Local WasmBindgen for generated bindings runtime
        .package(path: "../WasmBindgen"),
    ],
    targets: [
        .target(
            name: "WASIP2Harness",
            dependencies: [
                .product(name: "WasmKit", package: "WasmKit"),
                .product(name: "WasmBindgenRuntime", package: "WasmBindgen"),
            ],
            path: "Sources/WASIP2Harness"
        ),
        .testTarget(
            name: "WASIP2HarnessTests",
            dependencies: ["WASIP2Harness"],
            path: "Tests/WASIP2HarnessTests"
        ),
    ]
)
