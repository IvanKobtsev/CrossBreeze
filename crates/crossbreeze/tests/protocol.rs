use crossbreeze::transport::{read_message, write_message};
use serde_json::{Value, json};
use std::{
    io::BufReader,
    process::{Command, Stdio},
};

#[test]
fn formatting_configuration_rejects_cancelled_and_stale_requests() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_crossbreeze"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let send = |input: &mut std::process::ChildStdin, value: Value| {
        write_message(input, &serde_json::to_vec(&value).unwrap()).unwrap()
    };
    let receive = |output: &mut BufReader<std::process::ChildStdout>| -> Value {
        serde_json::from_slice(&read_message(output).unwrap().unwrap()).unwrap()
    };
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{"workspace":{"configuration":true}}}}),
    );
    assert_eq!(receive(&mut output)["id"], 1);
    send(
        &mut input,
        json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"untitled:format.xcss","languageId":"xcss","version":1,"text":".a{color:red}"}}}),
    );
    assert_eq!(
        receive(&mut output)["method"],
        "textDocument/publishDiagnostics"
    );
    for (id, code) in [(2, -32800), (3, -32801)] {
        send(
            &mut input,
            json!({"jsonrpc":"2.0","id":id,"method":"textDocument/formatting","params":{"textDocument":{"uri":"untitled:format.xcss"},"options":{"tabSize":2,"insertSpaces":true}}}),
        );
        let config = receive(&mut output);
        assert_eq!(config["method"], "workspace/configuration");
        if id == 2 {
            send(
                &mut input,
                json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}),
            );
        } else {
            send(
                &mut input,
                json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":"untitled:format.xcss","version":2},"contentChanges":[{"text":".b{color:blue}"}]}}),
            );
        }
        send(
            &mut input,
            json!({"jsonrpc":"2.0","id":config["id"],"result":[{"tabWidth":4,"useTabs":true,"printWidth":90,"endOfLine":"crlf"}]}),
        );
        loop {
            let response = receive(&mut output);
            if response["id"] == id {
                assert_eq!(response["error"]["code"], code, "{response}");
                break;
            }
        }
    }
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":4,"method":"shutdown"}),
    );
    assert_eq!(receive(&mut output)["id"], 4);
    send(&mut input, json!({"jsonrpc":"2.0","method":"exit"}));
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[test]
fn stdio_initialize_and_shutdown() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_crossbreeze"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    for (id, method, params) in [
        (1, "initialize", json!({"capabilities":{}})),
        (2, "shutdown", Value::Null),
    ] {
        write_message(
            &mut input,
            &serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .unwrap(),
        )
        .unwrap();
        let response: Value =
            serde_json::from_slice(&read_message(&mut output).unwrap().unwrap()).unwrap();
        assert_eq!(response["id"], id);
        assert!(response.get("error").is_none(), "{response}");
        if id == 1 {
            assert_eq!(
                response["result"]["capabilities"]["positionEncoding"],
                "utf-16"
            );
        }
    }
    write_message(&mut input, br#"{"jsonrpc":"2.0","method":"exit"}"#).unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
}
