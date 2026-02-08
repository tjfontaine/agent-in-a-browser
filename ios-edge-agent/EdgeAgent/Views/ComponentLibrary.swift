import SwiftUI

// MARK: - Helpers

/// Parse numeric values from JSON (comes as Double/Int/NSNumber, not CGFloat)
private func parseNumber(_ value: Any?) -> CGFloat? {
    if let d = value as? Double { return CGFloat(d) }
    if let i = value as? Int { return CGFloat(i) }
    if let n = value as? NSNumber { return CGFloat(n.doubleValue) }
    return nil
}

// MARK: - Component Keys & State

/// Tracks rendered components by key for partial updates
class ComponentState: ObservableObject {
    @Published var components: [String: Any] = [:]
    @Published var rootComponents: [[String: Any]] = []
    
    func render(_ components: [[String: Any]]) {
        rootComponents = components
        rebuildKeyIndex()
    }
    
    func applyPatches(_ patches: [[String: Any]]) {
        for patch in patches {
            guard let key = patch["key"] as? String,
                  let op = patch["op"] as? String else { continue }
            
            switch op {
            case "replace":
                if let component = patch["component"] as? [String: Any] {
                    replaceComponent(key: key, with: component)
                }
            case "remove":
                removeComponent(key: key)
            case "update":
                if let props = patch["props"] as? [String: Any] {
                    updateProps(key: key, props: props)
                }
            case "append":
                if let component = patch["component"] as? [String: Any] {
                    appendToContainer(key: key, component: component)
                }
            case "prepend":
                if let component = patch["component"] as? [String: Any] {
                    prependToContainer(key: key, component: component)
                }
            default:
                break
            }
        }
    }
    
    private func rebuildKeyIndex() {
        components.removeAll()
        for component in rootComponents {
            indexComponent(component)
        }
    }
    
    private func indexComponent(_ component: [String: Any]) {
        if let key = component["key"] as? String {
            components[key] = component
        }
        if let props = component["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            for child in children {
                indexComponent(child)
            }
        }
    }
    
    private func replaceComponent(key: String, with newComponent: [String: Any]) {
        rootComponents = rootComponents.map { replaceInTree($0, key: key, with: newComponent) }
        rebuildKeyIndex()
    }
    
    private func replaceInTree(_ component: [String: Any], key: String, with newComponent: [String: Any]) -> [String: Any] {
        if component["key"] as? String == key {
            return newComponent
        }
        var result = component
        if var props = component["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            props["children"] = children.map { replaceInTree($0, key: key, with: newComponent) }
            result["props"] = props
        }
        return result
    }
    
    private func removeComponent(key: String) {
        rootComponents = rootComponents.compactMap { removeFromTree($0, key: key) }
        rebuildKeyIndex()
    }
    
    private func removeFromTree(_ component: [String: Any], key: String) -> [String: Any]? {
        if component["key"] as? String == key {
            return nil
        }
        var result = component
        if var props = component["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            props["children"] = children.compactMap { removeFromTree($0, key: key) }
            result["props"] = props
        }
        return result
    }
    
    private func updateProps(key: String, props: [String: Any]) {
        rootComponents = rootComponents.map { updateInTree($0, key: key, newProps: props) }
        rebuildKeyIndex()
    }
    
    private func updateInTree(_ component: [String: Any], key: String, newProps: [String: Any]) -> [String: Any] {
        var result = component
        if component["key"] as? String == key {
            var existingProps = component["props"] as? [String: Any] ?? [:]
            for (k, v) in newProps {
                existingProps[k] = v
            }
            result["props"] = existingProps
        }
        if var props = result["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            props["children"] = children.map { updateInTree($0, key: key, newProps: newProps) }
            result["props"] = props
        }
        return result
    }
    
    private func appendToContainer(key: String, component: [String: Any]) {
        rootComponents = rootComponents.map { appendInTree($0, key: key, component: component, prepend: false) }
        rebuildKeyIndex()
    }
    
    private func prependToContainer(key: String, component: [String: Any]) {
        rootComponents = rootComponents.map { appendInTree($0, key: key, component: component, prepend: true) }
        rebuildKeyIndex()
    }
    
    private func appendInTree(_ container: [String: Any], key: String, component: [String: Any], prepend: Bool) -> [String: Any] {
        var result = container
        if container["key"] as? String == key {
            if var props = container["props"] as? [String: Any] {
                var children = props["children"] as? [[String: Any]] ?? []
                if prepend {
                    children.insert(component, at: 0)
                } else {
                    children.append(component)
                }
                props["children"] = children
                result["props"] = props
            }
        }
        if var props = result["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            props["children"] = children.map { appendInTree($0, key: key, component: component, prepend: prepend) }
            result["props"] = props
        }
        return result
    }
}

// MARK: - Component Router

/// Routes component type to SwiftUI view
struct ComponentRouter: View {
    let component: [String: Any]
    let onAction: (String, Any?) -> Void
    /// Long-press annotation callback: (componentType, key, props)
    var onAnnotate: ((String, String, [String: Any]) -> Void)? = nil
    
    var body: some View {
        let type = component["type"] as? String ?? ""
        let props = component["props"] as? [String: Any] ?? [:]
        let key = component["key"] as? String ?? type
        
        routedView(type: type, props: props)
            .onLongPressGesture(minimumDuration: 0.5) {
                onAnnotate?(type, key, props)
            }
    }
    
    @ViewBuilder
    private func routedView(type: String, props: [String: Any]) -> some View {
        switch type {
        // Layout
        case "VStack":
            VStackComponent(props: props, onAction: onAction)
        case "HStack":
            HStackComponent(props: props, onAction: onAction)
        case "Spacer":
            SpacerComponent(props: props)
        case "Card":
            CardComponent(props: props, onAction: onAction)
        case "ScrollView":
            ScrollViewComponent(props: props, onAction: onAction)
        case "Divider":
            DividerComponent(props: props)
            
        // Content
        case "Text":
            TextComponent(props: props)
        case "Image":
            ImageComponent(props: props)
        case "Icon":
            IconComponent(props: props)
        case "Badge":
            BadgeComponent(props: props)
            
        // Interactive
        case "Button":
            ButtonComponent(props: props, onAction: onAction)
        case "Pressable":
            PressableComponent(props: props, onAction: onAction)
        case "TextInput":
            TextInputComponent(props: props, onAction: onAction)
            
        // Feedback
        case "Loading":
            LoadingComponent(props: props)
        case "Skeleton":
            SkeletonComponent(props: props)
        case "ProgressBar":
            ProgressBarComponent(props: props)
        case "Toast":
            ToastComponent(props: props)
            
        // SDUI Components
        case "ForEach":
            ForEachComponent(props: props, onAction: onAction)
        case "If":
            IfComponent(props: props, onAction: onAction)
        case "View":
            ViewRefComponent(props: props, onAction: onAction)
            
        default:
            Text("Unknown: \(type)")
                .foregroundColor(.red)
                .font(.caption)
        }
    }
}

// MARK: - Layout Components

struct VStackComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let spacing = props["spacing"] as? CGFloat ?? 8
        let align = props["align"] as? String ?? "center"
        let children = props["children"] as? [[String: Any]] ?? []
        
        VStack(alignment: alignment(from: align), spacing: spacing) {
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                ComponentRouter(component: child, onAction: onAction)
            }
        }
    }
    
    private func alignment(from string: String) -> HorizontalAlignment {
        switch string {
        case "leading": return .leading
        case "trailing": return .trailing
        default: return .center
        }
    }
}

struct HStackComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let spacing = props["spacing"] as? CGFloat ?? 8
        let children = props["children"] as? [[String: Any]] ?? []
        
        HStack(spacing: spacing) {
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                ComponentRouter(component: child, onAction: onAction)
            }
        }
    }
}

struct SpacerComponent: View {
    let props: [String: Any]
    
    var body: some View {
        if let height = props["height"] as? CGFloat {
            Spacer().frame(height: height)
        } else if let width = props["width"] as? CGFloat {
            Spacer().frame(width: width)
        } else {
            Spacer()
        }
    }
}

struct CardComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let padding = props["padding"] as? CGFloat ?? 12
        let shadow = props["shadow"] as? Bool ?? true
        let cornerRadius = props["cornerRadius"] as? CGFloat ?? 12
        let children = props["children"] as? [[String: Any]] ?? []
        let cardContent = VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                ComponentRouter(component: child, onAction: onAction)
            }
        }
        .padding(padding)
        .background(Color(.systemBackground))
        .cornerRadius(cornerRadius)
        .shadow(color: shadow ? .black.opacity(0.1) : .clear, radius: 4, x: 0, y: 2)
        
        // Support structured dict actions on onTap (script-first dispatch)
        if let onTapDict = props["onTap"] as? [String: Any] {
            Button(action: {
                let actionName = onTapDict["type"] as? String ?? "event"
                onAction(actionName, onTapDict)
            }) {
                cardContent
            }
            .buttonStyle(.plain)
        } else if let onTap = props["onTap"] as? String {
            Button(action: {
                if onTap.contains(":") {
                    let parts = onTap.split(separator: ":", maxSplits: 1)
                    let actionName = String(parts[0])
                    let payload = parts.count > 1 ? String(parts[1]) : nil
                    onAction(actionName, payload)
                } else {
                    onAction(onTap, nil)
                }
            }) {
                cardContent
            }
            .buttonStyle(.plain)
        } else {
            cardContent
        }
    }
}

struct ScrollViewComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let axis = props["axis"] as? String ?? "vertical"
        let children = props["children"] as? [[String: Any]] ?? []
        
        ScrollView(axis == "horizontal" ? .horizontal : .vertical) {
            if axis == "horizontal" {
                HStack(spacing: 12) {
                    ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                        ComponentRouter(component: child, onAction: onAction)
                    }
                }
            } else {
                VStack(spacing: 12) {
                    ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                        ComponentRouter(component: child, onAction: onAction)
                    }
                }
            }
        }
    }
}

struct DividerComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let colorName = props["color"] as? String
        Divider()
            .background(colorName != nil ? Color(colorName!) : nil)
    }
}

// MARK: - Content Components

struct TextComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let content = props["content"] as? String ?? ""
        let size = props["size"] as? String ?? "md"
        let weight = props["weight"] as? String ?? "regular"
        let colorName = props["color"] as? String
        let align = props["align"] as? String
        
        Text(content)
            .font(font(for: size))
            .fontWeight(fontWeight(for: weight))
            .foregroundColor(color(for: colorName))
            .multilineTextAlignment(textAlignment(for: align))
    }
    
    private func font(for size: String) -> Font {
        switch size {
        case "xs": return .caption2
        case "sm": return .caption
        case "md": return .body
        case "lg": return .title3
        case "xl": return .title2
        case "2xl": return .title
        case "3xl": return .largeTitle
        default: return .body
        }
    }
    
    private func fontWeight(for weight: String) -> Font.Weight {
        switch weight {
        case "medium": return .medium
        case "semibold": return .semibold
        case "bold": return .bold
        default: return .regular
        }
    }
    
    private func color(for name: String?) -> Color? {
        guard let name = name else { return nil }
        switch name {
        case "primary": return .primary
        case "secondary": return .secondary
        case "orange": return .orange
        case "red": return .red
        case "green": return .green
        case "blue": return .blue
        case "gray": return .gray
        default: return nil
        }
    }
    
    private func textAlignment(for align: String?) -> TextAlignment {
        switch align {
        case "center": return .center
        case "trailing": return .trailing
        default: return .leading
        }
    }
}

struct ImageComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let url = props["url"] as? String ?? ""
        let height = parseNumber(props["height"])
        let width = parseNumber(props["width"])
        let cornerRadius = parseNumber(props["cornerRadius"]) ?? 0
        let aspectRatio = props["aspectRatio"] as? String ?? "fill"
        
        AsyncImage(url: URL(string: url)) { phase in
            switch phase {
            case .empty:
                Rectangle()
                    .fill(Color.gray.opacity(0.2))
                    .overlay(ProgressView())
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: aspectRatio == "fit" ? .fit : .fill)
            case .failure:
                Rectangle()
                    .fill(Color.gray.opacity(0.2))
                    .overlay(Image(systemName: "photo").foregroundColor(.gray))
            @unknown default:
                EmptyView()
            }
        }
        .frame(
            minWidth: width ?? 0,
            maxWidth: width ?? .infinity,
            minHeight: height ?? 100,
            maxHeight: height ?? 200
        )
        .clipped()
        .cornerRadius(cornerRadius)
    }
}

struct IconComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let name = props["name"] as? String ?? "questionmark"
        let size = props["size"] as? CGFloat ?? 20
        let colorName = props["color"] as? String
        
        Image(systemName: name)
            .font(.system(size: size))
            .foregroundColor(color(for: colorName) ?? .primary)
    }
    
    private func color(for name: String?) -> Color? {
        guard let name = name else { return nil }
        switch name {
        case "orange": return .orange
        case "red": return .red
        case "green": return .green
        case "blue": return .blue
        case "gray": return .gray
        case "secondary": return .secondary
        default: return nil
        }
    }
}

struct BadgeComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let text = props["text"] as? String ?? ""
        let colorName = props["color"] as? String ?? "orange"
        
        Text(text)
            .font(.caption)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(badgeColor(colorName))
            .foregroundColor(.white)
            .cornerRadius(4)
    }
    
    private func badgeColor(_ name: String) -> Color {
        switch name {
        case "green": return .green
        case "red": return .red
        case "blue": return .blue
        case "gray": return .gray
        default: return .orange
        }
    }
}

// MARK: - Interactive Components

struct ButtonComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let label = props["label"] as? String ?? "Button"
        let style = props["style"] as? String ?? "primary"
        let icon = props["icon"] as? String
        let fullWidth = props["fullWidth"] as? Bool ?? false
        let disabled = props["disabled"] as? Bool ?? false
        
        Button(action: {
            // Support structured action configs (dicts) for script-first dispatch
            if let actionDict = props["action"] as? [String: Any] {
                // Pass the dict as payload — handleAction will parse it as EventHandlerType
                let actionName = actionDict["type"] as? String ?? "event"
                onAction(actionName, actionDict)
            } else {
                let action = props["action"] as? String ?? ""
                onAction(action, nil)
            }
        }) {
            HStack(spacing: 6) {
                if let icon = icon {
                    Image(systemName: icon)
                }
                Text(label)
            }
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(buttonBackground(style))
            .foregroundColor(buttonForeground(style))
            .cornerRadius(8)
        }
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
    
    private func buttonBackground(_ style: String) -> Color {
        switch style {
        case "secondary": return Color.gray.opacity(0.15)
        case "ghost": return .clear
        case "destructive": return .red
        default: return .orange
        }
    }
    
    private func buttonForeground(_ style: String) -> Color {
        switch style {
        case "secondary": return .primary
        case "ghost": return .orange
        default: return .white
        }
    }
}

struct PressableComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let children = props["children"] as? [[String: Any]] ?? []
        
        Button(action: {
            // Support structured action configs (dicts) for script-first dispatch
            if let actionDict = props["action"] as? [String: Any] {
                let actionName = actionDict["type"] as? String ?? "event"
                onAction(actionName, actionDict)
            } else {
                let action = props["action"] as? String ?? ""
                // Parse action format: "action_name:payload"
                if action.contains(":") {
                    let parts = action.split(separator: ":", maxSplits: 1)
                    let actionName = String(parts[0])
                    let payload = parts.count > 1 ? String(parts[1]) : nil
                    onAction(actionName, payload)
                } else {
                    onAction(action, nil)
                }
            }
        }) {
            VStack(spacing: 0) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                    ComponentRouter(component: child, onAction: onAction)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

struct TextInputComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    @State private var text = ""
    
    var body: some View {
        let id = props["id"] as? String ?? "input"
        let placeholder = props["placeholder"] as? String ?? "Enter text..."
        let label = props["label"] as? String
        
        VStack(alignment: .leading, spacing: 8) {
            if let label = label {
                Text(label)
                    .font(.headline)
            }
            
            HStack {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        onAction("input_submit", ["id": id, "value": text])
                        text = ""
                    }
                
                Button(action: {
                    onAction("input_submit", ["id": id, "value": text])
                    text = ""
                }) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundColor(.orange)
                }
                .disabled(text.isEmpty)
            }
        }
    }
}

// MARK: - Feedback Components

struct LoadingComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let message = props["message"] as? String
        let size = props["size"] as? String ?? "large"
        
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(size == "small" ? 1.0 : 1.5)
            if let message = message {
                Text(message)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: size == "large" ? .infinity : nil)
    }
}

struct SkeletonComponent: View {
    let props: [String: Any]
    
    @State private var isAnimating = false
    
    var body: some View {
        let lines = props["lines"] as? Int ?? 1
        let height = props["height"] as? CGFloat ?? 20
        let width = props["width"] as? CGFloat
        
        VStack(alignment: .leading, spacing: 8) {
            ForEach(0..<lines, id: \.self) { i in
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.gray.opacity(isAnimating ? 0.3 : 0.15))
                    .frame(width: i == lines - 1 ? (width ?? .infinity) * 0.7 : width, height: height)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) {
                isAnimating = true
            }
        }
    }
}

struct ProgressBarComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let progress = props["progress"] as? Double ?? 0
        let label = props["label"] as? String
        
        VStack(alignment: .leading, spacing: 4) {
            if let label = label {
                Text(label)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.gray.opacity(0.2))
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.orange)
                        .frame(width: geo.size.width * CGFloat(min(max(progress, 0), 1)))
                }
            }
            .frame(height: 8)
        }
    }
}

struct ToastComponent: View {
    let props: [String: Any]
    
    var body: some View {
        let message = props["message"] as? String ?? ""
        let type = props["type"] as? String ?? "info"
        
        HStack(spacing: 8) {
            Image(systemName: icon(for: type))
            Text(message)
                .font(.subheadline)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(backgroundColor(for: type))
        .foregroundColor(.white)
        .cornerRadius(8)
    }
    
    private func icon(for type: String) -> String {
        switch type {
        case "success": return "checkmark.circle.fill"
        case "error": return "xmark.circle.fill"
        default: return "info.circle.fill"
        }
    }
    
    private func backgroundColor(for type: String) -> Color {
        switch type {
        case "success": return .green
        case "error": return .red
        default: return .blue
        }
    }
}

// MARK: - SDUI Components

/// ForEach - Iterates over an array and renders children for each item
struct ForEachComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        ForEach(Array(resolvedItems.enumerated()), id: \.offset) { index, item in
            // Render the template with item data available
            // The TemplateRenderer has already expanded this for us
            // so we just render whatever children we have
            let renderedTemplate = renderWithItem(template: resolvedTemplate, item: item, index: index)
            ComponentRouter(component: renderedTemplate, onAction: { action, data in
                // Include item context in action
                var enrichedData = (data as? [String: Any]) ?? [:]
                enrichedData["_item"] = item
                enrichedData["_index"] = index
                onAction(action, enrichedData)
            })
        }
    }
    
    private var resolvedItems: [[String: Any]] {
        let items = props["items"] as? [[String: Any]] ?? []
        if items.isEmpty {
            Log.app.debug("ForEachComponent: items array is empty or not resolved")
        }
        return items
    }
    
    private var resolvedTemplate: [String: Any] {
        // Accept both "template" and "itemTemplate" for compatibility
        return (props["template"] ?? props["itemTemplate"]) as? [String: Any] ?? [:]
    }
    
    private func renderWithItem(template: [String: Any], item: [String: Any], index: Int) -> [String: Any] {
        // If template already has resolved bindings, return as-is
        // Otherwise, resolve bindings using TemplateRenderer
        return TemplateRenderer.renderWithItem(template: template, data: item, item: item)
    }
}

/// If - Conditional rendering based on a boolean condition
struct IfComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let condition = evaluateCondition()
        let thenContent = props["then"] as? [String: Any]
        let elseContent = props["else"] as? [String: Any]
        
        if condition {
            if let thenContent = thenContent {
                ComponentRouter(component: thenContent, onAction: onAction)
            }
        } else {
            if let elseContent = elseContent {
                ComponentRouter(component: elseContent, onAction: onAction)
            }
        }
    }
    
    private func evaluateCondition() -> Bool {
        // Direct boolean
        if let condition = props["condition"] as? Bool {
            return condition
        }
        
        // String truthy check
        if let condition = props["condition"] as? String {
            // Check for common truthy/falsy values
            let lower = condition.lowercased()
            if lower == "true" || lower == "yes" || lower == "1" {
                return true
            }
            if lower == "false" || lower == "no" || lower == "0" || condition.isEmpty {
                return false
            }
            // Non-empty string is truthy
            return !condition.isEmpty
        }
        
        // Number truthy check
        if let condition = props["condition"] as? Int {
            return condition != 0
        }
        if let condition = props["condition"] as? Double {
            return condition != 0
        }
        
        // Array/dict not empty check
        if let condition = props["condition"] as? [Any] {
            return !condition.isEmpty
        }
        if let condition = props["condition"] as? [String: Any] {
            return !condition.isEmpty
        }
        
        // NSNull or nil is falsy
        if props["condition"] is NSNull {
            return false
        }
        
        // Default: check if condition key exists
        return props["condition"] != nil
    }
}

/// View - Reference to a registered view in ViewRegistry
struct ViewRefComponent: View {
    let props: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        let viewName = props["name"] as? String ?? ""
        let data = props["data"] as? [String: Any] ?? [:]
        
        // Render inline by fetching from ViewRegistry
        NestedViewRenderer(viewName: viewName, data: data, onAction: onAction)
    }
}

/// Helper view to render nested views from ViewRegistry
struct NestedViewRenderer: View {
    let viewName: String
    let data: [String: Any]
    let onAction: (String, Any?) -> Void
    
    var body: some View {
        // Get template from registry and render it
        let components = renderNestedView()
        
        ForEach(Array(components.enumerated()), id: \.offset) { _, component in
            ComponentRouter(component: component, onAction: onAction)
        }
    }
    
    private func renderNestedView() -> [[String: Any]] {
        // Access ViewRegistry on main actor
        // Since we're already on main thread in SwiftUI view, this is safe
        let registry = ViewRegistry.shared
        
        guard let template = registry.templates[viewName],
              let templateDict = template.parseTemplate() else {
            return [["type": "Text", "props": ["text": "View not found: \(viewName)"]]]
        }
        
        // Merge default data with provided data
        var mergedData = template.parseDefaultData() ?? [:]
        for (key, value) in data {
            mergedData[key] = value
        }
        
        // Render with data
        let rendered = TemplateRenderer.render(template: templateDict, data: mergedData)
        return [rendered]
    }
}
