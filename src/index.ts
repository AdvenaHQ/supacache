import { compress, decompress } from "compress-json";
import { decrypt, encrypt, getEncryptionKey } from "./crypto";
import { gzipCompress, gzipExpand } from "./gzip";

/**
 * An array of endpoint paths for which the cache should be bypassed.
 *
 * This array includes paths that require real-time data or have
 * subscription-based data that should not be cached to ensure
 * the most up-to-date information is always provided.
 */
export const bypassCacheOnPath = [
    "/realtime/", // Bypass cache for real-time endpoints
    "/subscriptions/", // Bypass cache for subscription endpoints
];

// This is the default TTL (time to live) in seconds. TTL is the
// amount of time which an item is allowed to remain in the cache
// before it is considered "stale" and is no longer used
const defaultTTL: number = 900; // 900 seconds = 15 minutes

export default {
    async fetch(request, env, ctx): Promise<Response> {
        // Extract the cache service key from the request headers. This key is used to
        // authenticate the request and ensure that only authorized clients can access the cache
        const cacheServiceKey = request?.headers?.get(
            "x-cache-service-key",
        ) as string;

        // Check if the cache service key is valid
        if (!isValidServiceKey(cacheServiceKey, env.SERVICE_AUTH_KEY))
            return new Response("Unauthorized", { status: 401 });

        // Derrive the encryption key from the environment variables
        const encryptionKey = await getEncryptionKey(
            env.D1_CACHESTORE_ENCRYPTION_KEY,
        );

        // Generate a cache key from the request URL
        const cacheKey = await generateCacheKey(request.url);

        // Parse the TTL from the request headers or use the default value
        const ttl = parseTTL(request?.headers);

        // Retrieve the Supabase URL from the environment variables
        const supabaseUrl = env.SUPABASE_URL;

        // Initialise a parameter to store the response from Supabase in case we run into an error
        let supabaseResponse: Response | undefined;

        // Check if the request URL is a real-time endpoint. If it is, fetch data directly
        // from Supabase. Real-time endpoints should not be cached as they are meant to be
        // consumed in real-time and are not suitable for caching.
        if (!canCacheEndpoint(request.url)) {
            // Fetch the data directly from Supabase
            supabaseResponse = await fetchFromSupabase(request, supabaseUrl);

            // Return the response from Supabase
            return supabaseResponse;
        }

        try {
            // Check if the response is already cached in D1 and is still fresh
            const cachedResponse = await getCachedResponse(
                cacheKey,
                env.SUPACACHE_DB,
                env.D1_CACHESTORE_TABLE_NAME,
                encryptionKey,
            );

            // Check to see if a fresh cached response was found
            if (cachedResponse) {
                // Log that a cache hit occurred
                console.log(
                    `🚀 Cache HIT for cache key ${cacheKey}. Served cached response to the client`,
                );

                // Return the cached response
                return cachedResponse;
            }

            // Log that a cache miss occurred
            console.log(
                `🐢 Cache MISS for cache key ${cacheKey}. Fetching data from Supabase...`,
            );

            // Otherwise, fetch the data directly from Supabase
            supabaseResponse = await fetchFromSupabase(request, supabaseUrl);

            // If the response should be cached, store it in the D1 database. This is
            // the core function of the worker. It caches the response from Supabase
            // in the D1 database for future requests.
            if (shouldCacheResponse(request, supabaseResponse)) {
                // Clone the response body to read it
                const body = await supabaseResponse.clone().text();

                // Cache the response in the D1 database
                await cacheResponse(
                    cacheKey,
                    body,
                    supabaseResponse,
                    ttl,
                    env.SUPACACHE_DB,
                    env.D1_CACHESTORE_TABLE_NAME,
                    encryptionKey,
                );
            }

            // Return the response from Supabase
            return supabaseResponse;
        } catch (error) {
            // Handle any errors that occur during the caching process. Log the error
            // to the console.
            console.error(
                "❌ An unhandled exception occurred while performing the cache operation:",
                error,
            );

            // Check to see if we have a Supabase response to return
            if (supabaseResponse) {
                // Log that we are returning the Supabase response due to an error.
                console.info(
                    "ℹ️ Returning the Supabase response due to an error during the cache operation",
                );

                // Return the response from Supabase
                return supabaseResponse;
            }

            // If there is no Supabase response to return, log a warning and return an
            // internal server error response.
            console.warn(
                "⚠️ An error occurred and there is no Supabase response to return. Returning an internal server error response",
            );

            // Return an internal server error response
            return new Response("Internal Server Error", { status: 500 });
        }
    },
} satisfies ExportedHandler<Env>;

/**
 * Checks if the provided service key matches the expected key.
 *
 * @param key - The service key to validate.
 * @param expectedKey - The expected service key to compare against.
 *
 * @returns `true` if the provided key matches the expected key, otherwise `false`.
 */
const isValidServiceKey = (key: string, expectedKey: string) => {
    return key === expectedKey;
};

/**
 * Generates a cache key for a given URL by creating an MD5 hash.
 *
 * @param url - The URL for which to generate the cache key.
 * @returns A promise that resolves to a hexadecimal string representing the MD5 hash of the URL.
 */
const generateCacheKey = async (url: string) => {
    // Create a new TextEncoder to encode the URL
    const encoder = new TextEncoder();

    // Encode the URL as an ArrayBuffer
    const data = encoder.encode(url);

    // Generate an MD5 hash of the URL
    const hash = await crypto.subtle.digest("MD5", data);

    // Convert the hash to a hexadecimal string and return it
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
};

/**
 * Parses the TTL (Time-To-Live) value from the provided HTTP headers.
 *
 * @param headers - The HTTP headers from which to extract the TTL value.
 *
 * @returns The TTL value in seconds. If no valid TTL is found in the headers,
 *          the default TTL value is returned.
 */
const parseTTL = (headers: Headers): number => {
    // Initialise a variable to store the TTL value
    let useTTL: number = Number.parseInt(defaultTTL.toString(), 10);

    // Check to see if headers were received
    if (headers) {
        // Get the TTL header value from the request headers
        const ttlHeader = headers?.get("x-ttl");

        if (ttlHeader) {
            // If the TTL header is present, move it into the useTTL variable
            useTTL = Number.parseInt(ttlHeader, 10);
        } else {
            // If the TTL header is not present, try to get the cache control header
            const cacheControl = headers?.get("Cache-Control");

            // If the Cache-Control header is present, try to extract the max-age value
            if (cacheControl) {
                // Extract the max-age value from the Cache-Control header
                const maxAgeMatch = cacheControl.match(/max-age=(\\d+)/);

                // If a max-age value is found, parse it and move it into the useTTL variable
                if (maxAgeMatch) useTTL = Number.parseInt(maxAgeMatch[1], 10);
            }
        }
    }

    // Parse the useTTL value and typecast it to a number if it is a valid number
    const ttl = Number.parseInt(useTTL.toString(), 10);

    // If the parsed TTL is a valid number and greater than 0, return it
    return !Number.isNaN(ttl) && ttl > 0
        ? ttl // Return the parsed TTL
        : defaultTTL; // Return the default TTL
};

/**
 * Determines if a given URL can be cached based on predefined paths that require real-time data.
 *
 * @param url - The URL to check for cache eligibility.
 *
 * @returns A boolean indicating whether the URL can be cached (`true`) or not (`false`).
 */
const canCacheEndpoint = (url: string) => {
    // Check if the URL contains any of the paths that require real-time data
    return !bypassCacheOnPath.some((path) => url.includes(path));
};

/**
 * Retrieves a cached response from the Cloudflare D1 database.
 *
 * @param cacheKey - The key used to identify the cached response.
 * @param db - The D1Database instance to query.
 * @param dbTableName - The name of the database table to query.
 * @param encryptionKey - The encryption key used to decrypt the cached response.
 *
 * @returns A promise that resolves to a Response object if a valid cached response is found, or null if no valid cached response is found.
 */
const getCachedResponse = async (
    cacheKey: string,
    db: D1Database,
    dbTableName: string,
    encryptionKey: CryptoKey,
) => {
    // Attempt to retrieve the cached response from the Cloudflare D1 database
    const result = await db
        .prepare(
            `SELECT key, body, status, headers, expires FROM "${dbTableName}" WHERE key = ? AND expires > CURRENT_TIMESTAMP`,
        )
        .bind(cacheKey)
        .first();

    // Check if a valid cached response is found
    if (result) {
        // Parse the cached response body
        const data = await parseD1Row(result, encryptionKey);

        // Make sure the parsed data is not null
        if (!data) return null;

        // Parse the cached response headers
        const headers = new Headers(JSON.parse(data.headers));

        // Return the cached response with the appropriate status code and headers
        return new Response(data.body, {
            status: Number(result.status),
            headers,
        });
    }

    // Return null if no valid cached response is found
    return null;
};

/**
 * Parses a database row and returns a SupacacheTableSchema object.
 *
 * @param row - The raw database row object. The schema is not strictly known, so `any` is used.
 * @param encryptionKey - The encryption key used to decrypt the body.
 *
 * @returns A promise that resolves to a SupacacheTableSchema object.
 */
const parseD1Row = async (
    // biome-ignore lint/suspicious/noExplicitAny: any is used to represent the raw database row object as the schema is not strictly known
    row: any,
    encryptionKey: CryptoKey,
): Promise<SupacacheTableSchema | null> => {
    try {
        // Convert the body to a Uint8Array for decryption
        const bodyAsUint8Array = new Uint8Array(row.body);

        // Decrypt the body (stored as a binary blob in the database)
        const decryptedBody = await decrypt(
            new TextDecoder().decode(bodyAsUint8Array),
            encryptionKey,
        );

        // Step 1: GZIP decompress the decrypted body
        const gzipDecompressedBody = gzipExpand(decryptedBody);

        // Step 2: JSON decompress the GZIP-decompressed body to get the original response body
        const originalBody = JSON.stringify(
            decompress(JSON.parse(gzipDecompressedBody)),
        );

        // Return the parsed row object
        return {
            key: row.key,
            body: new TextEncoder().encode(originalBody), // Convert to Uint8Array for in-memory use
            status: row.status,
            headers: row.headers,
            expires: new Date(row.expires),
            created_at: new Date(row.created_at),
        };
    } catch (error) {
        // If an error occurs during parsing, log the error and return null
        console.error("Error parsing D1 row:", error);

        return null;
    }
};

/**
 * Fetches data from Supabase by modifying the request URL and headers.
 *
 * This function strips the Cloudflare worker URL from the request URL by replacing
 * the hostname with the Supabase URL's hostname. It also removes specific headers
 * (`x-cache-service-key` and `x-ttl`) that are used for cache control in the worker
 * and should not be sent to Supabase.
 *
 * @param {Request} request - The original request object.
 * @param {string} supabaseUrl - The base URL of the Supabase instance.
 *
 * @returns {Promise<Response>} - The response from the Supabase fetch request.
 */
const fetchFromSupabase = async (request: Request, supabaseUrl: string) => {
    // Strip the Cloudflare worker url from the request URL by upserting the hostname
    // with the Supabase URL (removes the worker sub/domain)
    const url = new URL(request.url);
    url.protocol = "https";
    url.hostname = new URL(supabaseUrl).hostname;

    // Drop the `x-cache-service-key` and `x-ttl` headers to prevent them from being
    // sent to Supabase. These headers are only used for cache control in the worker.
    const headers = new Headers(request.headers);
    headers.delete("x-cache-service-key");
    headers.delete("x-ttl");

    // Initialize the fetch options
    const init = {
        // Pass the original request method, headers, and body
        method: request.method,
        headers: [...headers],
        body: request.body,
    };

    console.log("Fetching data from Supabase:", url.toString(), init);

    // Fetch the data from Supabase
    return await fetch(url, init);
};

/**
 * Determines whether a given response should be cached based on various criteria.
 *
 * @param request - The request object to evaluate.
 * @param response - The response object to evaluate.
 *
 * @returns `true` if the response should be cached, `false` otherwise.
 */
const shouldCacheResponse = (request: Request, response: Response) => {
    // First, check for the "ok" status of the response
    if (!response.ok)
        // The response is not "ok", do not cache it
        return false;

    // First, make sure the response is a successful response (status code 200-299)
    if (response.status < 200 || response.status >= 300)
        // The response is not successful, do not cache it
        return false;

    // Next, check if the response has a `Cache-Control` header with a `no-store` directive
    if (
        (response?.headers?.get("Cache-Control") as string)?.includes(
            "no-store",
        )
    )
        // The `no-store` directive indicates that the response should not be stored in any cache
        return false;

    // Check if the request method is GET or HEAD
    if (request.method !== "GET" && request.method !== "HEAD")
        // Only GET and HEAD requests are cacheable
        return false;

    // Finally, check if the request was a SQL command other than SELECT
    if (request.url.includes("/rest/") && !request.url.includes("?select="))
        // Do not cache SQL commands other than SELECT
        return false;

    // If all conditions are met, the response can be cached
    return true;
};

/**
 * Caches the given response in the specified D1 database table.
 *
 * @param cacheKey - The key under which the response should be cached.
 * @param body - The body of the response to be cached.
 * @param response - The Response object containing the status and headers.
 * @param ttl - The time-to-live (TTL) for the cached response in seconds.
 * @param db - The D1Database instance where the response should be stored.
 * @param dbTableName - The name of the table in the database where the response should be stored.
 * @param encryptionKey - The encryption key used to decrypt the cached response.
 *
 * @returns A promise that resolves when the response has been successfully cached.
 */
const cacheResponse = async (
    cacheKey: string,
    body: string,
    response: Response,
    ttl: number,
    db: D1Database,
    dbTableName: string,
    encryptionKey: CryptoKey,
) => {
    // Calculate the expiration time based on the TTL
    const expires = new Date(Date.now() + ttl * 1000).toISOString();

    // Convert the response headers to a JSON string
    const headers = JSON.stringify([...response.headers]);

    // Step 1: Apply JSON compression
    const jsonCompressedBody = JSON.stringify(compress(JSON.parse(body)));

    // Step 2: Apply GZIP compression to the JSON-compressed body
    const gzipCompressedBody = gzipCompress(jsonCompressedBody);

    // Step 3: Encrypt the GZIP-compressed body
    const encryptedBody = await encrypt(gzipCompressedBody, encryptionKey);

    // Convert to a Uint8Array for storage
    const bodyAsBlob = new TextEncoder().encode(encryptedBody);

    // Log the caching operation
    console.log(
        `💾 Caching response for cache key ${cacheKey}. Expires ${expires}`,
    );

    // Store the response in the D1 database
    await db
        .prepare(
            `INSERT OR REPLACE INTO ${dbTableName} (key, body, status, headers, expires) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(cacheKey, bodyAsBlob, response.status, headers, expires)
        .run();
};

/**
 * Represents the schema for a Supacache cached responses table.
 *
 * @property {string} key - The unique identifier for the cache entry.
 * @property {Uint8Array} body - The compressed and encrypted content or body of the cache entry.
 * @property {number} status - The HTTP status code associated with the cache entry.
 * @property {string} headers - The JSON-encoded HTTP headers associated with the cache entry.
 * @property {Date} expires - The expiration date and time of the cache entry.
 * @property {Date} created_at - The timestamp when the cache entry was created.
 */
export type SupacacheTableSchema = {
    key: string;
    body: Uint8Array;
    status: number;
    headers: string;
    expires: Date;
    created_at: Date;
};
