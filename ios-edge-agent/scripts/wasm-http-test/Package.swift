// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "wasm-http-test",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/swiftwasm/WasmKit", branch: "main")
    ],
    targets: [
        .executableTarget(
            name: "wasm-http-test",
            dependencies: [
                .product(name: "WasmKit", package: "WasmKit"),
                .product(name: "WASI", package: "WasmKit"),
                .product(name: "WasmKitWASI", package: "WasmKit")
            ],
            path: "Sources"
        )
    ]
)
