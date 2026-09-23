// Every Claude Code hook runs this binary. It reads the hook JSON from stdin,
// writes one line to pilld's unix socket, and exits 0.
//
// The only hard rule: never slow Claude Code down. Whatever goes wrong — no
// socket, no daemon, a full buffer, a half-written line — this exits 0 and the
// session carries on as if BotWatch were not installed. There is a 50ms budget
// for the whole process and no path that can exceed it.

use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

const BUDGET: Duration = Duration::from_millis(50);

fn main() -> ExitCode {
    // Failure is silent and total: the hook's job is to be invisible.
    let _ = deliver();
    ExitCode::SUCCESS
}

fn deliver() -> Option<()> {
    let mut payload = String::new();
    std::io::stdin().read_to_string(&mut payload).ok()?;
    let payload = payload.trim();
    if payload.is_empty() {
        return None;
    }

    let mut socket = UnixStream::connect(socket_path()).ok()?;
    socket.set_write_timeout(Some(BUDGET)).ok()?;

    // One event per line. pilld splits on newlines, so a payload containing one
    // would desynchronise the stream; hook JSON is emitted without them, but
    // stripping is cheaper than trusting that.
    let line = payload.replace('\n', " ");
    socket.write_all(line.as_bytes()).ok()?;
    socket.write_all(b"\n").ok()?;
    socket.flush().ok()
}

// BOTWATCH_SOCK exists so the test suite can point the hook at a throwaway
// socket instead of the user's running daemon.
fn socket_path() -> PathBuf {
    if let Ok(path) = env::var("BOTWATCH_SOCK") {
        return PathBuf::from(path);
    }
    let home = env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".claude/botwatch/pilld.sock")
}
