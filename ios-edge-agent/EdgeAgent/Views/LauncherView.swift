import SwiftUI

/// iOS Home Screen-style launcher grid for selecting or creating apps.
/// Replaces the old "Welcome View" with a visual app grid + "New App" tile.
struct LauncherView: View {
    let projects: [SuperAppProject]
    let onSelectProject: (SuperAppProject) -> Void
    let onNewProject: () -> Void
    
    private let columns = [
        GridItem(.adaptive(minimum: 80, maximum: 100), spacing: 20)
    ]
    
    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            
            // Hero area
            VStack(spacing: 8) {
                Image(systemName: "sparkles.rectangle.stack.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.orange, .pink, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                
                Text("Edge Super App")
                    .font(.title.weight(.bold))
                
                Text("Your on-device AI app builder")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 32)
            
            // App grid
            LazyVGrid(columns: columns, spacing: 20) {
                // New App tile (always first)
                Button(action: onNewProject) {
                    VStack(spacing: 8) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 16)
                                .fill(
                                    LinearGradient(
                                        colors: [.orange, .orange.opacity(0.7)],
                                        startPoint: .top,
                                        endPoint: .bottom
                                    )
                                )
                                .frame(width: 64, height: 64)
                            
                            Image(systemName: "plus")
                                .font(.title)
                                .foregroundColor(.white)
                        }
                        
                        Text("New App")
                            .font(.caption)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
                
                // Existing projects
                ForEach(projects, id: \.id) { project in
                    Button(action: { onSelectProject(project) }) {
                        VStack(spacing: 8) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(colorForProject(project))
                                    .frame(width: 64, height: 64)
                                
                                Text(projectInitials(project.name))
                                    .font(.title2.weight(.semibold))
                                    .foregroundColor(.white)
                            }
                            
                            Text(project.name)
                                .font(.caption)
                                .lineLimit(1)
                                .foregroundColor(.primary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 40)
            
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - Helpers
    
    private func projectInitials(_ name: String) -> String {
        let words = name.split(separator: " ")
        if words.count >= 2 {
            return String(words[0].prefix(1) + words[1].prefix(1)).uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
    
    private func colorForProject(_ project: SuperAppProject) -> LinearGradient {
        // Deterministic color based on project ID hash
        let hash = abs(project.id.hashValue)
        let colors: [(Color, Color)] = [
            (.blue, .cyan),
            (.purple, .pink),
            (.green, .mint),
            (.indigo, .blue),
            (.teal, .green),
            (.red, .orange),
        ]
        let pair = colors[hash % colors.count]
        return LinearGradient(colors: [pair.0, pair.1], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
