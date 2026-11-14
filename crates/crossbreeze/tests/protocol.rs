use crossbreeze::transport::{read_message, write_message};
use serde_json::{Value, json};
use std::{
    io::BufReader,
    process::{Command, Stdio},
};

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
