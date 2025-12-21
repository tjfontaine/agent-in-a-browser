//! MCP Tool Macros
//!
//! Provides proc macros for defining MCP tools with minimal boilerplate:
//! - `#[mcp_tool]` - Marks a function as an MCP tool
//! - `#[mcp_tool_router]` - Generates list_tools() and call_tool() dispatcher

use proc_macro::TokenStream;
use quote::{quote, format_ident, ToTokens};
use syn::{
    parse_macro_input, Attribute, FnArg, Ident, ImplItem, ImplItemFn, ItemImpl,
    Pat, Type, LitStr,
};

/// Attribute macro to mark a function as an MCP tool.
///
/// # Arguments
/// - `description` - The tool description shown to LLMs
///
/// # Example
/// ```ignore
/// #[mcp_tool(description = "Execute TypeScript code")]
/// fn run_typescript(&mut self, code: String) -> ToolResult {
///     // implementation
/// }
/// ```
#[proc_macro_attribute]
pub fn mcp_tool(attr: TokenStream, item: TokenStream) -> TokenStream {
    // Parse the description from attributes
    let attr_args: ToolAttrArgs = parse_macro_input!(attr as ToolAttrArgs);
    let func: ImplItemFn = parse_macro_input!(item as ImplItemFn);
    
    // Just return the function unchanged - the router macro will collect metadata
    let output = quote! {
        #[mcp_tool_marker(description = #attr_args)]
        #func
    };
    
    output.into()
}

/// Internal marker attribute - consumed by #[mcp_tool_router].
/// When expanded standalone (not in router context), just passes through the item.
/// The router looks for these before they would run.
#[proc_macro_attribute]
pub fn mcp_tool_marker(attr: TokenStream, item: TokenStream) -> TokenStream {
    // If we reach here, it means mcp_tool_router already ran and stripped us,
    // or we're being used incorrectly. Just return the item unchanged.
    let _ = attr; // suppress unused warning
    item
}

/// Parsed arguments from #[mcp_tool(description = "...")]
struct ToolAttrArgs {
    description: LitStr,
}

impl syn::parse::Parse for ToolAttrArgs {
    fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
        let ident: Ident = input.parse()?;
        if ident != "description" {
            return Err(syn::Error::new(ident.span(), "expected `description`"));
        }
        input.parse::<syn::Token![=]>()?;
        let description: LitStr = input.parse()?;
        Ok(ToolAttrArgs { description })
    }
}

impl ToTokens for ToolAttrArgs {
    fn to_tokens(&self, tokens: &mut proc_macro2::TokenStream) {
        self.description.to_tokens(tokens);
    }
}

/// Parses the description from a #[mcp_tool(description = "...")] attribute
fn parse_tool_description(attr: &Attribute) -> Option<String> {
    if !attr.path().is_ident("mcp_tool") {
        return None;
    }
    
    let args: syn::Result<ToolAttrArgs> = attr.parse_args();
    args.ok().map(|a| a.description.value())
}

/// Attribute macro to generate the MCP tool router for an impl block.
///
/// This macro:
/// 1. Collects all functions marked with `#[mcp_tool]`
/// 2. Generates `list_tools()` returning tool definitions
/// 3. Generates `call_tool()` dispatcher
///
/// # Example
/// ```ignore
/// #[mcp_tool_router]
/// impl MyServer {
///     #[mcp_tool(description = "Do something")]
///     fn my_tool(&mut self, arg: String) -> ToolResult { ... }
/// }
/// ```
#[proc_macro_attribute]
pub fn mcp_tool_router(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemImpl);
    
    // Collect tool information
    let mut tools: Vec<ToolInfo> = Vec::new();
    let mut methods: Vec<ImplItemFn> = Vec::new();
    let mut other_items: Vec<ImplItem> = Vec::new();
    
    for item in input.items {
        match item {
            ImplItem::Fn(mut method) => {
                // Check if this method has #[mcp_tool] attribute
                let tool_attr = method.attrs.iter()
                    .find(|a| a.path().is_ident("mcp_tool"));
                
                if let Some(attr) = tool_attr {
                    if let Some(description) = parse_tool_description(attr) {
                        // Extract parameter info
                        let params = extract_params(&method);
                        
                        tools.push(ToolInfo {
                            name: method.sig.ident.to_string(),
                            description,
                            params,
                            method_ident: method.sig.ident.clone(),
                        });
                    }
                    
                    // Remove the mcp_tool attribute from the output
                    method.attrs.retain(|a| !a.path().is_ident("mcp_tool"));
                }
                
                methods.push(method);
            }
            other => other_items.push(other),
        }
    }
    
    // Generate list_tools() method
    let list_tools_body = generate_list_tools(&tools);
    
    // Generate call_tool() method
    let call_tool_body = generate_call_tool(&tools);
    
    // Reconstruct the impl block
    let self_ty = &input.self_ty;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    
    let output = quote! {
        impl #impl_generics #self_ty #ty_generics #where_clause {
            #(#methods)*
        }
        
        impl #impl_generics crate::mcp_server::McpServer for #self_ty #ty_generics #where_clause {
            fn server_info(&self) -> crate::mcp_server::ServerInfo {
                crate::mcp_server::ServerInfo {
                    name: "ts-runtime".to_string(),
                    version: "0.1.0".to_string(),
                }
            }
            
            #list_tools_body
            #call_tool_body
        }
    };
    
    output.into()
}

struct ToolInfo {
    name: String,
    description: String,
    params: Vec<ParamInfo>,
    method_ident: Ident,
}

struct ParamInfo {
    name: String,
    param_type: String,
    is_optional: bool,
}

fn extract_params(method: &ImplItemFn) -> Vec<ParamInfo> {
    method.sig.inputs.iter()
        .filter_map(|arg| {
            match arg {
                FnArg::Typed(pat_type) => {
                    let name = match &*pat_type.pat {
                        Pat::Ident(ident) => ident.ident.to_string(),
                        _ => return None,
                    };
                    
                    // Skip self
                    if name == "self" {
                        return None;
                    }
                    
                    let (param_type, is_optional) = parse_type(&pat_type.ty);
                    
                    Some(ParamInfo {
                        name,
                        param_type,
                        is_optional,
                    })
                }
                FnArg::Receiver(_) => None,
            }
        })
        .collect()
}

fn parse_type(ty: &Type) -> (String, bool) {
    match ty {
        Type::Path(type_path) => {
            let path = &type_path.path;
            let segment = path.segments.last();
            
            if let Some(seg) = segment {
                let ident = seg.ident.to_string();
                
                // Check for Option<T>
                if ident == "Option" {
                    if let syn::PathArguments::AngleBracketed(args) = &seg.arguments {
                        if let Some(syn::GenericArgument::Type(inner_ty)) = args.args.first() {
                            let (inner_type, _) = parse_type(inner_ty);
                            return (inner_type, true);
                        }
                    }
                    return ("string".to_string(), true);
                }
                
                // Map Rust types to JSON schema types
                let json_type = match ident.as_str() {
                    "String" | "str" => "string",
                    "i32" | "i64" | "u32" | "u64" | "usize" | "isize" => "integer",
                    "f32" | "f64" => "number",
                    "bool" => "boolean",
                    _ => "string",
                };
                
                return (json_type.to_string(), false);
            }
            
            ("string".to_string(), false)
        }
        _ => ("string".to_string(), false),
    }
}

fn generate_list_tools(tools: &[ToolInfo]) -> proc_macro2::TokenStream {
    let tool_definitions = tools.iter().map(|tool| {
        let name = &tool.name;
        let description = &tool.description;
        
        // Build properties object
        let properties = tool.params.iter().map(|p| {
            let param_name = &p.name;
            let param_type = &p.param_type;
            let param_desc = format!("The {} parameter", param_name);
            
            quote! {
                #param_name: {
                    "type": #param_type,
                    "description": #param_desc
                }
            }
        });
        
        // Build required array (non-optional params)
        let required: Vec<_> = tool.params.iter()
            .filter(|p| !p.is_optional)
            .map(|p| &p.name)
            .collect();
        
        quote! {
            crate::mcp_server::ToolDefinition {
                name: #name.to_string(),
                description: #description.to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        #(#properties),*
                    },
                    "required": [#(#required),*]
                }),
            }
        }
    });
    
    quote! {
        fn list_tools(&self) -> Vec<crate::mcp_server::ToolDefinition> {
            vec![
                #(#tool_definitions),*
            ]
        }
    }
}

fn generate_call_tool(tools: &[ToolInfo]) -> proc_macro2::TokenStream {
    let match_arms = tools.iter().map(|tool| {
        let name = &tool.name;
        let method_ident = &tool.method_ident;
        
        // Generate argument extraction
        let arg_extractions = tool.params.iter().map(|p| {
            let param_name = &p.name;
            let param_ident = format_ident!("{}", param_name);
            
            if p.is_optional {
                quote! {
                    let #param_ident = arguments.get(#param_name)
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            } else {
                quote! {
                    let #param_ident = match arguments.get(#param_name).and_then(|v| v.as_str()) {
                        Some(v) => v.to_string(),
                        None => return crate::mcp_server::ToolResult::error(
                            format!("Missing required parameter: {}", #param_name)
                        ),
                    };
                }
            }
        });
        
        // Generate method call with arguments
        let arg_idents: Vec<_> = tool.params.iter()
            .map(|p| format_ident!("{}", p.name))
            .collect();
        
        quote! {
            #name => {
                #(#arg_extractions)*
                self.#method_ident(#(#arg_idents),*)
            }
        }
    });
    
    quote! {
        fn call_tool(&mut self, name: &str, arguments: serde_json::Value) -> crate::mcp_server::ToolResult {
            match name {
                #(#match_arms)*
                _ => crate::mcp_server::ToolResult::error(format!("Unknown tool: {}", name)),
            }
        }
    }
}

// =============================================================================
// Shell Command Macros
// =============================================================================

/// Parsed arguments from #[shell_command(name = "...", usage = "...", description = "...")]
struct ShellCommandAttrArgs {
    name: String,
    usage: String,
    description: String,
}

impl syn::parse::Parse for ShellCommandAttrArgs {
    fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
        let mut name = None;
        let mut usage = None;
        let mut description = None;
        
        while !input.is_empty() {
            let ident: Ident = input.parse()?;
            input.parse::<syn::Token![=]>()?;
            let value: LitStr = input.parse()?;
            
            match ident.to_string().as_str() {
                "name" => name = Some(value.value()),
                "usage" => usage = Some(value.value()),
                "description" => description = Some(value.value()),
                other => return Err(syn::Error::new(ident.span(), format!("unknown attribute: {}", other))),
            }
            
            // Consume optional comma
            if input.peek(syn::Token![,]) {
                input.parse::<syn::Token![,]>()?;
            }
        }
        
        Ok(ShellCommandAttrArgs {
            name: name.ok_or_else(|| syn::Error::new(input.span(), "missing `name`"))?,
            usage: usage.ok_or_else(|| syn::Error::new(input.span(), "missing `usage`"))?,
            description: description.ok_or_else(|| syn::Error::new(input.span(), "missing `description`"))?,
        })
    }
}

/// Attribute macro to mark a function as a shell command.
///
/// # Arguments
/// - `name` - The command name (e.g., "ls")
/// - `usage` - Usage string (e.g., "ls [-l] [PATH]...")
/// - `description` - Brief description
///
/// # Example
/// ```ignore
/// #[shell_command(name = "ls", usage = "ls [-l] [PATH]...", description = "List directory contents")]
/// fn cmd_ls(args: Vec<String>, env: &ShellEnv, ...) -> BoxedFuture<i32> { ... }
/// ```
#[proc_macro_attribute]
pub fn shell_command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let attr_args: ShellCommandAttrArgs = match syn::parse(attr) {
        Ok(args) => args,
        Err(e) => return e.to_compile_error().into(),
    };
    let func: ImplItemFn = parse_macro_input!(item as ImplItemFn);
    
    let name = &attr_args.name;
    let usage = &attr_args.usage;
    let description = &attr_args.description;
    
    // Pass through with marker attribute containing the metadata
    let output = quote! {
        #[shell_command_marker(name = #name, usage = #usage, description = #description)]
        #func
    };
    
    output.into()
}

/// Internal marker attribute - consumed by #[shell_commands].
#[proc_macro_attribute]
pub fn shell_command_marker(attr: TokenStream, item: TokenStream) -> TokenStream {
    let _ = attr;
    item
}

/// Parses shell command metadata from a #[shell_command(...)] attribute
fn parse_shell_command_attr(attr: &Attribute) -> Option<ShellCommandInfo> {
    if !attr.path().is_ident("shell_command") {
        return None;
    }
    
    let args: syn::Result<ShellCommandAttrArgs> = attr.parse_args();
    args.ok().map(|a| ShellCommandInfo {
        name: a.name,
        usage: a.usage,
        description: a.description,
        method_ident: None, // Will be filled in by caller
    })
}

struct ShellCommandInfo {
    name: String,
    usage: String,
    description: String,
    method_ident: Option<Ident>,
}

/// Attribute macro to generate the shell command dispatcher.
///
/// This macro:
/// 1. Collects all functions marked with `#[shell_command]`
/// 2. Generates `get_command()` dispatcher  
/// 3. Generates `show_help()` for --help output
/// 4. Generates `list_commands()` for introspection
///
/// # Example
/// ```ignore
/// #[shell_commands]
/// impl ShellCommands {
///     #[shell_command(name = "echo", usage = "echo [STRING]...", description = "Display line of text")]
///     fn cmd_echo(...) -> ... { }
/// }
/// ```
#[proc_macro_attribute]
pub fn shell_commands(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemImpl);
    
    // Collect command information
    let mut commands: Vec<ShellCommandInfo> = Vec::new();
    let mut methods: Vec<ImplItemFn> = Vec::new();
    let mut other_items: Vec<ImplItem> = Vec::new();
    
    for item in input.items {
        match item {
            ImplItem::Fn(mut method) => {
                // Check if this method has #[shell_command] attribute
                let cmd_attr = method.attrs.iter()
                    .find(|a| a.path().is_ident("shell_command"));
                
                if let Some(attr) = cmd_attr {
                    if let Some(mut info) = parse_shell_command_attr(attr) {
                        info.method_ident = Some(method.sig.ident.clone());
                        commands.push(info);
                    }
                    
                    // Remove the shell_command attribute from the output
                    method.attrs.retain(|a| !a.path().is_ident("shell_command"));
                }
                
                methods.push(method);
            }
            other => other_items.push(other),
        }
    }
    
    // Generate get_command() dispatcher
    let get_command_arms = commands.iter().map(|cmd| {
        let name = &cmd.name;
        let method_ident = cmd.method_ident.as_ref().unwrap();
        quote! {
            #name => Some(Self::#method_ident)
        }
    });
    
    // Generate show_help() function
    let help_arms = commands.iter().map(|cmd| {
        let name = &cmd.name;
        let usage = &cmd.usage;
        let description = &cmd.description;
        let help_text = format!("Usage: {}\n\n{}\n", usage, description);
        quote! {
            #name => Some(#help_text)
        }
    });
    
    // Generate list_commands()
    let command_names: Vec<_> = commands.iter().map(|cmd| &cmd.name).collect();
    
    // Reconstruct the impl block
    let self_ty = &input.self_ty;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    
    let output = quote! {
        impl #impl_generics #self_ty #ty_generics #where_clause {
            #(#methods)*
            
            #(#other_items)*
            
            /// Get a command function by name.
            pub fn get_command(name: &str) -> Option<crate::shell::commands::CommandFn> {
                match name {
                    #(#get_command_arms,)*
                    _ => None,
                }
            }
            
            /// Get help text for a command.
            pub fn show_help(name: &str) -> Option<&'static str> {
                match name {
                    #(#help_arms,)*
                    _ => None,
                }
            }
            
            /// List all available commands.
            pub fn list_commands() -> &'static [&'static str] {
                &[#(#command_names),*]
            }
        }
    };
    
    output.into()
}
