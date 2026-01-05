// Declarations for local JS shims
declare module './clocks-impl.js' {
    export const monotonicClock: any;
    export const wallClock: any;
    export const timezone: any;
}

declare module './terminal-info-impl.js' {
    export const size: any;
}

declare module './poll-impl.js' {
    export function poll(list: any[]): Promise<number>;
}
