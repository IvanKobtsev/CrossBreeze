//! Filesystem-backed analysis with open-document overlays.
use crate::{LanguageService, ServiceSnapshot};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use url::Url;
use xcss_source::FileId;

#[derive(Default)]
pub struct Workspace {
    pub roots: Vec<PathBuf>,
    pub excluded: Vec<PathBuf>,
    pub aliases: BTreeMap<String, Vec<String>>,
    pub overlays: BTreeMap<PathBuf, String>,
    files: BTreeMap<PathBuf, String>,
    revision: u64,
}

pub fn path(uri: &str) -> Option<PathBuf> {
    Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()
        .map(|p| canonical(&p))
}
pub fn uri(path: &Path) -> String {
    Url::from_file_path(path)
        .expect("absolute file path")
        .to_string()
}
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

impl Workspace {
    fn config_paths(
        &self,
        path: &Path,
        seen: &mut BTreeSet<PathBuf>,
    ) -> Option<(PathBuf, BTreeMap<String, Vec<String>>)> {
        let path = canonical(path);
        if !seen.insert(path.clone()) {
            return None;
        }
        let text = self
            .overlays
            .get(&path)
            .cloned()
            .or_else(|| fs::read_to_string(&path).ok())?;
        let data: serde_json::Value =
            jsonc_parser::parse_to_serde_value(&text, &Default::default())
                .ok()
                .flatten()?;
        let directory = path.parent()?;
        let mut inherited = (directory.to_path_buf(), BTreeMap::new());
        let parents: Vec<_> = data["extends"]
            .as_array()
            .map(|a| a.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_else(|| data["extends"].as_str().into_iter().collect());
        for parent in parents {
            let candidates: Vec<_> = if parent.starts_with('.') || Path::new(parent).is_absolute() {
                vec![directory.join(parent)]
            } else {
                directory
                    .ancestors()
                    .map(|dir| dir.join("node_modules").join(parent))
                    .collect()
            };
            for candidate in candidates {
                let paths = [
                    candidate.clone(),
                    candidate.with_extension("json"),
                    candidate.join("tsconfig.json"),
                ];
                if let Some(found) = paths
                    .iter()
                    .find_map(|p| self.config_paths(p, &mut seen.clone()))
                {
                    inherited = found;
                    break;
                }
            }
        }
        let options = &data["compilerOptions"];
        let base = options["baseUrl"]
            .as_str()
            .map(|base| canonical(&directory.join(base)))
            .unwrap_or_else(|| {
                if options.get("paths").is_some() {
                    directory.into()
                } else {
                    inherited.0
                }
            });
        let aliases = options
            .get("paths")
            .and_then(|paths| serde_json::from_value(paths.clone()).ok())
            .unwrap_or(inherited.1);
        Some((base, aliases))
    }

    fn nearest_paths(&self, importer: &Path) -> (PathBuf, BTreeMap<String, Vec<String>>) {
        for directory in importer.parent().into_iter().flat_map(Path::ancestors) {
            for name in ["tsconfig.json", "jsconfig.json"] {
                if let Some(paths) = self.config_paths(&directory.join(name), &mut BTreeSet::new())
                {
                    return paths;
                }
            }
        }
        (importer.parent().unwrap().into(), BTreeMap::new())
    }
    /// Build a project-relative TypeScript view; the engine supplies its own libs.
    pub fn typescript_snapshot(&mut self, source: &Path) -> Option<(ServiceSnapshot, PathBuf)> {
        let config = source.parent()?.ancestors().find_map(|dir| {
            let path = dir.join("tsconfig.json");
            (path.is_file() || self.overlays.contains_key(&path)).then_some(path)
        })?;
        let mut inputs = BTreeMap::new();
        let mut visited = BTreeSet::new();
        fn inventory(
            dir: &Path,
            inputs: &mut BTreeMap<PathBuf, String>,
            visited: &mut BTreeSet<PathBuf>,
        ) {
            if !visited.insert(canonical(dir)) {
                return;
            }
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if [
                    ".git", ".pnpm", "dist", "build", "target", "coverage", ".idea",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    continue;
                }
                if path.is_dir() {
                    inventory(&path, inputs, visited);
                } else if path.extension().is_some_and(|ext| {
                    [
                        "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "xcss",
                    ]
                    .iter()
                    .any(|e| ext == *e)
                }) && let Ok(text) = fs::read_to_string(&path)
                {
                    inputs.insert(path, text);
                }
            }
        }
        for root in &self.roots {
            inventory(root, &mut inputs, &mut visited);
        }
        for dir in config.parent()?.ancestors() {
            inventory(&dir.join("node_modules"), &mut inputs, &mut visited);
        }
        inputs.extend(self.files.clone());
        inputs.extend(self.overlays.clone());
        inputs.insert(
            config.clone(),
            self.overlays
                .get(&config)
                .cloned()
                .or_else(|| fs::read_to_string(&config).ok())?,
        );
        let mut anchor = config.parent()?.to_path_buf();
        for path in inputs.keys() {
            while !path.starts_with(&anchor) {
                anchor = anchor.parent()?.to_path_buf();
            }
        }
        let id = |p: &Path| {
            p.strip_prefix(&anchor)
                .ok()
                .map(|p| FileId(p.to_string_lossy().replace('\\', "/")))
        };
        let mut service = LanguageService::new();
        service.set_typescript_project(Some(id(&config)?.0));
        self.revision += 1;
        for (path, text) in &inputs {
            let Some(file) = id(path) else {
                continue;
            };
            if path.extension().is_some_and(|ext| ext == "xcss") {
                let parsed = xcss_syntax::parse(std::sync::Arc::new(xcss_source::SourceFile::new(
                    file.clone(),
                    self.revision,
                    text.clone(),
                )));
                for import in parsed
                    .tree
                    .descendants()
                    .filter_map(|n| parsed.injection_import(n))
                {
                    service.set_resolution(
                        file.clone(),
                        import.specifier.into(),
                        self.resolve(path, import.specifier).as_deref().and_then(id),
                    );
                }
                service.set_file(file, self.revision, text.clone()).ok()?;
            } else {
                service
                    .set_typescript_file(file, self.revision, text.clone())
                    .ok()?;
            }
        }
        Some((service.snapshot(), anchor))
    }
    pub fn refresh(&mut self) {
        let mut files = BTreeMap::new();
        for root in &self.roots {
            self.scan(root, &mut files);
        }
        files.extend(
            self.overlays
                .iter()
                .filter(|(p, _)| p.extension().is_some_and(|e| e == "xcss"))
                .map(|(p, text)| (p.clone(), text.clone())),
        );
        self.files = files;
    }
    fn scan(&self, directory: &Path, files: &mut BTreeMap<PathBuf, String>) {
        if self.excluded.iter().any(|p| directory.starts_with(p)) {
            return;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if ![
                    ".git",
                    ".idea",
                    "node_modules",
                    "dist",
                    "target",
                    "build",
                    "coverage",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    self.scan(&path, files);
                }
            } else if path.extension().is_some_and(|e| e == "xcss")
                && let Ok(text) = fs::read_to_string(&path)
            {
                files.insert(canonical(&path), text);
            }
        }
    }
    fn resolve(&self, importer: &Path, specifier: &str) -> Option<PathBuf> {
        let parent = importer.parent()?;
        let root = self
            .roots
            .iter()
            .find(|r| importer.starts_with(r))
            .map_or(parent, |r| r.as_path());
        let target = |candidate: PathBuf| {
            [
                candidate.clone(),
                PathBuf::from(format!("{}.xcss", candidate.display())),
                candidate.join("index.xcss"),
            ]
            .into_iter()
            .map(|p| canonical(&p))
            .find(|p| {
                p.extension().is_some_and(|e| e == "xcss")
                    && (self.overlays.contains_key(p) || p.is_file())
            })
        };
        if specifier.starts_with('.') || Path::new(specifier).is_absolute() {
            return target(parent.join(specifier));
        }
        let mut rules: Vec<_> = self
            .aliases
            .iter()
            .filter_map(|(key, values)| {
                if let Some((prefix, suffix)) = key.split_once('*') {
                    specifier
                        .strip_prefix(prefix)?
                        .strip_suffix(suffix)
                        .map(|capture| (false, prefix.len(), capture, values))
                } else {
                    (key == specifier).then_some((true, key.len(), "", values))
                }
            })
            .collect();
        rules.sort_by_key(|r| std::cmp::Reverse((r.0, r.1)));
        if let Some((_, _, capture, values)) = rules.first() {
            return values
                .iter()
                .find_map(|v| target(root.join(v.replace('*', capture))));
        }
        let (base, aliases) = self.nearest_paths(importer);
        let mut rules: Vec<_> = aliases
            .iter()
            .filter_map(|(key, values)| {
                if let Some((prefix, suffix)) = key.split_once('*') {
                    specifier
                        .strip_prefix(prefix)?
                        .strip_suffix(suffix)
                        .map(|capture| (false, prefix.len(), capture, values))
                } else {
                    (key == specifier).then_some((true, key.len(), "", values))
                }
            })
            .collect();
        rules.sort_by_key(|r| std::cmp::Reverse((r.0, r.1)));
        if let Some((_, _, capture, values)) = rules.first() {
            return values
                .iter()
                .find_map(|value| target(base.join(value.replace('*', capture))));
        }
        target(base.join(specifier))
    }
    pub fn snapshot(&mut self) -> ServiceSnapshot {
        self.revision += 1;
        let mut service = LanguageService::new();
        let mut pending: Vec<_> = self.files.keys().cloned().collect();
        let mut visited = BTreeSet::new();
        while let Some(path) = pending.pop() {
            if !visited.insert(path.clone()) {
                continue;
            }
            let text = self
                .overlays
                .get(&path)
                .or_else(|| self.files.get(&path))
                .cloned()
                .or_else(|| fs::read_to_string(&path).ok());
            let Some(text) = text else {
                continue;
            };
            let id = FileId(uri(&path));
            let parsed = xcss_syntax::parse(std::sync::Arc::new(xcss_source::SourceFile::new(
                id.clone(),
                self.revision,
                text.clone(),
            )));
            for specifier in parsed.tree.descendants().filter_map(|node| {
                parsed
                    .injection_import(node)
                    .map(|import| import.specifier.to_owned())
            }) {
                let resolved = self.resolve(&path, &specifier);
                service.set_resolution(
                    id.clone(),
                    specifier,
                    resolved.as_ref().map(|p| FileId(uri(p))),
                );
                if let Some(target) = resolved {
                    pending.push(target);
                }
            }
            let _ = service.set_file(id, self.revision, text);
        }
        service.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_jsonc_aliases_follow_overlays_and_authoritative_overrides() {
        let root = std::env::temp_dir().join(format!("crossbreeze-aliases-{}", std::process::id()));
        fs::create_dir_all(root.join("config")).unwrap();
        fs::create_dir_all(root.join("styles")).unwrap();
        fs::write(
            root.join("config/base.json"),
            r#"{"compilerOptions":{"baseUrl":"..","paths":{"@theme/*":["styles/*"]}}}"#,
        )
        .unwrap();
        fs::write(
            root.join("tsconfig.json"),
            "{ /* JSONC */ \"extends\": \"./config/base.json\", }",
        )
        .unwrap();
        fs::write(root.join("styles/lib.xcss"), "@injection paint {}").unwrap();
        let root = canonical(&root);
        let importer = root.join("app #é.xcss");
        let mut workspace = Workspace {
            roots: vec![root.clone()],
            ..Default::default()
        };
        assert_eq!(
            workspace.resolve(&importer, "@theme/lib"),
            Some(root.join("styles/lib.xcss"))
        );
        workspace.overlays.insert(
            root.join("config/base.json"),
            r#"{"compilerOptions":{"baseUrl":"..","paths":{"@theme/*":["missing/*"]}}}"#.into(),
        );
        assert!(workspace.resolve(&importer, "@theme/lib").is_none());
        workspace
            .aliases
            .insert("@theme/*".into(), vec!["styles/*".into()]);
        assert_eq!(
            workspace.resolve(&importer, "@theme/lib"),
            Some(root.join("styles/lib.xcss"))
        );
        workspace
            .aliases
            .insert("@theme/*".into(), vec!["absent/*".into()]);
        assert!(workspace.resolve(&importer, "@theme/lib").is_none());
        fs::remove_file(root.join("config/base.json")).unwrap();
        fs::remove_file(root.join("tsconfig.json")).unwrap();
        fs::remove_file(root.join("styles/lib.xcss")).unwrap();
        fs::remove_dir(root.join("styles")).unwrap();
        fs::remove_dir(root.join("config")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn typescript_navigation_uses_project_relative_engine_inputs() {
        let root = std::env::temp_dir().join(format!("crossbreeze-ts-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"files":["app.ts"]}"#).unwrap();
        fs::write(root.join("a.xcss"), ".button {}").unwrap();
        let root = canonical(&root);
        let source = root.join("app.ts");
        let text = "import { styles } from './a.xcss'; const button = styles.button;";
        let mut workspace = Workspace {
            roots: vec![root.clone()],
            ..Default::default()
        };
        workspace.overlays.insert(source.clone(), text.into());
        workspace.refresh();
        let (snapshot, anchor) = workspace.typescript_snapshot(&source).unwrap();
        let file = FileId(
            source
                .strip_prefix(&anchor)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
        );
        let definitions = snapshot.definition(
            &file,
            xcss_source::Position {
                line: 0,
                character: text.rfind("button").unwrap(),
            },
        );
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].file.0, "a.xcss");
        fs::remove_file(root.join("a.xcss")).unwrap();
        fs::remove_file(root.join("tsconfig.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn overlays_resolve_imports_and_excluded_directories_are_not_scanned() {
        let root =
            std::env::temp_dir().join(format!("crossbreeze-workspace-{}", std::process::id()));
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/ignored.xcss"), "broken").unwrap();
        fs::write(
            root.join("lib.xcss"),
            "@injection paint($p: color = red) { color: $p; }",
        )
        .unwrap();
        let root = canonical(&root);
        let app = root.join("app.xcss");
        let text = "@import lib from \"./lib\"; .button { @:lib.paint; }";
        let mut workspace = Workspace {
            roots: vec![root.clone()],
            ..Default::default()
        };
        workspace.overlays.insert(app.clone(), text.into());
        workspace.refresh();
        assert_eq!(workspace.files.len(), 2);
        let snapshot = workspace.snapshot();
        let definitions = snapshot.definition(
            &FileId(uri(&app)),
            xcss_source::Position {
                line: 0,
                character: text.find("paint").unwrap(),
            },
        );
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].file.0, uri(&root.join("lib.xcss")));
        workspace.overlays.remove(&app);
        workspace.refresh();
        assert_eq!(workspace.files.len(), 1);
        fs::remove_file(root.join("node_modules/ignored.xcss")).unwrap();
        fs::remove_dir(root.join("node_modules")).unwrap();
        fs::remove_file(root.join("lib.xcss")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
