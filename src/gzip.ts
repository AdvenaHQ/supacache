import { gzip, ungzip } from "pako";

/**
 * Compresses a string using GZIP.
 *
 * @param data - The string to compress.
 *
 * @returns A base64-encoded string of the GZIP-compressed data.
 */
export const gzipCompress = (data: string): string => {
    // Compress the data using GZIP
    const compressed = gzip(data);

    // Return the compressed data as a base64-encoded string
    return btoa(
        // Convert the compressed data to a Uint8Array
        String.fromCharCode(
            // Convert the compressed data to a Uint8Array
            ...new Uint8Array(compressed),
        ),
    );
};

/**
 * Decompresses a GZIP-compressed, base64-encoded string.
 *
 * @param compressedData - The base64-encoded GZIP data.
 *
 * @returns The original string.
 */
export const gzipExpand = (compressedData: string): string => {
    // Convert the base64-encoded string to a binary string
    const binary = atob(compressedData);

    // Convert the binary string to a Uint8Array
    const compressed = new Uint8Array(
        [...binary].map((char) => char.charCodeAt(0)),
    );

    // Decompress the data using GZIP
    return ungzip(compressed, { to: "string" });
};
