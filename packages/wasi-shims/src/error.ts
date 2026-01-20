/**
 * WASI io/error shim
 * Replaces @bytecodealliance/preview2-shim/io for error handling
 */

export class IoError {
    public msg: string;

    constructor(msg: string) {
        this.msg = msg;
    }

    toDebugString(): string {
        return this.msg;
    }
}

export const error = { Error: IoError };
