import SwiftUI

/// iOS Home Screen-style launcher grid for selecting or creating apps.
/// Replaces the old "Welcome View" with a visual app grid + "New App" tile.
struct LauncherView: View {
    let projects: [SuperAppProject]
    let onRunProject: (SuperAppProject) -> Void
    let onEditProject: (SuperAppProject) -> Void
    let onDeleteProject: (SuperAppProject) -> Void
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
                    let displayName = normalizedProjectName(project.name)
                    VStack(spacing: 8) {
                        ZStack(alignment: .topTrailing) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(colorForProject(project))
                                    .frame(width: 64, height: 64)

                                Text(projectInitials(displayName))
                                    .font(.title2.weight(.semibold))
                                    .foregroundColor(.white)
                            }

                            Button {
                                onDeleteProject(project)
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .font(.system(size: 18))
                                    .foregroundStyle(.red, .white)
                                    .background(Color(.systemBackground), in: Circle())
                            }
                            .buttonStyle(.plain)
                            .offset(x: 8, y: -8)
                        }

                        Text(displayName)
                            .font(.caption)
                            .lineLimit(1)
                            .foregroundColor(.primary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        onRunProject(project)
                    }
                    .onLongPressGesture(minimumDuration: 0.5) {
                        onEditProject(project)
                    }
                }
            }
            .padding(.horizontal, 40)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func normalizedProjectName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled App" : trimmed
    }
    
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
