/**
 * WASI random shim
 * Replaces @bytecodealliance/preview2-shim/random
 */

const MAX_BYTES = 65536;

let insecureRandomValue1: bigint | undefined;
let insecureRandomValue2: bigint | undefined;

export const insecure = {
    getInsecureRandomBytes(len: bigint): Uint8Array {
        return random.getRandomBytes(len);
    },
    getInsecureRandomU64(): bigint {
        return random.getRandomU64();
    },
};

let insecureSeedValue1: bigint | undefined;
let insecureSeedValue2: bigint | undefined;

export const insecureSeed = {
    insecureSeed(): [bigint, bigint] {
        if (insecureSeedValue1 === undefined) {
            insecureSeedValue1 = random.getRandomU64();
            insecureSeedValue2 = random.getRandomU64();
        }
        return [insecureSeedValue1, insecureSeedValue2!];
    },
};

export const random = {
    getRandomBytes(len: bigint): Uint8Array {
        const bytes = new Uint8Array(Number(len));

        if (len > MAX_BYTES) {
            for (let generated = 0; generated < Number(len); generated += MAX_BYTES) {
                crypto.getRandomValues(
                    bytes.subarray(generated, generated + MAX_BYTES)
                );
            }
        } else {
            crypto.getRandomValues(bytes);
        }

        return bytes;
    },

    getRandomU64(): bigint {
        return crypto.getRandomValues(new BigUint64Array(1))[0];
    },

    insecureRandom(): [bigint, bigint] {
        if (insecureRandomValue1 === undefined) {
            insecureRandomValue1 = random.getRandomU64();
            insecureRandomValue2 = random.getRandomU64();
        }
        return [insecureRandomValue1, insecureRandomValue2!];
    },
};
