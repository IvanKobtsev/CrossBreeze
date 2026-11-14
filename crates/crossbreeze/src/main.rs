use crossbreeze::{
    documents::{Change, Document, Documents},
    transport,
    workspace::{self, Workspace},
};
use notify::Watcher;
use serde_json::{Value, json};
use std::io;
use xcss_language_service::{EditorLocation, Range};
use xcss_source::{FileId, Position};

fn position(value: &Value) -> Position {
    Position {
        line: value["line"].as_u64().unwrap_or(0) as usize,
        character: value["character"].as_u64().unwrap_or(0) as usize,
    }
}
fn range(r: &Range) -> Value {
    json!({"start":{"line":r.start.line,"character":r.start.character},"end":{"line":r.end.line,"character":r.end.character}})
}
fn location(l: &EditorLocation) -> Value {
    json!({"uri":l.file.0,"range":range(&l.range)})
}
fn isolated(uri: &str, document: &Document) -> crossbreeze::ServiceSnapshot {
    let mut service = crossbreeze::LanguageService::new();
    service
        .set_file(FileId(uri.into()), 1, document.text.clone())
        .expect("Valid document URI");
    service.snapshot()
}
fn diagnostics(
    snapshot: &crossbreeze::ServiceSnapshot,
    file: &FileId,
    css_properties: bool,
    css_values: bool,
) -> Vec<Value> {
    let mut result: Vec<_> = snapshot.diagnostics(file).iter().map(|d| json!({"range":range(&d.location.range),"code":d.diagnostic.code,"source":"XCSS","severity":match d.diagnostic.severity { xcss_source::Severity::Error=>1,xcss_source::Severity::Warning=>2,xcss_source::Severity::Information=>3 },"message":format!("{} {} — {}",d.diagnostic.code,d.label,d.diagnostic.message)})).collect();
    result.extend(crossbreeze::css::validate(
        &snapshot.css_declarations(file),
        css_properties,
        css_values,
    ));
    result
}
fn send(output: &mut impl io::Write, value: Value) -> io::Result<()> {
    transport::write_message(output, &serde_json::to_vec(&value)?)
}
fn project_diagnostics(
    workspace: &mut Workspace,
    path: &std::path::Path,
    properties: bool,
    values: bool,
) -> Vec<Value> {
    if path
        .extension()
        .is_some_and(|ext| ["ts", "tsx", "mts", "cts"].iter().any(|e| ext == *e))
    {
        if let Some((snapshot, anchor)) = workspace.typescript_snapshot(path) {
            let file = FileId(
                path.strip_prefix(anchor)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            return diagnostics(&snapshot, &file, false, false);
        }
        return Vec::new();
    }
    diagnostics(
        &workspace.snapshot(),
        &FileId(workspace::uri(path)),
        properties,
        values,
    )
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let input_sender = sender.clone();
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match transport::read_message(&mut input) {
                Ok(Some(body)) => {
                    if input_sender.send(Some(body)).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = input_sender.send(None);
                    break;
                }
            }
        }
    });
    let mut _watcher = None;
    let mut output = io::stdout().lock();
    let mut documents = Documents::default();
    let mut workspace = Workspace::default();
    let mut shutdown = false;
    let mut css_properties = true;
    let mut css_values = true;
    while let Ok(Some(body)) = receiver.recv() {
        let message: Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => {
                send(
                    &mut output,
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}),
                )?;
                continue;
            }
        };
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        let id = message.get("id");
        if method == "exit" {
            if !shutdown {
                return Err("exit before shutdown".into());
            }
            break;
        }
        let result: Result<Value, String> = (|| {
            if shutdown {
                return Err("Server has shut down".into());
            }
            match method {
                "initialize" => {
                    css_properties = params["initializationOptions"]["checkCssProperties"]
                        .as_bool()
                        .unwrap_or(true);
                    css_values = params["initializationOptions"]["checkCssValues"]
                        .as_bool()
                        .unwrap_or(true);
                    let roots = params["workspaceFolders"]
                        .as_array()
                        .map(|folders| {
                            folders
                                .iter()
                                .filter_map(|f| f["uri"].as_str().and_then(workspace::path))
                                .collect()
                        })
                        .unwrap_or_else(|| {
                            params["rootUri"]
                                .as_str()
                                .and_then(workspace::path)
                                .into_iter()
                                .collect()
                        });
                    workspace.roots = roots;
                    if let Some(roots) = params["initializationOptions"]["excludedRoots"].as_array()
                    {
                        workspace.excluded = roots
                            .iter()
                            .filter_map(|r| r.as_str().map(Into::into))
                            .collect();
                    }
                    if let Ok(aliases) =
                        serde_json::from_value(params["initializationOptions"]["aliases"].clone())
                    {
                        workspace.aliases = aliases;
                    }
                    workspace.refresh();
                    let watch_sender = sender.clone();
                    let mut native_watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                        if let Ok(event) = event && !matches!(event.kind, notify::EventKind::Access(_)) {
                            let changes: Vec<_> = event.paths.iter().filter_map(|p| url::Url::from_file_path(p).ok().map(|url| json!({"uri":url.to_string(),"type":2}))).collect();
                            let _ = watch_sender.send(Some(serde_json::to_vec(&json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles","params":{"changes":changes}})).unwrap()));
                        }
                    }).map_err(|e| e.to_string())?;
                    for root in &workspace.roots {
                        native_watcher
                            .watch(root, notify::RecursiveMode::Recursive)
                            .map_err(|e| e.to_string())?;
                    }
                    _watcher = Some(native_watcher);
                    Ok(
                        json!({"capabilities":{"positionEncoding":"utf-16","textDocumentSync":2,"definitionProvider":true,"referencesProvider":true,"hoverProvider":true,"colorProvider":true,"completionProvider":{"triggerCharacters":[".","\"","'","<"]},"documentFormattingProvider":true,"semanticTokensProvider":{"legend":{"tokenTypes":xcss_language_service::TOKEN_TYPES,"tokenModifiers":["declaration"]},"full":true}},"serverInfo":{"name":"CrossBreeze","version":env!("CARGO_PKG_VERSION")}}),
                    )
                }
                "shutdown" => {
                    _watcher = None;
                    shutdown = true;
                    Ok(Value::Null)
                }
                "initialized" | "$/cancelRequest" => Ok(Value::Null),
                "workspace/didChangeConfiguration" => {
                    let settings = &params["settings"]["crossbreeze"];
                    css_properties = settings["checkCssProperties"]
                        .as_bool()
                        .unwrap_or(css_properties);
                    css_values = settings["checkCssValues"].as_bool().unwrap_or(css_values);
                    if let Ok(aliases) = serde_json::from_value(settings["aliases"].clone()) {
                        workspace.aliases = aliases;
                    }
                    Ok(Value::Null)
                }
                "workspace/didChangeWatchedFiles" => {
                    workspace.refresh();
                    let snapshot = workspace.snapshot();
                    for (uri, document) in documents.iter().filter(|(_, d)| d.language_id == "xcss")
                    {
                        if let Some(path) = workspace::path(uri) {
                            let diagnostics = diagnostics(
                                &snapshot,
                                &FileId(workspace::uri(&path)),
                                css_properties,
                                css_values,
                            );
                            send(&mut output, json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":document.version,"diagnostics":diagnostics}})).map_err(|e| e.to_string())?;
                        }
                    }
                    Ok(Value::Null)
                }
                "textDocument/didOpen" | "textDocument/didChange" | "textDocument/didClose" => {
                    let document = &params["textDocument"];
                    let uri = document["uri"].as_str().ok_or("Missing document URI")?;
                    if method.ends_with("didClose") {
                        documents.close(uri);
                        if let Some(path) = workspace::path(uri) {
                            workspace.overlays.remove(&path);
                        }
                    } else if method.ends_with("didOpen") {
                        documents
                            .open(
                                uri.into(),
                                Document {
                                    version: document["version"]
                                        .as_i64()
                                        .ok_or("Missing version")?,
                                    text: document["text"].as_str().ok_or("Missing text")?.into(),
                                    language_id: document["languageId"]
                                        .as_str()
                                        .unwrap_or("xcss")
                                        .into(),
                                },
                            )
                            .map_err(|e| format!("{e:?}"))?;
                    } else {
                        let changes: Vec<_> = params["contentChanges"]
                            .as_array()
                            .ok_or("Missing changes")?
                            .iter()
                            .map(|c| Change {
                                range: c
                                    .get("range")
                                    .map(|r| (position(&r["start"]), position(&r["end"]))),
                                text: c["text"].as_str().unwrap_or("").into(),
                            })
                            .collect();
                        documents
                            .change(
                                uri,
                                document["version"].as_i64().ok_or("Missing version")?,
                                &changes,
                            )
                            .map_err(|e| format!("{e:?}"))?;
                    }
                    if let Some(document) = documents.get(uri)
                        && let Some(path) = workspace::path(uri)
                    {
                        workspace.overlays.insert(path, document.text.clone());
                    }
                    workspace.refresh();
                    let diagnostics = if let Some(path) = workspace::path(uri) {
                        project_diagnostics(&mut workspace, &path, css_properties, css_values)
                    } else if let Some(document) = documents.get(uri) {
                        diagnostics(
                            &isolated(uri, document),
                            &FileId(uri.into()),
                            css_properties,
                            css_values,
                        )
                    } else {
                        vec![]
                    };
                    send(&mut output, json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":uri,"version":documents.get(uri).map(|d| d.version),"diagnostics":if method.ends_with("didClose") {vec![]} else {diagnostics}}})).map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                _ => {
                    let uri = params["textDocument"]["uri"]
                        .as_str()
                        .ok_or("Unsupported request")?;
                    let standalone = workspace::path(uri).is_none();
                    let path = workspace::path(uri).unwrap_or_default();
                    let typescript = path
                        .extension()
                        .is_some_and(|e| ["ts", "tsx", "mts", "cts"].iter().any(|ext| e == *ext));
                    let (snapshot, anchor) = if standalone {
                        (
                            isolated(uri, documents.get(uri).ok_or("Document is not open")?),
                            None,
                        )
                    } else if typescript {
                        let (snapshot, anchor) = workspace
                            .typescript_snapshot(&path)
                            .ok_or("No TypeScript project found")?;
                        (snapshot, Some(anchor))
                    } else {
                        (workspace.snapshot(), None)
                    };
                    let file = FileId(anchor.as_ref().map_or_else(
                        || {
                            if standalone {
                                uri.into()
                            } else {
                                workspace::uri(&path)
                            }
                        },
                        |root| {
                            path.strip_prefix(root)
                                .unwrap()
                                .to_string_lossy()
                                .replace('\\', "/")
                        },
                    ));
                    let location = |l: &EditorLocation| {
                        let mut result = location(l);
                        if let Some(root) = &anchor {
                            result["uri"] = json!(workspace::uri(&root.join(&l.file.0)));
                        }
                        result
                    };
                    let pos = position(&params["position"]);
                    match method {
                        "textDocument/definition" | "crossbreeze/navigation" => Ok(json!(snapshot.definition(&file,pos).iter().map(location).collect::<Vec<_>>())),
                        "textDocument/references" => Ok(json!(snapshot.references(&file,pos,params["context"]["includeDeclaration"].as_bool().unwrap_or(false)).iter().map(location).collect::<Vec<_>>())),
                        "textDocument/colorPresentation" => {
                            let range_value = &params["range"];
                            let doc = documents.get(uri).ok_or("Document is not open")?;
                            let start = crossbreeze::documents::byte_offset(&doc.text, position(&range_value["start"])).ok_or("Invalid color range")?;
                            let end = crossbreeze::documents::byte_offset(&doc.text, position(&range_value["end"])).ok_or("Invalid color range")?;
                            if start > end { return Err("Invalid color range".into()); }
                            let c = &params["color"];
                            let color = [c["red"].as_f64().ok_or("Invalid color")?, c["green"].as_f64().ok_or("Invalid color")?, c["blue"].as_f64().ok_or("Invalid color")?, c["alpha"].as_f64().ok_or("Invalid color")?];
                            Ok(json!(crossbreeze::css::presentation(&doc.text[start..end], color, range_value.clone())))
                        }
                        "textDocument/documentColor" => Ok(json!(crossbreeze::css::colors(&snapshot.css_values(&file)))), 
                        "textDocument/hover" => Ok(snapshot.hover(&file,pos).map_or(Value::Null, |h| json!({"contents":{"kind":"plaintext","value":h.text},"range":range(&h.range)}))),
                        "textDocument/completion" => Ok(json!(snapshot.completion(&file,pos).iter().map(|c| json!({"label":c.label,"kind":if c.kind=="class" {7}else if c.kind=="variantGroup" {13}else{20},"textEdit":{"range":range(&c.range),"newText":c.new_text}})).collect::<Vec<_>>())),
                        "textDocument/semanticTokens/full" => { let mut data=Vec::new(); let mut line=0; let mut character=0; let mut tokens=snapshot.semantic_tokens(&file); if typescript && let Some(document)=documents.get(uri) { for extra in crossbreeze::typescript::import_tokens(&document.text) { if !tokens.iter().any(|token|token.line==extra.line && token.character<extra.character+extra.length && extra.character<token.character+token.length) {tokens.push(extra);} } tokens.sort_by_key(|token|(token.line,token.character)); } for token in tokens { data.extend([token.line-line,if token.line==line {token.character-character}else{token.character},token.length,token.token_type,usize::from(token.declaration)]); line=token.line; character=token.character; } Ok(json!({"data":data})) }
                        "textDocument/formatting" => {
                            let doc=documents.get(uri).ok_or("Document is not open")?;
                            let options=xcss_format::FormatOptions { tab_width:params["options"]["tabSize"].as_u64().unwrap_or(2) as usize,use_tabs: !params["options"]["insertSpaces"].as_bool().unwrap_or(true),..Default::default() };
                            let result=xcss_format::format(&doc.text,&options); let text=result.text.ok_or("Formatting failed")?;
                            let mut line=0; let mut character=0; for ch in doc.text.chars() { if ch=='\n' {line+=1;character=0;}else{character+=ch.len_utf16();} }
                            Ok(if text==doc.text {json!([])}else{json!([{"range":{"start":{"line":0,"character":0},"end":{"line":line,"character":character}},"newText":text}])})
                        }
                        _ => Err(format!("Unsupported method: {method}")),
                    }
                }
            }
        })();
        if let Some(id) = id {
            send(
                &mut output,
                match result {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(message) => {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":if method=="textDocument/formatting" {-32803}else{-32602},"message":message}})
                    }
                },
            )?;
        } else if let Err(error) = result {
            eprintln!("{method}: {error}");
        }
    }
    Ok(())
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("CrossBreeze {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("vite-setup") {
        if let Err(error) = crossbreeze::setup::run() {
            eprintln!("CrossBreeze setup: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = run() {
        eprintln!("CrossBreeze: {error}");
        std::process::exit(1);
    }
}
