import Foundation
import OSLog

// MLX requires Metal GPU which is not available on iOS Simulator
#if canImport(MLXLLM) && !targetEnvironment(simulator)
import MLXLLM
import MLXLMCommon
#endif

/// Manages MLX model downloading and caching
/// Note: MLX only works on physical devices with Metal GPU, not Simulator.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class MLXModelManager: ObservableObject {
    static let shared = MLXModelManager()
    
    /// Available models for selection
    static let availableModels: [(id: String, name: String, size: String)] = [
        ("mlx-community/Qwen3-4B-4bit", "Qwen3 4B", "~2.5GB"),
        ("mlx-community/Llama-3.2-3B-Instruct-4bit", "LLaMA 3.2 3B", "~2GB"),
        ("mlx-community/Phi-3.5-mini-instruct-4bit", "Phi 3.5 Mini", "~2GB"),
        ("mlx-community/gemma-2-2b-it-4bit", "Gemma 2 2B", "~1.5GB"),
    ]
    
    @Published var currentModelId: String?
    @Published var isLoading = false
    @Published var downloadProgress: Double = 0
    @Published var error: String?
    
    private init() {}
    
    /// Check if a model is likely cached (heuristic based on HuggingFace hub cache)
    func isModelCached(_ modelId: String) -> Bool {
        // HuggingFace hub caches in ~/Library/Caches/huggingface
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("huggingface")
        
        guard let cacheDir = cacheDir else { return false }
        
        // Check if cache directory exists and has content
        // This is a heuristic - actual model may need re-download
        let modelCacheId = modelId.replacingOccurrences(of: "/", with: "--")
        let modelPath = cacheDir.appendingPathComponent("hub").appendingPathComponent("models--\(modelCacheId)")
        
        return FileManager.default.fileExists(atPath: modelPath.path)
    }
    
    /// Load a model (downloads if not cached)
    func loadModel(_ modelId: String) async throws {
        #if canImport(MLXLLM) && !targetEnvironment(simulator)
        isLoading = true
        downloadProgress = 0
        error = nil
        
        defer {
            isLoading = false
        }
        
        do {
            Log.agent.info("MLX: Loading model \(modelId)")
            
            // Load with MLXLLM - this handles downloading automatically
            try await MLXServer.shared.loadModel(id: modelId)
            
            currentModelId = modelId
            downloadProgress = 1.0
            Log.agent.info("MLX: Model \(modelId) loaded successfully")
        } catch {
            self.error = error.localizedDescription
            Log.agent.error("MLX: Failed to load model: \(error)")
            throw error
        }
        #else
        throw MLXServerError.notAvailable
        #endif
    }
    
    /// Get display name for a model ID
    func displayName(for modelId: String) -> String {
        Self.availableModels.first { $0.id == modelId }?.name ?? modelId
    }
}
