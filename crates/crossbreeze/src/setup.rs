//! Read-only setup planning. The IDE reviews and applies the returned edits.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const PLUGIN: &str = "@cross-css/vite";
const CLIENT: &str = "@cross-css/vite/client";
const RUNTIME: &str = "@cross-css/vite/react";

#[derive(Deserialize)]
pub struct Input {
    pub root: PathBuf,
    #[serde(default)]
    pub files: BTreeMap<PathBuf, String>,
    #[serde(default)]
    pub sources: Option<Vec<PathBuf>>,
}
#[derive(Default, Serialize)]
pub struct Plan {
    pub edits: Vec<Edit>,
    pub steps: Vec<Step>,
}
#[derive(Serialize)]
pub struct Edit {
    pub path: PathBuf,
    pub before: Option<String>,
    pub after: String,
}
#[derive(Serialize)]
pub struct Step {
    pub message: String,
    pub path: PathBuf,
}
#[derive(Serialize)]
pub struct Output {
    pub root: PathBuf,
    pub plan: Option<Plan>,
}

impl Input {
    fn read(&self, path: &Path) -> Option<String> {
        self.files
            .get(path)
            .cloned()
            .or_else(|| fs::read_to_string(path).ok())
    }
}
impl Plan {
    fn step(&mut self, path: &Path, message: impl Into<String>) {
        self.steps.push(Step {
            path: path.into(),
            message: message.into(),
        });
    }
    fn edit(&mut self, input: &Input, path: &Path, after: String, message: &str) {
        let before = input.read(path);
        if before.as_deref() != Some(&after) {
            self.edits.push(Edit {
                path: path.into(),
                before,
                after,
            });
            self.step(path, message);
        }
    }
}
fn json(text: &str) -> Option<Value> {
    jsonc_parser::parse_to_serde_value(text, &Default::default())
        .ok()
        .flatten()
}

fn effective_config(input: &Input, path: &Path, seen: &mut Vec<PathBuf>) -> Option<Value> {
    if seen.iter().any(|p| p == path) {
        return None;
    }
    seen.push(path.into());
    let data = json(&input.read(path)?)?;
    let mut result = serde_json::json!({});
    let parents: Vec<_> = data["extends"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_else(|| data["extends"].as_str().into_iter().collect());
    for parent in parents {
        if !parent.starts_with('.') {
            return None;
        }
        let mut parent_path = path.parent()?.join(parent);
        if parent_path.extension().is_none() {
            parent_path.set_extension("json");
        }
        let inherited = effective_config(input, &parent_path, seen)?;
        for (key, value) in inherited.as_object()? {
            result[key] = value.clone();
        }
    }
    for (key, value) in data.as_object()? {
        if key == "compilerOptions" {
            if !result[key].is_object() {
                result[key] = serde_json::json!({});
            }
            for (option, value) in value.as_object()? {
                result[key][option] = value.clone();
            }
        } else {
            result[key] = value.clone();
        }
    }
    seen.pop();
    Some(result)
}

fn application_config(input: &Input, entry: &Path) -> Option<(PathBuf, Value)> {
    fn visit(
        input: &Input,
        path: &Path,
        seen: &mut Vec<PathBuf>,
        candidates: &mut Vec<(PathBuf, Value)>,
    ) {
        if seen.iter().any(|p| p == path) {
            return;
        }
        seen.push(path.into());
        let Some(data) = effective_config(input, path, &mut Vec::new()) else {
            return;
        };
        let files = data["files"].as_array();
        let app_file = |name: &str| {
            !name.ends_with(".d.ts")
                && !name.contains("vite.config.")
                && !name.contains(".test.")
                && !name.contains(".spec.")
                && [".ts", ".tsx", ".mts", ".cts"]
                    .iter()
                    .any(|ext| name.ends_with(ext))
        };
        let has_sources = files.map_or_else(
            || {
                input
                    .sources
                    .as_ref()
                    .is_none_or(|sources| sources.iter().any(|p| app_file(&p.to_string_lossy())))
            },
            |files| files.iter().filter_map(Value::as_str).any(app_file),
        );
        if has_sources {
            candidates.push((path.into(), data.clone()));
        }
        for reference in data["references"].as_array().into_iter().flatten() {
            if let Some(name) = reference["path"].as_str() {
                let mut target = path.parent().unwrap().join(name);
                if target.extension().is_none() {
                    target = target.join("tsconfig.json");
                }
                visit(input, &target, seen, candidates);
            }
        }
    }
    let mut candidates = Vec::new();
    visit(input, entry, &mut Vec::new(), &mut candidates);
    if candidates.len() == 1 {
        candidates.pop()
    } else {
        None
    }
}

pub fn plan(input: &Input) -> Option<Plan> {
    let manifest_path = input.root.join("package.json");
    let manifest = json(&input.read(&manifest_path)?)?;
    let dependencies: BTreeMap<_, _> = ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|s| manifest[*s].as_object())
        .flat_map(|o| o.iter().map(|(key, value)| (key.clone(), value)))
        .collect();
    let configs: Vec<_> = ["ts", "js", "mts", "mjs", "cts", "cjs"]
        .iter()
        .map(|e| input.root.join(format!("vite.config.{e}")))
        .filter(|p| input.read(p).is_some())
        .collect();
    let scripts: Vec<_> = manifest["scripts"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(Value::as_str)
        .collect();
    if configs.is_empty()
        && !dependencies.contains_key("vite")
        && !scripts
            .iter()
            .any(|s| s.trim().starts_with("vite ") || s.trim() == "vite")
    {
        return None;
    }
    let mut result = Plan::default();
    let installed = input.root.ancestors().any(|d| {
        d.join("node_modules/@cross-css/vite/package.json")
            .is_file()
    });
    if !dependencies.contains_key(PLUGIN) || !installed {
        let manager = manifest["packageManager"]
            .as_str()
            .and_then(|s| s.split('@').next())
            .map(str::to_owned)
            .or_else(|| {
                input.root.ancestors().find_map(|d| {
                    [
                        ("pnpm", "pnpm-lock.yaml"),
                        ("yarn", "yarn.lock"),
                        ("bun", "bun.lock"),
                        ("npm", "package-lock.json"),
                    ]
                    .iter()
                    .find(|(_, name)| d.join(name).exists())
                    .map(|(m, _)| m.to_string())
                })
            })
            .unwrap_or("npm".into());
        let command = if manager == "npm" {
            format!("npm install -D {PLUGIN}")
        } else {
            format!("{manager} add -D {PLUGIN}")
        };
        result.step(
            &manifest_path,
            format!("Install the XCSS Vite plugin in this package: {command}"),
        );
        return Some(result);
    }
    if configs.len() > 1
        || scripts
            .iter()
            .any(|s| s.contains("--config") || s.contains(" -c "))
    {
        result.step(configs.first().unwrap_or(&manifest_path),format!("Register {PLUGIN} before JSX transforms in the Vite config selected by this package."));
        return Some(result);
    }
    let config_entry = ["tsconfig.json", "tsconfig.app.json"]
        .iter()
        .map(|n| input.root.join(n))
        .find(|p| input.read(p).is_some());
    let selected = config_entry
        .as_deref()
        .and_then(|entry| application_config(input, entry));
    if let Some(entry) = &config_entry
        && selected.is_none()
    {
        result.step(entry,"Select the application tsconfig and point xcss({ tsconfig: … }) at it. Setup could not identify one TypeScript application.");
        return Some(result);
    }
    let config = selected.as_ref().map(|(path, _)| path.clone());
    let react = dependencies.contains_key("react") && config.is_some();
    if react && let Some((path, data)) = &selected {
        let options = &data["compilerOptions"];
        if options["jsxImportSource"]
            .as_str()
            .is_some_and(|source| source != "react" && source != RUNTIME)
            || options["jsx"]
                .as_str()
                .is_some_and(|jsx| jsx == "react" || jsx == "react-native")
        {
            result.step(path,format!("Resolve the configured JSX runtime and import source before switching to {RUNTIME}."));
            return Some(result);
        }
    }
    let vite_path = configs.first().cloned().unwrap_or_else(|| {
        input.root.join(if config.is_some() {
            "vite.config.ts"
        } else {
            "vite.config.js"
        })
    });
    // Existing dynamic configuration must never be overwritten by a generated file.
    let explicit_config = config
        .as_ref()
        .filter(|p| **p != input.root.join("tsconfig.json"))
        .and_then(|p| p.strip_prefix(&input.root).ok())
        .map(|p| format!("./{}", p.to_string_lossy().replace('\\', "/")));
    let existing_vite = if let Some(source) = input.read(&vite_path) {
        match crate::vite::edit_config(&source, react, explicit_config.as_deref()) {
            Ok(after) => Some(after),
            Err(message) => {
                result.step(&vite_path, message);
                return Some(result);
            }
        }
    } else {
        None
    };
    let mut vite =
        format!("import {{ defineConfig }} from \"vite\";\nimport xcss from \"{PLUGIN}\";\n");
    if react && dependencies.contains_key("@vitejs/plugin-react") {
        vite.push_str("import react from \"@vitejs/plugin-react\";\n");
    }
    let xcss_call = explicit_config.as_ref().map_or_else(
        || "xcss()".into(),
        |config| {
            format!(
                "xcss({{ tsconfig: {} }})",
                serde_json::to_string(config).unwrap()
            )
        },
    );
    let plugins = if react && dependencies.contains_key("@vitejs/plugin-react") {
        format!("{xcss_call}, react({{ jsxImportSource: \"{RUNTIME}\" }})")
    } else {
        xcss_call
    };
    let oxc = if react && !dependencies.contains_key("@vitejs/plugin-react") {
        format!(", oxc: {{ jsx: {{ runtime: 'automatic', importSource: \"{RUNTIME}\" }} }}")
    } else {
        String::new()
    };
    vite.push_str(&format!(
        "export default defineConfig({{ plugins: [{plugins}]{oxc} }});\n"
    ));
    if let Some(existing) = existing_vite {
        vite = existing;
    }
    if react && let Some(config_path) = &config {
        let source = input.read(config_path)?;
        let root = match jsonc_parser::cst::CstRootNode::parse(&source, &Default::default()) {
            Ok(root) => root,
            Err(_) => {
                result.step(
                    config_path,
                    "Fix the TypeScript configuration before applying setup.",
                );
                return Some(result);
            }
        };
        let object = root.object_value()?;
        let options = object.object_value_or_create("compilerOptions")?;
        for (key, value) in [("jsx", "react-jsx"), ("jsxImportSource", RUNTIME)] {
            if let Some(property) = options.get(key) {
                property.set_value(jsonc_parser::json!(value));
            } else {
                options.append(key, jsonc_parser::json!(value));
            }
        }
        result.edit(
            input,
            config_path,
            root.to_string(),
            "Configure the XCSS JSX runtime",
        );
    }
    result.edit(input, &vite_path, vite, "Configure the XCSS Vite plugin");
    if config.is_some() {
        let declarations: Vec<_> = input
            .sources
            .as_ref()
            .into_iter()
            .flatten()
            .filter(|p| p.to_string_lossy().ends_with(".d.ts"))
            .collect();
        let declared = declarations.iter().any(|p| {
            input
                .read(p)
                .is_some_and(|s| s.contains(CLIENT) || s.contains("declare module '*.xcss'"))
        });
        if !declared && input.read(&input.root.join("xcss-env.d.ts")).is_some() {
            result.step(&input.root.join("xcss-env.d.ts"),"Add the XCSS client reference to an included declaration file; xcss-env.d.ts is already occupied.");
        } else if !declared {
            result.edit(
                input,
                &input.root.join("xcss-env.d.ts"),
                format!("/// <reference types=\"{CLIENT}\" />\n"),
                "Add the XCSS client reference",
            );
        }
    } else {
        result.step(&manifest_path,"Stylesheet imports can work without TypeScript. xClass and xVars need a suitable tsconfig and the XCSS JSX runtime.");
    }
    Some(result)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let inputs: Vec<Input> = serde_json::from_reader(std::io::stdin().lock())?;
    let outputs: Vec<_> = inputs
        .iter()
        .map(|input| Output {
            root: input.root.clone(),
            plan: plan(input),
        })
        .collect();
    serde_json::to_writer(std::io::stdout().lock(), &outputs)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_references_select_application_and_inherit_options() {
        let root = PathBuf::from("/crossbreeze-config-test");
        let input=Input {root:root.clone(),sources:Some(vec![root.join("src/app.tsx")]),files:BTreeMap::from([
            (root.join("tsconfig.json"),r#"{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}"#.into()),
            (root.join("tsconfig.node.json"),r#"{"files":["vite.config.ts"]}"#.into()),
            (root.join("tsconfig.base.json"),r#"{"compilerOptions":{"strict":true},"include":["src"]}"#.into()),
            (root.join("tsconfig.app.json"),r#"{"extends":"./tsconfig.base.json"}"#.into()),
        ])};
        let (path, data) = application_config(&input, &root.join("tsconfig.json")).unwrap();
        assert_eq!(path, root.join("tsconfig.app.json"));
        assert_eq!(data["compilerOptions"]["strict"], true);
        assert_eq!(data["include"], serde_json::json!(["src"]));
    }
    #[test]
    fn cyclic_config_inheritance_is_rejected() {
        let root = PathBuf::from("/crossbreeze-cycle-test");
        let input = Input {
            root: root.clone(),
            sources: None,
            files: BTreeMap::from([
                (root.join("a.json"), r#"{"extends":"./b.json"}"#.into()),
                (root.join("b.json"), r#"{"extends":"./a.json"}"#.into()),
            ]),
        };
        assert!(effective_config(&input, &root.join("a.json"), &mut Vec::new()).is_none());
    }
    #[test]
    fn plain_packages_are_ignored_and_uninstalled_vite_gets_instructions() {
        let root = PathBuf::from("/crossbreeze-test-unused");
        let mut input = Input {
            root: root.clone(),
            files: BTreeMap::from([(root.join("package.json"), "{}".into())]),
            sources: None,
        };
        assert!(plan(&input).is_none());
        input.files.insert(
            root.join("package.json"),
            r#"{"devDependencies":{"vite":"*"},"packageManager":"pnpm@10.0.0"}"#.into(),
        );
        let result = plan(&input).unwrap();
        assert!(result.edits.is_empty());
        assert!(
            result.steps[0]
                .message
                .contains("pnpm add -D @cross-css/vite")
        );
    }
    #[test]
    fn fresh_react_setup_previews_comment_preserving_edits() {
        let root = std::env::temp_dir().join(format!("crossbreeze-setup-{}", std::process::id()));
        let dependency = root.join("node_modules/@cross-css/vite");
        fs::create_dir_all(&dependency).unwrap();
        fs::write(dependency.join("package.json"), "{}").unwrap();
        let mut input = Input {
            root: root.clone(),
            files: BTreeMap::new(),
            sources: None,
        };
        input.files.insert(root.join("package.json"),r#"{"dependencies":{"react":"*","vite":"*","@cross-css/vite":"*","@vitejs/plugin-react":"*"}}"#.into());
        input.files.insert(
            root.join("tsconfig.json"),
            "{\n // retain me\n \"include\": [\"src\"]\n}".into(),
        );
        let result = plan(&input).unwrap();
        assert_eq!(result.edits.len(), 3);
        let config = result
            .edits
            .iter()
            .find(|e| e.path.ends_with("tsconfig.json"))
            .unwrap();
        assert!(config.after.contains("// retain me"));
        assert!(config.after.contains(RUNTIME));
        assert!(!root.join("vite.config.ts").exists());
        input.files.insert(root.join("vite.config.ts"),"import react from '@vitejs/plugin-react'; export default { plugins: [react()], server: { port: 3001 } };".into());
        let existing = plan(&input).unwrap();
        assert!(
            existing
                .edits
                .iter()
                .any(|e| e.path.ends_with("vite.config.ts")
                    && e.after.contains(RUNTIME)
                    && e.after.contains("server: { port: 3001 }"))
        );
        assert!(
            existing
                .edits
                .iter()
                .any(|e| e.path.ends_with("tsconfig.json") && e.after.contains(RUNTIME))
        );
        input.files.insert(root.join("vite.config.ts"),"import react from '@vitejs/plugin-react'; export default { plugins: [react({ jsxRuntime: 'classic' })] };".into());
        assert!(plan(&input).unwrap().edits.is_empty());
        fs::remove_file(dependency.join("package.json")).unwrap();
        fs::remove_dir(&dependency).unwrap();
        fs::remove_dir(root.join("node_modules/@cross-css")).unwrap();
        fs::remove_dir(root.join("node_modules")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
