use crossbreeze::{FormatOptions, LanguageService, format};
use xcss_source::FileId;

#[test]
fn engine_accepts_document_updates_and_snapshots() {
    let mut service = LanguageService::new();
    let file = FileId("empty.xcss".into());
    service.set_file(file.clone(), 1, String::new()).unwrap();
    let snapshot = service.snapshot();
    assert!(snapshot.diagnostics(&file).is_empty());
    assert!(snapshot.semantic_tokens(&file).is_empty());
    service.set_file(file.clone(), 2, String::new()).unwrap();
    assert!(service.snapshot().revision() > snapshot.revision());
    service.remove_file(&file, 3).unwrap();
}

#[test]
fn formatter_is_callable_without_node() {
    let result = format("", &FormatOptions::default());
    assert!(result.diagnostics.is_empty());
    assert!(result.text.is_some());
}
