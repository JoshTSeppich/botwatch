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
use std::time::{Duration, Instant};

// The whole process gets 50ms. Delivery gets 25 of them: the rest is exec,
// startup and exit — ~5ms native, up to ~20ms for the x86_64 slice under
// Rosetta, which is the slowest way this binary can run.
const BUDGET: Duration = Duration::from_millis(25);

fn main() -> ExitCode {
    let deadline = Instant::now() + BUDGET;
    // Failure is silent and total: the hook's job is to be invisible.
    let _ = deliver(deadline);
    ExitCode::SUCCESS
}

fn deliver(deadline: Instant) -> Option<()> {
    let mut payload = String::new();
    std::io::stdin().read_to_string(&mut payload).ok()?;
    let payload = payload.trim();
    if payload.is_empty() {
        return None;
    }

    let mut socket = UnixStream::connect(socket_path()).ok()?;

    // One event per line. pilld splits on newlines, so a payload containing one
    // would desynchronise the stream; hook JSON is emitted without them, but
    // stripping is cheaper than trusting that.
    let mut line = payload.replace('\n', " ");
    line.push('\n');
    send(&mut socket, line.as_bytes(), deadline)
}

// write_all with a deadline. A socket write timeout applies to each write
// call, and a large payload to a daemon that has stopped reading is many
// partial writes — measured at 115ms for 200KB before this. So the time left is
// recomputed before every write, and a half-sent line is abandoned: it is not
// valid JSON, so pilld drops it.
fn send(socket: &mut UnixStream, mut bytes: &[u8], deadline: Instant) -> Option<()> {
    while !bytes.is_empty() {
        let left = deadline.checked_duration_since(Instant::now())?;
        if left.is_zero() {
            return None;
        }
        socket.set_write_timeout(Some(left)).ok()?;
        match socket.write(bytes) {
            Ok(0) => return None,
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    Some(())
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
