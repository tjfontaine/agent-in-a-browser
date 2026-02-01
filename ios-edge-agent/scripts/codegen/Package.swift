// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "generate-wasi-stubs",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/swiftwasm/WasmKit.git", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "generate-wasi-stubs",
            dependencies: [
                .product(name: "WasmKit", package: "WasmKit"),
            ],
            path: "Sources"
        ),
    ]
)
