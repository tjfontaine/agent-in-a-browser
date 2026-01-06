//! WASM-compatible async utilities
//!
//! Provides blocking execution for futures in WASM environments that use
//! JSPI (JavaScript Promise Integration) for stack suspension.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// WASIP2-compatible block_on implementation.
///
/// Unlike `futures::executor::block_on`, this doesn't use thread parking
/// which fails in WASM. Instead, it polls with a noop waker and relies on
/// JSPI to suspend the WASM stack during blocking operations.
///
/// IMPORTANT: This only works in WASIP2/JSPI environments where blocking
/// WASI calls (like poll.block() and blocking_read) suspend the stack.
///
/// # Panics
/// Panics after 50 pending polls without progress to detect deadlocks.
pub fn wasm_block_on<F: Future>(mut future: F) -> F::Output {
    use futures::task::noop_waker;

    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);

    // SAFETY: We're pinning a local future that won't be moved
    let mut future = unsafe { Pin::new_unchecked(&mut future) };

    let mut pending_count = 0u32;
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(result) => return result,
            Poll::Pending => {
                pending_count += 1;
                if pending_count > 50 {
                    panic!(
                        "[wasm_block_on] DEADLOCK DETECTED: future returned Pending {} times. \
                         This indicates an await point that cannot be resolved without a working waker. \
                         Check for tokio::sync primitives or other async mechanisms that require an executor.",
                        pending_count
                    );
                }
                // In WASIP2/JSPI, blocking WASI calls inside the future will
                // suspend the WASM stack. When they return, we continue polling.
                // If we get Pending without a blocking call, we need to yield.
                // Use a short sleep to avoid busy-spinning.
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
}
