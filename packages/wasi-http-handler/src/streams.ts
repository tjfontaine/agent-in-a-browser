/**
 * Re-export stream classes from @tjfontaine/wasi-shims
 * This ensures a single source of truth and avoids module duplication issues.
 */
export {
    InputStream,
    OutputStream,
    ReadyPollable,
    CustomInputStream,
    CustomOutputStream,
} from '@tjfontaine/wasi-shims/streams.js';
